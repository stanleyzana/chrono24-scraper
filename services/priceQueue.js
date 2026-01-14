const { Queue } = require('bullmq');
const Redis = require('ioredis');

// Connexion Redis pour BullMQ avec support TLS (lazy loading)
let connection;

function getConnection() {
  if (!connection && process.env.REDIS_URL) {
    connection = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      family: 6,
      lazyConnect: true,
    });
    
    connection.on('error', (err) => {
      console.error('❌ Erreur Redis:', err);
    });
    
    connection.on('ready', () => {
      console.log('✅ Redis connecté!');
    });
  }
  return connection;
}

// Création de la queue
const priceQueue = new Queue('price-scraping', {
  connection: getConnection(),
});

priceQueue.on('error', (err) => {
  console.error('❌ Erreur Queue:', err);
});

console.log('✅ Queue "price-scraping" créée');

module.exports = priceQueue;
