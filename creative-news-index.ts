// creative-news: collects creative news for the Projeclab Feed tab.
// Reads public RSS/Atom feeds (video editing, graphic design, AI tools),
// keeps the newest articles in the feed_news table. The app calls this when
// someone opens the Feed; it only goes out to the sites every 3 hours.
// Writes with the service-role key that Supabase gives every Edge Function
// automatically (nothing to paste, nothing secret in the app).
import { createClient } from "jsr:@supabase/supabase-js@2";

const SOURCES: { topic: string; source: string; url: string }[] = [
  // Video editing
  { topic: "video", source: "No Film School", url: "https://nofilmschool.com/rss.xml" },
  { topic: "video", source: "PremiumBeat", url: "https://www.premiumbeat.com/blog/feed/" },
  { topic: "video", source: "Frame.io Insider", url: "https://blog.frame.io/feed/" },
  { topic: "video", source: "Motionographer", url: "https://motionographer.com/feed/" },
  { topic: "video", source: "Videomaker", url: "https://www.videomaker.com/feed/" },
  // Graphic design
  { topic: "design", source: "Creative Bloq", url: "https://www.creativebloq.com/feeds/all" },
  { topic: "design", source: "Creative Boom", url: "https://www.creativeboom.com/feed/" },
  { topic: "design", source: "Abduzeedo", url: "https://abduzeedo.com/rss.xml" },
  { topic: "design", source: "Dezeen", url: "https://www.dezeen.com/design/feed/" },
  // AI tools
  { topic: "ai", source: "The Verge", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { topic: "ai", source: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { topic: "ai", source: "VentureBeat", url: "https://venturebeat.com/category/ai/feed/" },
];
const PER_SOURCE = 12;
const EVERY_MS = 3 * 60 * 60 * 1000;
const KEEP_DAYS = 60;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
const decode = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const uncdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? uncdata(m[1]).trim() : "";
};
const attr = (xml: string, name: string, a: string) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${a}=["']([^"']+)["']`, "i"));
  return m ? decode(m[1]) : "";
};
const plain = (html: string) => decode(decode(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

function parse(xml: string) {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  return blocks.map((b) => {
    const title = plain(tag(b, "title"));
    let link = decode(tag(b, "link"));
    if (!/^https?:/.test(link)) link = attr(b, 'link[^>]*rel=["\']alternate["\']', "href") || attr(b, "link", "href");
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const content = tag(b, "content:encoded") || tag(b, "content") || "";
    const desc = tag(b, "description") || tag(b, "summary") || content;
    let image = attr(b, "media:content", "url") || attr(b, "media:thumbnail", "url") ||
      (/<enclosure[^>]+type=["']image/i.test(b) ? attr(b, "enclosure", "url") : "");
    if (!image) {
      const im = decode(content + " " + desc).match(/<img[^>]+src=["']([^"']+)["']/i);
      if (im) image = im[1];
    }
    const t = date ? Date.parse(date) : NaN;
    return {
      title: title.slice(0, 300),
      link: link.trim(),
      image: /^https:\/\//.test(image) ? image : null,
      summary: plain(desc).slice(0, 280) || null,
      published_at: isNaN(t) ? null : new Date(t).toISOString(),
    };
  }).filter((x) => x.title && /^https?:\/\//.test(x.link));
}

async function sha1(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { ...cors, "Content-Type": "application/json" } });
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  let force = false;
  try { force = !!(await req.json()).force; } catch (_) { /* no body */ }

  const { data: last } = await db.from("feed_news").select("fetched_at").order("fetched_at", { ascending: false }).limit(1);
  // "force" (refresh now) still waits at least 10 minutes between runs.
  const age = last && last[0] ? Date.now() - Date.parse(last[0].fetched_at) : Infinity;
  if (age < (force ? 10 * 60 * 1000 : EVERY_MS)) {
    return json({ skipped: true, last: last![0].fetched_at });
  }

  const now = new Date().toISOString();
  const report: Record<string, string | number> = {};
  const rows: Record<string, unknown>[] = [];
  await Promise.all(SOURCES.map(async (s) => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 12000);
      const r = await fetch(s.url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (ProjeclabFeed; +https://projeclab-alpha-1.vercel.app)", "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
      clearTimeout(timer);
      if (!r.ok) { report[s.source] = "HTTP " + r.status; return; }
      const items = parse(await r.text()).slice(0, PER_SOURCE);
      for (const it of items) rows.push({ id: await sha1(it.link), topic: s.topic, source: s.source, ...it, published_at: it.published_at || now, fetched_at: now });
      report[s.source] = items.length;
    } catch (e) {
      report[s.source] = "error: " + String((e as Error).message || e).slice(0, 80);
    }
  }));

  if (rows.length) {
    const { error } = await db.from("feed_news").upsert(rows, { onConflict: "id" });
    if (error) return json({ ok: false, error: error.message, report });
  }
  await db.from("feed_news").delete().lt("published_at", new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  return json({ ok: true, saved: rows.length, report });
});
