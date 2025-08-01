const Redis = require('ioredis');

const redisClient = new Redis({
  host: '127.0.0.1', // Direcci0n del servidor Redis
  port: 6379,        // Puerto del servidor Redis
  // Opcionalmente, si Redis requiere autenticaci0n:
  // password: 'your_redis_password'
});

redisClient.on('error', (err) => {
  console.error('Error connecting to Redis:', err);
});

redisClient.on('connect', () => {
  console.log('Connected to Redis');
});

module.exports = redisClient;
