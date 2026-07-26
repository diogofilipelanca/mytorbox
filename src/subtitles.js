const tmdb = require('./tmdb')
const redis = require('./redisClient')
const stats = require('./stats')
const { getJson } = require('./httpUtils')
const { OPENSUBTITLES_BASE, SUBTITLE_CACHE_TTL_SECONDS } = require('./config')

const IMDB_ID_RE = /^tt\d+$/

/**
 * Why this module exists
 * ----------------------
 * Subtitle addons (including Stremio's bundled OpenSubtitles v3) declare
 * `idPrefixes: ['tt']` — they only answer for IMDb ids. This addon mints its own
 * `tb:` ids, so Stremio never even asks them, and every item shows up with no
 * subtitles at all. We declare the `subtitles` resource for `tb:` ourselves and
 * act as a translation layer: `tb:` id -> IMDb id -> upstream provider.
 */

/**
 * Split an addon id into its parts.
 *   tb:movie:tmdb-550                -> { kind: 'movie', canonical: 'tmdb-550' }
 *   tb:series:tmdb-1234:1:5          -> { kind: 'tv', canonical: 'tmdb-1234', season: 1, episode: 5 }
 *   tb:custom:movie:tt0137523        -> { kind: 'movie', canonical: 'tt0137523' }
 *   tb:custom:series:tt0137523:1:5   -> { kind: 'tv', canonical: 'tt0137523', season: 1, episode: 5 }
 */
function parseAddonId(id) {
  if (typeof id !== 'string' || !id.startsWith('tb:')) return null
  const parts = id.split(':')
  const custom = parts[1] === 'custom'
  const type = custom ? parts[2] : parts[1]
  const canonical = custom ? parts[3] : parts[2]
  if (!type || !canonical) return null

  const seasonRaw = custom ? parts[4] : parts[3]
  const episodeRaw = custom ? parts[5] : parts[4]
  const season = Number(seasonRaw)
  const episode = Number(episodeRaw)

  return {
    kind: type === 'series' ? 'tv' : 'movie',
    canonical,
    season: Number.isInteger(season) ? season : null,
    episode: Number.isInteger(episode) ? episode : null,
  }
}

/**
 * Resolve the canonical part of an addon id to an IMDb id.
 * Custom streams already carry one. Library items are keyed `tmdb-<id>` and need a
 * lookup. Items TMDB never matched are keyed `raw-<slug>`/`noimdb-<slug>` and have
 * nothing to resolve — those simply get no subtitles.
 */
async function imdbIdFor(parsed, tmdbKey) {
  if (IMDB_ID_RE.test(parsed.canonical)) return parsed.canonical
  if (!parsed.canonical.startsWith('tmdb-')) return null

  const tmdbId = parsed.canonical.slice('tmdb-'.length)
  if (!/^\d+$/.test(tmdbId)) return null

  const external = await tmdb.getExternalIds(parsed.kind, tmdbId, tmdbKey)
  const imdbId = external && external.imdbId
  return imdbId && IMDB_ID_RE.test(imdbId) ? imdbId : null
}

/** Build the id the upstream provider expects: `tt123` for films, `tt123:1:5` per episode. */
function upstreamId(imdbId, parsed) {
  if (parsed.kind !== 'tv') return imdbId
  if (parsed.season == null || parsed.episode == null) return null
  return `${imdbId}:${parsed.season}:${parsed.episode}`
}

/** Forward the hints Stremio sends (videoHash, videoSize, filename) — they materially
 *  improve match quality, and the upstream addon knows what to do with them. */
function extraSegment(extra) {
  const allowed = ['videoHash', 'videoSize', 'filename']
  const pairs = allowed
    .filter((k) => extra && extra[k] != null && extra[k] !== '')
    .map((k) => `${k}=${encodeURIComponent(extra[k])}`)
  return pairs.length ? `/${pairs.join('&')}` : ''
}

function cacheKeyFor(type, id, extra) {
  return `sub:${type}:${id}${extraSegment(extra)}`
}

const UPSTREAM_HEADERS = { 'User-Agent': 'MyTorbox/1.0 (+stremio-addon)' }

async function fetchUpstream(type, id, extra) {
  const url = `${OPENSUBTITLES_BASE}/subtitles/${type}/${encodeURIComponent(id)}${extraSegment(extra)}.json`
  try {
    const data = await getJson(url, { headers: UPSTREAM_HEADERS }, 2)
    return (data && Array.isArray(data.subtitles)) ? data.subtitles : []
  } catch (err) {
    console.warn('subtitles: upstream lookup failed:', err.message)
    stats.track('subtitles:upstream_error')
    return []
  }
}

async function cachedUpstream(type, id, extra) {
  const key = cacheKeyFor(type, id, extra)
  if (redis) {
    try {
      const raw = await redis.get(key)
      if (raw != null) {
        stats.track('subtitles:hit')
        return JSON.parse(raw)
      }
    } catch {
      // fall through to a live fetch
    }
  }
  const subtitles = await fetchUpstream(type, id, extra)
  if (redis) {
    try {
      await redis.set(key, JSON.stringify(subtitles), 'EX', SUBTITLE_CACHE_TTL_SECONDS)
    } catch {
      // caching is best-effort
    }
  }
  return subtitles
}

/** Stremio expects every subtitle to carry a unique id; upstream ids are only unique
 *  within one response, so namespace them to avoid collisions between providers. */
function normalise(subtitles) {
  return subtitles
    .filter((s) => s && s.url)
    .map((s, i) => ({
      id: `os-${s.id != null ? s.id : i}`,
      url: s.url,
      lang: s.lang || s.language || 'unknown',
    }))
}

/** Build the proxy URL for a subtitle file that lives inside the user's TorBox entry.
 *  Routed through this addon rather than linked directly to TorBox — see subfile.js. */
function localSubtitleUrl(entry, { baseUrl, configPath }) {
  const prefix = configPath ? `${baseUrl}/${configPath}` : baseUrl
  const name = encodeURIComponent(entry.filename || 'subtitle.srt')
  return `${prefix}/subfile/${entry.source}/${entry.itemId}/${entry.fileId}/${name}`
}

/** Subtitles shipped with the file are cut for that exact encode, so they're almost
 *  always better synced than a generic download. They go first; Stremio keeps the order. */
function localSubtitles(entries, urlContext) {
  if (!Array.isArray(entries)) return []
  return entries.map((e, i) => ({
    id: `tb-${e.source}-${e.itemId}-${e.fileId}-${i}`,
    url: localSubtitleUrl(e, urlContext),
    lang: e.forced ? `${e.lang}-forced` : e.lang,
  }))
}

async function getSubtitles({ type, id, keys, extra = {}, localEntries = [], urlContext = null }) {
  if (!keys) return { subtitles: [] }

  const parsed = parseAddonId(id)
  if (!parsed) return { subtitles: [] }

  const local = urlContext ? localSubtitles(localEntries, urlContext) : []
  if (local.length) stats.track('subtitles:local', local.length)

  const imdbId = await imdbIdFor(parsed, keys.tmdbKey)
  const target = imdbId ? upstreamId(imdbId, parsed) : null
  if (!imdbId) stats.track('subtitles:no_imdb')

  let upstream = []
  if (target) {
    const upstreamType = parsed.kind === 'tv' ? 'series' : 'movie'
    upstream = normalise(await cachedUpstream(upstreamType, target, extra))
  }

  const subtitles = [...local, ...upstream]
  stats.track('subtitles:served', subtitles.length)
  return { subtitles }
}

module.exports = { getSubtitles, parseAddonId, imdbIdFor, upstreamId, localSubtitles }
