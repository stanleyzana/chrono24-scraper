const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3001;

// ===== Proxy config kept (safe trim), but optional =====
const PROXY_URL = (process.env.PROXY_URL || "").trim() || null;

// ===== Config =====
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
  detailGotoTimeoutMs: 25000,
  detailRetryCount: 1,
  enrichConcurrency: 4,
};

// ===== Small in-memory cache (debugging convenience) =====
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

// ===== Utils =====
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
function parseEuroFromText(s) {
  const t = normalize(s);
  const m = t.match(/(\d{1,3}(?:[ .]\d{3})+)\s?€/);
  if (!m) return null;
  const v = Number(m[1].replace(/[ .]/g, ""));
  return Number.isFinite(v) ? v : null;
}

// ===== Concurrency limiter (no deps) =====
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

// ===== Browser =====
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

  // light blocking
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

// ===== Core: scrape ONE list page (fast, robust) =====
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

    // strict listing links
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

// ===== Core: fetch price from detail page =====
async function fetchPriceFromDetail(url) {
  const br = await getBrowser(false);

  const attemptOnce = async () => {
    const { context, page } = await createPage(br, false);
    try {
      await page.goto(url, { waitUntil: "commit", timeout: CONFIG.detailGotoTimeoutMs });
      await acceptCookies(page);

      // meta price
      const meta = await page.$('meta[itemprop="price"]');
      if (meta) {
        const c = await meta.getAttribute("content");
        if (c) {
          const v = Number(String(c).replace(/[^\d]/g, ""));
          if (v > 0) return { price: v, priceSource: "detail-meta" };
        }
      }

      // JSON-LD offers.price
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
              if (v > 0) return { price: v, priceSource: "detail-jsonld" };
            }
            if (c?.["@graph"]) {
              for (const g of c["@graph"]) {
                if (g?.offers?.price) {
                  const v = Number(String(g.offers.price).replace(/[^\d]/g, ""));
                  if (v > 0) return { price: v, priceSource: "detail-jsonld" };
                }
              }
            }
          }
        } catch {}
      }

      const body = await page.evaluate(() => document.body?.innerText || "");
      if (/prix sur demande|price on request/i.test(body)) {
        return { price: null, priceSource: "on-request" };
      }

      return { price: null, priceSource: "detail-missing" };
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    return await attemptOnce();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Timeout/i.test(msg) && CONFIG.detailRetryCount > 0) {
      try {
        await sleep(300);
        return await attemptOnce();
      } catch {
        return { price: null, priceSource: "detail-timeout" };
      }
    }
    return { price: null, priceSource: "detail-error" };
  }
}

// ===== Endpoint logic: scrape list across pages (partial-safe) =====
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

app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    proxy: PROXY_URL ? PROXY_URL.replace(/:[^:]+@/, ":***@") : "none",
  })
);

// Debug: can we reach Chrono24?
app.get("/api/ping-chrono24", async (req, res) => {
  let br, context;
  try {
    br = await getBrowser(true);
    const pageObj = await createPage(br, false);
    context = pageObj.context;
    const page = pageObj.page;

    const resp = await page.goto("https://www.chrono24.fr", { waitUntil: "commit", timeout: 30000 });
    const status = resp ? resp.status() : null;
    const title = await page.title().catch(() => "");
    res.json({ ok: true, status, title, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// Debug: load any url and return title + html head
app.get("/api/debug-goto", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: "Missing ?url=" });

  let br, context;
  try {
    br = await getBrowser(true);
    const pageObj = await createPage(br, false);
    context = pageObj.context;
    const page = pageObj.page;

    const resp = await page.goto(String(url), { waitUntil: "commit", timeout: 30000 });
    const status = resp ? resp.status() : null;
    const title = await page.title().catch(() => "");
    const html = await page.content().catch(() => "");
    res.json({ ok: true, status, title, htmlHead: html.slice(0, 900) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// 1) FAST: list only
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

// 2) ENRICH PRICES: batch detail pages
app.post("/api/enrich-prices", async (req, res) => {
  console.log("[HIT] /api/enrich-prices", new Date().toISOString());

  try {
    const { items, urls, batchSize = 10 } = req.body || {};

    const list =
      Array.isArray(items) ? items :
      Array.isArray(urls) ? urls.map((u) => ({ url: u })) :
      [];

    if (!Array.isArray(list) || list.length === 0) {
      return res.status(400).json({ error: "Provide items:[{id,url}] or urls:[...]" });
    }

    const limit = createLimiter(CONFIG.enrichConcurrency);
    const start = Date.now();

    const slice = list.slice(0, Number(batchSize));
    const results = await Promise.all(
      slice.map((it) =>
        limit(async () => {
          const url = it.url;
          const id = it.id || extractListingId(url) || null;

          const pr = await fetchPriceFromDetail(url);
          return { id, url, ...pr };
        })
      )
    );

    res.json({
      ok: true,
      batchSize: slice.length,
      ms: Date.now() - start,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// Backward compatible: /api/scrape = list + (optional) enrich by budget
app.post("/api/scrape", async (req, res) => {
  console.log("[HIT] /api/scrape", new Date().toISOString(), req.body);

  try {
    const {
      url,
      pageSize = 30,
      maxPages = 1,
      noCache = false,
      enrichPrices = true,
      maxDetailLookups = Number(pageSize),
      detailTimeBudgetMs = 150000
    } = req.body || {};

    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }

    const key = JSON.stringify({ url, pageSize, maxPages, enrichPrices, maxDetailLookups, detailTimeBudgetMs });
    if (!noCache) {
      const cached = cacheGet(key);
      if (cached) return res.json({ ...cached, fromCache: true });
    }

    const listOut = await scrapeList(url, Number(pageSize), Number(maxPages));

    // Optional inline enrichment (bounded)
    let attempted = 0;
    let done = 0;

    if (enrichPrices) {
      const missing = listOut.items.slice(0, Number(maxDetailLookups));
      const limit = createLimiter(CONFIG.enrichConcurrency);
      const start = Date.now();

      await Promise.all(
        missing.map((it) =>
          limit(async () => {
            if (Date.now() - start > Number(detailTimeBudgetMs)) return;
            attempted++;
            const pr = await fetchPriceFromDetail(it.url);
            if (pr.price != null) done++;
            it.price = pr.price;
            it.priceSource = pr.priceSource;
            await sleep(randInt(150, 450));
          })
        )
      );
    }

    const out = {
      ...listOut,
      enrichPrices,
      maxDetailLookups,
      detailTimeBudgetMs,
      detailLookupsAttempted: attempted,
      detailLookupsDone: done,
    };

    cacheSet(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

process.on("SIGTERM", async () => {
  try {
    if (browserInstance) await browserInstance.close().catch(() => {});
  } finally {
    process.exit(0);
  }
});
