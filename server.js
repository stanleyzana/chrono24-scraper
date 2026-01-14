require('dotenv').config();

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { Redis } = require("@upstash/redis");

const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3001;
const PROXY_URL = (process.env.PROXY_URL || "").trim() || null;

// âœ… Redis avec Upstash REST API (pas de problÃ¨me DNS)
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

console.log("âœ… Redis REST configurÃ©");

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
  return (s || "").replace(/\u00A0|\u202F/g, " ").replace(/\s+/g, " ").trim();
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
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    const url = route.request().url();
    if (["media", "font"].includes(t)) route.abort();
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
    'button:has-text("J\'accepte")',
    'button:has-text("Accept")',
  ];
  await page.waitForTimeout(randInt(250, 650));
  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(randInt(150, 400));
        return;
      }
    } catch {}
  }
}

async function simulateHuman(page) {
  try {
    await page.evaluate(() => window.scrollTo(0, Math.random() * 500));
    await page.waitForTimeout(randInt(150, 400));
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
        .map((a) => ({
          href: a.getAttribute("href") || "",
          inMain: !!a.closest("main"),
          text: (a.textContent || "").trim(),
        }))
        .filter((x) => x.href && x.href.includes("--id"))
    );
    let filtered = links;
    if (selectorUsed === anySel && links.some((x) => x.inMain)) {
      filtered = links.filter((x) => x.inMain);
    }
    filtered = filtered.filter((x) => x.href.includes(".htm"));
    const byId = new Map();
    for (const l of filtered) {
      const fullUrl = l.href.startsWith("http") ? l.href : `https://www.chrono24.fr${l.href}`;
      const id = extractListingId(fullUrl);
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        url: fullUrl,
        title: l.text && l.text.length > 3 ? l.text : `Listing ${id}`,
      });
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
    await sleep(randInt(700, 1400));
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

// âœ… Fonction de scraping de prix (similaire Ã  avant)
async function scrapePriceForListing(listingUrl) {
  const br = await getBrowser(false);
  const { context, page } = await createPage(br, true);
  try {
    console.log("[PRICE] goto", listingUrl);
    await page.goto(listingUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await acceptCookies(page);
    await simulateHuman(page);
    
    // Priorité 1: JSON-LD (le plus fiable)
    const priceFromJsonLd = await page.evaluate(() => {
      try {
        const scripts = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of scripts) {
          const data = JSON.parse(script.textContent);
          if (data.offers?.price) {
            return parseInt(data.offers.price.toString().replace(/[^0-9]/g, ''), 10);
          }
          if (data['@type'] === 'Product' && data.offers?.[0]?.price) {
            return parseInt(data.offers[0].price.toString().replace(/[^0-9]/g, ''), 10);
          }
        }
      } catch (e) {}
      return null;
    });
    
    if (priceFromJsonLd) return priceFromJsonLd;
    
    // Priorité 2: Meta tags
    const priceFromMeta = await page.evaluate(() => {
      const metaPrice = document.querySelector('meta[itemprop="price"]');
      if (metaPrice) {
        const price = metaPrice.getAttribute('content');
        return price ? parseInt(price.replace(/[^0-9]/g, ''), 10) : null;
      }
      return null;
    });
    
    if (priceFromMeta) return priceFromMeta;
    
    // Priorité 3: Sélecteurs CSS (fallback)
    const priceText = await page.evaluate(() => {
      const selectors = [
        '.js-price-shipping-country[data-price]',
        '[data-testid="price"]',
        '.m-price',
        '.js-price'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          return el.getAttribute('data-price') || el.textContent;
        }
      }
      return null;
    });
    
    if (!priceText) return null;
    
    const cleaned = priceText.replace(/[^0-9]/g, '');
    return cleaned ? parseInt(cleaned, 10) : null;
  } catch (error) {
    console.error('[PRICE ERROR]', listingUrl, error.message);
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= ROUTES =================

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

// ðŸš€ Scrape avec rÃ©cupÃ©ration de prix en background
app.post("/api/scrape", async (req, res) => {
  console.log("[HIT] /api/scrape", new Date().toISOString(), req.body);
  try {
    const { url, pageSize = 30, maxPages = 1, noCache = false, withPrices = false } = req.body || {};
    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }

    const key = JSON.stringify({ url, pageSize, maxPages });
    if (!noCache) {
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    const listOut = await scrapeList(url, Number(pageSize), Number(maxPages));

    // Si pas de prix demandÃ©s, retourner directement
    if (!withPrices) {
      const response = {
        ...listOut,
        message: `${listOut.count} annonces rÃ©cupÃ©rÃ©es`,
      };
      cacheSet(key, response);
      return res.json(response);
    }

    // Sinon, crÃ©er un job et stocker dans Redis
    const jobId = `job:${Date.now()}:${Math.random().toString(36).substr(2, 9)}`;
    await redis.set(jobId, JSON.stringify({
      status: 'pending',
      listings: listOut.items,
      total: listOut.items.length,
      processed: 0,
      results: [],
      createdAt: new Date().toISOString()
    }), { ex: 3600 }); // 1h TTL

    // Lancer le traitement en background
    (async () => {
      const results = [];
      // Lancer le traitement en background
(async () => {
  const results = [];
  for (let i = 0; i < listOut.items.length; i++) {
    const listing = listOut.items[i];
    const price = await scrapePriceForListing(listing.url);
    results.push({ ...listing, price });
    
    // Update progress
    await redis.set(jobId, JSON.stringify({...}), { ex: 3600 });
    
    await sleep(randInt(500, 1000));
  }
      // Mark as completed
      await redis.set(jobId, JSON.stringify({
        status: 'completed',
        total: listOut.items.length,
        processed: listOut.items.length,
        results,
        completedAt: new Date().toISOString()
      }), { ex: 3600 });
    })().catch(err => {
      console.error('[JOB ERROR]', jobId, err);
      redis.set(jobId, JSON.stringify({
        status: 'failed',
        error: err.message,
        failedAt: new Date().toISOString()
      }), { ex: 3600 });
    });

    const response = {
      ...listOut,
      jobId,
      pricesStatus: 'pending',
      message: `${listOut.count} annonces rÃ©cupÃ©rÃ©es. Prix en cours de rÃ©cupÃ©ration...`,
      statusUrl: `/api/jobs/${jobId}/status`,
      resultsUrl: `/api/jobs/${jobId}/results`
    };

    res.json(response);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// VÃ©rifier le statut d'un job
app.get("/api/jobs/:jobId/status", async (req, res) => {
  try {
    const { jobId } = req.params;
    const data = await redis.get(jobId);

    if (!data) {
      return res.status(404).json({ error: 'Job non trouvÃ©' });
    }

    const job = JSON.parse(data);
    res.json({
      jobId,
      status: job.status,
      progress: job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0,
      processed: job.processed,
      total: job.total,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// RÃ©cupÃ©rer les rÃ©sultats
app.get("/api/jobs/:jobId/results", async (req, res) => {
  try {
    const { jobId } = req.params;
    const data = await redis.get(jobId);

    if (!data) {
      return res.status(404).json({ error: 'Job non trouvÃ©' });
    }

    const job = JSON.parse(data);

    if (job.status !== 'completed') {
      return res.json({
        status: job.status,
        message: job.status === 'active' ? 'Traitement en cours...' : 'Pas encore terminÃ©',
        progress: job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0
      });
    }

    res.json({
      status: 'completed',
      jobId,
      count: job.results.length,
      prices: job.results,
      completedAt: job.completedAt
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ancien endpoint (compatibilitÃ©)
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
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ðŸš€ Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
  } finally {
    process.exit(0);
  }
});
