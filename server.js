/**
 * Chrono24 Bulletproof Scraper (PRO)
 * - CommonJS (require), no external concurrency deps
 * - Pagination multi-pages (page + pageSize) using URLSearchParams (keeps original query params)
 * - Link-first STRICT: ONLY `main a[href*="--id"][href$=".htm"]`
 * - Dedup STRICT: ONLY /--id(\d+)\.htm/i
 * - Fast by default: detailMode controls detail scraping: "none" | "missing" | "all"
 * - Detail fallback is resilient: longer timeout + 1 retry on timeout, NEVER crashes the whole batch
 * - Fail-fast FINAL exact (only on count) when detailMode is irrelevant:
 *     If expectedCount found and after pagination+dedup count != expectedCount => 500 with meta
 * - Adds small delay between page navigations to reduce rate limiting (no fingerprint hacks)
 */

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;

// ================= CONFIG =================
const CONFIG = {
  cacheTTLms: 10 * 60 * 1000, // 10 min
  viewport: { width: 1920, height: 1080 },
  locale: "fr-FR",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",

  // Timeouts
  listGotoTimeoutMs: 60000,
  listSelectorTimeoutMs: 30000,
  detailGotoTimeoutMs: 60000,
  detailRetryCount: 1, // one retry on timeout

  // Concurrency
  detailConcurrency: 4,

  // Politeness
  betweenPagesDelayMsMin: 300,
  betweenPagesDelayMsMax: 800,
};

// ================= INLINE CONCURRENCY LIMITER =================
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= concurrency) return;
    const job = queue.shift();
    if (!job) return;

    active++;
    const { fn, resolve, reject } = job;

    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ================= CACHE =================
const cache = new Map();
function getCached(key, noCache) {
  if (noCache) return null;
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CONFIG.cacheTTLms) {
    cache.delete(key);
    return null;
  }
  return e.data;
}
function setCache(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

// ================= BROWSER =================
let browserInstance = null;
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browserInstance;
}

async function createPage(br) {
  const context = await br.newContext({
    locale: CONFIG.locale,
    userAgent: CONFIG.userAgent,
    viewport: CONFIG.viewport,
    extraHTTPHeaders: { "Accept-Language": CONFIG.acceptLanguage },
  });

  const page = await context.newPage();

  // speed/stability: block heavy resources
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (["image", "font", "media"].includes(t)) route.abort();
    else route.continue();
  });

  return { context, page };
}

// ================= HELPERS =================
function normalize(s) {
  return (s || "").replace(/\u00A0|\u202F/g, " ").replace(/\s+/g, " ").trim();
}

function extractListingId(url) {
  const m = (url || "").match(/--id(\d+)\.htm/i);
  return m ? m[1] : null;
}

function parseEuroFromText(s) {
  const t = normalize(s);
  const m = t.match(/(\d{1,3}(?:[ .]\d{3})+)\s?€/);
  if (!m) return null;
  const v = Number(m[1].replace(/[ .]/g, ""));
  return Number.isFinite(v) ? v : null;
}

function withParams(inputUrl, params) {
  const u = new URL(inputUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function acceptCookies(page) {
  const sels = [
    "#onetrust-accept-btn-handler",
    '[data-testid="uc-accept-all-button"]',
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter")',
    'button:has-text("J\'accepte")',
  ];
  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(300);
        return;
      }
    } catch {}
  }
}

async function getExpectedCount(page) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const m = bodyText.match(/(\d+)\s+(?:annonces?|résultats?|montres?)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

// ================= CARD EXTRACTION (LIST) =================
async function extractTitle(card) {
  const sels = [".article-title", "h3", "h2"];
  for (const s of sels) {
    try {
      const el = await card.$(s);
      if (!el) continue;
      const t = normalize(await el.textContent());
      if (t) return t;
    } catch {}
  }
  return null;
}

async function extractCountry(card) {
  const sels = ['[class*="country"]', '[class*="location"]'];
  for (const s of sels) {
    try {
      const el = await card.$(s);
      if (!el) continue;
      const t = normalize(await el.textContent());
      if (t) return t;
    } catch {}
  }
  return null;
}

async function extractSponsored(card) {
  try {
    const t = await card.evaluate((n) => n.innerText || "");
    return /sponsor|promoted|publicité/i.test(t);
  } catch {
    return false;
  }
}

async function extractPriceFromCard(card) {
  // 1) meta itemprop price (rare on list, but try)
  try {
    const meta = await card.$('meta[itemprop="price"]');
    if (meta) {
      const c = await meta.getAttribute("content");
      if (c) {
        const v = Number(String(c).replace(/[^\d]/g, ""));
        if (v > 0) return { price: v, priceSource: "card-meta" };
      }
    }
  } catch {}

  // 2) "on request"
  try {
    const txt = await card.evaluate((n) => n.innerText || "");
    if (/prix sur demande|price on request/i.test(txt)) return { price: null, priceSource: "on-request" };
  } catch {}

  // 3) price blocks (inside card only)
  const sels = ['[data-testid="price"]', '[class*="price"]'];
  for (const s of sels) {
    try {
      const el = await card.$(s);
      if (!el) continue;
      const t = normalize(await el.textContent());
      if (!t) continue;
      if (/frais de port|shipping/i.test(t) || /^\+/.test(t)) continue;
      if (/prix sur demande|price on request/i.test(t)) return { price: null, priceSource: "on-request" };

      const v = parseEuroFromText(t);
      if (v) return { price: v, priceSource: "card-dom" };
    } catch {}
  }

  return { price: null, priceSource: "missing" };
}

// ================= DETAIL FALLBACK (RESILIENT) =================
async function enrichFromDetail(br, item) {
  const { context, page } = await createPage(br);

  const attempt = async () => {
    await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: CONFIG.detailGotoTimeoutMs });
    await acceptCookies(page);

    // meta itemprop
    const meta = await page.$('meta[itemprop="price"]');
    if (meta) {
      const c = await meta.getAttribute("content");
      if (c) {
        const v = Number(String(c).replace(/[^\d]/g, ""));
        if (v > 0) {
          item.price = v;
          item.priceSource = "detail-meta";
          return true;
        }
      }
    }

    // JSON-LD
    const jsonlds = await page.$$eval('script[type="application/ld+json"]', (nodes) =>
      nodes.map((n) => n.textContent).filter(Boolean)
    );

    for (const raw of jsonlds) {
      try {
        const data = JSON.parse(raw);
        const candidates = Array.isArray(data) ? data : [data];

        for (const c of candidates) {
          if (c?.offers?.price) {
            const v = Number(String(c.offers.price).replace(/[^\d]/g, ""));
            if (v > 0) {
              item.price = v;
              item.priceSource = "detail-jsonld";
              return true;
            }
          }
          if (c?.["@graph"] && Array.isArray(c["@graph"])) {
            for (const g of c["@graph"]) {
              if (g?.offers?.price) {
                const v = Number(String(g.offers.price).replace(/[^\d]/g, ""));
                if (v > 0) {
                  item.price = v;
                  item.priceSource = "detail-jsonld";
                  return true;
                }
              }
            }
          }
        }
      } catch {}
    }

    // on-request fallback
    const body = await page.evaluate(() => document.body?.innerText || "");
    if (/prix sur demande|price on request/i.test(body)) {
      item.price = null;
      item.priceSource = "on-request";
      return true;
    }

    item.priceSource = "detail-missing";
    return true;
  };

  try {
    return await attempt();
  } catch (e) {
    const msg = String(e?.message || e);
    const isTimeout = /Timeout/i.test(msg);

    if (isTimeout && CONFIG.detailRetryCount > 0) {
      try {
        await page.waitForTimeout(500);
        return await attempt();
      } catch {
        item.price = null;
        item.priceSource = "detail-timeout";
        return false;
      }
    }

    item.price = null;
    item.priceSource = "detail-error";
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= SCRAPE ONE LIST PAGE (LINK-FIRST STRICT) =================
async function scrapeOnePage(br, pageUrl) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: CONFIG.listGotoTimeoutMs });
    await acceptCookies(page);

    await page.waitForSelector('main a[href*="--id"][href$=".htm"]', {
      timeout: CONFIG.listSelectorTimeoutMs,
    });

    const expectedCount = await getExpectedCount(page);

    const links = await page.$$('main a[href*="--id"][href$=".htm"]');
    const byId = new Map();

    for (const link of links) {
      const href = await link.getAttribute("href");
      if (!href) continue;
      const full = href.startsWith("http") ? href : `https://www.chrono24.fr${href}`;

      const id = extractListingId(full);
      if (!id || byId.has(id)) continue;

      const card = await link.evaluateHandle((a) => a.closest("article") || a.closest("li") || a.closest("div"));
      byId.set(id, { id, url: full, card });
    }

    const items = [];
    for (const v of byId.values()) {
      const title = (await extractTitle(v.card)) || `Listing ${v.id}`;
      const country = await extractCountry(v.card);
      const isSponsored = await extractSponsored(v.card);
      const pr = await extractPriceFromCard(v.card);

      items.push({
        id: v.id,
        url: v.url,
        title,
        country,
        isSponsored,
        price: pr.price,
        priceSource: pr.priceSource,
      });
    }

    return { expectedCount, items };
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= MAIN (PAGINATION + DETAILMODE + FAIL-FAST FINAL) =================
async function scrapeChrono24(url, opts) {
  const pageSize = Number(opts.pageSize || 120);
  const maxPages = Number(opts.maxPages || 50);
  const noCache = !!opts.noCache;
  const detailMode = String(opts.detailMode || "missing"); // "none" | "missing" | "all"

  const cacheKey = JSON.stringify({ url, pageSize, maxPages, detailMode });
  const cached = getCached(cacheKey, noCache);
  if (cached) return { ...cached, fromCache: true };

  const br = await getBrowser();

  // page 1
  const url1 = withParams(url, { pageSize, page: 1 });
  const first = await scrapeOnePage(br, url1);

  const expectedCount = first.expectedCount;
  const totalPages =
    typeof expectedCount === "number" && expectedCount > 0
      ? Math.min(maxPages, Math.ceil(expectedCount / pageSize))
      : 1;

  const all = new Map(first.items.map((x) => [x.id, x]));
  let pagesScraped = 1;

  for (let p = 2; p <= totalPages; p++) {
    const pageUrl = withParams(url, { pageSize, page: p });
    const { items } = await scrapeOnePage(br, pageUrl);
    for (const it of items) all.set(it.id, it);
    pagesScraped = p;

    await sleep(randInt(CONFIG.betweenPagesDelayMsMin, CONFIG.betweenPagesDelayMsMax));
  }

  const items = [...all.values()];

  // detail fallback per mode (resilient, never crashes batch)
  const limit = createLimiter(CONFIG.detailConcurrency);

  if (detailMode !== "none") {
    const targets =
      detailMode === "all"
        ? items
        : items.filter((it) => it.priceSource === "missing");

    await Promise.all(
      targets.map((it) =>
        limit(async () => {
          await enrichFromDetail(br, it);
        })
      )
    );
  }

  // FAIL-FAST FINAL EXACT on count (true bulletproof for pagination)
  if (typeof expectedCount === "number" && expectedCount > 0 && items.length !== expectedCount) {
    const e = new Error(`Count mismatch after pagination: expected ${expectedCount}, got ${items.length}`);
    e.meta = { expectedCount, got: items.length, pagesScraped, pageSize, sample: items.slice(0, 5) };
    throw e;
  }

  // stats
  const stats = {
    total: items.length,
    withPrice: items.filter((x) => typeof x.price === "number" && x.price > 0).length,
    onRequest: items.filter((x) => x.priceSource === "on-request").length,
    detailTimeout: items.filter((x) => x.priceSource === "detail-timeout").length,
    detailError: items.filter((x) => x.priceSource === "detail-error").length,
    missing: items.filter((x) => x.priceSource === "missing" || x.priceSource === "detail-missing").length,
  };

  const result = {
    expectedCount,
    count: items.length,
    pageSize,
    pagesScraped,
    detailMode,
    items,
    stats,
  };

  setCache(cacheKey, result);
  return result;
}

// ================= ROUTES =================
app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

app.post("/api/scrape", async (req, res) => {
  try {
    const { url, pageSize, maxPages, noCache, detailMode } = req.body || {};
    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }
    const out = await scrapeChrono24(url, { pageSize, maxPages, noCache, detailMode });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, meta: e.meta || null });
  }
});

app.post("/api/cache/clear", (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

// ================= STARTUP =================
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
  } finally {
    process.exit(0);
  }
});

process.on("SIGINT", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
  } finally {
    process.exit(0);
  }
});
