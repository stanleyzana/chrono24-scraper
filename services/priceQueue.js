const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Connexion Redis pour BullMQ
const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

// Création de la queue
const priceQueue = new Queue('price-scraping', { 
  connection 
});

priceQueue.on('error', (err) => {
  console.error('❌ Erreur Queue:', err);
});

console.log('✅ Queue "price-scraping" créée');

module.exports = priceQueue;
