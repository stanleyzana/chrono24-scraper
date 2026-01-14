const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Connexion Redis pour BullMQ avec support TLS
const connection = process.env.REDIS_URL 
  ? new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      family: 6,
    })
  : new Redis();

// Création de la queue
const priceQueue = new Queue('price-scraping', { 
  connection 
});

priceQueue.on('error', (err) => {
  console.error('❌ Erreur Queue:', err);
});

console.log('✅ Queue "price-scraping" créée');

module.exports = priceQueue;
