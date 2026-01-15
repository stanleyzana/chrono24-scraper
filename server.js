/**
 * Chrono24 Scraper — FINAL (1 deploy, then stop touching it)
 *
 * Goals achieved:
 * ✅ Correct titles (from listing card, not pagination links)
 * ✅ Robust price extraction (JSON-LD array/@graph/offers + meta itemprop + OG product meta + DOM fallback)
 * ✅ Async job UX (POST /api/scrape returns immediately with jobId)
 * ✅ Reliable Redis parsing (safeJsonParse fixes "Unexpected token o")
 * ✅ Lightweight status updates during job (no huge payload spam to Redis)
 * ✅ Render port binding + stable browser singleton
 *
 * Endpoints:
 * - GET  /health
 * - POST /api/scrape        { url, pageSize, maxPages, noCache, withPrices }
 * - GET  /api/jobs/:jobId/status
 * - GET  /api/jobs/:jobId/results
 * - POST /api/scrape-list   (list only)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Redis } = require("@upstash/redis");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 10000);
const PROXY_URL = (process.env.PROXY_URL || "").trim() || null;

// Upstash Redis (REST)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

console.log("✅ Redis REST configuré");

const CONFIG = {
  viewport: { width: 1920, height: 1080 },
  locale: "fr-FR",
  acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  ],
  listGotoTimeoutMs: 90000,
  listSelectorTimeoutMs: 60000,
  detailGotoTimeoutMs: 30000,
  priceConcurrency: 3,
};

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) return null;
  return e.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function normalize(s) {
  return (s || "").replace(/[\u00A0\u202F]/g, " ").replace(/\s+/g, " ").trim();
}
function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
function extractListingId(url) {
  const m = (url || "").match(/--id(\d+)\.htm/i);
  return m ? m[1] : null;
}
function withParams(inputUrl, params) {
  const u = new URL(inputUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

// -------------------- Playwright browser singleton --------------------
let browserInstance = null;

async function getBrowser(forceNew = false) {
  if (browserInstance && forceNew) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
  if (!browserInstance) {
    const opts = {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    };
    if (PROXY_URL) {
      opts.proxy = { server: PROXY_URL };
      console.log("[Browser] Using proxy:", PROXY_URL.replace(/:[^:]+@/, ":***@"));
    } else {
      console.log("[Browser] Direct connection (no proxy)");
    }
    browserInstance = await chromium.launch(opts);
  }
  return browserInstance;
}

function pickUA() {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}

async function createPage(br, stealth = true) {
  const context = await br.newContext({
    locale: CONFIG.locale,
    userAgent: pickUA(),
    viewport: CONFIG.viewport,
    extraHTTPHeaders: {
      "Accept-Language": CONFIG.acceptLanguage,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Upgrade-Insecure-Requests": "1",
    },
    javaScriptEnabled: true,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  // Speed: block heavy resources
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    const url = route.request().url();
    if (["media", "font", "stylesheet"].includes(t)) route.abort();
    else if (t === "image" && !url.includes("chrono24")) route.abort();
    else route.continue();
  });

  if (stealth) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      window.chrome = { runtime: {} };
    });
  }

  return { context, page };
}

async function acceptCookies(page) {
  const sels = [
    "#onetrust-accept-btn-handler",
    '[data-testid="uc-accept-all-button"]',
    'button:has-text("Tout accepter")',
    'button:has-text("Accepter")',
    "button:has-text(\"J'accepte\")",
    'button:has-text("Accept")',
  ];
  await page.waitForTimeout(randInt(200, 500));
  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(randInt(150, 350));
        return;
      }
    } catch {}
  }
}

async function simulateHuman(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, Math.random() * 500));
    await page.waitForTimeout(randInt(120, 260));
  } catch {}
}

async function getExpectedCount(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || "");
    const m = text.match(/(\d+)\s+(?:annonces?|resultats?|montres?|watches?|listings?)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/**
 * LIST PAGE: extract listing links AND titles from the card (not link text)
 */
async function scrapeListPage(pageUrl) {
  const br = await getBrowser(false);
  const { context, page } = await createPage(br, true);

  try {
    console.log("[LIST] goto", pageUrl);
    await page.goto(pageUrl, { waitUntil: "commit", timeout: CONFIG.listGotoTimeoutMs });
    await acceptCookies(page);
    await simulateHuman(page);

    const mainSel = 'main a[href*="--id"]';
    const anySel = 'a[href*="--id"]';
    let selectorUsed = mainSel;

    try {
      await page.waitForSelector(mainSel, { timeout: CONFIG.listSelectorTimeoutMs, state: "attached" });
    } catch {
      selectorUsed = anySel;
      await page.waitForSelector(anySel, { timeout: CONFIG.listSelectorTimeoutMs, state: "attached" });
    }

    const expectedCount = await getExpectedCount(page);

    const links = await page.$$eval(selectorUsed, (as) =>
      as
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const inMain = !!a.closest("main");

          const card = a.closest("article") || a.closest("li") || a.closest("div");
          let title = "";
          if (card) {
            const h = card.querySelector("h3, h2, [class*='title'], [data-testid*='title']");
            title = (h?.textContent || "").trim();
          }
          return { href, inMain, title };
        })
        .filter((x) => x.href && x.href.includes("--id") && x.href.includes(".htm"))
    );

    let filtered = links;
    if (selectorUsed === anySel && links.some((x) => x.inMain)) {
      filtered = links.filter((x) => x.inMain);
    }

    const byId = new Map();
    for (const l of filtered) {
      const fullUrl = l.href.startsWith("http") ? l.href : `https://www.chrono24.fr${l.href}`;
      const id = extractListingId(fullUrl);
      if (!id || byId.has(id)) continue;

      const t = normalize(l.title);
      byId.set(id, { id, url: fullUrl, title: t && t.length > 3 ? t : `Listing ${id}` });
    }

    return { expectedCount, items: [...byId.values()] };
  } finally {
    await context.close().catch(() => {});
  }
}

async function scrapeList(url, pageSize, maxPages) {
  const url1 = withParams(url, { pageSize, page: 1 });
  const first = await scrapeListPage(url1);

  const expectedCount = first.expectedCount;
  const computedTotalPages =
    typeof expectedCount === "number" && expectedCount > 0 ? Math.ceil(expectedCount / pageSize) : 1;

  const totalPagesToScrape = Math.min(maxPages, computedTotalPages);

  const all = new Map(first.items.map((x) => [x.id, x]));
  let pagesScraped = 1;

  for (let p = 2; p <= totalPagesToScrape; p++) {
    const pageUrl = withParams(url, { pageSize, page: p });
    const next = await scrapeListPage(pageUrl);
    for (const it of next.items) all.set(it.id, it);
    pagesScraped = p;
    await sleep(randInt(500, 900));
  }

  return {
    scrapedAt: new Date().toISOString(),
    expectedCount,
    count: all.size,
    pageSize,
    pagesScraped,
    totalPages: computedTotalPages,
    maxPages,
    partial: pagesScraped !== computedTotalPages,
    warning: pagesScraped !== computedTotalPages ? `Partial: ${pagesScraped}/${computedTotalPages} pages` : null,
    items: [...all.values()],
  };
}

/**
 * DETAIL PRICE: robust JSON-LD + meta + fallback
 */
async function scrapePriceForListing(listingUrl) {
  const br = await getBrowser(false);
  const { context, page } = await createPage(br, true);

  try {
    console.log("[PRICE] goto", listingUrl);

    await page.goto(listingUrl, { waitUntil: "commit", timeout: CONFIG.detailGotoTimeoutMs });
    await acceptCookies(page);
    await simulateHuman(page);

    // JSON-LD robust
    const jsonLdResult = await page.evaluate(() => {
      function pickPriceFromObj(obj) {
        if (!obj) return null;

        const tryOffers = (off) => {
          if (!off) return null;
          if (off.price != null) {
            const v = parseInt(String(off.price).replace(/[^0-9]/g, ""), 10);
            if (v) return v;
          }
          if (off.lowPrice != null) {
            const v = parseInt(String(off.lowPrice).replace(/[^0-9]/g, ""), 10);
            if (v) return v;
          }
          return null;
        };

        const offers = obj.offers;
        if (Array.isArray(offers)) {
          for (const off of offers) {
            const v = tryOffers(off);
            if (v) return v;
          }
        } else {
          const v = tryOffers(offers);
          if (v) return v;
        }

        if (obj.price != null) {
          const v = parseInt(String(obj.price).replace(/[^0-9]/g, ""), 10);
          if (v) return v;
        }

        return null;
      }

      try {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const s of scripts) {
          const raw = s.textContent || "";
          if (!raw.trim()) continue;

          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }

          const candidates = Array.isArray(data) ? data : [data];

          for (const c of candidates) {
            const direct = pickPriceFromObj(c);
            if (direct) return { price: direct, priceSource: "jsonld" };

            if (c && Array.isArray(c["@graph"])) {
              for (const g of c["@graph"]) {
                const v = pickPriceFromObj(g);
                if (v) return { price: v, priceSource: "jsonld" };
              }
            }
          }
        }
      } catch {}
      return null;
    });
    if (jsonLdResult && jsonLdResult.price) return jsonLdResult;

    // Meta: itemprop + OG product:price:amount
    const metaResult = await page.evaluate(() => {
      const selectors = [
        'meta[itemprop="price"]',
        'meta[property="product:price:amount"]',
        'meta[name="product:price:amount"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const content = el.getAttribute("content");
        if (!content) continue;
        const v = parseInt(content.replace(/[^0-9]/g, ""), 10);
        if (v) return { price: v, priceSource: "meta" };
      }
      return null;
    });
    if (metaResult && metaResult.price) return metaResult;

    // Fallback DOM
    const fallbackResult = await page.evaluate(() => {
      const selectors = [
        '.js-price-shipping-country[data-price]',
        '[data-testid="price"]',
        ".m-price",
        ".js-price",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const raw = el.getAttribute("data-price") || el.textContent || "";
          const cleaned = String(raw).replace(/[^0-9]/g, "");
          if (cleaned) return { price: parseInt(cleaned, 10), priceSource: "fallback" };
        }
      }
      return null;
    });
    if (fallbackResult && fallbackResult.price) return fallbackResult;

    return { price: null, priceSource: "none" };
  } catch (error) {
    console.error("[PRICE ERROR]", listingUrl, error.message);
    return { price: null, priceSource: "error" };
  } finally {
    await context.close().catch(() => {});
  }
}

// -------------------- Routes --------------------
app.get("/", (req, res) => res.send("ok"));

app.get("/health", async (req, res) => {
  try {
    await redis.ping();
    res.json({
      status: "ok",
      ts: new Date().toISOString(),
      redis: "connected",
      proxy: PROXY_URL ? PROXY_URL.replace(/:[^:]+@/, ":***@") : "none",
    });
  } catch (error) {
    res.status(500).json({
      status: "error",
      redis: "disconnected",
      error: error.message,
    });
  }
});

app.post("/api/scrape", async (req, res) => {
  console.log("[HIT] /api/scrape", new Date().toISOString(), req.body);

  try {
    const { url, pageSize = 30, maxPages = 1, noCache = false, withPrices = false } = req.body || {};
    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }

    const key = JSON.stringify({ url, pageSize, maxPages, withPrices });
    if (!noCache) {
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    const listOut = await scrapeList(url, Number(pageSize), Number(maxPages));

    if (!withPrices) {
      const response = { ...listOut, message: `${listOut.count} annonces récupérées` };
      cacheSet(key, response);
      return res.json(response);
    }

    const jobId = `job:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;

    await redis.set(
      jobId,
      JSON.stringify({
        status: "pending",
        total: listOut.items.length,
        processed: 0,
        createdAt: new Date().toISOString(),
      }),
      { ex: 3600 }
    );

    // background worker
    (async () => {
      const CONCURRENCY = CONFIG.priceConcurrency;
      const results = [];

      async function processBatch(batch) {
        const batchResults = await Promise.all(
          batch.map(async (listing) => {
            const { price, priceSource } = await scrapePriceForListing(listing.url);
            return { ...listing, price, priceSource };
          })
        );
        return batchResults;
      }

      for (let i = 0; i < listOut.items.length; i += CONCURRENCY) {
        const batch = listOut.items.slice(i, i + CONCURRENCY);
        const batchResults = await processBatch(batch);
        results.push(...batchResults);

        // lightweight status update (no huge payload)
        await redis.set(
          jobId,
          JSON.stringify({
            status: "active",
            total: listOut.items.length,
            processed: results.length,
            updatedAt: new Date().toISOString(),
          }),
          { ex: 3600 }
        );

        await sleep(randInt(100, 250));
      }

      await redis.set(
        jobId,
        JSON.stringify({
          status: "completed",
          total: listOut.items.length,
          processed: listOut.items.length,
          results,
          completedAt: new Date().toISOString(),
        }),
        { ex: 3600 }
      );
    })().catch(async (err) => {
      console.error("[JOB ERROR]", jobId, err);
      await redis.set(
        jobId,
        JSON.stringify({
          status: "failed",
          error: err.message,
          failedAt: new Date().toISOString(),
        }),
        { ex: 3600 }
      );
    });

    const response = {
      ...listOut,
      jobId,
      pricesStatus: "pending",
      message: `${listOut.count} annonces récupérées. Prix en cours de récupération...`,
      statusUrl: `/api/jobs/${jobId}/status`,
      resultsUrl: `/api/jobs/${jobId}/results`,
    };

    cacheSet(key, response);
    return res.json(response);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/jobs/:jobId/status", async (req, res) => {
  try {
    const { jobId } = req.params;
    const data = await redis.get(jobId);

    if (!data) return res.status(404).json({ error: "Job non trouvé" });

    const job = safeJsonParse(data);
    if (!job) return res.status(500).json({ error: "Invalid job data in Redis" });

    res.json({
      jobId,
      status: job.status,
      progress: job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0,
      processed: job.processed,
      total: job.total,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/jobs/:jobId/results", async (req, res) => {
  try {
    const { jobId } = req.params;
    const data = await redis.get(jobId);

    if (!data) return res.status(404).json({ error: "Job non trouvé" });

    const job = safeJsonParse(data);
    if (!job) return res.status(500).json({ error: "Invalid job data in Redis" });

    if (job.status !== "completed") {
      return res.json({
        status: job.status,
        message: job.status === "active" ? "Traitement en cours..." : "Pas encore terminé",
        progress: job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0,
      });
    }

    res.json({
      status: "completed",
      jobId,
      count: Array.isArray(job.results) ? job.results.length : 0,
      prices: Array.isArray(job.results) ? job.results : [],
      completedAt: job.completedAt,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/scrape-list", async (req, res) => {
  console.log("[HIT] /api/scrape-list", new Date().toISOString(), req.body);
  try {
    const { url, pageSize = 30, maxPages = 1, noCache = false } = req.body || {};
    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }

    const key = JSON.stringify({ url, pageSize, maxPages });
    if (!noCache) {
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    const out = await scrapeList(url, Number(pageSize), Number(maxPages));
    cacheSet(key, out);
    return res.json(out);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
  } finally {
    process.exit(0);
  }
});
