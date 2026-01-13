const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

// ============ CONFIGURATION ============
const CONFIG = {
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  LOCALE: 'fr-FR',
  ACCEPT_LANGUAGE: 'fr-FR,fr;q=0.9,en;q=0.8',
  CACHE_TTL_MS: 10 * 60 * 1000,
  DETAIL_CONCURRENCY: 4,
  VIEWPORT: { width: 1920, height: 1080 },
};

// ============ CACHE MÉMOIRE ============
const cache = new Map();

function getCached(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CONFIG.CACHE_TTL_MS) {
    return entry.data;
  }
  cache.delete(url);
  return null;
}

function setCache(url, data) {
  cache.set(url, { data, timestamp: Date.now() });
}

// ============ BROWSER INSTANCE ============
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

async function createPage(browser) {
  const context = await browser.newContext({
    locale: CONFIG.LOCALE,
    userAgent: CONFIG.USER_AGENT,
    viewport: CONFIG.VIEWPORT,
    extraHTTPHeaders: { 'Accept-Language': CONFIG.ACCEPT_LANGUAGE },
  });

  const page = await context.newPage();

  await page.route('**/*', (route) => {
    const resourceType = route.request().resourceType();
    if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  return { page, context };
}

// ============ COOKIE HANDLER ============
async function acceptCookies(page) {
  try {
    const cookieSelectors = [
      'button[data-testid="uc-accept-all-button"]',
      '#onetrust-accept-btn-handler',
      'button:has-text("Tout accepter")',
      'button:has-text("Accepter")',
      'button:has-text("Accept all")',
      '.js-cookie-accept',
    ];

    for (const selector of cookieSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(1000);
          return true;
        }
      } catch (e) {}
    }
    return false;
  } catch (err) {
    return false;
  }
}

// ============ EXTRACT EXPECTED COUNT ============
async function extractExpectedCount(page) {
  try {
    const countSelectors = ['.js-search-result-count', '[data-testid="search-result-count"]', '.search-result-header__count'];

    for (const selector of countSelectors) {
      const el = await page.$(selector);
      if (el) {
        const text = await el.textContent();
        const match = text.match(/(\d[\d\s,.]*)/);
        if (match) {
          return parseInt(match[1].replace(/[\s,.]/g, ''), 10);
        }
      }
    }

    const title = await page.title();
    const titleMatch = title.match(/(\d+)\s*(montres?|offres?|résultats?|watches?)/i);
    if (titleMatch) return parseInt(titleMatch[1], 10);

    return null;
  } catch (err) {
    return null;
  }
}

// ============ EXTRACT ID FROM URL ============
function extractListingId(url) {
  const match = url.match(/--id(\d+)\.htm/i);
  return match ? match[1] : null;
}

// ============ EXTRACT PRICE FROM CARD ============
async function extractPriceFromCard(card) {
  try {
    const metaPrice = await card.$('meta[itemprop="price"]');
    if (metaPrice) {
      const content = await metaPrice.getAttribute('content');
      if (content) {
        const price = parseFloat(content);
        if (price > 0) return { price, source: 'meta-itemprop' };
      }
    }

    const priceSelectors = ['.article-price-container .text-bold', '[data-testid="price"]', '.article-price', '.text-price-primary'];

    for (const selector of priceSelectors) {
      const priceEl = await card.$(selector);
      if (priceEl) {
        const text = await priceEl.textContent();
        const cleanText = text.replace(/[^\d.,\s]/g, '').trim();
        const normalized = cleanText.replace(/[\s.]/g, '').replace(',', '.');
        const price = parseFloat(normalized);
        if (price > 500 && price < 50000000) return { price, source: `selector:${selector}` };
      }
    }

    return null;
  } catch (err) {
    return null;
  }
}

// ============ EXTRACT LISTING FROM CARD ============
async function extractListingFromCard(card, index) {
  try {
    const linkEl = await card.$('a[href*="--id"]');
    if (!linkEl) return null;

    const href = await linkEl.getAttribute('href');
    if (!href) return null;

    const id = extractListingId(href);
    if (!id) return null;

    const fullUrl = href.startsWith('http') ? href : `https://www.chrono24.fr${href}`;

    let title = '';
    const titleEl = await card.$('.article-title, [data-testid="article-title"], h3, h2');
    if (titleEl) title = (await titleEl.textContent()).trim();

    const priceData = await extractPriceFromCard(card);

    let country = null;
    const countryEl = await card.$('[data-testid="seller-country"], .seller-country, .merchant-country');
    if (countryEl) {
      const countryText = await countryEl.textContent();
      const countryMatch = countryText.match(/([A-Z]{2})/);
      if (countryMatch) country = countryMatch[1];
    }

    let isSponsored = false;
    const sponsoredEl = await card.$('[data-testid="promoted"], .promoted-label, .sponsored');
    if (sponsoredEl) isSponsored = true;

    return { id, url: fullUrl, title: title || `Listing ${id}`, price: priceData?.price || null, priceSource: priceData?.source || null, country, isSponsored };
  } catch (err) {
    return null;
  }
}

// ============ DETAIL PAGE FALLBACK ============
async function extractPriceFromDetailPage(browser, url) {
  let context = null;
  try {
    const result = await createPage(browser);
    context = result.context;
    const page = result.page;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await acceptCookies(page);
    await page.waitForTimeout(1000);

    const metaPrice = await page.$('meta[itemprop="price"]');
    if (metaPrice) {
      const content = await metaPrice.getAttribute('content');
      if (content) {
        const price = parseFloat(content);
        if (price > 0) { await context.close(); return { price, source: 'detail-meta' }; }
      }
    }

    const priceSelectors = ['.js-price-shipping-country-price', '[data-testid="price"]', '.price-value'];
    for (const selector of priceSelectors) {
      const priceEl = await page.$(selector);
      if (priceEl) {
        const text = await priceEl.textContent();
        const normalized = text.replace(/[^\d.,\s]/g, '').replace(/[\s.]/g, '').replace(',', '.');
        const price = parseFloat(normalized);
        if (price > 500 && price < 50000000) { await context.close(); return { price, source: `detail:${selector}` }; }
      }
    }

    await context.close();
    return null;
  } catch (err) {
    if (context) await context.close();
    return null;
  }
}

// ============ SCRAPE WITH CONCURRENCY ============
async function scrapeDetailPagesWithConcurrency(browser, listings, concurrency = CONFIG.DETAIL_CONCURRENCY) {
  const needDetailFetch = listings.filter(l => l.price === null);
  if (needDetailFetch.length === 0) return listings;

  const results = [...listings];
  const queue = [...needDetailFetch];

  async function processNext() {
    if (queue.length === 0) return;
    const item = queue.shift();
    try {
      const priceData = await extractPriceFromDetailPage(browser, item.url);
      if (priceData) {
        const idx = results.findIndex(r => r.id === item.id);
        if (idx >= 0) { results[idx].price = priceData.price; results[idx].priceSource = priceData.source; }
      }
    } catch (err) {}
    await processNext();
  }

  const workers = [];
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) workers.push(processNext());
  await Promise.all(workers);

  return results;
}

// ============ MAIN SCRAPE ============
async function scrapeChrono24(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const browser = await getBrowser();
  let context = null;

  try {
    const result = await createPage(browser);
    context = result.context;
    const page = result.page;

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await acceptCookies(page);
    await page.waitForTimeout(2000);

    const expectedCount = await extractExpectedCount(page);

    let previousHeight = 0, scrollAttempts = 0;
    while (scrollAttempts < 20) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) break;
      previousHeight = currentHeight;
      scrollAttempts++;
    }

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const cardSelectors = ['article[data-testid="article-card"]', '.article-item-container', '.search-result-item', '.article-card'];
    let cards = [];
    for (const selector of cardSelectors) {
      cards = await page.$$(selector);
      if (cards.length > 0) break;
    }

    if (cards.length === 0) { await context.close(); return { expectedCount, count: 0, items: [], error: 'No cards found' }; }

    const rawListings = [];
    for (let i = 0; i < cards.length; i++) {
      const listing = await extractListingFromCard(cards[i], i);
      if (listing) rawListings.push(listing);
    }

    // Dedup by ID
    const seenIds = new Set();
    const deduped = rawListings.filter(l => { if (seenIds.has(l.id)) return false; seenIds.add(l.id); return true; });

    const withPrices = await scrapeDetailPagesWithConcurrency(browser, deduped);
    await context.close();

    const response = { expectedCount, count: withPrices.length, items: withPrices };
    if (expectedCount !== null && withPrices.length !== expectedCount) response.warning = `Count mismatch: expected ${expectedCount}, got ${withPrices.length}`;

    setCache(url, response);
    return response;
  } catch (err) {
    if (context) await context.close();
    throw err;
  }
}

// ============ API ============
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  if (!url.includes('chrono24.')) return res.status(400).json({ error: 'Invalid Chrono24 URL' });

  try {
    const result = await scrapeChrono24(url);

    if (result.expectedCount !== null && result.count > 0) {
      const diff = Math.abs(result.expectedCount - result.count);
      if (diff / result.expectedCount > 0.1 && diff > 5) {
        return res.status(500).json({ error: 'Count mismatch', expectedCount: result.expectedCount, got: result.count, sample: result.items.slice(0, 5) });
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cache/clear', (req, res) => { cache.clear(); res.json({ status: 'cleared' }); });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

process.on('SIGTERM', async () => { if (browserInstance) await browserInstance.close(); process.exit(0); });
