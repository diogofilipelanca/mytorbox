const Redis = require('ioredis')

const redisUrl = process.env.REDIS_URL

let redis = null

if (redisUrl) {
  redis = new Redis(redisUrl, {
    keepAlive: 30000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  })
  redis.on('error', (err) => console.warn('redisClient: connection error:', err.message))
} else {
  console.warn('redisClient: no Redis configured — caching disabled, falling back to in-memory')
}

module.exports = redis
