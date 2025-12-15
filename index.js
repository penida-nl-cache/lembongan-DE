// cachewarmer_tw_gsheets.js
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { parseStringPromise } from "xml2js";
import * as dotenv from "dotenv";

dotenv.config();

/* ====== ENV WAJIB (LOG KE GSHEETS) ====== */
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

/* ====== KONFIG DOMAIN / PROXY / UA ====== */
const DOMAINS_MAP = {
  de: "https://divinglembongan.de",
};

const PROXIES = {
  de: process.env.BRD_PROXY_DE,
};

const USER_AGENTS = {
  de: "DivingLembongan - CacheWarmer - DE / 1.0",
};

/* ====== CLOUDFLARE ====== */
const CLOUDFLARE_ZONE_ID = process.env.CLOUDFLARE_ZONE_ID;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

/* ====== TARGET EU EDGES ====== */
const TARGET_EDGES_EU = ["FRA", "AMS", "LHR"];
const MAX_EDGE_RETRIES = 5;

/* ====== UTIL ====== */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cryptoRandomId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

function extractCfEdge(cfRay) {
  if (typeof cfRay === "string" && cfRay.includes("-")) {
    const parts = cfRay.split("-");
    return parts[parts.length - 1] || "N/A";
  }
  return "N/A";
}

/** Nama tab per-run: YYYY-MM-DD_HH-mm-ss_WITA */
function makeSheetNameForRun(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const local = new Date(date.getTime() + 8 * 3600 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(
    local.getUTCDate()
  )}_${pad(local.getUTCHours())}-${pad(local.getUTCMinutes())}-${pad(
    local.getUTCSeconds()
  )}_WITA`;
}

/* ====== LOGGER → APPS SCRIPT ====== */
class AppsScriptLogger {
  constructor() {
    this.rows = [];
    this.runId = cryptoRandomId();
    this.startedAt = new Date().toISOString();
    this.finishedAt = null;
    this.sheetName = makeSheetNameForRun();
  }

  log({
    country = "",
    url = "",
    status = "",
    cfCache = "",
    lsCache = "",
    cfRay = "",
    responseMs = "",
    error = 0,
    message = "",
  } = {}) {
    this.rows.push([
      this.runId,
      this.startedAt,
      this.finishedAt,
      country,
      url,
      status,
      cfCache,
      lsCache,
      cfRay,
      typeof responseMs === "number" ? responseMs : "",
      error ? 1 : 0,
      message,
    ]);
  }

  setFinished() {
    this.finishedAt = new Date().toISOString();
    this.rows = this.rows.map((r) => ((r[2] = this.finishedAt), r));
  }

  async flush() {
    if (!APPS_SCRIPT_URL || this.rows.length === 0) return;

    try {
      await axios.post(
        APPS_SCRIPT_URL,
        { sheetName: this.sheetName, rows: this.rows },
        { timeout: 20000, headers: { "Content-Type": "application/json" } }
      );
      this.rows = [];
    } catch (e) {
      console.warn("Apps Script logging error:", e?.message || e);
    }
  }
}

/* ====== HTTP HELPER ====== */
function buildAxiosCfg(country, extra = {}) {
  const proxy = PROXIES[country];
  const headers = {
    "User-Agent": USER_AGENTS[country],
    Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
    ...extra.headers,
  };

  const cfg = {
    headers,
    timeout: 30000,
    ...extra,
  };

  if (proxy) {
    cfg.httpsAgent = new HttpsProxyAgent(proxy);
  }

  return cfg;
}

async function fetchWithProxy(url, country, timeout = 15000) {
  const res = await axios.get(url, buildAxiosCfg(country, { timeout }));
  return res.data;
}

/* ====== SITEMAP ====== */
async function fetchRobotsSitemaps(domain, country) {
  try {
    const txt = await fetchWithProxy(`${domain}/robots.txt`, country, 10000);
    return String(txt)
      .split(/\r?\n/)
      .filter((l) => /^sitemap:\s*/i.test(l))
      .map((l) => l.split(/:\s*/i)[1].trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchIndexSitemaps(domain, country) {
  const candidates = [
    ...(await fetchRobotsSitemaps(domain, country)),
    `${domain}/sitemap.xml`,
    `${domain}/sitemap_index.xml`,
  ];

  for (const url of [...new Set(candidates)]) {
    try {
      const xml = await fetchWithProxy(url, country, 15000);
      const parsed = await parseStringPromise(xml, {
        explicitArray: false,
        ignoreAttrs: true,
      });

      if (parsed?.sitemapindex?.sitemap) {
        const list = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];
        const locs = list.map((e) => e.loc).filter(Boolean);
        if (locs.length) return locs;
      }

      if (parsed?.urlset?.url) return [url];
    } catch {}
  }

  return [];
}

async function fetchUrlsFromSitemap(sitemapUrl, country) {
  try {
    const xml = await fetchWithProxy(sitemapUrl, country, 15000);
    const parsed = await parseStringPromise(xml, {
      explicitArray: false,
      ignoreAttrs: true,
    });
    const urls = parsed?.urlset?.url;
    if (!urls) return [];
    return (Array.isArray(urls) ? urls : [urls])
      .map((u) => u.loc)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/* ====== CLOUDFLARE PURGE ====== */
async function purgeCloudflareCache(url) {
  if (!CLOUDFLARE_ZONE_ID || !CLOUDFLARE_API_TOKEN) return;

  try {
    await axios.post(
      `https://api.cloudflare.com/client/v4/zones/${CLOUDFLARE_ZONE_ID}/purge_cache`,
      { files: [url] },
      {
        headers: {
          Authorization: `Bearer ${CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch {}
}

/* ====== WARMER (EU EDGE AWARE) ====== */
async function warmUrls(urls, country, logger, batchSize = 1, delay = 2000) {
  const batches = Array.from(
    { length: Math.ceil(urls.length / batchSize) },
    (_, i) => urls.slice(i * batchSize, i * batchSize + batchSize)
  );

  for (const batch of batches) {
    await Promise.all(
      batch.map(async (url) => {
        const t0 = Date.now();

        for (let attempt = 1; attempt <= MAX_EDGE_RETRIES; attempt++) {
          try {
            const res = await axios.get(
              url,
              buildAxiosCfg(country, { timeout: 15000 })
            );

            const cfCache = res.headers["cf-cache-status"] || "N/A";
            const lsCache = res.headers["x-litespeed-cache"] || "N/A";
            const cfRay = res.headers["cf-ray"] || "N/A";
            const cfEdge = extractCfEdge(cfRay);
            const dt = Date.now() - t0;

            console.log(
              `[${cfEdge}] try=${attempt} cf=${cfCache} ls=${lsCache} ${url}`
            );

            if (TARGET_EDGES_EU.includes(cfEdge)) {
              logger.log({
                country: cfEdge,
                url,
                status: res.status,
                cfCache,
                lsCache,
                cfRay,
                responseMs: dt,
                message: `EU edge reached (try ${attempt})`,
              });

              if (String(lsCache).toLowerCase() !== "hit") {
                await purgeCloudflareCache(url);
              }
              return;
            }

            await sleep(1500);
          } catch {
            await sleep(1500);
          }
        }

        logger.log({
          country,
          url,
          error: 1,
          message: "EU edge not reached",
        });
      })
    );

    await sleep(delay);
  }
}

/* ====== MAIN ====== */
(async () => {
  console.log("[CacheWarmer] Started");
  const logger = new AppsScriptLogger();

  try {
    await Promise.all(
      Object.entries(DOMAINS_MAP).map(async ([country, domain]) => {
        const sitemaps = await fetchIndexSitemaps(domain, country);
        const urls = (
          await Promise.all(
            sitemaps.map((s) => fetchUrlsFromSitemap(s, country))
          )
        )
          .flat()
          .filter(Boolean);

        logger.log({
          country,
          message: `Found ${urls.length} URLs`,
        });

        await warmUrls(urls, country, logger);
      })
    );
  } finally {
    logger.setFinished();
    await logger.flush();
  }

  console.log("[CacheWarmer] Finished");
})();
