const net = require('net')
const redis = require('./redisClient')
const stats = require('./stats')

/** req.ip is only as trustworthy as the `trust proxy` setting, and an unvalidated value
 *  becomes part of a Redis key name. Folding anything that isn't a real IP into a single
 *  bucket stops a rotating header from both bypassing the limit and minting unbounded keys. */
function clientKey(req) {
  const raw = req.ip || req.socket.remoteAddress || ''
  return net.isIP(raw) ? raw : 'unknown'
}

// Used only when Redis isn't configured (local dev). Not viable across serverless instances,
// but keeps the limiter functional for a single long-running process.
const memHits = new Map()

async function withinLimit(key, windowSeconds, limit) {
  if (redis) {
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, windowSeconds)
    return count <= limit
  }
  const now = Date.now()
  const entry = memHits.get(key)
  if (!entry || now - entry.start > windowSeconds * 1000) {
    memHits.set(key, { start: now, count: 1 })
    return true
  }
  entry.count += 1
  return entry.count <= limit
}

/** `failClosed` rejects when the limiter itself errors. Use it on anything guarding a
 *  credential (the admin routes): a Redis outage must not silently remove the only brake
 *  on brute-forcing ADMIN_SECRET. Everything else stays fail-open for availability. */
function rateLimit(prefix, { windowSeconds, limit }, { failClosed = false } = {}) {
  return async (req, res, next) => {
    const ip = clientKey(req)
    try {
      const allowed = await withinLimit(`rl:${prefix}:${ip}`, windowSeconds, limit)
      if (!allowed) {
        stats.track(`ratelimit:blocked:${prefix}`)
        res.status(429).json({ ok: false, error: 'Too many requests, try again later' })
        return
      }
    } catch (err) {
      if (failClosed) {
        console.error(`rateLimit: check failed for ${prefix}, refusing request:`, err.message)
        stats.track(`ratelimit:failclosed:${prefix}`)
        res.status(503).json({ ok: false, error: 'Rate limiter unavailable' })
        return
      }
      console.warn(`rateLimit: check failed for ${prefix}, allowing request:`, err.message)
    }
    next()
  }
}

module.exports = { rateLimit, clientKey }
