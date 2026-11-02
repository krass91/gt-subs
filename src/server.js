/* eslint-disable no-console */
/**
 * Преведени субтитри – добавка за Stremio и Nuvio (Node >= 18, без зависимости).
 *
 * Как работи:
 *  1. Плеърът пита /subtitles/:type/:imdbId.json
 *  2. Добавката пита Cinemeta за име (+година), после търси в subtitlecat.com
 *  3. Взима оригиналния (EN) SRT и превежда реплика по реплика с Google
 *     Translate през безплатния keyless endpoint (translate.googleapis.com)
 *  4. Връща адреси на готовите преведени SRT-та
 *
 * Пускане локално:  node src/server.js   (порт 7000)
 */
"use strict";

const http = require("http");

const PORT = process.env.PORT || 7000;
const BASE_URL = process.env.BASE_URL || "";            // напр. https://my-gt-subs.onrender.com
const DEFAULT_LANG = process.env.DEFAULT_LANG || "bul"; // 3-буквен код, виж LANGS
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

/* ------------------------------------------------------------------ *
 * Езици: [код за Stremio (3 букви), код за Google, код на SubCat, име]
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
const NAME_BY_CODE3 = new Map(LANGS.map((l) => [l[0], l[3]]));

/* ------------------------------------------------------------------ *
 * LRU кеш
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
const metaCache = makeCache(2000, 6 * 3600e3);   // imdb -> { name, year }
const pageCache = makeCache(1500, 6 * 3600e3);   // key -> SubCat страница
const srtCache = makeCache(50, 6 * 3600e3);      // url -> оригинален SRT текст
const resultCache = makeCache(300, 24 * 3600e3); // (език|източник) -> преведен SRT

/* ------------------------------------------------------------------ *
 * HTTP помощни функции
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

function fetchSrtSource(url) {
  const hit = srtCache.get(url);
  if (hit) return Promise.resolve(hit);
  return fetchText(url, 30000, { Referer: "https://www.subtitlecat.com/" }).then((t) => {
    srtCache.set(url, t);
    return t;
  });
}

/* ------------------------------------------------------------------ *
 * Cinemeta: imdbId -> { name, year }
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
 * SubtitleCat: търсене и откриване на страница с SRT-та
 * ------------------------------------------------------------------ */
const SUBCAT = "https://www.subtitlecat.com";

async function subcatSearch(query) {
  const html = await fetchText(`${SUBCAT}/index.php?search=${encodeURIComponent(query)}`);
  const out = [];
  const re = /href="(subs\/[^"]+?\.html)"[^>]*>([^<]+)</g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ url: `${SUBCAT}/${m[1]}`, title: m[2].trim() });
  }
  return out;
}

function parseSubtitlePage(pageUrl, html) {
  const dirMatch = pageUrl.match(/^(https?:\/\/[^/]+\/subs\/[0-9]+)\/([^/]+)\.html$/);
  if (!dirMatch) return null;
  const dir = dirMatch[1];
  const base = decodeURIComponent(dirMatch[2]);

  // всички директни SRT-та на страницата: href="/subs/123/<release>-<code>.srt"
  const raw = new Map(); // 2-буквен код -> пълен URL
  const re = /href="(\/subs\/[0-9]+\/[^"]+?-([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)\.srt)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const code2 = m[2].toLowerCase();
    if (!raw.has(code2)) raw.set(code2, `${SUBCAT}${m[1]}`);
  }

  const direct = new Map();
  for (const [code2, url] of raw) if (BY_CODE2.has(code2)) direct.set(code2, url);

  // Източник за превода: английската версия; ако липсва – оригиналната
  const source = raw.get("en") || `${dir}/${encodeURIComponent(base)}-orig.srt`;
  return { dir, base, raw, direct, source };
}

function pageKeyFor(imdbId, type, season, episode) {
  return `${imdbId}|${type}|${season || ""}|${episode || ""}`;
}

async function findSubtitlePage(imdbId, type, season, episode) {
  const key = pageKeyFor(imdbId, type, season, episode);
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

  for (const cand of candidates.slice(0, 5)) {
    try {
      const parsed = parseSubtitlePage(cand.url, await fetchText(cand.url));
      if (parsed) {
        parsed.label = cand.title.slice(0, 60);
        pageCache.set(key, parsed);
        return parsed;
      }
    } catch (_) { /* пробваме следващата */ }
  }
  pageCache.set(key, null); // помни и неуспеха, за да не бием SubCat постоянно
  return null;
}

/* ------------------------------------------------------------------ *
 * SRT парсване и сглобяване
 * ------------------------------------------------------------------ */
function parseSrt(text) {
  const lines = text.replace(/\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  const cues = [];
  let time = "", textBuf = "", prevLine = "";
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
    prevLine = line;
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
    .replace(/\{[^{}]*\}/g, " ")            // ASS/SSA тагове {\an8} и т.н.
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
 * Google Translate (без ключ):
 *   /translate_a/t?client=dict-chrome-ex&sl=..&tl=..&q=..&q=..
 * Проверено на живо: пакети с няколко q= върщат преведените да обратно.
 * ------------------------------------------------------------------ */
/**
 * Мрежов маршрут за превод: директните Google хостове първо; от облачни сървъри
 * Google често отговаря 429 (блокира datacenter IP) – тогава минаваме на
 * r.jina.ai, който проксира заявката от СВОИ IP и връща JSON-а на Google.
 */
const GT_URLS = [
  "https://translate.googleapis.com/translate_a/t",
  "https://clients5.google.com/translate_a/t",
  "https://translate.google.com/translate_a/t",
];
const GT_PROXY = "https://r.jina.ai/";
let gtHostIdx = 0;

function gtParse(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return gtParse(v[0]);
  return null;
}

/** Джина добавя заглавка и "Markdown Content:" преди JSON-а. */
function extractGtJson(text) {
  const start = text.indexOf("[[");
  const end = text.lastIndexOf("]]");
  if (start < 0 || end <= start) throw new Error("jina: няма JSON");
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
  // редът: директните хостове от gtHostIdx нататък, накрая jina (2 опита)
  const order = [];
  for (let k = 0; k < GT_URLS.length; k++) order.push(direct[(gtHostIdx + k) % GT_URLS.length]);
  const jinaUrl = GT_PROXY + direct[0];
  order.push(jinaUrl, jinaUrl);
  let lastErr = null;
  for (const url of order) {
    const viaJina = url.startsWith(GT_PROXY);
    try {
      const out = await tryGt(url, viaJina ? 40000 : 20000);
      gtHostIdx = viaJina ? 0 : (GT_URLS.indexOf(url.split("?")[0]) + 1) % GT_URLS.length;
      return out;
    } catch (e) {
      lastErr = e;
      if (viaJina) await new Promise((r) => setTimeout(r, 3000)); // jina rpm лимит
    }
  }
  throw lastErr;
}

/** Превежда всички реплики с няколко паралелни пакетни заявки. */
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
        catch (_) { results[i] = chunks[i]; failed++; } // при провал остава оригиналът
      }
    })());
  }
  await Promise.all(workers);
  return { lines: results.flat(), failedChunks: failed };
}

/* ------------------------------------------------------------------ *
 * Целия поток: източник SRT -> преведен SRT
 * ------------------------------------------------------------------ */
async function getTranslatedSrt(sourceUrl, langCode3) {
  const target = BY_CODE3.get(langCode3);
  if (!target) throw new Error("неподдържан език: " + langCode3);

  const key = `${langCode3}|${sourceUrl}`;
  const hit = resultCache.get(key);
  if (hit) return { srt: hit, fromCache: true };

  const cues = parseSrt(await fetchSrtSource(sourceUrl));
  if (!cues.length) throw new Error("източникът SRT е празен/нечистем");
  const cleaned = cues.map((c) => cleanLine(decodeEntities(c.text)).slice(0, 900));
  const { lines, failedChunks } = await translateAll(cleaned, target[1]);
  const srt = buildTranslatedSrt(cues, lines);
  if (failedChunks) throw new Error(`Преводът пропадна за ${failedChunks} части от филма`);
  resultCache.set(key, srt);
  return { srt, fromCache: false };
}

/* ------------------------------------------------------------------ *
 * Списъка със субтитри за един файл
 * ------------------------------------------------------------------ */
function gtUrl(payloadObj, origin) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8").toString("base64url");
  return `${origin}/gt/${payload}.srt`; // origin = BASE_URL или адресът от заявката
}

async function buildSubList(type, imdbId, season, episode, requestedLang, origin) {
  const page = await findSubtitlePage(imdbId, type, season, episode);
  if (!page) return [];

  const key = pageKeyFor(imdbId, type, season, episode).replace(/\|/g, "-");
  const gtTarget = requestedLang || DEFAULT_LANG;
  const list = [
    {
      id: `gt-${key}`,
      url: gtUrl({ s: page.source, t: gtTarget, n: page.label }, origin),
      lang: gtTarget,
    },
  ];

  // Директни (предварително преведени) версии от SubtitleCat като допълнение
  for (const [code2, url] of page.direct) {
    const lang = BY_CODE2.get(code2);
    if (requestedLang && lang[0] !== requestedLang) continue;
    if (!requestedLang && lang[0] !== DEFAULT_LANG) continue;
    list.push({ id: `sc-${key}-${code2}`, url, lang: lang[0] });
  }

  return list;
}

/* ------------------------------------------------------------------ *
 * HTTP сървър
 * ------------------------------------------------------------------ */
const ADDON_ID = "gt.subs.translator";

function manifest() {
  return {
    id: ADDON_ID,
    version: "1.0.0",
    name: "Преведени субтитри – Google Translate",
    description:
      "Дава субтитри на които видовии езици – оригиналните SRT-та от subtitlecat.com " +
      "са преведени автоматично с Google Translate (без ключ). ",
    catalog: [],
    types: ["movie", "series"],
    resources: ["subtitles", ...LANGS.map((l) => "subtitles:" + l[0])],
  };
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": type + "; charset=utf-8",
  });
  res.end(body);
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
    `2\n00:00:31,000 --> 00:01:30,000\nОпитайте отново след минута.\nПървозаписния превод отнема 1-2 мин.\n`
  );
}

function landingPage() {
  const origin = BASE_URL || `http://localhost:${PORT}`;
  return `<!DOCTYPE html><html lang="bg"><head><meta charset="utf-8">
<title>Преведени субтитри – Google Translate</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui;max-width:660px;margin:2rem auto;padding:0 1rem;line-height:1.55">
<h1>🎬 Преведени субтитри</h1>
<p>Добавка за <b>Stremio</b> и <b>Nuvio</b>: дава субтитри на избрания от вас език,
като оригиналните субтитри от subtitlecat.com се превеждаат автоматично с Google Translate.</p>
<p><b>Манифест URL за инсталиране (сложете го в Stremio/Nuvio):</b><br>
<code style="word-break:break-all">${origin}/manifest.json</code><br>
<code style="word-break:break-all">stremio://${origin.replace(/^https?:\/\//, "")}/manifest.json</code></p>
<p>Бележка: първото превеждане на един файл отнема 1-2 мин; после се кешира и зарежда бързо.</p>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (_) {
    return send(res, 400, "лоша заявка", "text/plain");
  }
  const path = decodeURIComponent(u.pathname);

  try {
    /* Начална страница */
    if (path === "/" || path === "/index.html") {
      return send(res, 200, landingPage(), "text/html");
    }

    /* Манифест за Stremio/Nuvio */
    if (path === "/manifest.json") {
      return send(res, 200, JSON.stringify(manifest(), null, 2));
    }

    if (path === "/health") {
      return send(res, 200, JSON.stringify({
        ok: true,
        uptime: Math.round(process.uptime()) + "s",
        caches: { pages: pageCache.size(), srts: srtCache.size(), translated: resultCache.size() },
      }));
    }

    /* Диагностика на хостовете за превод */
    if (path === "/debug-gt" || path === "/debug-alt") {
      const out = [];
      for (const url of GT_URLS) {
        const host = new URL(url).hostname;
        try {
          const text = await fetchText(`${url}?client=dict-chrome-ex&sl=auto&tl=bg&q=Hello&q=world`, 20000);
          out.push({ trans: "google", host, status: "OK", head: text.slice(0, 60) });
        } catch (e) {
          out.push({ trans: "google", host, status: "FAIL", error: String(e.message || e).slice(0, 60) });
        }
      }
      // MyMemory (без ключ)
      for (const host of ["mymemory.translated.net"]) {
        try {
          const text = await fetchText(`https://${host}/api/get?q=Hello%20world&langpair=en|bg`, 20000);
          out.push({ trans: "mymemory", host, status: "OK", head: text.slice(0, 100) });
        } catch (e) {
          out.push({ trans: "mymemory", host, status: "FAIL", error: String(e.message || e).slice(0, 60) });
        }
      }
      // Lingva (безключово огледало на Google)
      for (const host of ["lingva.ml", "translate.plausibility.cloud"]) {
        try {
          const text = await fetchText(`https://${host}/api/v1/en/bg/Hello%20world`, 20000);
          out.push({ trans: "lingva", host, status: "OK", head: text.slice(0, 100) });
        } catch (e) {
          out.push({ trans: "lingva", host, status: "FAIL", error: String(e.message || e).slice(0, 60) });
        }
      }
      // jina (прокси канал – връща JSON-а на Google от свои IP)
      try {
        const jinaUrl = GT_PROXY + GT_URLS[0] + "?client=dict-chrome-ex&sl=auto&tl=bg&q=Hello&q=world";
        const text = await fetchText(jinaUrl, 40000);
        out.push({ trans: "jina", host: "r.jina.ai", status: "OK", head: extractGtJson(text) });
      } catch (e) {
        out.push({ trans: "jina", host: "r.jina.ai", status: "FAIL", error: String(e.message || e).slice(0, 60) });
      }
      return send(res, 200, JSON.stringify(out, null, 1));
    }

    /* Готово преведено SRT: /gt/<payload>.srt */
    const gtMatch = path.match(/^\/gt\/([A-Za-z0-9_-]+)\.srt$/);
    if (gtMatch) {
      let payload;
      try {
        payload = JSON.parse(Buffer.from(gtMatch[1], "base64url").toString("utf8"));
      } catch (_) {
        return send(res, 400, failSrt("Повреден адрес на субтитрите."), "text/plain");
      }
      try {
        const { srt } = await getTranslatedSrt(payload.s, payload.t);
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
        });
        return res.end(srt);
      } catch (e) {
        console.error("[gt]", e.message);
        return send(res, 200, failSrt("Грешка при превода: " + e.message), "text/plain");
      }
    }

    /* Списък със субтитри: /subtitles/... */
    if (path.startsWith("/subtitles")) {
      const parts = path.split("/").filter(Boolean); // subtitles | [език] | movie/series | tt...
      let lang = null, type = null, id = null;
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (!type && (p === "movie" || p === "series" || p === "tv")) {
          type = p === "tv" ? "series" : p;
        } else if (!lang && /^[a-z]{2,3}$/.test(p) && BY_CODE3.has(p)) {
          lang = p;
        } else if (!id && /^tt\d+/.test(p)) {
          id = p.replace(/\.json$/, "");
        }
      }
      if (!id) return send(res, 400, JSON.stringify({ subtitles: [], error: "липсва imdb id" }));
      const qLang = u.searchParams.get("language") || u.searchParams.get("subLang");
      if (!lang && qLang && BY_CODE3.has(qLang)) lang = qLang;
      const parsed = parseId(id);
      if (!parsed) return send(res, 400, JSON.stringify({ subtitles: [], error: "лош id" }));
      const typeFinal = type || "movie";
      const season = parsed.season !== null ? parsed.season : (parseInt(u.searchParams.get("season"), 10) || null);
      const episode = parsed.episode !== null ? parsed.episode : (parseInt(u.searchParams.get("episode"), 10) || null);

      const proto = req.headers["x-forwarded-proto"] || "http";
      const host = req.headers.host || `localhost:${PORT}`;
      const origin = BASE_URL || `${proto}://${host}`;

      const subs = await buildSubList(typeFinal, parsed.imdb, season, episode, lang, origin);
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(JSON.stringify({ subtitles: subs }));
    }

    return send(res, 404, "not found", "text/plain");
  } catch (e) {
    console.error("[srv]", path, e.message);
    return send(res, 502, JSON.stringify({ error: e.message }), "text/plain");
  }
});

server.listen(PORT, () => {
  console.log(`✅ Преведени субтитри е на: http://localhost:${PORT}/manifest.json`);
  console.log(`   Език по подразбиране: ${DEFAULT_LANG}; поддържани езици: ${LANGS.length}`);
});
