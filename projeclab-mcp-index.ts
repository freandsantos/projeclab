// @ts-nocheck
// Projeclab connector for Claude (tasks: create, list, delete-to-Trash, restore;
// calendar: add, list and remove meetings and events; Feed: post as Projeclab
// Studios, list and remove studio posts) — Supabase Edge Function "projeclab-mcp".
// Paste this whole file into Supabase: Edge Functions -> Deploy a new function
// -> Via Editor, name it projeclab-mcp, and turn OFF "Verify JWT" (the
// connector uses its own private key instead, set as PROJECLAB_MCP_KEY).
//
// Secrets it reads (Edge Functions -> Secrets):
//   PROJECLAB_MCP_KEY   required. A long random key; the same one goes in Claude.
//   PROJECLAB_ACTOR     optional. Your login email or name - tasks show as
//                       assigned by this person. Default: whoever has the Lead role.
//   PROJECLAB_SITE_URL  optional. Default https://projeclab-alpha-1.vercel.app/
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase itself.
import { createClient } from "npm:@supabase/supabase-js@2";

/* ---------------------------------------------------------------------------
   Projeclab connector core: an MCP server (Streamable HTTP, stateless JSON)
   that lets Claude work with tasks and the team Calendar in the shared
   Projeclab app_state row. Tasks can be added, listed, moved to the Trash and
   restored. Calendar meetings and events can be added, listed and removed,
   saved exactly like the Calendar tab saves them (db.meetings).
   Feed posts (v1.2.0) go into the feed_posts table as the studio itself
   (person_id "studio"), with photos copied into the task-photos bucket.
   It never touches payroll.
   --------------------------------------------------------------------------- */
const TZ = "Asia/Manila";
const STORE_KEY = "cutline-state-v2";
const TASK_KINDS = ["video", "design", "report", "onboarding", "hrdoc", "other"];
const KIND_LABEL = { video: "Video", design: "Graphic design", report: "Report", onboarding: "Onboarding", hrdoc: "HR document", other: "Other" };
const REPEATS = ["none", "daily", "weekly", "biweekly", "monthly"];
const CAL_KINDS = ["meeting", "event"];
const VIDEO_CHECKS = [
  "Watched the whole cut at normal speed",
  "Captions and on-screen text are spelled right",
  "Audio is even with no clipping",
  "No black frames, glitches, or bad cuts",
  "Exported at the right size and format"
];
const DETAIL_MAX = 2000;
const SKIP_NAMES = ["admin"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STUDIO = "studio";
const FEED_MAX_PICS = 10;
const PIC_MAX_BYTES = 15 * 1024 * 1024;
const PIC_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

const uid = (p) => p + Math.random().toString(36).slice(2, 9);
const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const firstOf = (name) => norm(String(name || "").trim().split(/\s+/)[0]);
const near = (a, b) => {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, miss = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++miss > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return miss + (a.length - i) + (b.length - j) <= 1;
};

/* Find one row by a spoken name: exact full name, then first name, then the
   start of a name, then a one-letter typo. Ambiguity is an error, never a guess. */
const matchOne = (list, query, label) => {
  const q = norm(query);
  if (!q) return { error: `No ${label} given.` };
  const byId = list.find((x) => x.id === query);
  if (byId) return { row: byId };
  const tiers = [
    (x) => norm(x.name) === q,
    (x) => firstOf(x.name) === q,
    (x) => norm(x.name).startsWith(q) || firstOf(x.name).startsWith(q),
    (x) => near(firstOf(x.name), q) || near(norm(x.name), q)
  ];
  for (const test of tiers) {
    const hits = list.filter(test);
    if (hits.length === 1) return { row: hits[0] };
    if (hits.length > 1) return { error: `"${query}" matches more than one ${label}: ${hits.map((x) => x.name).join(", ")}. Ask which one.` };
  }
  return { error: `No ${label} called "${query}". The ${label}s are: ${list.map((x) => x.name).join(", ")}. Ask the user which one they meant.` };
};

const manilaNow = (now) => {
  const d = now || new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "long" }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === "24" ? "00" : parts.hour}:${parts.minute}`, weekday: parts.weekday };
};
const prettyDay = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const timeLabel = (hhmm) => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm || "");
  if (!m) return hhmm || "";
  const hh = +m[1];
  return `${((hh + 11) % 12) + 1}:${m[2]} ${hh < 12 ? "AM" : "PM"}`;
};
const prettyDue = (due) => {
  if (!due) return "no due date";
  const [d, t] = String(due).split("T");
  if (!t) return prettyDay(d);
  return `${prettyDay(d)}, ${timeLabel(t)}`;
};
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const manilaStamp = (iso) => {
  const n = manilaNow(new Date(iso));
  return `${prettyDay(n.date)}, ${timeLabel(n.time)}`;
};

const TOOLS = [
  {
    name: "list_team",
    description: "List the Projeclab team (names, roles) and clients, plus today's date and time in Manila. Call this before create_task or add_to_calendar whenever you're unsure who someone is or what 'tomorrow' means.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "List team and clients" }
  },
  {
    name: "create_task",
    description: "Create a task in the Projeclab Studios app and assign it to a team member. It appears in the app straight away and the person is notified. Dates are Manila time (Asia/Manila). Resolve words like 'tomorrow' or 'Friday' to a real date first (list_team gives today's date). If the person or client is unclear, ask the user instead of guessing.",
    inputSchema: {
      type: "object",
      properties: {
        assignee: { type: "string", description: "Who does the task: a team member's name as the user said it (e.g. 'Jay', 'Raizza'). Must match one person." },
        title: { type: "string", description: "The task itself, short and clear, e.g. 'Edit Episode 521'." },
        due_date: { type: "string", description: "Due date as YYYY-MM-DD in Manila time. Omit for no due date." },
        due_time: { type: "string", description: "Due time as 24-hour HH:MM in Manila time, e.g. '17:00' for 5 PM. Omit for end of day." },
        type: { type: "string", enum: TASK_KINDS, description: "Task type. video = video edit (default), design = graphic design, report = report (goes straight to the Lead for the final check, skips QA), onboarding, hrdoc = HR document, other." },
        client: { type: "string", description: "Client name, if the task is for a client. Optional." },
        brief: { type: "string", description: "Longer instructions or notes for the task. Optional." },
        assist: { type: "array", items: { type: "string" }, description: "Other team members helping on the task (the app's 'Assist'). Optional." },
        repeat: { type: "string", enum: REPEATS, description: "Repeat schedule. Default none." }
      },
      required: ["assignee", "title"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: "Create a task" }
  },
  {
    name: "delete_task",
    description: "Move a Projeclab task to the app's Trash (like the Delete button in the app). It disappears from everyone's lists but can be restored for 30 days with restore_task. Identify the task by its id (from list_open_tasks or a create_task link) or by its title. Always confirm with the user which task before deleting, especially if several have similar titles.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The task's id (e.g. 'tx3d1m53') or its title as the user said it." },
        person: { type: "string", description: "Whose task it is, to narrow down a title match. Optional." }
      },
      required: ["task"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, title: "Delete a task (to Trash)" }
  },
  {
    name: "restore_task",
    description: "Bring a task back out of the Projeclab Trash (undo delete_task). Identify it by id or title.",
    inputSchema: {
      type: "object",
      properties: { task: { type: "string", description: "The task's id or title." } },
      required: ["task"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, title: "Restore a deleted task" }
  },
  {
    name: "list_open_tasks",
    description: "List open (not done) tasks in Projeclab, optionally for one person. Use it to check what someone already has, or to confirm a task was created.",
    inputSchema: { type: "object", properties: { person: { type: "string", description: "Team member's name. Omit for everyone." } }, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "List open tasks" }
  },
  {
    name: "add_to_calendar",
    description: "Add a meeting or an event to the team Calendar in the Projeclab app (the same as clicking a day in the Calendar tab). Tagged people are notified in the app, and it's posted to Slack like the app does. Dates and times are Manila time; resolve words like 'Tuesday' to a real date first (list_team gives today's date). Leave time out for a whole-day item. Only events can span several days (end_date). If a name is unclear, ask the user.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: CAL_KINDS, description: "meeting (default) or event (e.g. a party, a shoot, a holiday)." },
        title: { type: "string", description: "What it is, e.g. 'Client review with Maya' or 'Halloween party'." },
        date: { type: "string", description: "Day as YYYY-MM-DD in Manila time. For a multi-day event, the first day." },
        time: { type: "string", description: "Start time as 24-hour HH:MM in Manila time, e.g. '10:00'. Omit for whole day." },
        end_date: { type: "string", description: "Events only: last day as YYYY-MM-DD, for an event that runs several days. Omit for one day." },
        people: { type: "array", items: { type: "string" }, description: "Team members to tag, by name. Use [\"everyone\"] for the whole team. Optional." }
      },
      required: ["title", "date"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: "Add a meeting or event" }
  },
  {
    name: "list_calendar",
    description: "Show what's on the Projeclab team Calendar: meetings, events and who's off, day by day, with ids. Defaults to the next 14 days from today (Manila).",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "First day, YYYY-MM-DD. Default today." },
        to: { type: "string", description: "Last day, YYYY-MM-DD. Default 13 days after from. At most 92 days." },
        person: { type: "string", description: "Only items this team member is tagged on (and their time off). Optional." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, title: "List calendar" }
  },
  {
    name: "remove_from_calendar",
    description: "Remove a meeting or event from the Projeclab Calendar (like the × in the Calendar tab). This is permanent - there is no Trash for calendar items - so always confirm with the user which one first. Identify it by id (from list_calendar) or by its exact title; add date to tell apart items with the same title.",
    inputSchema: {
      type: "object",
      properties: {
        item: { type: "string", description: "The item's id (e.g. 'm4k2p9xz') or its exact title." },
        date: { type: "string", description: "Its day, YYYY-MM-DD, to narrow a title match. Optional." }
      },
      required: ["item"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, title: "Remove a meeting or event" }
  },
  {
    name: "post_to_feed",
    description: "Post to the Feed tab of the Projeclab app as the studio itself: the post shows 'Projeclab Studios' with the Projeclab logo, not a person. The whole team sees it and gets a bell notification. Before calling this, show the user the exact text (and which photos) and wait for their OK. A post can be text, a quote (set quote_by), or up to 10 photos with an optional caption. Photos are copied into the app's own storage.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The post text or photo caption, up to 2000 characters. For a quote, the quote itself without quote marks. To tag someone, write @ and their full name from list_team (e.g. '@Jay Collins') and also list them in tag." },
        quote_by: { type: "string", description: "Makes the post a quote card: who said it (up to 120 characters). Not allowed with photos." },
        photos: { type: "array", items: { type: "string" }, description: "Up to 10 pictures, each a public https link to a JPG, PNG, WebP or GIF, or a data:image/...;base64,... string. Max 15 MB each." },
        tag: { type: "array", items: { type: "string" }, description: "Team members to tag, by name. They get a 'tagged you' notification. Optional." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, title: "Post to the Feed as Projeclab Studios" }
  },
  {
    name: "list_feed_posts",
    description: "List recent Feed posts made as Projeclab Studios (newest first) with their ids, hearts and comments, so you can check or remove one.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "How many, 1-30. Default 10." } }, additionalProperties: false },
    annotations: { readOnlyHint: true, title: "List studio Feed posts" }
  },
  {
    name: "remove_feed_post",
    description: "Delete a Projeclab Studios post from the Feed, with its hearts and comments. Permanent, so confirm with the user first. Only studio posts can be removed this way; use the id from post_to_feed or list_feed_posts.",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "The post's id." } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, title: "Remove a studio Feed post" }
  }
];

function makeHandler({ store, feed = null, env = {}, slackPost = null, now = () => new Date() }) {
  const siteUrl = String(env.siteUrl || "https://projeclab-alpha-1.vercel.app/").replace(/\/?$/, "/");
  const token = env.token || "";

  const load = async () => {
    const r = await store.get(STORE_KEY);
    if (!r || r.value == null) throw new Error("Projeclab's data couldn't be found.");
    const raw = r.value;
    const db = typeof raw === "string" ? JSON.parse(raw) : raw;
    return { db, at: r.at, wasString: typeof raw === "string" };
  };
  const crewOf = (db) => (db.people || []).filter((p) => p.role !== "client" && !SKIP_NAMES.includes(firstOf(p.name)));
  const actorOf = (db) => {
    const people = db.people || [];
    const want = norm(env.actor || "");
    return (want && people.find((p) => norm(p.email) === want || norm(p.name) === want || firstOf(p.name) === want))
      || people.find((p) => p.role === "lead") || null;
  };
  const slackActivity = async (db, text) => {
    if (!slackPost || (db.slack && db.slack.activity === false)) return;
    try { await slackPost(text); } catch (e) { /* Slack is a nice-to-have */ }
  };

  /* Read, change, write back only if nobody saved in between; retry if they did. */
  const writeDb = async (change) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const { db, at, wasString } = await load();
      const stamp = now().toISOString();
      const res = change(db, stamp);
      if (!res || res.error || !res.next) return res;
      const next = { ...res.next, rev: (db.rev || 0) + 1, savedAt: stamp };
      if (await store.cas(STORE_KEY, wasString ? JSON.stringify(next) : next, at, stamp)) return { ...res, db };
    }
    return { error: "The app was busy saving other changes. Try again in a moment." };
  };
  /* Find one task by id, or by title (exact, then contains), optionally for one person. */
  const findTask = (list, db, query, person) => {
    const q = String(query || "").trim();
    if (!q) return { error: "Say which task." };
    const byId = list.find((t) => t.id === q || t.id === q.replace(/^.*#task=/, ""));
    if (byId) return { row: byId };
    let pool = list;
    if (person) {
      const m = matchOne(crewOf(db), person, "team member");
      if (m.error) return { error: m.error };
      pool = pool.filter((t) => t.personId === m.row.id);
    }
    const nq = norm(q);
    const nameOf = (id) => ((db.people || []).find((p) => p.id === id) || {}).name || "?";
    const line = (t) => `- ${t.text} — ${nameOf(t.personId)}, ${prettyDue(t.due)} [id ${t.id}]`;
    /* Only an exact title (or the id) acts on its own. A partial match is
       offered back as a suggestion - deleting the wrong task is worse than asking. */
    const exact = pool.filter((t) => norm(t.text) === nq);
    if (exact.length === 1) return { row: exact[0] };
    if (exact.length > 1) return { error: `More than one task is called "${q}":\n${exact.slice(0, 10).map(line).join("\n")}\nAsk the user which one, then use its id.` };
    const close = pool.filter((t) => nq && norm(t.text).includes(nq));
    if (close.length) return { error: `No task is called exactly "${q}". Close matches:\n${close.slice(0, 10).map(line).join("\n")}\nConfirm with the user which one, then use its id.` };
    return { error: `No task matches "${q}"${person ? ` for ${person}` : ""}. Use list_open_tasks to see what's there.` };
  };

  /* ---- Calendar helpers: same shapes and rules as the app's Calendar tab ---- */
  const isEvent = (m) => m.kind === "event";
  const calWhen = (m) => `${prettyDay(m.date)}${isEvent(m) && m.to ? ` – ${prettyDay(m.to)}` : ""}${m.time ? ` at ${timeLabel(m.time)}` : " (whole day)"}`;
  const calLine = (db, m) => {
    const crew = crewOf(db);
    const nameOf = (id) => ((db.people || []).find((p) => p.id === id) || {}).name || "?";
    const ppl = m.people && m.people.length
      ? (crew.length > 2 && crew.every((p) => m.people.includes(p.id)) ? "everyone" : m.people.filter((id) => crew.some((p) => p.id === id)).map(nameOf).join(", "))
      : "";
    return `- ${isEvent(m) ? "Event" : "Meeting"}: ${m.title} — ${calWhen(m)}${ppl ? ` — with ${ppl}` : ""} [id ${m.id}]`;
  };

  /* ---- Feed helpers ---- */
  /* One picture in: a public https link or a data: URI. Out: bytes + type. */
  const readPic = async (src, n) => {
    const s = String(src || "").trim();
    const label = `Photo ${n}`;
    const data = /^data:(image\/[a-z+.-]+);base64,([\s\S]+)$/i.exec(s);
    if (data) {
      const type = data[1].toLowerCase().replace("image/jpg", "image/jpeg");
      if (!PIC_TYPES[type]) return { error: `${label} must be JPG, PNG, WebP or GIF.` };
      let bytes;
      try { bytes = Uint8Array.from(atob(data[2].replace(/\s+/g, "")), (c) => c.charCodeAt(0)); } catch (e) { return { error: `${label}: the base64 data is broken.` }; }
      if (bytes.length > PIC_MAX_BYTES) return { error: `${label} is bigger than 15 MB.` };
      return { bytes, type };
    }
    let u;
    try { u = new URL(s); } catch (e) { return { error: `${label} isn't a link or an image.` }; }
    if (u.protocol !== "https:") return { error: `${label} must be an https link.` };
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[)/i.test(u.hostname) || !u.hostname.includes(".")) return { error: `${label}: that address isn't allowed.` };
    if (!feed || !feed.fetch) return { error: "Photo links can't be fetched here." };
    let r;
    try { r = await feed.fetch(u.href); } catch (e) { return { error: `${label} couldn't be downloaded (${e && e.message ? e.message : e}).` }; }
    if (!r || !r.ok) return { error: `${label} couldn't be downloaded (the site answered ${r ? r.status : "nothing"}). Use a direct image link.` };
    const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase().replace("image/jpg", "image/jpeg");
    if (!PIC_TYPES[type]) return { error: `${label} isn't a JPG, PNG, WebP or GIF picture (got "${type || "unknown"}"). Use a direct image link, not a web page.` };
    const len = +(r.headers.get("content-length") || 0);
    if (len > PIC_MAX_BYTES) return { error: `${label} is bigger than 15 MB.` };
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length > PIC_MAX_BYTES) return { error: `${label} is bigger than 15 MB.` };
    return { bytes, type };
  };

  const tools = {
    async delete_task(args) {
      const a = args || {};
      const res = await writeDb((db, stamp) => {
        const f = findTask(db.tasks || [], db, a.task, a.person);
        if (f.error) {
          const gone = (db.trash || []).find((t) => t.id === a.task || norm(t.text) === norm(a.task));
          return { error: gone ? `"${gone.text}" is already in the Trash. ${f.error.startsWith("No task is called") ? f.error.replace(/^No task is called exactly "[^"]*"\. /, "Other open tasks with similar names:\n").replace("Close matches:\n", "") : ""}`.trim() : f.error };
        }
        const t = f.row;
        const actor = actorOf(db);
        const row = { ...t, trashedAt: stamp, trashedBy: actor ? actor.id : "system" };
        const owner = ((db.people || []).find((p) => p.id === t.personId) || {}).name || "?";
        return {
          next: { ...db, tasks: (db.tasks || []).filter((x) => x.id !== t.id), trash: [...(db.trash || []).filter((x) => x.id !== t.id), row] },
          msg: `Moved "${t.text}" (${owner}) to the Trash. It can be restored for 30 days — in the app under Archive → Trash, or ask me to restore it. [id ${t.id}]`
        };
      });
      return res && res.msg ? res.msg : res;
    },

    async restore_task(args) {
      const a = args || {};
      const res = await writeDb((db) => {
        const f = findTask(db.trash || [], db, a.task, null);
        if (f.error) return { error: f.error.replace("Use list_open_tasks to see what's there.", "It isn't in the Trash.") };
        const { trashedAt, trashedBy, ...rest } = f.row;
        const tasks = (db.tasks || []).some((x) => x.id === rest.id) ? db.tasks : [...(db.tasks || []), rest];
        return { next: { ...db, trash: (db.trash || []).filter((x) => x.id !== rest.id), tasks }, msg: `Restored "${rest.text}". It's back in the app. [id ${rest.id}]` };
      });
      return res && res.msg ? res.msg : res;
    },

    async list_team() {
      const { db } = await load();
      const n = manilaNow(now());
      const crew = crewOf(db).map((p) => `- ${p.name} (${p.role})`).join("\n");
      const clients = (db.clients || []).map((c) => `- ${c.name}`).join("\n") || "- (none)";
      return `Today in Manila: ${n.weekday} ${n.date}, ${n.time}.\n\nTeam:\n${crew}\n\nClients:\n${clients}`;
    },

    async list_open_tasks(args) {
      const { db } = await load();
      const crew = crewOf(db);
      let who = null;
      if (args && args.person) {
        const m = matchOne(crew, args.person, "team member");
        if (m.error) return { error: m.error };
        who = m.row;
      }
      const nameOf = (id) => (db.people.find((p) => p.id === id) || {}).name || "?";
      const open = (db.tasks || []).filter((t) => !t.done && (!who || t.personId === who.id))
        .sort((a, b) => String(a.due || "9999").localeCompare(String(b.due || "9999")));
      if (!open.length) return who ? `${who.name} has no open tasks.` : "No open tasks.";
      return open.slice(0, 60).map((t) => `- ${t.text} — ${nameOf(t.personId)}, ${prettyDue(t.due)} [id ${t.id}]`).join("\n") + (open.length > 60 ? `\n…and ${open.length - 60} more.` : "");
    },

    async create_task(args) {
      const a = args || {};
      const title = String(a.title || "").trim();
      if (!title) return { error: "The task needs a title." };
      if (a.due_date && !DATE_RE.test(a.due_date)) return { error: "due_date must look like 2026-10-22." };
      if (a.due_time && !TIME_RE.test(a.due_time)) return { error: "due_time must be 24-hour HH:MM, like 17:00." };
      if (a.due_time && !a.due_date) return { error: "A due_time needs a due_date too." };
      const kind = a.type || "video";
      if (!TASK_KINDS.includes(kind)) return { error: `type must be one of: ${TASK_KINDS.join(", ")}.` };
      const repeat = a.repeat || "none";
      if (!REPEATS.includes(repeat)) return { error: `repeat must be one of: ${REPEATS.join(", ")}.` };
      if (a.due_date) {
        const today = manilaNow(now()).date;
        if (a.due_date < today) return { error: `${a.due_date} is in the past (today in Manila is ${today}). Check the date with the user.` };
      }

      for (let attempt = 0; attempt < 8; attempt++) {
        const { db, at, wasString } = await load();
        const crew = crewOf(db);
        const m = matchOne(crew, a.assignee, "team member");
        if (m.error) return { error: m.error };
        const person = m.row;
        let client = null;
        if (a.client) {
          const c = matchOne(db.clients || [], a.client, "client");
          if (c.error) return { error: c.error };
          client = c.row;
        }
        const helpers = [];
        for (const h of a.assist || []) {
          const hm = matchOne(crew, h, "team member");
          if (hm.error) return { error: hm.error };
          if (hm.row.id !== person.id && !helpers.includes(hm.row.id)) helpers.push(hm.row.id);
        }
        const actor = actorOf(db);
        const by = actor ? actor.id : "system";
        const stamp = now().toISOString();
        const due = a.due_date ? (a.due_time ? `${a.due_date}T${a.due_time}` : a.due_date) : null;
        const task = {
          id: uid("t"),
          personId: person.id,
          text: title.slice(0, 300),
          kind,
          clientId: client ? client.id : null,
          details: String(a.brief || "").trim().slice(0, DETAIL_MAX),
          photos: [],
          due,
          done: false,
          doneAt: null,
          status: "todo",
          by,
          home: person.id,
          repeat,
          at: stamp,
          link: "",
          deliverable: "",
          notes: "",
          reviewFrom: null,
          qaFrom: null,
          steps: kind === "video" ? VIDEO_CHECKS.map((x) => ({ text: x, done: false })) : [],
          ...(helpers.length ? { helpers } : {}),
          history: [{ at: stamp, by, text: `Assigned to ${person.name} (via Claude)` }]
        };
        const next = { ...db, tasks: [...(db.tasks || []), task], rev: (db.rev || 0) + 1, savedAt: stamp };
        const value = wasString ? JSON.stringify(next) : next;
        const ok = await store.cas(STORE_KEY, value, at, stamp);
        if (!ok) continue; /* someone saved at the same moment: re-read and try again */

        const link = `${siteUrl}#task=${task.id}`;
        const who = actor ? actor.name : "Claude";
        const line = person.id === by ? "added a task to their own list" : `assigned a new task to ${person.name}`;
        await slackActivity(db, `*${who}* — ${line} (via Claude)\n_${task.text}_${client ? ` · ${client.name}` : ""} · <${link}|Open task>`);
        const extras = [
          `type ${KIND_LABEL[kind]}`,
          client ? `client ${client.name}` : null,
          helpers.length ? `assist: ${helpers.map((id) => crew.find((p) => p.id === id).name).join(", ")}` : null,
          repeat !== "none" ? `repeats ${repeat}` : null
        ].filter(Boolean).join(", ");
        return `Created "${task.text}" for ${person.name}, ${due ? `due ${prettyDue(due)}` : "no due date"} (${extras}). It's in the app now.\nLink: ${link}`;
      }
      return { error: "The app was busy saving other changes. Try again in a moment." };
    },

    async add_to_calendar(args) {
      const a = args || {};
      const title = String(a.title || "").trim().slice(0, 200);
      if (!title) return { error: "The calendar item needs a title." };
      const kind = a.kind || "meeting";
      if (!CAL_KINDS.includes(kind)) return { error: `kind must be one of: ${CAL_KINDS.join(", ")}.` };
      const ev = kind === "event";
      if (!DATE_RE.test(a.date || "")) return { error: "date must look like 2026-10-31." };
      if (a.time && !TIME_RE.test(a.time)) return { error: "time must be 24-hour HH:MM, like 10:00. Leave it out for a whole-day item." };
      if (a.end_date && !DATE_RE.test(a.end_date)) return { error: "end_date must look like 2026-11-02." };
      if (a.end_date && !ev && a.end_date !== a.date) return { error: "Only events can run several days. Use kind 'event', or leave end_date out." };
      if (a.end_date && a.end_date < a.date) return { error: "end_date is before date. Check the dates with the user." };
      const today = manilaNow(now()).date;
      if ((a.end_date || a.date) < today) return { error: `${a.date} is in the past (today in Manila is ${today}). Check the date with the user.` };

      let added = null, named = [];
      const res = await writeDb((db, stamp) => {
        const crew = crewOf(db);
        const people = [];
        for (const w of a.people || []) {
          /* "Everyone" tags the same people as the app's Everyone chip (all non-clients). */
          if (["everyone", "all", "wholeteam", "team"].includes(norm(w))) { (db.people || []).filter((p) => p.role !== "client").forEach((p) => people.includes(p.id) || people.push(p.id)); continue; }
          const m = matchOne(crew, w, "team member");
          if (m.error) return { error: m.error };
          if (!people.includes(m.row.id)) people.push(m.row.id);
        }
        const actor = actorOf(db);
        const by = actor ? actor.id : "system";
        const to = ev && a.end_date && a.end_date > a.date ? a.end_date : "";
        const item = { id: uid(ev ? "e" : "m"), kind, date: a.date, ...(to ? { to } : {}), time: a.time || "", title, people, by, at: stamp, via: "claude" };
        added = item;
        named = crew.filter((p) => people.includes(p.id) && p.id !== by).map((p) => p.name);
        return { next: { ...db, meetings: [...(db.meetings || []), item] } };
      });
      if (!res || res.error) return res;
      const db = res.db;
      const actor = actorOf(db);
      const who = actor ? actor.name : "Claude";
      const when = calWhen(added);
      if (named.length) await slackActivity(db, `${ev ? "🎉" : "📅"} *${who}* put ${named.join(" and ")} on ${ev ? "an event" : "a meeting"} — ${title} (via Claude)\n${when}`);
      else if (ev) await slackActivity(db, `🎉 *${who}* added an event — ${title} (via Claude)\n${when}`);
      return `Added ${ev ? "event" : "meeting"} "${title}" — ${when}${named.length ? `, with ${named.join(", ")} (they're notified in the app)` : ""}. It's on the Calendar now. [id ${added.id}]`;
    },

    async list_calendar(args) {
      const a = args || {};
      const today = manilaNow(now()).date;
      const from = a.from || today;
      if (!DATE_RE.test(from)) return { error: "from must look like 2026-10-24." };
      const to = a.to || addDays(from, 13);
      if (!DATE_RE.test(to)) return { error: "to must look like 2026-11-06." };
      if (to < from) return { error: "to is before from." };
      if (to > addDays(from, 91)) return { error: "That's more than 92 days. Ask for a shorter range." };
      const { db } = await load();
      const crew = crewOf(db);
      let who = null;
      if (a.person) {
        const m = matchOne(crew, a.person, "team member");
        if (m.error) return { error: m.error };
        who = m.row;
      }
      const items = (db.meetings || [])
        .filter((m) => m.date <= to && ((isEvent(m) && m.to) || m.date) >= from)
        .filter((m) => !who || (m.people || []).includes(who.id))
        .sort((x, y) => x.date.localeCompare(y.date) || (x.time || "").localeCompare(y.time || ""));
      const offs = [];
      crew.filter((p) => !who || p.id === who.id).forEach((p) => (p.away || []).forEach((w) => {
        if (w.from <= to && w.to >= from) offs.push(`- ${p.name} off ${prettyDay(w.from)}${w.to !== w.from ? ` – ${prettyDay(w.to)}` : ""}${w.note ? ` (${w.note})` : ""}`);
      }));
      const head = `Calendar ${prettyDay(from)} – ${prettyDay(to)}${who ? ` for ${who.name}` : ""}:`;
      const body = items.length ? items.map((m) => calLine(db, m)).join("\n") : "- No meetings or events.";
      return `${head}\n${body}\n\nTime off:\n${offs.length ? offs.join("\n") : "- Nobody's off."}`;
    },

    async remove_from_calendar(args) {
      const a = args || {};
      const q = String(a.item || "").trim();
      if (!q) return { error: "Say which meeting or event." };
      if (a.date && !DATE_RE.test(a.date)) return { error: "date must look like 2026-10-31." };
      const res = await writeDb((db) => {
        const list = db.meetings || [];
        let hit = list.find((m) => m.id === q);
        if (!hit) {
          const nq = norm(q);
          const pool = list.filter((m) => !a.date || m.date === a.date || (isEvent(m) && m.to && m.date <= a.date && a.date <= m.to));
          const exact = pool.filter((m) => norm(m.title) === nq);
          if (exact.length > 1) return { error: `More than one item is called "${q}":\n${exact.slice(0, 10).map((m) => calLine(db, m)).join("\n")}\nAsk the user which one, then use its id.` };
          if (exact.length === 1) hit = exact[0];
          else {
            const close = pool.filter((m) => nq && norm(m.title).includes(nq));
            if (close.length) return { error: `Nothing is called exactly "${q}". Close matches:\n${close.slice(0, 10).map((m) => calLine(db, m)).join("\n")}\nConfirm with the user which one, then use its id.` };
            return { error: `Nothing on the Calendar matches "${q}"${a.date ? ` on ${a.date}` : ""}. Use list_calendar to see what's there.` };
          }
        }
        return { next: { ...db, meetings: list.filter((m) => m.id !== hit.id) }, msg: `Removed ${isEvent(hit) ? "event" : "meeting"} "${hit.title}" (${calWhen(hit)}) from the Calendar.` };
      });
      return res && res.msg ? res.msg : res;
    },

    async post_to_feed(args) {
      if (!feed) return { error: "The Feed isn't connected here." };
      const a = args || {};
      let text = String(a.text || "").trim();
      const quoteBy = String(a.quote_by || "").trim();
      const pics = Array.isArray(a.photos) ? a.photos.filter((x) => String(x || "").trim()) : [];
      if (!text && !pics.length) return { error: "A post needs text or at least one photo." };
      if (quoteBy && pics.length) return { error: "A quote can't have photos. Post them separately, or leave quote_by out." };
      if (quoteBy && !text) return { error: "A quote needs the quote itself in text." };
      if (quoteBy.length > 120) return { error: "quote_by is too long (120 characters max)." };
      if (pics.length > FEED_MAX_PICS) return { error: `At most ${FEED_MAX_PICS} photos per post.` };

      /* Tags: match names against the team, and make sure "@Full Name" is in the
         text, because that's what the app highlights. */
      const { db } = await load();
      const crew = crewOf(db);
      const tags = [];
      for (const w of Array.isArray(a.tag) ? a.tag : []) {
        const m = matchOne(crew, w, "team member");
        if (m.error) return { error: m.error };
        if (!tags.includes(m.row.id)) tags.push(m.row.id);
      }
      for (const id of tags) {
        const name = crew.find((p) => p.id === id).name;
        if (!text.toLowerCase().includes("@" + name.toLowerCase())) text = `${text}${text ? " " : ""}@${name}`;
      }
      if (text.length > 2000) return { error: `The text is ${text.length} characters; the Feed allows 2000.` };

      /* Check every photo before uploading any, so a bad link posts nothing. */
      const got = [];
      for (let i = 0; i < pics.length; i++) {
        const r = await readPic(pics[i], i + 1);
        if (r.error) return { error: r.error };
        got.push(r);
      }
      const urls = [];
      for (const p of got) urls.push(await feed.upload(p.bytes, p.type, PIC_TYPES[p.type]));

      const kind = quoteBy ? "quote" : urls.length ? "photo" : "text";
      const row = { person_id: STUDIO, author: null, kind, body: text, quote_by: quoteBy || null, photo_url: urls[0] || null, photos: urls, tags };
      const id = await feed.insert(row);
      const what = kind === "quote" ? "a quote" : kind === "photo" ? `${urls.length > 1 ? urls.length + " photos" : "a photo"}${text ? " with a caption" : ""}` : "";
      const tagged = tags.length ? ` Tagged: ${tags.map((t) => crew.find((p) => p.id === t).name).join(", ")}.` : "";
      return `Posted ${what ? what + " " : ""}to the Feed as Projeclab Studios. The team sees it now.${tagged}\nOpen: ${siteUrl} → Feed [id ${id}]`;
    },

    async list_feed_posts(args) {
      if (!feed) return { error: "The Feed isn't connected here." };
      const lim = Math.max(1, Math.min(30, Math.round(+((args || {}).limit) || 10)));
      const rows = await feed.list(lim);
      if (!rows.length) return "Projeclab Studios hasn't posted on the Feed yet.";
      return rows.map((p) => {
        const n = Array.isArray(p.photos) ? p.photos.length : 0;
        const body = p.kind === "quote" ? `“${p.body}” — ${p.quote_by || ""}` : p.body || "";
        const short = body.length > 90 ? body.slice(0, 90) + "…" : body;
        return `- ${manilaStamp(p.created_at)} · ${p.kind}${n ? ` (${n} photo${n > 1 ? "s" : ""})` : ""}: ${short || "(no caption)"} · ${p.hearts || 0} hearts, ${p.comments || 0} comments [id ${p.id}]`;
      }).join("\n");
    },

    async remove_feed_post(args) {
      if (!feed) return { error: "The Feed isn't connected here." };
      const id = String((args || {}).id || "").trim();
      if (!/^[0-9a-f-]{36}$/i.test(id)) return { error: "Give the post's id (from list_feed_posts)." };
      const gone = await feed.remove(id);
      if (gone === "notstudio") return { error: "That post was made by a teammate, not Projeclab Studios. Only studio posts can be removed from here; the Lead or HR can delete others in the app." };
      if (!gone) return { error: "No Feed post has that id. Use list_feed_posts to see the studio's posts." };
      return `Removed the Projeclab Studios post (${gone.kind}: ${String(gone.body || "").slice(0, 60) || "photos"}) from the Feed, with its hearts and comments.`;
    }
  };

  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
  const rpcErr = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

  const handleOne = async (msg, ok, authNote = "") => {
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcErr(msg && msg.id, -32600, "Invalid request");
    const { id, method, params } = msg;
    const isNote = id === undefined || id === null;
    if (method === "initialize") {
      const want = params && params.protocolVersion;
      return {
        jsonrpc: "2.0", id, result: {
          protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "projeclab", title: "Projeclab Studios", version: "1.2.0" },
          instructions: "Works with tasks, the team Calendar (meetings and events) and the Feed in the Projeclab Studios team app. Times are Manila time. Match people by the names from list_team; if a name is unclear or matches nobody, ask the user. Feed posts made here appear as Projeclab Studios, not as a person: show the user the exact post first and only post after they say OK. Confirm before deleting or removing anything. Confirm what you did in one short line."
        }
      };
    }
    if (isNote) return null; /* notifications/initialized and friends need no reply */
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    if (method === "tools/call") {
      const name = params && params.name;
      /* Connecting and listing tools is open (nothing private in it); doing
         anything with Projeclab's data needs the key. */
      if (!ok) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Not authorised: the Projeclab key is missing or wrong (${authNote}). The connector URL must end with ?key=... matching PROJECLAB_MCP_KEY in Supabase.` }], isError: true } };
      if (!tools[name]) return rpcErr(id, -32602, `Unknown tool: ${name}`);
      try {
        const out = await tools[name]((params && params.arguments) || {});
        if (out && out.error) return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out.error }], isError: true } };
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: String(out) }] } };
      } catch (e) {
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Something went wrong: ${e && e.message ? e.message : e}` }], isError: true } };
      }
    }
    if (method === "resources/list") return { jsonrpc: "2.0", id, result: { resources: [] } };
    if (method === "prompts/list") return { jsonrpc: "2.0", id, result: { prompts: [] } };
    return rpcErr(id, -32601, `Method not found: ${method}`);
  };

  /* The key can arrive several ways: ?key= on the URL, an Authorization:
     Bearer header, an x-api-key header, or the last part of the path. Claude
     may send its own Authorization header too, so every candidate is tried. */
  const keyCandidates = (req) => {
    const out = [];
    const h = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (h) out.push(["header", h]);
    const x = (req.headers.get("x-api-key") || "").trim();
    if (x) out.push(["x-api-key", x]);
    try {
      const u = new URL(req.url);
      const q = (u.searchParams.get("key") || "").trim();
      if (q) out.push(["url", q]);
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "").trim();
      if (last && last.length >= 16 && !/projeclab/i.test(last)) out.push(["path", last]);
    } catch (e) { /* ignore */ }
    return out;
  };
  const same = (a, b) => {
    if (!a || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };
  const authCheck = (req) => {
    const want = String(token || "").trim();
    const cands = keyCandidates(req);
    const hit = want ? cands.find(([, v]) => same(v, want)) : null;
    /* Lengths only - never the key itself - so the logs can show what's off. */
    const note = `secret:${want ? want.length + " chars" : "NOT SET"} given:${cands.map(([w, v]) => `${w}(${v.length})`).join(",") || "none"}`;
    return { ok: !!hit, via: hit ? hit[0] : "", note };
  };


  return async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "access-control-allow-methods": "POST, GET, DELETE, OPTIONS" } });
    const auth = authCheck(req);
    const ok = auth.ok;
    try { console.log(`[projeclab-mcp] ${req.method} ${new URL(req.url).pathname} key:${ok ? "ok via " + auth.via : "NO"} ${auth.note}`); } catch (e) { /* logging only */ }
    if (req.method === "GET") return new Response("Projeclab connector: POST MCP requests here.", { status: 405, headers: { allow: "POST" } });
    if (req.method === "DELETE") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    let body;
    try { body = await req.json(); } catch (e) { return json(rpcErr(null, -32700, "Parse error"), 400); }
    if (Array.isArray(body)) {
      const outs = (await Promise.all(body.map((m) => handleOne(m, ok, auth.note)))).filter(Boolean);
      return outs.length ? json(outs) : new Response(null, { status: 202 });
    }
    try { console.log(`[projeclab-mcp] rpc ${body && body.method}${body && body.params && body.params.name ? " " + body.params.name : ""}`); } catch (e) { /* logging only */ }
    const out = await handleOne(body, ok, auth.note);
    return out ? json(out) : new Response(null, { status: 202 });
  };
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const store = {
  // Same row the app reads: app_state where key = "cutline-state-v2".
  get: async (key: string) => {
    const { data, error } = await sb.from("app_state").select("value, updated_at").eq("key", key).maybeSingle();
    if (error) throw error;
    return data ? { value: data.value, at: data.updated_at } : null;
  },
  // Write only if nobody saved since we read - exactly how the app saves.
  cas: async (key: string, value: unknown, expectAt: string, stamp: string) => {
    const { data, error } = await sb.from("app_state")
      .update({ value, updated_at: stamp })
      .eq("key", key).eq("updated_at", expectAt).select("key");
    if (error) throw error;
    return !!(data && data.length);
  },
};

// Feed: its own tables (not app_state). Photos go to the task-photos bucket
// like every other picture in the app.
const feed = {
  fetch: (url: string) => fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Projeclab feed)", accept: "image/*" }, signal: AbortSignal.timeout(20000) }),
  upload: async (bytes: Uint8Array, type: string, ext: string) => {
    const path = `feed/${new Date().toISOString().slice(0, 10)}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
    const { error } = await sb.storage.from("task-photos").upload(path, bytes, { contentType: type, cacheControl: "31536000", upsert: false });
    if (error) throw new Error("A photo wouldn't upload: " + error.message);
    return sb.storage.from("task-photos").getPublicUrl(path).data.publicUrl;
  },
  insert: async (row: Record<string, unknown>) => {
    const { data, error } = await sb.from("feed_posts").insert(row).select("id").single();
    if (error) throw new Error("The post didn't save: " + error.message);
    return data.id;
  },
  list: async (limit: number) => {
    const { data, error } = await sb.from("feed_posts").select("id, kind, body, quote_by, photos, created_at").eq("person_id", "studio").order("created_at", { ascending: false }).limit(limit);
    if (error) throw error;
    const ids = (data || []).map((p) => p.id);
    if (!ids.length) return [];
    const [h, c] = await Promise.all([
      sb.from("feed_hearts").select("post_id").in("post_id", ids),
      sb.from("feed_comments").select("post_id").in("post_id", ids),
    ]);
    const count = (rows, id) => (rows || []).filter((r) => r.post_id === id).length;
    return data.map((p) => ({ ...p, hearts: count(h.data, p.id), comments: count(c.data, p.id) }));
  },
  remove: async (id: string) => {
    const { data, error } = await sb.from("feed_posts").select("id, person_id, kind, body").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    if (data.person_id !== "studio") return "notstudio";
    const del = await sb.from("feed_posts").delete().eq("id", id).eq("person_id", "studio");
    if (del.error) throw del.error;
    return data;
  },
};

// Reuses your existing "slack" function, so the webhook stays where it is.
const slackPost = async (text: string) => {
  await fetch(`${SUPABASE_URL}/functions/v1/slack`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify({ text: text.slice(0, 500) }),
  });
};

const handler = makeHandler({
  store,
  feed,
  slackPost,
  env: {
    token: Deno.env.get("PROJECLAB_MCP_KEY") ?? "",
    actor: Deno.env.get("PROJECLAB_ACTOR") ?? "",
    siteUrl: Deno.env.get("PROJECLAB_SITE_URL") ?? "",
  },
});

Deno.serve(handler);
