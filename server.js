const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// ============ CONFIG ============
const CONFIG = {
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  locale: 'fr-FR',
  cacheTTL: 10 * 60 * 1000,
  detailConcurrency: 3,
  viewport: { width: 1920, height: 1080 },
};

// ============ CACHE ============
const cache = new Map();
const getCached = (url) => {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.timestamp < CONFIG.cacheTTL) return entry.data;
  return null;
};
const setCache = (url, data) => cache.set(url, { data, timestamp: Date.now() });

// ============ BROWSER ============
let browserInstance = null;
const getBrowser = async () => {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
};

const createPage = async (browser) => {
  const context = await browser.newContext({
    locale: CONFIG.locale,
    userAgent: CONFIG.userAgent,
    viewport: CONFIG.viewport,
  });
  const page = await context.newPage();
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'font', 'media'].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });
  return { context, page };
};

// ============ COOKIE CONSENT ============
const acceptCookies = async (page) => {
  const selectors = [
    'button#onetrust-accept-btn-handler',
    'button[data-testid="uc-accept-all-button"]',
    'button.accept-cookies',
    'button[id*="accept"]',
    'button[class*="accept"]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click();
        await page.waitForTimeout(500);
        return;
      }
    } catch {}
  }
};

// ============ EXTRACT EXPECTED COUNT ============
const extractExpectedCount = async (page) => {
  const selectors = [
    '.js-result-count',
    '[data-testid="result-count"]',
    '.result-count',
    'h1.h3',
    '.search-result-header span',
  ];
  
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const text = await el.textContent();
        const match = text.match(/(\d[\d\s]*)/);
        if (match) return parseInt(match[1].replace(/\s/g, ''), 10);
      }
    } catch {}
  }
  
  // Fallback: check page title
  const title = await page.title();
  const match = title.match(/(\d+)\s*(montres|résultats|watches)/i);
  if (match) return parseInt(match[1], 10);
  
  return null;
};

// ============ EXTRACT LISTING ID ============
const extractListingId = (url) => {
  const match = url.match(/--id(\d+)\.htm/);
  return match ? match[1] : null;
};

// ============ EXTRACT PRICE FROM CARD ============
const extractPriceFromCard = async (card) => {
  // Priority 1: meta itemprop="price"
  try {
    const meta = await card.$('meta[itemprop="price"]');
    if (meta) {
      const content = await meta.getAttribute('content');
      if (content) {
        const price = parseInt(content.replace(/[^\d]/g, ''), 10);
        if (price > 0) return { price, source: 'meta-itemprop' };
      }
    }
  } catch {}

  // Priority 2: data-price attribute
  try {
    const priceEl = await card.$('[data-price]');
    if (priceEl) {
      const dataPrice = await priceEl.getAttribute('data-price');
      if (dataPrice) {
        const price = parseInt(dataPrice.replace(/[^\d]/g, ''), 10);
        if (price > 0) return { price, source: 'data-price' };
      }
    }
  } catch {}

  // Priority 3: Price text selectors
  const priceSelectors = [
    '.article-price-container strong',
    '.article-price strong',
    '.price-container .price',
    '.article-item-price',
    '[class*="price"] strong',
    '.text-price',
    'strong.text-xl',
  ];

  for (const sel of priceSelectors) {
    try {
      const el = await card.$(sel);
      if (el) {
        const text = await el.textContent();
        if (text && !text.toLowerCase().includes('demande') && !text.toLowerCase().includes('request')) {
          const cleaned = text.replace(/[^\d]/g, '');
          const price = parseInt(cleaned, 10);
          if (price > 100) return { price, source: sel };
        }
      }
    } catch {}
  }

  return { price: null, source: null };
};

// ============ EXTRACT TITLE FROM CARD ============
const extractTitleFromCard = async (card) => {
  const titleSelectors = [
    'a[href*="--id"] h3',
    '.article-title',
    'h3.h4',
    '.article-item-title',
    'a[href*="chrono24"] h3',
    'h3',
  ];

  for (const sel of titleSelectors) {
    try {
      const el = await card.$(sel);
      if (el) {
        const text = await el.textContent();
        if (text && text.trim().length > 5) {
          return text.trim();
        }
      }
    } catch {}
  }
  return null;
};

// ============ EXTRACT COUNTRY FROM CARD ============
const extractCountryFromCard = async (card) => {
  const countrySelectors = [
    '.article-dealer-country',
    '.seller-country',
    '[class*="country"]',
    '.text-muted:has-text("France")',
    '.text-muted:has-text("Germany")',
    '.article-merchant-location',
  ];

  for (const sel of countrySelectors) {
    try {
      const el = await card.$(sel);
      if (el) {
        const text = await el.textContent();
        if (text && text.trim().length > 1) {
          return text.trim();
        }
      }
    } catch {}
  }

  // Fallback: Look for flag images or country codes
  try {
    const flagImg = await card.$('img[src*="flags"], img[alt*="flag"]');
    if (flagImg) {
      const alt = await flagImg.getAttribute('alt');
      if (alt) return alt.replace('flag', '').trim();
    }
  } catch {}

  return null;
};

// ============ EXTRACT LISTING FROM CARD ============
const extractListingFromCard = async (card, index) => {
  try {
    // Get URL
    const link = await card.$('a[href*="--id"]');
    if (!link) return null;

    const href = await link.getAttribute('href');
    if (!href) return null;

    const url = href.startsWith('http') ? href : `https://www.chrono24.fr${href}`;
    const id = extractListingId(url);
    if (!id) return null;

    // Get title
    const title = await extractTitleFromCard(card) || `Listing ${id}`;

    // Get price
    const { price, source: priceSource } = await extractPriceFromCard(card);

    // Get country
    const country = await extractCountryFromCard(card);

    // Check if sponsored
    let isSponsored = false;
    try {
      const sponsoredEl = await card.$('[class*="sponsor"], [class*="premium"], [data-sponsored]');
      isSponsored = !!sponsoredEl;
    } catch {}

    return { id, url, title, price, priceSource, country, isSponsored };
  } catch (error) {
    console.error(`Error extracting card ${index}:`, error.message);
    return null;
  }
};

// ============ MAIN SCRAPE FUNCTION ============
const scrapeChrono24 = async (url) => {
  // Check cache
  const cached = getCached(url);
  if (cached) {
    console.log('Returning cached result');
    return cached;
  }

  const browser = await getBrowser();
  const { context, page } = await createPage(browser);

  try {
    console.log(`Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Accept cookies
    await acceptCookies(page);

    // Get expected count
    const expectedCount = await extractExpectedCount(page);
    console.log(`Expected count: ${expectedCount}`);

    // Scroll to load all items
    let previousHeight = 0;
    let scrollAttempts = 0;
    const maxScrolls = 20;

    while (scrollAttempts < maxScrolls) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1000);
      
      const currentHeight = await page.evaluate(() => document.body.scrollHeight);
      if (currentHeight === previousHeight) {
        scrollAttempts++;
        if (scrollAttempts >= 3) break;
      } else {
        scrollAttempts = 0;
      }
      previousHeight = currentHeight;
    }

    // Find all article cards
    const cardSelectors = [
      'article.article-item',
      '.article-item-container',
      '[data-testid="article-item"]',
      '.js-article-item',
      'article[class*="article"]',
    ];

    let cards = [];
    for (const sel of cardSelectors) {
      cards = await page.$$(sel);
      if (cards.length > 0) {
        console.log(`Found ${cards.length} cards with selector: ${sel}`);
        break;
      }
    }

    if (cards.length === 0) {
      // Fallback: find all links to listings
      console.log('No cards found, trying link-based extraction');
      const links = await page.$$('a[href*="--id"][href$=".htm"]');
      console.log(`Found ${links.length} listing links`);
      
      const items = [];
      const seenIds = new Set();
      
      for (const link of links) {
        try {
          const href = await link.getAttribute('href');
          const url = href.startsWith('http') ? href : `https://www.chrono24.fr${href}`;
          const id = extractListingId(url);
          
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            items.push({
              id,
              url,
              title: `Listing ${id}`,
              price: null,
              priceSource: null,
              country: null,
              isSponsored: false,
            });
          }
        } catch {}
      }
      
      const result = { expectedCount, count: items.length, items };
      setCache(url, result);
      return result;
    }

    // Extract data from each card
    const rawItems = [];
    for (let i = 0; i < cards.length; i++) {
      const item = await extractListingFromCard(cards[i], i);
      if (item) rawItems.push(item);
    }

    // Deduplicate by ID
    const seenIds = new Set();
    const items = rawItems.filter((item) => {
      if (seenIds.has(item.id)) return false;
      seenIds.add(item.id);
      return true;
    });

    console.log(`Extracted ${items.length} unique items`);

    const result = { expectedCount, count: items.length, items };
    setCache(url, result);
    return result;
  } finally {
    await context.close();
  }
};

// ============ API ENDPOINTS ============
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;

  if (!url || !url.includes('chrono24')) {
    return res.status(400).json({ error: 'Invalid Chrono24 URL' });
  }

  try {
    console.log(`\n========== SCRAPE REQUEST ==========`);
    console.log(`URL: ${url}`);
    
    const result = await scrapeChrono24(url);
    
    console.log(`Result: ${result.count} items`);
    res.json(result);
  } catch (error) {
    console.error('Scrape error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/cache/clear', (req, res) => {
  cache.clear();
  res.json({ success: true, message: 'Cache cleared' });
});

// ============ START SERVER ============
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Graceful shutdown
process.on('SIGTERM', async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
