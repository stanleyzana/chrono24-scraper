const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const pLimit = require('p-limit');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3001;

// ================= CONFIG =================
const CONFIG = {
  cacheTTL: 10 * 60 * 1000,
  viewport: { width: 1920, height: 1080 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  acceptLanguage: 'fr-FR,fr;q=0.9',
  detailConcurrency: 4,
};

const cache = new Map();
const getCached = (key, noCache) => {
  if (noCache) return null;
  const e = cache.get(key);
  if (e && Date.now() - e.ts < CONFIG.cacheTTL) return e.data;
  return null;
};
const setCache = (key, data) => cache.set(key, { ts: Date.now(), data });

// ================= BROWSER =================
let browserInstance = null;
async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browserInstance;
}

async function createPage(br) {
  const context = await br.newContext({
    locale: 'fr-FR',
    userAgent: CONFIG.userAgent,
    viewport: CONFIG.viewport,
    extraHTTPHeaders: { 'Accept-Language': CONFIG.acceptLanguage },
  });

  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'font', 'media'].includes(t)) route.abort();
    else route.continue();
  });

  return { context, page };
}

// ================= COOKIES =================
async function acceptCookies(page) {
  const sels = [
    '#onetrust-accept-btn-handler',
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

// ================= HELPERS =================
const extractListingId = (url) => {
  const m = (url || '').match(/--id(\d+)\.htm/i);
  return m ? m[1] : null;
};

const normalize = (s) =>
  (s || '').replace(/\u00A0|\u202F/g, ' ').replace(/\s+/g, ' ').trim();

const parseEuro = (s) => {
  const m = normalize(s).match(/(\d{1,3}(?:[ .]\d{3})+)\s?€/);
  if (!m) return null;
  const v = Number(m[1].replace(/[ .]/g, ''));
  return Number.isFinite(v) ? v : null;
};

function withParams(inputUrl, params) {
  const u = new URL(inputUrl);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, String(v)));
  return u.toString();
}

// ================= CARD EXTRACTION =================
async function extractTitle(card) {
  const sels = ['.article-title', 'h3', 'h2'];
  for (const s of sels) {
    const el = await card.$(s);
    if (el) {
      const t = normalize(await el.textContent());
      if (t) return t;
    }
  }
  return null;
}

async function extractCountry(card) {
  const sels = ['[class*="country"]', '[class*="location"]'];
  for (const s of sels) {
    const el = await card.$(s);
    if (el) {
      const t = normalize(await el.textContent());
      if (t && t.length <= 3) return t;
    }
  }
  return null;
}

async function extractPriceFromCard(card) {
  // meta itemprop (rare en liste, mais on tente)
  const meta = await card.$('meta[itemprop="price"]');
  if (meta) {
    const c = await meta.getAttribute('content');
    if (c) {
      const v = Number(String(c).replace(/[^\d]/g, ''));
      if (v > 0) return { price: v, source: 'card-meta' };
    }
  }

  const txt = await card.evaluate((n) => n.innerText || '');
  if (/prix sur demande/i.test(txt)) return { price: null, source: 'on-request' };

  // bloc prix dédié
  const sels = ['[data-testid="price"]', '[class*="price"]'];
  for (const s of sels) {
    const el = await card.$(s);
    if (!el) continue;
    const t = normalize(await el.textContent());
    if (!t) continue;
    if (/frais de port/i.test(t) || /^\+/.test(t)) continue;
    if (/prix sur demande/i.test(t)) return { price: null, source: 'on-request' };
    const v = parseEuro(t);
    if (v) return { price: v, source: 'card-dom' };
  }

  return { price: null, source: 'missing' };
}

// ================= DETAIL FALLBACK =================
async function enrichFromDetail(br, item) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await acceptCookies(page);

    const meta = await page.$('meta[itemprop="price"]');
    if (meta) {
      const c = await meta.getAttribute('content');
      if (c) {
        const v = Number(String(c).replace(/[^\d]/g, ''));
        if (v > 0) {
          item.price = v;
          item.priceSource = 'detail-meta';
          return item;
        }
      }
    }

    const ld = await page.$$eval('script[type="application/ld+json"]', (n) =>
      n.map((x) => x.textContent).filter(Boolean)
    );

    for (const raw of ld) {
      try {
        const o = JSON.parse(raw);
        const candidates = Array.isArray(o) ? o : [o];
        for (const c of candidates) {
          const offers = c?.offers;
          if (offers?.price) {
            const v = Number(String(offers.price).replace(/[^\d]/g, ''));
            if (v > 0) {
              item.price = v;
              item.priceSource = 'detail-jsonld';
              return item;
            }
          }
        }
      } catch {}
    }

    const body = await page.evaluate(() => document.body?.innerText || '');
    if (/prix sur demande/i.test(body)) {
      item.price = null;
      item.priceSource = 'on-request';
    } else {
      item.priceSource = 'missing';
    }
    return item;
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= SCRAPE ONE PAGE =================
async function scrapeOnePage(br, url) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await acceptCookies(page);

    await page.waitForSelector('main a[href*="--id"][href$=".htm"]', { timeout: 30000 });

    const expectedCount = await page.evaluate(() => {
      const t = document.body?.innerText || '';
      const m = t.match(/(\d+)\s+(?:annonces?|résultats?|montres?)/i);
      return m ? Number(m[1]) : null;
    });

    const links = await page.$$('main a[href*="--id"][href$=".htm"]');

    const byId = new Map();
    for (const link of links) {
      const href = await link.getAttribute('href');
      if (!href) continue;
      const full = href.startsWith('http') ? href : `https://www.chrono24.fr${href}`;
      const id = extractListingId(full);
      if (!id || byId.has(id)) continue;

      const card = await link.evaluateHandle((a) => a.closest('article') || a.closest('li') || a.closest('div'));
      byId.set(id, { id, url: full, card });
    }

    const items = [];
    for (const v of byId.values()) {
      const title = (await extractTitle(v.card)) || `Listing ${v.id}`;
      const country = await extractCountry(v.card);
      const pr = await extractPriceFromCard(v.card);

      let isSponsored = false;
      try {
        const t = await v.card.evaluate((n) => n.innerText || '');
        isSponsored = /sponsor|promoted/i.test(t);
      } catch {}

      items.push({
        id: v.id,
        url: v.url,
        title,
        country,
        isSponsored,
        price: pr.price,
        priceSource: pr.source,
      });
    }

    return { expectedCount, items };
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= MAIN SCRAPER (PAGINATION) =================
async function scrapeChrono24(url, opts) {
  const pageSize = Number(opts.pageSize || 120);
  const maxPages = Number(opts.maxPages || 50);
  const noCache = !!opts.noCache;

  const cacheKey = JSON.stringify({ url, pageSize, maxPages });
  const cached = getCached(cacheKey, noCache);
  if (cached) return cached;

  const br = await getBrowser();

  // page 1
  const url1 = withParams(url, { pageSize, page: 1 });
  const first = await scrapeOnePage(br, url1);

  const expectedCount = first.expectedCount;
  const totalPages =
    typeof expectedCount === 'number' && expectedCount > 0
      ? Math.min(maxPages, Math.ceil(expectedCount / pageSize))
      : 1;

  const all = new Map(first.items.map((x) => [x.id, x]));
  let pagesScraped = 1;

  for (let p = 2; p <= totalPages; p++) {
    const pageUrl = withParams(url, { pageSize, page: p });
    const { items } = await scrapeOnePage(br, pageUrl);
    for (const it of items) all.set(it.id, it);
    pagesScraped = p;
  }

  const items = [...all.values()];

  // fallback détail uniquement si manque prix
  const limit = pLimit(CONFIG.detailConcurrency);
  await Promise.all(
    items.map((it) =>
      limit(async () => {
        if (it.priceSource === 'missing') await enrichFromDetail(br, it);
      })
    )
  );

  // FAIL-FAST FINAL
  if (typeof expectedCount === 'number' && expectedCount > 0 && items.length !== expectedCount) {
    const e = new Error(`Count mismatch after pagination: expected ${expectedCount}, got ${items.length}`);
    e.meta = { expectedCount, got: items.length, pagesScraped, pageSize, sample: items.slice(0, 5) };
    throw e;
  }

  const result = {
    expectedCount,
    count: items.length,
    pageSize,
    pagesScraped,
    items,
  };

  setCache(cacheKey, result);
  return result;
}

// ================= API =================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/scrape', async (req, res) => {
  try {
    const { url, pageSize, maxPages, noCache } = req.body || {};
    if (!url || typeof url !== 'string' || !url.includes('chrono24')) {
      return res.status(400).json({ error: 'Invalid Chrono24 URL' });
    }
    const out = await scrapeChrono24(url, { pageSize, maxPages, noCache });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, meta: e.meta || null });
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});
