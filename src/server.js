const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const addon = require('./addon')
const validators = require('./validators')
const library = require('./library')
const tmdb = require('./tmdb')
const customStreams = require('./customStreams')
const config = require('./config')
const stats = require('./stats')
const subfile = require('./subfile')
const { rateLimit } = require('./rateLimit')
const { CUSTOM_STREAM_MIN_TTL_MS, CUSTOM_STREAM_MAX_TTL_MS, CUSTOM_STREAM_DEFAULT_TTL_MS, RATE_LIMITS } = config

const PUBLIC_DIR = path.join(__dirname, '..', 'public')
const LOGO_PATH = path.join(PUBLIC_DIR, 'logo.png')
const CONFIGURE_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'configure.html'), 'utf8')
const STATS_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'stats.html'), 'utf8')

function logoVersion() {
  return Math.floor(fs.statSync(LOGO_PATH).mtimeMs / 1000)
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// IMPORTANT: every replacement below MUST use the callback form of String.replace.
// With a string replacement, `$&`, `$'`, "$`" and `$1` are interpreted as substitution
// patterns — and escapeHtml() turns a `'` into `&#39;`, which manufactures a literal `$&`
// out of an attacker-supplied `$'`. That expands to the matched text (which contains a
// quote), breaks out of the value="" attribute and lets arbitrary attributes such as
// `onfocus=...` land on the <input>. The callback form disables `$` handling entirely.
function fillValue(page, fieldId, value) {
  return page.replace(
    `id="${fieldId}" placeholder`,
    () => `id="${fieldId}" value="${escapeHtml(value)}" placeholder`
  )
}

function configurePage(torboxKey = '', tmdbKey = '', rpdbKey = '') {
  let page = CONFIGURE_HTML.replace(/__LOGO_VERSION__/g, () => String(logoVersion()))
  page = fillValue(page, 'torbox', torboxKey)
  page = fillValue(page, 'tmdb', tmdbKey)
  page = fillValue(page, 'rpdb', rpdbKey)
  return page
}

function decodeConfigParam(raw) {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// Hashing both sides first keeps the compared buffers a fixed 32 bytes, so an early
// length check can't leak how long ADMIN_SECRET is through response timing.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest()
}

function secretMatches(provided) {
  if (!config.ADMIN_SECRET || typeof provided !== 'string') return false
  return crypto.timingSafeEqual(sha256(provided), sha256(config.ADMIN_SECRET))
}

function providedSecret(req) {
  const header = req.get('x-admin-secret')
  if (header) return header
  const auth = req.get('authorization') || ''
  return auth.startsWith('Bearer ') ? auth.slice(7) : null
}

function requireAdmin(req, res, next) {
  if (!config.ADMIN_SECRET) {
    res.status(503).json({ ok: false, error: 'ADMIN_SECRET is not configured on this server' })
    return
  }
  if (!secretMatches(providedSecret(req))) {
    stats.track('admin:auth_failed')
    res.status(401).json({ ok: false, error: 'unauthorized' })
    return
  }
  next()
}

const app = express()

// `true` would trust an X-Forwarded-For header supplied by the client verbatim, making
// req.ip — and therefore every rate-limit bucket keyed off it — attacker-controlled.
// TRUST_PROXY_HOPS is the number of proxies actually in front of this process (1 for a
// single reverse proxy such as Caddy/nginx, 0 when exposed directly).
app.set('trust proxy', config.TRUST_PROXY_HOPS)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The configure/stats pages ship their JS and CSS inline.
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https://image.tmdb.org', 'https://api.ratingposterdb.com'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  // Posters are loaded cross-origin from TMDB/RPDB.
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  referrerPolicy: { policy: 'no-referrer' },
}))

// The Stremio protocol routes genuinely need to be readable from any origin; the
// management API and the configure page do not.
const stremioCors = cors()
const sameOriginOnly = cors({ origin: false })

app.use(express.json({ limit: '64kb' }))
app.use('/api', sameOriginOnly)

const UNTRACKED_PATHS = /^\/(logo\.png|stats|api\/stats)$/

app.use((req, res, next) => {
  if (UNTRACKED_PATHS.test(req.path)) {
    next()
    return
  }
  const startedAt = Date.now()
  res.on('finish', () => {
    const kind = req.statsKind || 'other'
    stats.trackHourly('req')
    stats.track(`req:${kind}`)
    stats.track(`status:${Math.floor(res.statusCode / 100)}xx`)
    stats.trackDuration(`req:${kind}`, Date.now() - startedAt)
  })
  next()
})

app.get('/', (req, res) => {
  req.statsKind = 'configure'
  res.type('html').send(configurePage())
})

app.get('/configure', (req, res) => {
  req.statsKind = 'configure'
  res.type('html').send(configurePage())
})

app.get('/:config/configure', (req, res) => {
  req.statsKind = 'configure'
  const cfg = decodeConfigParam(req.params.config)
  if (!cfg) {
    res.type('html').send(configurePage())
    return
  }
  res.type('html').send(configurePage(cfg.torbox_key || '', cfg.tmdb_key || '', cfg.rpdb_key || ''))
})

app.post('/api/validate', rateLimit('validate', RATE_LIMITS.validate), async (req, res) => {
  req.statsKind = 'validate'
  const { torbox_key: torboxKey, tmdb_key: tmdbKey, rpdb_key: rpdbKey } = req.body || {}
  const [torbox, tmdb, rpdb] = await Promise.all([
    validators.checkTorbox(torboxKey),
    validators.checkTmdb(tmdbKey),
    validators.checkRpdb(rpdbKey),
  ])
  stats.track(`validate:torbox:${torbox.valid ? 'ok' : 'fail'}`)
  stats.track(`validate:tmdb:${tmdb.valid ? 'ok' : 'fail'}`)
  if (rpdb) stats.track(`validate:rpdb:${rpdb.valid ? 'ok' : 'fail'}`)
  if (torbox.valid && tmdb.valid) stats.trackUser({ torboxKey, tmdbKey, rpdbKey: rpdbKey || null })
  res.json({ torbox, tmdb, rpdb })
})

app.post('/api/cache/clear', rateLimit('cacheClear', RATE_LIMITS.cacheClear, { failClosed: true }), requireAdmin, async (req, res) => {
  req.statsKind = 'admin'
  await library.clearCache()
  tmdb.clearCache()
  stats.track('admin:cache_cleared')
  res.json({ cleared: true })
})

app.get('/stats', (req, res) => {
  if (!config.ADMIN_SECRET) {
    res.status(503).type('html').send(
      '<!doctype html><meta charset="utf-8"><title>Stats unavailable</title>' +
      '<body style="font:15px system-ui;background:#12101a;color:#e8e4f0;padding:3rem">' +
      '<h1 style="font-size:1.25rem">Stats dashboard is disabled</h1>' +
      '<p>Set <code>ADMIN_SECRET</code> in the environment and restart to enable <code>/stats</code>.</p>'
    )
    return
  }
  res.type('html').send(STATS_HTML.replace(/__LOGO_VERSION__/g, String(logoVersion())))
})

app.get('/api/stats', rateLimit('stats', RATE_LIMITS.stats, { failClosed: true }), requireAdmin, async (req, res) => {
  try {
    const payload = await stats.summary({ fresh: req.query.fresh === '1' })
    res.json({ ok: true, stats: payload })
  } catch (err) {
    console.error('stats handler error:', err)
    res.status(500).json({ ok: false, error: 'Could not compute stats' })
  }
})

function toPublicEntry(e) {
  return {
    id: e.id,
    type: e.type,
    imdb_id: e.imdbId,
    season: e.season,
    episode: e.episode,
    stream_url: e.streamUrl,
    title: e.title,
    created_at: e.createdAt,
    expires_at: e.expiresAt,
  }
}

async function enrichEntry(e, tmdbKey, rpdbKey) {
  const found = e.imdbId ? await tmdb.findByImdbId(e.imdbId, tmdbKey).catch(() => null) : null
  const tmdbRes = found ? found.result : null
  const name = (tmdbRes && (tmdbRes.title || tmdbRes.name)) || e.title || e.imdbId
  const poster = library.posterUrlFor(tmdbRes, e.type, rpdbKey)
  return { ...toPublicEntry(e), name, poster }
}

app.post('/api/custom-streams/list', rateLimit('customStreamRead', RATE_LIMITS.customStreamRead), async (req, res) => {
  req.statsKind = 'custom:list'
  const { torbox_key: torboxKey, tmdb_key: tmdbKey, rpdb_key: rpdbKey } = req.body || {}
  if (!torboxKey || !tmdbKey) {
    return res.status(400).json({ ok: false, error: 'torbox_key and tmdb_key are required' })
  }
  stats.trackUser({ torboxKey, tmdbKey, rpdbKey: rpdbKey || null })
  const entries = await customStreams.listCustomStreams(torboxKey, tmdbKey, rpdbKey || null)
  const enriched = await Promise.all(entries.map((e) => enrichEntry(e, tmdbKey, rpdbKey || null)))
  res.json({ ok: true, entries: enriched })
})

app.post('/api/custom-streams/add', rateLimit('customStreamWrite', RATE_LIMITS.customStreamWrite), async (req, res) => {
  req.statsKind = 'custom:add'
  const {
    torbox_key: torboxKey, tmdb_key: tmdbKey, rpdb_key: rpdbKey,
    type, imdb_id: imdbId, season, episode, stream_url: streamUrl, title, ttl_seconds: ttlSeconds,
  } = req.body || {}

  if (!torboxKey || !tmdbKey) {
    return res.status(400).json({ ok: false, error: 'torbox_key and tmdb_key are required' })
  }
  if (type !== 'movie' && type !== 'series') {
    return res.status(400).json({ ok: false, error: 'type must be "movie" or "series"' })
  }
  const trimmedTitle = typeof title === 'string' ? title.trim().slice(0, 200) : ''
  if (imdbId && !customStreams.isValidImdbId(imdbId)) {
    return res.status(400).json({ ok: false, error: 'imdb_id must look like ttNNNNNNN' })
  }
  if (!imdbId && !trimmedTitle) {
    return res.status(400).json({ ok: false, error: 'Provide an IMDb id, or a title if there isn\'t one' })
  }
  if (!customStreams.isValidStreamUrl(streamUrl)) {
    return res.status(400).json({ ok: false, error: 'stream_url must be a valid http(s) URL' })
  }

  let seasonNum = null
  let episodeNum = null
  if (type === 'series') {
    seasonNum = Number(season)
    episodeNum = Number(episode)
    if (!Number.isInteger(seasonNum) || seasonNum < 0) {
      return res.status(400).json({ ok: false, error: 'season must be a non-negative integer' })
    }
    if (!Number.isInteger(episodeNum) || episodeNum < 1) {
      return res.status(400).json({ ok: false, error: 'episode must be a positive integer' })
    }
  }

  const minTtlSec = Math.floor(CUSTOM_STREAM_MIN_TTL_MS / 1000)
  const maxTtlSec = Math.floor(CUSTOM_STREAM_MAX_TTL_MS / 1000)
  let ttlMs = CUSTOM_STREAM_DEFAULT_TTL_MS
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    const ttlSecondsNum = Number(ttlSeconds)
    if (!Number.isInteger(ttlSecondsNum) || ttlSecondsNum < minTtlSec || ttlSecondsNum > maxTtlSec) {
      return res.status(400).json({ ok: false, error: `ttl_seconds must be an integer between ${minTtlSec} and ${maxTtlSec}` })
    }
    ttlMs = ttlSecondsNum * 1000
  }

  const entry = await customStreams.addCustomStream(torboxKey, tmdbKey, rpdbKey || null, {
    type, imdbId: imdbId || null, season: seasonNum, episode: episodeNum, streamUrl, title: trimmedTitle || null, ttlMs,
  })
  if (!entry) {
    return res.status(400).json({ ok: false, error: 'Custom stream limit reached, or storage is not configured' })
  }
  res.json({ ok: true, entry: toPublicEntry(entry) })
})

app.post('/api/custom-streams/remove', rateLimit('customStreamRead', RATE_LIMITS.customStreamRead), async (req, res) => {
  req.statsKind = 'custom:remove'
  const { torbox_key: torboxKey, tmdb_key: tmdbKey, rpdb_key: rpdbKey, id } = req.body || {}
  if (!torboxKey || !tmdbKey || !id) {
    return res.status(400).json({ ok: false, error: 'torbox_key, tmdb_key, and id are required' })
  }
  const removed = await customStreams.removeCustomStream(torboxKey, tmdbKey, rpdbKey || null, id)
  if (!removed) {
    return res.status(404).json({ ok: false, error: 'Entry not found or already expired' })
  }
  res.json({ ok: true })
})

app.get('/logo.png', stremioCors, (req, res) => {
  res.set('Cache-Control', 'public, max-age=31536000, immutable')
  res.sendFile(LOGO_PATH)
})



function stripJsonExt(s) {
  return s.endsWith('.json') ? s.slice(0, -5) : s
}

/** Absolute base URL for links this addon serves back to the player. BASE_URL wins when
 *  set; otherwise it's derived from the request, which keeps localhost and tunnels working
 *  without configuration. req.protocol reflects X-Forwarded-Proto only as far as the
 *  `trust proxy` setting allows, so it can't be spoofed past the real proxy. */
function publicBaseUrl(req) {
  if (config.BASE_URL) return config.BASE_URL
  return `${req.protocol}://${req.get('host')}`
}

// Stremio encodes catalog extras as a path segment, e.g. /catalog/movie/id/skip=100.json
// decodeURIComponent throws URIError on malformed input (a bare `%`), so each pair is
// decoded defensively — one bad extra shouldn't fail the whole request.
function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseExtra(raw) {
  const out = {}
  if (!raw) return out
  for (const pair of raw.split('&')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    out[safeDecode(pair.slice(0, idx))] = safeDecode(pair.slice(idx + 1))
  }
  return out
}

// Only gates the no-:config fallback to DEFAULT_* env keys — a :config URL already carries its
// own credentials. Off by default (preserves existing behavior); set ADDON_ACCESS_TOKEN to stop
// anyone with the bare addon URL from browsing/streaming through your own TorBox account.
function defaultAccessAllowed(req, cfg) {
  if (cfg) return true
  if (!addon.HAS_DEFAULTS || !config.ADDON_ACCESS_TOKEN) return true
  return req.query.token === config.ADDON_ACCESS_TOKEN
}

function trackConfiguredUser(cfg) {
  const keys = addon.resolveKeys(cfg)
  if (keys) stats.trackUser(keys)
}

// Folded to a known set before reaching a stats key name, so a varied URL can't mint
// unbounded month-lived Redis keys.
const KNOWN_CATALOG_IDS = new Set(addon.manifest.catalogs.map((c) => c.id))

function knownCatalogId(id) {
  return KNOWN_CATALOG_IDS.has(id) ? id : 'unknown'
}

function knownType(type) {
  return type === 'movie' || type === 'series' ? type : 'other'
}

function manifestHandler(req, res) {
  req.statsKind = 'manifest'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  trackConfiguredUser(cfg)
  stats.track(cfg ? 'manifest:configured' : 'manifest:default')
  res.type('application/json').send(JSON.stringify(addon.manifestFor(cfg)))
}

app.get('/manifest.json', stremioCors, manifestHandler)
app.get('/:config/manifest.json', stremioCors, manifestHandler)

async function catalogHandler(req, res) {
  req.statsKind = 'catalog'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  trackConfiguredUser(cfg)
  const type = req.params.type
  let id, extra
  if (req.params.extraWithExt !== undefined) {
    id = req.params.id
    extra = parseExtra(stripJsonExt(req.params.extraWithExt))
  } else {
    id = stripJsonExt(req.params.idWithExt)
    extra = {}
  }
  try {
    const result = await addon.getCatalog({ type, id, config: cfg, extra })
    stats.track(`catalog:${knownCatalogId(id)}`)
    if (!result.metas.length) stats.track('catalog:empty')
    res.type('application/json').send(JSON.stringify(result))
  } catch (err) {
    console.error('catalog handler error:', err)
    stats.track('error:catalog')
    res.status(500).json({ err: 'handler error' })
  }
}

async function metaHandler(req, res) {
  req.statsKind = 'meta'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  trackConfiguredUser(cfg)
  const type = req.params.type
  const id = stripJsonExt(req.params.idWithExt)
  try {
    const result = await addon.getMeta({ type, id, config: cfg })
    if (!result) {
      stats.track('meta:not_found')
      res.status(404).json({ err: 'not found' })
      return
    }
    stats.track(`meta:${knownType(type)}`)
    res.type('application/json').send(JSON.stringify(result))
  } catch (err) {
    console.error('meta handler error:', err)
    stats.track('error:meta')
    res.status(500).json({ err: 'handler error' })
  }
}

async function streamHandler(req, res) {
  req.statsKind = 'stream'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  trackConfiguredUser(cfg)
  const type = req.params.type
  const id = stripJsonExt(req.params.idWithExt)
  try {
    const result = await addon.getStream({
      type, id, config: cfg,
      urlContext: { baseUrl: publicBaseUrl(req), configPath: req.params.config || null },
    })
    if (!result) {
      stats.track('stream:not_found')
      res.status(404).json({ err: 'not found' })
      return
    }
    stats.track(`stream:${knownType(type)}`)
    stats.track('stream:offered', (result.streams || []).length)
    if (id.startsWith('tb:custom:')) stats.track('stream:custom')
    res.type('application/json').send(JSON.stringify(result))
  } catch (err) {
    console.error('stream handler error:', err)
    stats.track('error:stream')
    res.status(500).json({ err: 'handler error' })
  }
}

// Stremio appends match hints as an extra path segment, e.g.
// /subtitles/series/tb:series:tmdb-1234:1:5/videoHash=abc&videoSize=123.json
async function subtitlesHandler(req, res) {
  req.statsKind = 'subtitles'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  trackConfiguredUser(cfg)
  const type = req.params.type
  let id, extra
  if (req.params.extraWithExt !== undefined) {
    id = req.params.id
    extra = parseExtra(stripJsonExt(req.params.extraWithExt))
  } else {
    id = stripJsonExt(req.params.idWithExt)
    extra = {}
  }
  try {
    const result = await addon.getSubtitles({
      type, id, config: cfg, extra,
      urlContext: { baseUrl: publicBaseUrl(req), configPath: req.params.config || null },
    })
    stats.track(`subtitles:${knownType(type)}`)
    if (!result.subtitles.length) stats.track('subtitles:empty')
    res.type('application/json').send(JSON.stringify(result))
  } catch (err) {
    console.error('subtitles handler error:', err)
    stats.track('error:subtitles')
    // An empty list is a valid answer; a 500 makes Stremio surface an error to the user.
    res.type('application/json').send(JSON.stringify({ subtitles: [] }))
  }
}

app.get('/catalog/:type/:idWithExt', stremioCors, catalogHandler)
app.get('/:config/catalog/:type/:idWithExt', stremioCors, catalogHandler)

app.get('/catalog/:type/:id/:extraWithExt', stremioCors, catalogHandler)
app.get('/:config/catalog/:type/:id/:extraWithExt', stremioCors, catalogHandler)

app.get('/meta/:type/:idWithExt', stremioCors, metaHandler)
app.get('/:config/meta/:type/:idWithExt', stremioCors, metaHandler)

app.get('/stream/:type/:idWithExt', stremioCors, streamHandler)
app.get('/:config/stream/:type/:idWithExt', stremioCors, streamHandler)

app.get('/subtitles/:type/:idWithExt', stremioCors, subtitlesHandler)
app.get('/:config/subtitles/:type/:idWithExt', stremioCors, subtitlesHandler)

app.get('/subtitles/:type/:id/:extraWithExt', stremioCors, subtitlesHandler)
app.get('/:config/subtitles/:type/:id/:extraWithExt', stremioCors, subtitlesHandler)

// Proxy for subtitle files that ship inside a TorBox entry. The coordinates are numeric
// ids validated in subfile.js and the key comes from the caller's own config, so this
// can only ever read from the requester's own TorBox account — it is not a general proxy.
async function subfileHandler(req, res) {
  req.statsKind = 'subfile'
  const cfg = req.params.config ? decodeConfigParam(req.params.config) : null
  if (!defaultAccessAllowed(req, cfg)) {
    res.status(401).json({ err: 'unauthorized' })
    return
  }
  const torboxKey = addon.torboxKeyFor(cfg)
  if (!torboxKey) {
    res.status(404).type('text/plain').send('Not found')
    return
  }
  const { source, itemId, fileId } = req.params
  const filename = req.params.filename || ''
  try {
    const file = await subfile.fetchSubtitle(torboxKey, source, itemId, fileId, filename)
    if (!file) {
      res.status(404).type('text/plain').send('Not found')
      return
    }
    // `private` keeps shared proxies out of it, and revalidation means a client that
    // does key its cache loosely still checks back rather than serving a stale episode.
    res.set('Cache-Control', 'private, max-age=0, must-revalidate')
    res.type(file.contentType).send(file.text)
  } catch (err) {
    console.error('subfile handler error:', err)
    stats.track('error:subfile')
    res.status(404).type('text/plain').send('Not found')
  }
}

const subfileLimit = rateLimit('subfile', RATE_LIMITS.subfile)

app.get('/subfile/:source/:itemId/:fileId/:filename', stremioCors, subfileLimit, subfileHandler)
app.get('/:config/subfile/:source/:itemId/:fileId/:filename', stremioCors, subfileLimit, subfileHandler)
app.get('/subfile/:source/:itemId/:fileId', stremioCors, subfileLimit, subfileHandler)
app.get('/:config/subfile/:source/:itemId/:fileId', stremioCors, subfileLimit, subfileHandler)

module.exports = app
