const { Worker } = require('bullmq');
const { connection } = require('../services/priceQueue');
const { chromium } = require('playwright');

// Config
const CONFIG = {
  detailGotoTimeoutMs: 25000,
  detailRetryCount: 1,
  enrichConcurrency: parseInt(process.env.DETAIL_CONCURRENCY || '8'),
  userAgents: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  ]
};

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    console.log('🌐 Browser Playwright lancé');
  }
  return browserInstance;
}

function pickUA() {
  return CONFIG.userAgents[Math.floor(Math.random() * CONFIG.userAgents.length)];
}

async function createPage(br) {
  const context = await br.newContext({
    locale: "fr-FR",
    userAgent: pickUA(),
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  
  await page.route("**/*", (route) => {
    const t = route.request().resourceType();
    if (['media', 'font', 'image'].includes(t)) {
      route.abort();
    } else {
      route.continue();
    }
  });
  
  return { context, page };
}

async function acceptCookies(page) {
  const sels = [
    "#onetrust-accept-btn-handler",
    '[data-testid="uc-accept-all-button"]',
    'button:has-text("Tout accepter")',
    'button:has-text("Accept")',
  ];
  await page.waitForTimeout(300);
  for (const s of sels) {
    try {
      const b = await page.$(s);
      if (b) {
        await b.click().catch(() => {});
        await page.waitForTimeout(200);
        return;
      }
    } catch {}
  }
}

async function fetchPriceFromDetail(url, br) {
  const { context, page } = await createPage(br);
  try {
    await page.goto(url, { waitUntil: "commit", timeout: CONFIG.detailGotoTimeoutMs });
    await acceptCookies(page);

    const meta = await page.$('meta[itemprop="price"]');
    if (meta) {
      const c = await meta.getAttribute("content");
      if (c) {
        const v = Number(String(c).replace(/[^\d]/g, ""));
        if (v > 0) return { price: v, priceSource: "detail-meta" };
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
            if (v > 0) return { price: v, priceSource: "detail-jsonld" };
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
}

async function scrapePrices(job) {
  const { listings } = job.data;
  console.log(`[Worker] 🚀 Début scraping de ${listings.length} prix`);
  
  const results = [];
  const br = await getBrowser();
  
  const limit = CONFIG.enrichConcurrency;
  const batches = [];
  
  for (let i = 0; i < listings.length; i += limit) {
    batches.push(listings.slice(i, i + limit));
  }
  
  for (const batch of batches) {
    await Promise.all(
      batch.map(async (listing) => {
        try {
          const priceData = await fetchPriceFromDetail(listing.url, br);
          
          results.push({
            listingId: listing.id,
            url: listing.url,
            title: listing.title,
            price: priceData.price,
            priceSource: priceData.priceSource,
            success: true
          });
          
          await job.updateProgress(Math.round((results.length / listings.length) * 100));
          
        } catch (error) {
          results.push({
            listingId: listing.id,
            url: listing.url,
            error: error.message,
            success: false
          });
        }
      })
    );
    
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  const successCount = results.filter(r => r.success && r.price).length;
  console.log(`[Worker] ✅ Terminé : ${successCount}/${listings.length} prix récupérés`);
  
  return results;
}

const priceWorker = new Worker('price-scraping', scrapePrices, { 
  connection,
  concurrency: 1,
  limiter: {
    max: 10,
    duration: 1000
  }
});

priceWorker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} terminé avec succès`);
});

priceWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} échoué :`, err.message);
});

priceWorker.on('error', (err) => {
  console.error('❌ Erreur worker:', err);
});

console.log('🚀 Worker "price-scraping" démarré et prêt !');

module.exports = priceWorker;

process.on('SIGTERM', async () => {
  console.log('🛑 Arrêt du worker...');
  await priceWorker.close();
  if (browserInstance) await browserInstance.close().catch(() => {});
  process.exit(0);
});
