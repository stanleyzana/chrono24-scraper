/**
 * Chrono24 Bulletproof Scraper v5 (Fixed, proxy untouched)
 * - Proxy section LEFT AS-IS (no changes)
 * - Chrome-only UAs
 * - Clean headers (no forced Sec-CH-UA / Sec-Fetch)
 * - Link-first strict in MAIN + safe global fallback filtered in ONE PASS (fast)
 * - Fail-fast exact after pagination
 * - Retry on timeout in enrichFromDetail (non-blocking)
 * - getBrowser(forceNew) properly closes old instance when forced (fix)
 */

const express = require("express");
const cors = require("cors");
const { chromium } = require("playwright");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3001;

// ================= PROXY CONFIG (UNCHANGED) =================
const PROXY_URL = (process.env.PROXY_URL || "").trim() || null;

const FREE_PROXIES = [
  // Add working ones from https://free-proxy-list.net/ (look for HTTPS, Elite, EU)
];

let currentProxyIndex = 0;
function getNextProxy() {
  if (PROXY_URL) return PROXY_URL;
  if (FREE_PROXIES.length === 0) return null;
  const proxy = FREE_PROXIES[currentProxyIndex % FREE_PROXIES.length];
  currentProxyIndex++;
  return proxy;
}

// ================= CONFIG =================
const CONFIG = {
  cacheTTLms: 10 * 60 * 1000,
  viewport: { width: 1920, height: 1080 },
  locale: "fr-FR",
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  ],
  acceptLanguage: "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
  detailConcurrency: 3,
  pageTimeout: 90000,
  selectorTimeout: 60000,
  detailRetryCount: 1,
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

// ================= RANDOM HELPERS =================
function randomDelay(min = 500, max = 2000) {
  return Math.floor(Math.random() * (max - min) + min);
}
function getRandomUserAgent() {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= BROWSER =================
let browserInstance = null;
let currentBrowserProxy = null;

async function getBrowser(forceNew = false) {
  const proxy = getNextProxy();

  // FIX: if forceNew, close old instance even if proxy didn't change
  if (browserInstance && forceNew) {
    console.log("[Browser] forceNew=true, closing existing browser");
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  // If proxy changed, close old browser
  if (browserInstance && proxy !== currentBrowserProxy) {
    console.log("[Browser] Proxy changed, closing old browser");
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }

  if (!browserInstance) {
    const launchOptions = {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
      ],
    };

    // proxy untouched
    if (proxy) {
      console.log(`[Browser] Using proxy: ${proxy.replace(/:[^:]+@/, ":***@")}`);
      launchOptions.proxy = { server: proxy };
    } else {
      console.log("[Browser] No proxy configured, using direct connection");
    }

    browserInstance = await chromium.launch(launchOptions);
    currentBrowserProxy = proxy;
  }

  return browserInstance;
}

async function createPage(br, stealth = true) {
  const userAgent = getRandomUserAgent();

  const context = await br.newContext({
    locale: CONFIG.locale,
    userAgent,
    viewport: CONFIG.viewport,
    extraHTTPHeaders: {
      "Accept-Language": CONFIG.acceptLanguage,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Upgrade-Insecure-Requests": "1",
    },
    javaScriptEnabled: true,
    bypassCSP: true,
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  if (stealth) {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) =>
        parameters.name === "notifications"
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);

      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages", { get: () => ["fr-FR", "fr", "en-US", "en"] });
      window.chrome = { runtime: {} };
    });
  }

  // keep your blocking rules (unchanged)
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    const url = route.request().url();

    if (["media", "font"].includes(t)) route.abort();
    else if (t === "image" && !url.includes("chrono24")) route.abort();
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

function isDetailPage(url) {
  return /--id\d+\.htm/i.test(url);
}

function parseEuroFromText(s) {
  const t = normalize(s);
  const patterns = [
    /(\d{1,3}(?:[ .]\d{3})+)\s?€/,
    /€\s?(\d{1,3}(?:[ ,.]\d{3})+)/,
    /(\d{4,})\s?€/,
  ];

  for (const pattern of patterns) {
    const m = t.match(pattern);
    if (m) {
      const v = Number(m[1].replace(/[ .,]/g, ""));
      if (Number.isFinite(v) && v > 100) return v;
    }
  }
  return null;
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
    'button:has-text("Accept All")',
    'button:has-text("Accept")',
  ];

  await page.waitForTimeout(randomDelay(500, 1500));

  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(randomDelay(300, 800));
        return;
      }
    } catch {}
  }
}

async function simulateHumanBehavior(page) {
  await page.evaluate(() => window.scrollTo(0, Math.random() * 500));
  await page.waitForTimeout(randomDelay(200, 600));
  await page.mouse.move(Math.random() * 800 + 100, Math.random() * 400 + 100);
}

async function getExpectedCount(page) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || "");
    const patterns = [
      /(\d+)\s+(?:annonces?|résultats?|montres?|watches?|listings?)/i,
      /(?:Total|Résultats?|Found)[\s:]+(\d+)/i,
    ];
    for (const pattern of patterns) {
      const m = bodyText.match(pattern);
      if (m) return Number(m[1]);
    }
    return null;
  } catch {
    return null;
  }
}

// ================= CARD EXTRACTION =================
async function extractTitle(card) {
  const sels = [".article-title", "h3", "h2", '[class*="title"]'];
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
  const sels = ['[class*="country"]', '[class*="location"]', '[class*="seller"]'];
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

  try {
    const txt = await card.evaluate((n) => n.innerText || "");
    if (/prix sur demande|price on request/i.test(txt)) return { price: null, priceSource: "on-request" };
  } catch {}

  const sels = ['[data-testid="price"]', '[class*="price"]', '[class*="Price"]'];
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

// ================= DETAIL PAGE SCRAPING =================
async function scrapeDetailPage(br, url) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: CONFIG.pageTimeout });
    await acceptCookies(page);
    await simulateHumanBehavior(page);

    const id = extractListingId(url);
    let title = null;
    let price = null;
    let priceSource = "missing";
    let country = null;

    const titleSels = ["h1", '[class*="title"]', ".article-title"];
    for (const s of titleSels) {
      try {
        const el = await page.$(s);
        if (el) {
          title = normalize(await el.textContent());
          if (title) break;
        }
      } catch {}
    }

    // meta
    try {
      const meta = await page.$('meta[itemprop="price"]');
      if (meta) {
        const c = await meta.getAttribute("content");
        if (c) {
          const v = Number(String(c).replace(/[^\d]/g, ""));
          if (v > 0) {
            price = v;
            priceSource = "detail-meta";
          }
        }
      }
    } catch {}

    // json-ld
    if (!price) {
      try {
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
                  price = v;
                  priceSource = "detail-jsonld";
                  break;
                }
              }
              if (c?.["@graph"]) {
                for (const g of c["@graph"]) {
                  if (g?.offers?.price) {
                    const v = Number(String(g.offers.price).replace(/[^\d]/g, ""));
                    if (v > 0) {
                      price = v;
                      priceSource = "detail-jsonld";
                      break;
                    }
                  }
                }
              }
            }
          } catch {}
        }
      } catch {}
    }

    // dom
    if (!price) {
      const priceSels = ['[class*="price"]', '[data-testid="price"]'];
      for (const s of priceSels) {
        try {
          const el = await page.$(s);
          if (el) {
            const t = normalize(await el.textContent());
            if (t && !/frais de port|shipping/i.test(t)) {
              const v = parseEuroFromText(t);
              if (v) {
                price = v;
                priceSource = "detail-dom";
                break;
              }
            }
          }
        } catch {}
      }
    }

    if (!price) {
      try {
        const body = await page.evaluate(() => document.body?.innerText || "");
        if (/prix sur demande|price on request/i.test(body)) priceSource = "on-request";
      } catch {}
    }

    const countrySels = ['[class*="seller-info"]', '[class*="location"]', '[class*="country"]'];
    for (const s of countrySels) {
      try {
        const el = await page.$(s);
        if (el) {
          country = normalize(await el.textContent());
          if (country) break;
        }
      } catch {}
    }

    return { id, url, title: title || `Listing ${id}`, price, priceSource, country, isSponsored: false };
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= DETAIL FALLBACK WITH RETRY =================
async function enrichFromDetail(br, item) {
  const attempt = async () => {
    const { context, page } = await createPage(br);
    try {
      await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: CONFIG.pageTimeout });
      await acceptCookies(page);
      await simulateHumanBehavior(page);

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
            if (c?.["@graph"]) {
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

      const body = await page.evaluate(() => document.body?.innerText || "");
      if (/prix sur demande|price on request/i.test(body)) {
        item.price = null;
        item.priceSource = "on-request";
      } else {
        item.priceSource = "missing";
      }
      return false;
    } finally {
      await context.close().catch(() => {});
    }
  };

  try {
    return await attempt();
  } catch (e) {
    const msg = String(e?.message || e);
    if (/Timeout/i.test(msg) && CONFIG.detailRetryCount > 0) {
      await sleep(500);
      try {
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
  }
}

// ================= SCRAPE ONE PAGE (MAIN STRICT + FAST FILTER) =================
async function scrapeOnePage(br, pageUrl) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(pageUrl, { waitUntil: "commit", timeout: CONFIG.pageTimeout });
    await acceptCookies(page);
    await simulateHumanBehavior(page);

    const mainSel = 'main a[href*="--id"][href$=".htm"]';
    const anySel = 'a[href*="--id"][href$=".htm"]';

    // Wait main, else fallback
    let selectorUsed = mainSel;
    try {
      await page.waitForSelector(mainSel, { timeout: CONFIG.selectorTimeout });
    } catch {
      selectorUsed = anySel;
      try {
        await page.waitForSelector(anySel, { timeout: CONFIG.selectorTimeout });
      } catch {
        return { expectedCount: 0, items: [] };
      }
    }

    const expectedCount = await getExpectedCount(page);

    // FAST: single-pass collect href + inMain
    const links = await page.$$eval(selectorUsed, (as) =>
      as
        .map((a) => ({ href: a.getAttribute("href") || "", inMain: !!a.closest("main") }))
        .filter((x) => x.href)
    );

    const filtered = selectorUsed === mainSel ? links : (links.some((x) => x.inMain) ? links.filter((x) => x.inMain) : links);

    const byId = new Map();

    // Use JS to map href->card quickly (avoid per-link roundtrips as much as possible)
    for (const { href } of filtered) {
      const full = href.startsWith("http") ? href : `https://www.chrono24.fr${href}`;
      const id = extractListingId(full);
      if (!id || byId.has(id)) continue;

      let cardHandle = null;
      try {
        const a = await page.$(`a[href="${href}"]`);
        if (a) cardHandle = await a.evaluateHandle((el) => el.closest("article") || el.closest("li") || el.closest("div"));
      } catch {}

      if (!cardHandle) cardHandle = await page.evaluateHandle(() => document.body);

      byId.set(id, { id, url: full, card: cardHandle });
    }

    const items = [];
    for (const v of byId.values()) {
      const title = (await extractTitle(v.card)) || `Listing ${v.id}`;
      const country = await extractCountry(v.card);
      const isSponsored = await extractSponsored(v.card);
      const pr = await extractPriceFromCard(v.card);
      items.push({ id: v.id, url: v.url, title, country, isSponsored, price: pr.price, priceSource: pr.priceSource });
    }

    return { expectedCount, items };
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= MAIN SCRAPE FUNCTION =================
async function scrapeChrono24(url, opts) {
  const pageSize = Number(opts.pageSize || 120);
  const maxPages = Number(opts.maxPages || 50);
  const noCache = !!opts.noCache;

  if (isDetailPage(url)) {
    const br = await getBrowser();
    const item = await scrapeDetailPage(br, url);
    return { expectedCount: 1, count: 1, pageSize: 1, pagesScraped: 1, items: [item], isDetailPage: true };
  }

  const cacheKey = JSON.stringify({ url, pageSize, maxPages });
  const cached = getCached(cacheKey, noCache);
  if (cached) return { ...cached, fromCache: true };

  const br = await getBrowser();

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
    await sleep(randomDelay(900, 1700));
  }

  const items = [...all.values()];

  // Detail fallback missing prices only
  const missingPrices = items.filter((it) => it.priceSource === "missing");
  if (missingPrices.length > 0) {
    const limit = createLimiter(CONFIG.detailConcurrency);
    await Promise.all(
      missingPrices.map((it) =>
        limit(async () => {
          await enrichFromDetail(br, it);
          await sleep(randomDelay(400, 900));
        })
      )
    );
  }

  // Fail-fast exact after pagination
  if (typeof expectedCount === "number" && expectedCount > 0 && items.length !== expectedCount) {
    const e = new Error(`Count mismatch after pagination: expected ${expectedCount}, got ${items.length}`);
    e.meta = { expectedCount, got: items.length, pagesScraped, pageSize, sample: items.slice(0, 5) };
    throw e;
  }

  const result = { expectedCount, count: items.length, pageSize, pagesScraped, items };
  setCache(cacheKey, result);
  return result;
}

// ================= ROUTES =================
app.get("/health", (req, res) =>
  res.json({
    status: "ok",
    ts: new Date().toISOString(),
    proxy: PROXY_URL ? PROXY_URL.replace(/:[^:]+@/, ":***@") : "none",
    freeProxies: FREE_PROXIES.length,
  })
);

app.post("/api/scrape", async (req, res) => {
  try {
    const { url, pageSize, maxPages, noCache } = req.body || {};
    if (!url || typeof url !== "string" || !url.includes("chrono24")) {
      return res.status(400).json({ error: "Invalid Chrono24 URL" });
    }
    const out = await scrapeChrono24(url, { pageSize, maxPages, noCache });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, meta: e.meta || null });
  }
});

app.post("/api/cache/clear", (req, res) => {
  cache.clear();
  res.json({ ok: true });
});

// ================= DEBUG: PING CHRONO24 =================
app.get("/api/ping-chrono24", async (req, res) => {
  let br;
  let context;

  try {
    br = await getBrowser(true); // force nouveau browser
    const pageObj = await createPage(br, false);
    context = pageObj.context;
    const page = pageObj.page;

    const resp = await page.goto("https://www.chrono24.fr", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const title = await page.title().catch(() => "");
    const status = resp ? resp.status() : null;

    res.json({
      ok: true,
      status,
      title,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: String(e.message || e),
      timestamp: new Date().toISOString(),
    });
  } finally {
    if (context) await context.close().catch(() => {});
  }
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
