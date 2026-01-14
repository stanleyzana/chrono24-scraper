const { Queue } = require('bullmq');
const IORedis = require('ioredis');

// Connexion IORedis pour BullMQ
const connection = new IORedis(process.env.UPSTASH_REDIS_REST_URL, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: false,
  tls: {
    rejectUnauthorized: false
  }
});

// Créer la queue pour les prix
const priceQueue = new Queue('price-scraping', { 
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: {
      age: 3600, // garde 1h
      count: 100
    },
    removeOnFail: {
      age: 7200
    }
  }
});

console.log('✅ Queue "price-scraping" créée');

module.exports = priceQueue;
