const Redis = require('ioredis')

const isServerless = !!process.env.VERCEL
const restUrl = process.env.UPSTASH_REDIS_REST_URL
const restToken = process.env.UPSTASH_REDIS_REST_TOKEN
const redisUrl = process.env.REDIS_URL

function makeRestClient(url, token) {
  const { Redis: UpstashRest } = require('@upstash/redis')
  // automaticDeserialization: false keeps values as raw strings, matching ioredis —
  // our callers JSON.stringify on set and JSON.parse on get themselves.
  const c = new UpstashRest({ url, token, automaticDeserialization: false })

  return {
    get: (key) => c.get(key),
    set: (key, value, ...opts) => {
      // Supports the ioredis form redis.set(key, value, 'EX', seconds).
      if (opts.length >= 2 && String(opts[0]).toUpperCase() === 'EX') {
        return c.set(key, value, { ex: Number(opts[1]) })
      }
      return c.set(key, value)
    },
    incr: async (key) => Number(await c.incr(key)),
    expire: (key, seconds) => c.expire(key, seconds),
    keys: (pattern) => c.keys(pattern),
    del: (...keys) => c.del(...keys),
    mget: (...keys) => c.mget(...keys),
    // ioredis: zadd(key, score, member). REST: zadd(key, { score, member }).
    zadd: (key, score, member) => c.zadd(key, { score: Number(score), member }),
    zcard: async (key) => Number(await c.zcard(key)),
    zrange: (key, start, stop) => c.zrange(key, start, stop),
    zrem: (key, ...members) => c.zrem(key, ...members),
    zremrangebyscore: (key, min, max) => c.zremrangebyscore(key, min, max),
    ping: () => c.ping(),
    // REST client is connectionless — these keep the ioredis-shaped API safe to call.
    on: () => {},
    disconnect: () => {},
  }
}

let redis = null

if (isServerless && restUrl && restToken) {
  redis = makeRestClient(restUrl, restToken)
  console.log('redisClient: using Upstash REST client (serverless)')
} else if (redisUrl) {
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
