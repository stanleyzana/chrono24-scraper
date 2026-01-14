require('dotenv').config();
const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");
const { priceQueue } = require('./services/priceQueue');
const redis = require('./services/redis');

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3001;

const PROXY_URL = (process.env.PROXY_URL || "").trim() || null;

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
    const m = text.match(/(\d+)\s+(?:annonces?|résultats?|montres?|watches?|listings?)/i);
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
      error: error.message
    });
  }
});

// 🚀 NOUVEAU : Scrape rapide avec job async
app.post("/api/scrape", async (req, res) => {
  console.log("[HIT] /api/scrape", new Date().toISOString(), req.body);
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

    const listOut = await scrapeList(url, Number(pageSize), Number(maxPages));

    const job = await priceQueue.add('scrape-prices', {
      listings: listOut.items,
      query: url
    });

    const response = {
      ...listOut,
      jobId: job.id,
      pricesStatus: 'pending',
      message: `${listOut.count} annonces récupérées. Prix en cours de récupération...`,
      statusUrl: `/api/jobs/${job.id}/status`,
      resultsUrl: `/api/jobs/${job.id}/results`
    };

    cacheSet(key, response);
    res.json(response);

  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 🚀 NOUVEAU : Vérifier le statut d'un job
app.get("/api/jobs/:jobId/status", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await priceQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job non trouvé' });
    }

    const state = await job.getState();
    const progress = job.progress || 0;

    res.json({
      jobId,
      state,
      progress,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// 🚀 NOUVEAU : Récupérer les résultats
app.get("/api/jobs/:jobId/results", async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = await priceQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job non trouvé' });
    }

    const state = await job.getState();

    if (state !== 'completed') {
      return res.json({
        status: state,
        message: state === 'active' ? 'Traitement en cours...' : 'Pas encore terminé',
        progress: job.progress || 0
      });
    }

    const results = job.returnvalue;
    res.json({
      status: 'completed',
      jobId,
      count: results.length,
      prices: results,
      completedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Ancien endpoint (compatibilité)
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

app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
    await priceQueue.close();
  } finally {
    process.exit(0);
  }
});
