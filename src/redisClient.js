const Redis = require('ioredis')

const redisUrl = process.env.REDIS_URL

let redis = null

if (redisUrl) {
  redis = new Redis(redisUrl, {
    keepAlive: 30000,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    // Without this, a command issued while the connection is down is queued and only
    // rejects after the retry budget runs out — so an unreachable Redis makes every
    // request slow instead of just uncached. Callers all treat a rejection as a cache
    // miss, so failing immediately is both faster and equivalent.
    enableOfflineQueue: false,
  })
  redis.on('error', (err) => console.warn('redisClient: connection error:', err.message))
} else {
  console.warn('redisClient: no Redis configured — caching disabled, falling back to in-memory')
}

module.exports = redis
