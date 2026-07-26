const crypto = require('crypto')
const redis = require('./redisClient')
const stats = require('./stats')
const { buildStreamUrl, isKnownSource, extensionOf } = require('./torbox')
const { MAX_SUBTITLE_BYTES, SUBFILE_CACHE_TTL_SECONDS } = require('./config')

/**
 * Serving subtitle files that ship inside a TorBox entry.
 *
 * These are proxied rather than linked, for two reasons:
 *   1. Encoding. Release-pack .srt files are frequently Windows-1252 or ISO-8859-1.
 *      Stremio expects UTF-8, so a direct link renders accented text as mojibake —
 *      which in Portuguese means most lines. We transcode on the way through.
 *   2. Credentials. A direct link would be a TorBox requestdl URL with `token=<apiKey>`
 *      embedded, handed to the player and anything that logs it. Proxying keeps the key
 *      on the server.
 */

// UTF-16 and UTF-8 byte-order marks. A BOM is authoritative when present.
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
]

function detectBom(buf) {
  for (const bom of BOMS) {
    if (buf.length >= bom.skip && bom.bytes.every((b, i) => buf[i] === b)) return bom
  }
  return null
}

function isValidUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return true
  } catch {
    return false
  }
}

/**
 * Decode a subtitle file to a JS string.
 * BOM wins; otherwise strict UTF-8 is tried, and anything that fails it is treated as
 * Windows-1252 — a superset of Latin-1 that covers essentially every Western European
 * release pack, and never itself fails to decode.
 */
function decodeSubtitle(buf) {
  const bom = detectBom(buf)
  if (bom) {
    return {
      text: new TextDecoder(bom.encoding).decode(buf.subarray(bom.skip)),
      encoding: `${bom.encoding} (BOM)`,
    }
  }
  if (isValidUtf8(buf)) {
    return { text: new TextDecoder('utf-8').decode(buf), encoding: 'utf-8' }
  }
  return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' }
}

const CONTENT_TYPES = {
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.ass': 'text/x-ssa; charset=utf-8',
  '.ssa': 'text/x-ssa; charset=utf-8',
  '.sub': 'text/plain; charset=utf-8',
}

function contentTypeFor(filename) {
  return CONTENT_TYPES[extensionOf(filename)] || 'text/plain; charset=utf-8'
}

/** Numeric ids only — these go straight into an upstream URL. */
function validCoordinates(source, itemId, fileId) {
  return isKnownSource(source) && /^\d+$/.test(String(itemId)) && /^\d+$/.test(String(fileId))
}

function cacheKeyFor(torboxKey, source, itemId, fileId) {
  const owner = crypto.createHash('sha256').update(torboxKey).digest('hex').slice(0, 16)
  return `sf:${owner}:${source}:${itemId}:${fileId}`
}

/**
 * Fetch one subtitle file from TorBox and return it as UTF-8 text.
 * Returns null when the coordinates are invalid, the file is too large, or the fetch
 * fails — callers turn that into a 404 rather than surfacing an upstream error.
 */
async function fetchSubtitle(torboxKey, source, itemId, fileId, filename = '') {
  if (!validCoordinates(source, itemId, fileId)) return null

  const cacheKey = cacheKeyFor(torboxKey, source, itemId, fileId)
  if (redis) {
    try {
      const cached = await redis.get(cacheKey)
      if (cached != null) {
        stats.track('subfile:hit')
        return { text: cached, contentType: contentTypeFor(filename) }
      }
    } catch {
      // fall through to a live fetch
    }
  }

  const url = buildStreamUrl(source, itemId, fileId, torboxKey)
  let res
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'MyTorbox/1.0' },
      signal: AbortSignal.timeout(15000),
    })
  } catch (err) {
    console.warn('subfile: fetch failed:', err.message)
    stats.track('subfile:error')
    return null
  }
  if (!res.ok) {
    // Never log the URL — it carries the TorBox key as a query parameter.
    console.warn(`subfile: upstream returned HTTP ${res.status}`)
    stats.track('subfile:error')
    return null
  }

  // Guard before buffering: a mislabelled file shouldn't pull hundreds of MB into memory.
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_SUBTITLE_BYTES) {
    stats.track('subfile:too_big')
    return null
  }

  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength > MAX_SUBTITLE_BYTES) {
    stats.track('subfile:too_big')
    return null
  }

  const { text, encoding } = decodeSubtitle(buf)
  stats.track('subfile:served')
  stats.track(`subfile:encoding:${encoding.split(' ')[0]}`)

  if (redis) {
    try {
      await redis.set(cacheKey, text, 'EX', SUBFILE_CACHE_TTL_SECONDS)
    } catch {
      // caching is best-effort
    }
  }
  return { text, contentType: contentTypeFor(filename) }
}

module.exports = { fetchSubtitle, decodeSubtitle, validCoordinates, contentTypeFor }
