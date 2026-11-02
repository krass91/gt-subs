/**
 * Преведени субтитри – Cloudflare Worker версия.
 * Същата логика като src/server.js, но за Cloudflare (fetch handler).
 * Деплой: https://deploy.workers.cloudflare.com/?url=https://github.com/krass91/gt-subs
 *         или ръчно през dashboard: Workers & Pages -> Create Worker -> pastе кода.
 */
"use strict";

/* ------------------------------------------------------------------ *
 * Езици: [код за Stremio, код за Google, код на SubCat, име]
 * ------------------------------------------------------------------ */
const LANGS = [
  ["bul", "bg", "bg", "български"],
  ["mkd", "mk", "mk", "македонски"],
  ["srp", "sr", "sr", "сръбски"],
  ["hrv", "hr", "hr", "хърватски"],
  ["slv", "sl", "sl", "словенски"],
  ["ron", "ro", "ro", "румънски"],
  ["tur", "tr", "tr", "турски"],
  ["rus", "ru", "ru", "руски"],
  ["ukr", "uk", "uk", "украински"],
  ["pol", "pl", "pl", "полски"],
  ["ces", "cs", "cs", "чешки"],
  ["slk", "sk", "sk", "словашки"],
  ["hun", "hu", "hu", "унгарски"],
  ["deu", "de", "de", "немски"],
  ["nld", "nl", "nl", "нидерландски"],
  ["fra", "fr", "fr", "френски"],
  ["spa", "es", "es", "испански"],
  ["por", "pt", "pt", "португалски"],
  ["ita", "it", "it", "италиански"],
  ["ell", "el", "el", "гръцки"],
  ["ara", "ar", "ar", "арабски"],
  ["heb", "he", "he", "иврит"],
  ["fas", "fa", "fa", "персийски"],
  ["hin", "hi", "hi", "хинди"],
  ["ben", "bn", "bn", "бенгали"],
  ["zho", "zh-CN", "zh", "китайски"],
  ["jpn", "ja", "ja", "японски"],
  ["kor", "ko", "ko", "корейски"],
  ["vie", "vi", "vi", "виетнамски"],
  ["ind", "id", "id", "индонезийски"],
  ["tha", "th", "th", "тайски"],
];
const BY_CODE3 = new Map(LANGS.map((l) => [l[0], l]));
const BY_CODE2 = new Map(LANGS.map((l) => [l[2], l]));

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const SUBCAT = "https://www.subtitlecat.com";

/* Google carriers: директни хостове, после cors.lol, накрая jina */
const GT_URLS = [
  "https://translate.googleapis.com/translate_a/t",
  "https://clients5.google.com/translate_a/t",
  "https://translate.google.com/translate_a/t",
];
const GT_PROXY = "https://r.jina.ai/";
const GT_PROXY2 = "https://api.cors.lol/?url=";
let gtHostIdx = 0;

/* ------------------------------------------------------------------ *
 * LRU кеш (в паметта на isolate-а)
 * ------------------------------------------------------------------ */
function makeCache(maxEntries, ttlMs) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (!v) return null;
      if (ttlMs && Date.now() - v.at > ttlMs) { m.delete(k); return null; }
      return v.val;
    },
    set(k, val) {
      if (m.has(k)) m.delete(k);
      m.set(k, { val, at: Date.now() });
      while (m.size > maxEntries) m.delete(m.keys().next().value);
    },
    size() { return m.size; },
  };
}
const metaCache = makeCache(2000, 6 * 3600e3);
const pageCache = makeCache(1500, 6 * 3600e3);
const srtCache = makeCache(50, 6 * 3600e3);
const resultCache = makeCache(300, 24 * 3600e3);

/* ------------------------------------------------------------------ *
 * Помощни функции
 * ------------------------------------------------------------------ */
async function fetchText(url, timeoutMs = 25000, headers = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept-Language": "en", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} от ${url}`);
  return res.text();
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function json(resBody, status = 200, type = "application/json") {
  return new Response(resBody, {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Content-Type": type + "; charset=utf-8",
    },
  });
}

/* ------------------------------------------------------------------ *
 * Cinemeta
 * ------------------------------------------------------------------ */
async function lookupTitle(imdbId, type) {
  const key = type + ":" + imdbId;
  const hit = metaCache.get(key);
  if (hit) return hit;
  const meta = JSON.parse(await fetchText(`https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`, 20000)).meta;
  if (!meta || !meta.name) throw new Error("Cinemeta не даде метаданни за " + imdbId);
  const year = String(meta.year || String(meta.released || "").slice(0, 4)).slice(0, 4);
  const info = { name: meta.name, year };
  metaCache.set(key, info);
  return info;
}

/* ------------------------------------------------------------------ *
 * SubtitleCat
 * ------------------------------------------------------------------ */
async function subcatSearch(query) {
  const html = await fetchText(`${SUBCAT}/index.php?search=${encodeURIComponent(query)}`);
  const out = [];
  const re = /href="(subs\/[^"]+?\.html)"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html)) !== null) out.push({ url: `${SUBCAT}/${m[1]}`, title: m[2].trim() });
  return out;
}

function parseSubtitlePage(pageUrl, html) {
  const dirMatch = pageUrl.match(/^(https?:\/\/[^/]+\/subs\/[0-9]+)\/([^/]+)\.html$/);
  if (!dirMatch) return null;
  const dir = dirMatch[1];
  const base = decodeURIComponent(dirMatch[2]);

  const raw = new Map(); // 2-буквен код -> пълен URL
  const re = /href="(\/subs\/[0-9]+\/[^"]+?-([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\.srt)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code2 = m[2].toLowerCase();
    if (!raw.has(code2)) raw.set(code2, `${SUBCAT}${m[1]}`);
  }
  const direct = new Map();
  for (const [code2, url] of raw) if (BY_CODE2.has(code2)) direct.set(code2, url);

  const source = raw.get("en") || `${dir}/${encodeURIComponent(base)}-orig.srt`;
  return { dir, base, raw, direct, source };
}

function pageKeyFor(imdbId, type, season, episode) {
  return `${imdbId}|${type}|${season || ""}|${episode || ""}`;
}

async function fetchSrtSource(url) {
  const hit = srtCache.get(url);
  if (hit) return hit;
  const t = await fetchText(url, 30000, { Referer: "https://www.subtitlecat.com/" });
  srtCache.set(url, t);
  return t;
}

async function findSubtitlePage(imdbId, type, season, episode, wantLang) {
  const key = pageKeyFor(imdbId, type, season, episode) + (wantLang ? "!" + wantLang : "");
  const hit = pageCache.get(key);
  if (hit !== null) return hit;

  const meta = await lookupTitle(imdbId, type);
  let candidates = [];

  if (type === "series") {
    const ep = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    candidates = await subcatSearch(`${meta.name} ${ep}`);
    const exact = candidates.filter((c) => new RegExp(ep, "i").test(c.title));
    if (exact.length) candidates = exact;
  } else {
    const q = meta.year ? `${meta.name} ${meta.year}` : meta.name;
    candidates = await subcatSearch(q);
    if (!candidates.length) candidates = await subcatSearch(meta.name);
    if (meta.year) {
      const withYear = candidates.filter((c) => c.title.includes(meta.year));
      if (withYear.length) candidates = withYear;
    }
  }

  // 1) страница, чийто директни езици съдържат искания; 2) всичко; 3) EП-о
  for (const cand of candidates.slice(0, 8)) {
    try {
      const parsed = parseSubtitlePage(cand.url, await fetchText(cand.url));
      if (!parsed) continue;
      if (wantLang && parsed.direct.has(wantLang)) {
        parsed.label = cand.title.slice(0, 60);
        parsed.foundDirect = true;
        pageCache.set(key, parsed);
        return parsed;
      }
      if (!parsed.fallback || parsed.direct.size > parsed.fallback.direct.size) parsed.fallback = parsed;
    } catch (_) { /* следващата */ }
  }

  for (const cand of candidates.slice(0, 8)) {
    try {
      const parsed = parseSubtitlePage(cand.url, await fetchText(cand.url));
      if (parsed) {
        parsed.label = cand.title.slice(0, 60);
        pageCache.set(key, parsed);
        return parsed;
      }
    } catch (_) { /* следващата */ }
  }

  pageCache.set(key, null);
  return null;
}

/* ------------------------------------------------------------------ *
 * SRT
 * ------------------------------------------------------------------ */
function parseSrt(text) {
  const lines = text.replace(/\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const cues = [];
  let time = "", textBuf = "";
  const flush = () => {
    if (time && textBuf.trim()) cues.push({ n: cues.length + 1, t: time, text: textBuf.trim() });
    time = ""; textBuf = "";
  };
  for (const line of lines) {
    if (line.includes("-->")) {
      flush();
      time = line.trim();
    } else if (line.trim() === "") {
      flush();
    } else if (!/^-?\d+$/.test(line.trim()) || time === "") {
      textBuf += (textBuf ? " " : "") + line.trim();
    }
  }
  flush();
  return cues;
}

function decodeEntities(t) {
  return t
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
}

function cleanLine(t) {
  return t
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/<\/?(b|i|u|font|s)[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTranslatedSrt(cues, translated) {
  let buf = "";
  cues.forEach((cue, k) => {
    let txt = translated[k] == null ? cue.text : String(translated[k]).trim();
    if (/^[-–]\s/.test(cue.text) && !/^[-–]/.test(txt)) txt = "- " + txt;
    txt = txt.trim() || cue.text;
    buf += `${cue.n}\n${cue.t}\n${txt}\n\n`;
  });
  return buf.trim() + "\n";
}

/* ------------------------------------------------------------------ *
 * Google Translate (през верига от канали)
 * ------------------------------------------------------------------ */
function gtParse(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return gtParse(v[0]);
  return null;
}

function extractGtJson(text) {
  const start = text.indexOf("[[");
  const end = text.lastIndexOf("]]");
  if (start < 0 || end <= start) throw new Error("няма JSON в отговора на преводача");
  return JSON.parse(text.slice(start, end + 2));
}

function gtQuery(lines, target) {
  const params = new URLSearchParams();
  params.set("client", "dict-chrome-ex");
  params.set("sl", "auto");
  params.set("tl", target);
  for (const l of lines) params.append("q", l);
  return params.toString();
}

async function tryGt(url, timeoutMs) {
  const text = await fetchText(url, timeoutMs);
  const arr = extractGtJson(text);
  if (!Array.isArray(arr) || !arr.length) throw new Error("неочакван отговор от Google Translate");
  return arr.map(gtParse);
}

async function gtBatch(lines, target) {
  const query = gtQuery(lines, target);
  const direct = GT_URLS.map((h) => `${h}?${query}`);
  const order = [];
  for (let k = 0; k < GT_URLS.length; k++) order.push(direct[(gtHostIdx + k) % GT_URLS.length]);
  order.push(GT_PROXY2 + encodeURIComponent(direct[0]));
  const jinaUrl = GT_PROXY + direct[0];
  order.push(jinaUrl, jinaUrl);
  let lastErr = null;
  for (const url of order) {
    const viaProxy = url.startsWith(GT_PROXY) || url.startsWith(GT_PROXY2);
    try {
      const out = await tryGt(url, viaProxy ? 40000 : 20000);
      gtHostIdx = url === jinaUrl ? 0 : (GT_URLS.indexOf(url.split("?")[0]) + 1) % GT_URLS.length;
      return out;
    } catch (e) {
      lastErr = e;
      if (url === jinaUrl) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

async function translateAll(lines, target) {
  const chunks = [];
  let cur = [], size = 0;
  for (const l of lines) {
    const enc = encodeURIComponent(l).length + 30;
    if (cur.length && (cur.length >= 60 || size + enc > 2600)) {
      chunks.push(cur); cur = []; size = 0;
    }
    cur.push(l); size += enc;
  }
  if (cur.length) chunks.push(cur);

  const results = new Array(chunks.length);
  let failed = 0, next = 0;
  const workers = [];
  const workerCount = Math.min(4, chunks.length);
  for (let w = 0; w < workerCount; w++) {
    workers.push((async () => {
      while (next < chunks.length) {
        const i = next++;
        try { results[i] = await gtBatch(chunks[i], target); }
        catch (_) { results[i] = chunks[i]; failed++; }
      }
    })());
  }
  await Promise.all(workers);
  return { lines: results.flat(), failedChunks: failed };
}

async function getTranslatedSrt(sourceUrl, langCode3) {
  const target = BY_CODE3.get(langCode3);
  if (!target) throw new Error("неподдържан език: " + langCode3);
  const key = `${langCode3}|${sourceUrl}`;
  const hit = resultCache.get(key);
  if (hit) return { srt: hit, fromCache: true };

  const cues = parseSrt(await fetchSrtSource(sourceUrl));
  if (!cues.length) throw new Error("източникът SRT е празен");
  const cleaned = cues.map((c) => cleanLine(decodeEntities(c.text)).slice(0, 900));
  const { lines, failedChunks } = await translateAll(cleaned, target[1]);
  if (failedChunks) throw new Error(`Преводът пропадна за ${failedChunks} части (блокирано от Google)`);
  const srt = buildTranslatedSrt(cues, lines);
  resultCache.set(key, srt);
  return { srt, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * Списъци и манифест
 * ------------------------------------------------------------------ */
function gtUrl(payloadObj, origin) {
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  return `${origin}/gt/${payload}.srt`;
}

async function buildSubList(type, imdbId, season, episode, requestedLang, origin) {
  const page = await findSubtitlePage(imdbId, type, season, episode, requestedLang);
  if (!page) return [];
  const key = pageKeyFor(imdbId, type, season, episode).replace(/\|/g, "-");
  const gtTarget = requestedLang || "bul";
  const list = [
    { id: `gt-${key}`, url: gtUrl({ s: page.source, t: gtTarget, n: page.label }, origin), lang: gtTarget },
  ];
  for (const [code2, url] of page.direct) {
    const lang = BY_CODE2.get(code2);
    if (requestedLang && lang[0] !== requestedLang) continue;
    if (!requestedLang && lang[0] !== "bul") continue;
    list.push({ id: `sc-${key}-${code2}`, url, lang: lang[0] });
  }
  return list;
}

const ADDON_ID = "gt.subs.translator";

function manifest() {
  return {
    id: ADDON_ID,
    version: "1.0.0",
    name: "Преведени субтитри – Google Translate",
    description: "Дава субтитри на избрания от вас език – Google Translate, без ключ.",
    catalog: [],
    types: ["movie", "series"],
    resources: ["subtitles", ...LANGS.map((l) => "subtitles:" + l[0])],
  };
}

function parseId(raw) {
  const parts = String(raw).split(":");
  const m = parts[0].match(/^(tt\d+)/);
  if (!m) return null;
  let season = null, episode = null;
  if (parts.length >= 3) { season = parseInt(parts[1], 10); episode = parseInt(parts[2], 10); }
  return { imdb: m[1], season, episode };
}

function failSrt(message) {
  return (
    `1\n00:00:01,000 --> 00:00:30,000\n${message}\n\n` +
    `2\n00:00:31,000 --> 00:01:30,000\nОпитайте отново след минута.\n`
  );
}

/* ------------------------------------------------------------------ *
 * Worker entry
 * ------------------------------------------------------------------ */
export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const path = decodeURIComponent(u.pathname);
    const origin = u.origin;
    const DEFAULT_LANG = (env && env.DEFAULT_LANG) || "bul";

    try {
      if (request.method === "OPTIONS") return json("", 204);

      if (path === "/" || path === "/index.html") {
        return json(landing(origin), 200, "text/html");
      }

      if (path === "/manifest.json") {
        return json(JSON.stringify(manifest(), null, 2));
      }

      if (path === "/health") {
        return json(JSON.stringify({
          ok: true, runtime: "cloudflare",
          caches: { pages: pageCache.size(), srts: srtCache.size(), translated: resultCache.size() },
        }));
      }

      if (path === "/debug-alt") {
        const out = [];
        for (const url of GT_URLS) {
          try {
            const t = await fetchText(`${url}?client=dict-chrome-ex&sl=auto&tl=bg&q=Hello`, 20000);
            out.push({ trans: "google", host: new URL(url).hostname, status: "OK", head: t.slice(0, 50) });
          } catch (e) { out.push({ trans: "google", host: new URL(url).hostname, status: "FAIL", error: String(e.message).slice(0, 60) }); }
        }
        try {
          const t = await fetchText(GT_PROXY2 + encodeURIComponent(GT_URLS[0] + "?client=dict-chrome-ex&sl=auto&tl=bg&q=Hello"), 30000);
          out.push({ trans: "cors.lol", host: "api.cors.lol", status: "OK", head: t.slice(0, 60) });
        } catch (e) { out.push({ trans: "cors.lol", host: "api.cors.lol", status: "FAIL", error: String(e.message).slice(0, 60) }); }
        try {
          const t = await fetchText(GT_PROXY + GT_URLS[0] + "?client=dict-chrome-ex&sl=auto&tl=bg&q=Hello", 40000);
          out.push({ trans: "jina", host: "r.jina.ai", status: "OK", head: t.slice(0, 60) });
        } catch (e) { out.push({ trans: "jina", host: "r.jina.ai", status: "FAIL", error: String(e.message).slice(0, 60) }); }
        return json(JSON.stringify(out, null, 1));
      }

      /* Преведено SRT: /gt/<payload>.srt */
      const gtMatch = path.match(/^\/gt\/([A-Za-z0-9_-]+)\.srt$/);
      if (gtMatch) {
        let payload;
        try { payload = JSON.parse(b64urlDecode(gtMatch[1])); }
        catch (_) { return json(failSrt("Повреден адрес на субтитрите."), 200, "text/plain"); }
        try {
          const { srt } = await getTranslatedSrt(payload.s, payload.t);
          return new Response(srt, {
            status: 200,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Content-Type": "text/plain; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        } catch (e) {
          return json(failSrt("Грешка при превода: " + e.message), 200, "text/plain");
        }
      }

      /* Списък със субтитри: /subtitles/... */
      if (path.startsWith("/subtitles")) {
        const parts = path.split("/").filter(Boolean);
        let lang = null, type = null, id = null;
        for (let i = 1; i < parts.length; i++) {
          const p = parts[i];
          if (!type && (p === "movie" || p === "series" || p === "tv")) type = p === "tv" ? "series" : p;
          else if (!lang && /^[a-z]{2,3}$/.test(p) && BY_CODE3.has(p)) lang = p;
          else if (!id && /^tt\d+/.test(p)) id = p.replace(/\.json$/, "");
        }
        const qLang = u.searchParams.get("language") || u.searchParams.get("subLang");
        if (!lang && qLang && BY_CODE3.has(qLang)) lang = qLang;
        if (!id) return json(JSON.stringify({ subtitles: [], error: "липсва imdb id" }));
        const parsed = parseId(id);
        if (!parsed) return json(JSON.stringify({ subtitles: [], error: "лош id" }));
        const typeFinal = type || "movie";
        const season = parsed.season !== null ? parsed.season : (parseInt(u.searchParams.get("season"), 10) || null);
        const episode = parsed.episode !== null ? parsed.episode : (parseInt(u.searchParams.get("episode"), 10) || null);
        const subs = await buildSubList(typeFinal, parsed.imdb, season, episode, lang, origin);
        return json(JSON.stringify({ subtitles: subs }));
      }

      return json("not found", 404, "text/plain");
    } catch (e) {
      return json(JSON.stringify({ error: e.message }), 502);
    }
  },
};

function landing(origin) {
  return `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8">
<title>Преведени субтитри – Google Translate</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui;max-width:660px;margin:2rem auto;padding:0 1rem;line-height:1.55">
<h1>🎬 Преведени субтитри</h1>
<p>Добавка за <b>Stremio</b> и <b>Nuvio</b> – субтитри на избрания от вас език
через автоматичен превод с Google Translate.</p>
<p><b>Манифест URL:</b><br>
<code style="word-break:break-all">${origin}/manifest.json</code></p>
</body></html>`;
}

/* Локална проверка в Node (по избор) */
