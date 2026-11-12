// creative-news: collects creative news for the Projeclab Feed tab.
// Reads public RSS/Atom feeds (video editing, graphic design, branding, AI tools),
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
  { topic: "video", source: "ProVideo Coalition", url: "https://www.provideocoalition.com/feed/" },
  { topic: "video", source: "Larry Jordan", url: "https://larryjordan.com/feed/" },
  // Graphic design
  { topic: "design", source: "Creative Bloq", url: "https://www.creativebloq.com/feeds/all" },
  { topic: "design", source: "Creative Boom", url: "https://www.creativeboom.com/feed/" },
  { topic: "design", source: "Abduzeedo", url: "https://abduzeedo.com/rss.xml" },
  { topic: "design", source: "Dezeen", url: "https://www.dezeen.com/design/feed/" },
  // Branding
  { topic: "brand", source: "BP&O", url: "https://bpando.org/feed/" },
  { topic: "brand", source: "Identity Designed", url: "https://identitydesigned.com/feed/" },
  // AI tools
  { topic: "ai", source: "The Verge", url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml" },
  { topic: "ai", source: "TechCrunch", url: "https://techcrunch.com/category/artificial-intelligence/feed/" },
  { topic: "ai", source: "VentureBeat", url: "https://venturebeat.com/category/ai/feed/" },
];
const PER_SOURCE = 12;

// Only creative value: no gossip, business drama, politics or shopping deals.
const BLOCK = /\b(scandal|affair|spy|spies|lawsuits?|sues?|sued|suing|court|judge|fired|fires|firing|resign\w*|ceo|ceos|layoffs?|laid off|stocks?|shares|shareholders?|earnings|revenue|valuation|funding|raises|investors?|acquir\w*|acquisition|merger|ipo|antitrust|congress|senate|lawmakers?|trump|biden|election\w*|politic\w*|tariffs?|government|regulat\w*|banned|ban|deals?|discount\w*|sale|black friday|cyber monday|cheapest|price drop|rumou?rs?|reportedly|allegations?|alleged\w*|controvers\w*|backlash|outrage|drama|feud|leaks?|leaked|arrest\w*|police|crime|criminal|dies|died|death|killed|war|military|nvidia|jensen|musk|openai'?s? board|xai)\b|£\d|\$\d[\d,.]*\s*(off|billion|million)|\d+% off/i;
// Fluff, judged on the headline only: product reviews, gadgets, celebrity lists.
const FLUFF = /\b(reviews?|reviewed|vs|versus|quote of the day|roles|villains?|heroes|celebrit\w*|actors?|actress|box office|exploitation|con artists?|nostalgia|zelda|nintendo|playstation|xbox|gaming|watch|smartwatch|chair|desk|headphones|earbuds|laptop|gift guide|gifts?)\b|^the best |^\d+ (times|movies|films|roles|actors|shows)\b/i;
// AI stories only when they are about creative work and tools.
const AI_ALLOW = /\b(adobe|firefly|photoshop|premiere|after effects|illustrator|lightroom|canva|figma|davinci|resolve|capcut|runway|midjourney|sora|veo|kling|pika|luma|flux|stable diffusion|dall-?e|imagen|image|images|video|videos|design\w*|creative\w*|creators?|edit\w*|animat\w*|3d|art|artists?|photo\w*|music|voice|font|typograph\w*|brand\w*|film\w*|motion|vfx|prompt\w*|tutorial|how to|workflow)\b/i;
// Design stories about identities and logos go under Branding.
const BRANDY = /\b(brand\w*|rebrand\w*|identity|identities|logo\w*|wordmark|visual system)\b/i;
const keep = (topic: string, title: string, summary: string | null) => {
  const text = title + " " + (summary || "");
  if (BLOCK.test(text) || FLUFF.test(title)) return false;
  if (topic === "ai" && !AI_ALLOW.test(title)) return false;
  return true;
};
const UA = "Mozilla/5.0 (ProjeclabFeed; +https://projeclab-alpha-1.vercel.app)";
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

// The article's own "share image" (what Facebook shows), for feeds that don't send a picture.
async function ogImage(url: string): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "text/html" } });
    clearTimeout(timer);
    if (!r.ok || !r.body) return null;
    // Only the <head> matters: read at most ~250 KB.
    const reader = r.body.getReader();
    let html = "";
    const dec = new TextDecoder();
    while (html.length < 250000) {
      const { value, done } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    try { reader.cancel(); } catch (_) { /* fine */ }
    const metas = html.match(/<meta\b[^>]*>/gi) || [];
    for (const want of ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]) {
      for (const m of metas) {
        const key = (m.match(/\b(?:property|name)=["']([^"']+)["']/i) || [])[1];
        if (key && key.toLowerCase() === want) {
          const c = (m.match(/\bcontent=["']([^"']+)["']/i) || [])[1];
          if (c) { const u = decode(c.trim()); const abs = new URL(u, url).href; if (/^https:\/\//.test(abs)) return abs; }
        }
      }
    }
  } catch (_) { /* no picture */ }
  return null;
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
      const r = await fetch(s.url, { signal: ctl.signal, headers: { "User-Agent": UA, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
      clearTimeout(timer);
      if (!r.ok) { report[s.source] = "HTTP " + r.status; return; }
      const items = parse(await r.text()).filter((it) => keep(s.topic, it.title, it.summary)).slice(0, PER_SOURCE);
      await Promise.all(items.filter((it) => !it.image).map(async (it) => { it.image = await ogImage(it.link); }));
      for (const it of items) rows.push({ id: await sha1(it.link), topic: s.topic === "design" && BRANDY.test(it.title) ? "brand" : s.topic, source: s.source, ...it, published_at: it.published_at || now, fetched_at: now });
      report[s.source] = items.length;
    } catch (e) {
      report[s.source] = "error: " + String((e as Error).message || e).slice(0, 80);
    }
  }));

  if (rows.length) {
    const { error } = await db.from("feed_news").upsert(rows, { onConflict: "id" });
    if (error) return json({ ok: false, error: error.message, report });
  }
  const { data: all } = await db.from("feed_news").select("id, topic, title, summary");
  const drop = (all || []).filter((x) => !keep(x.topic, x.title, x.summary)).map((x) => x.id);
  if (drop.length) await db.from("feed_news").delete().in("id", drop);
  report.removed = drop.length;
  const toBrand = (all || []).filter((x) => x.topic === "design" && BRANDY.test(x.title) && !drop.includes(x.id)).map((x) => x.id);
  if (toBrand.length) await db.from("feed_news").update({ topic: "brand" }).in("id", toBrand);
  await db.from("feed_news").delete().lt("published_at", new Date(Date.now() - KEEP_DAYS * 864e5).toISOString());
  return json({ ok: true, saved: rows.length, report });
});
