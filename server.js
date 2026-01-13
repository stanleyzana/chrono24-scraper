const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const pLimit = require('p-limit');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ================= CONFIG =================
const CONFIG = {
  detailConcurrency: 3,
  cacheTTL: 10 * 60 * 1000,
  viewport: { width: 1920, height: 1080 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  acceptLanguage: 'fr-FR,fr;q=0.9',
};

// ================= CACHE =================
const cache = new Map();
const getCached = (url, noCache = false) => {
  if (noCache) return null;
  const e = cache.get(url);
  if (e && Date.now() - e.ts < CONFIG.cacheTTL) return e.data;
  return null;
};
const setCache = (url, data) => cache.set(url, { ts: Date.now(), data });

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
  ];
  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    } catch {}
  }
}

// ================= HELPERS =================
const extractListingId = (url) => {
  const m = url.match(/--id(\d+)\.htm/i);
  return m ? m[1] : null;
};

const normalize = (s) =>
  (s || '').replace(/\u00A0|\u202F/g, ' ').replace(/\s+/g, ' ').trim();

const parseEuro = (s) => {
  const m = normalize(s).match(/(\d{1,3}(?:[ .]\d{3})+)\s?€/);
  if (!m) return null;
  return Number(m[1].replace(/[ .]/g, ''));
};

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

  const sels = ['[class*="price"]', '[data-testid="price"]'];
  for (const s of sels) {
    const el = await card.$(s);
    if (!el) continue;
    const t = normalize(await el.textContent());
    if (/frais de port/i.test(t) || /^\+/.test(t)) continue;
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
        const offers = o?.offers || (Array.isArray(o) ? o.find((x) => x?.offers)?.offers : null);
        if (offers?.price) {
          const v = Number(String(offers.price).replace(/[^\d]/g, ''));
          if (v > 0) {
            item.price = v;
            item.priceSource = 'detail-jsonld';
            return item;
          }
        }
      } catch {}
    }

    const body = await page.evaluate(() => document.body?.innerText || '');
    if (/prix sur demande/i.test(body)) {
      item.price = null;
      item.priceSource = 'on-request';
    }

    return item;
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= MAIN =================
async function scrapeChrono24(url, noCache = false) {
  const cached = getCached(url, noCache);
  if (cached) return cached;

  const br = await getBrowser();
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
      items.push({
        id: v.id,
        url: v.url,
        title,
        country,
        price: pr.price,
        priceSource: pr.source,
      });
    }

    if (typeof expectedCount === 'number' && items.length !== expectedCount) {
      const e = new Error(`Count mismatch: expected ${expectedCount}, got ${items.length}`);
      e.meta = { expectedCount, got: items.length, sample: items.slice(0, 5) };
      throw e;
    }

    const limit = pLimit(CONFIG.detailConcurrency);
    await Promise.all(
      items.map((it) =>
        limit(async () => {
          if (it.priceSource === 'missing') await enrichFromDetail(br, it);
        })
      )
    );

    const result = { expectedCount, count: items.length, items };
    setCache(url, result);
    return result;
  } finally {
    await context.close().catch(() => {});
  }
}

// ================= API =================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/scrape', async (req, res) => {
  try {
    const { url, noCache } = req.body;
    if (!url || !url.includes('chrono24')) {
      return res.status(400).json({ error: 'Invalid Chrono24 URL' });
    }
    const r = await scrapeChrono24(url, !!noCache);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message, meta: e.meta || null });
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
