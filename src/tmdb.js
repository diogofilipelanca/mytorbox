const crypto = require('crypto')
const { TMDB_BASE, TMDB_IMAGE_BASE, TMDB_CACHE_TTL_SECONDS, TMDB_NEGATIVE_CACHE_TTL_SECONDS } = require('./config')
const { getJson } = require('./httpUtils')
const redis = require('./redisClient')
const stats = require('./stats')

const cache = new Map()
const imagesCache = new Map()
const findCache = new Map()
const externalIdsCache = new Map()
async function cachedLookup(ns, l1, l1key, fetchFn) {
  if (l1.has(l1key)) {
    stats.track('tmdb:hit_memory')
    return l1.get(l1key)
  }
  const rk = `tmdb:${ns}:${crypto.createHash('sha1').update(l1key).digest('hex')}`
  if (redis) {
    try {
      const raw = await redis.get(rk)
      if (raw != null) {
        const value = JSON.parse(raw)
        l1.set(l1key, value)
        stats.track('tmdb:hit_redis')
        return value
      }
    } catch {
      // fall through to a live fetch on any Redis error
    }
  }
  const value = await fetchFn()
  stats.track('tmdb:fetch')
  if (value == null) stats.track('tmdb:no_match')
  l1.set(l1key, value)
  if (redis) {
    // Cache "no match"/errors only briefly so late-arriving TMDB entries surface soon.
    const ttl = value == null ? TMDB_NEGATIVE_CACHE_TTL_SECONDS : TMDB_CACHE_TTL_SECONDS
    try {
      await redis.set(rk, JSON.stringify(value), 'EX', ttl)
    } catch {
      // caching is best-effort
    }
  }
  return value
}

async function searchOnce(title, year, kind, apiKey) {
  const params = new URLSearchParams({ api_key: apiKey, query: title })
  const yearKey = kind === 'movie' ? 'year' : 'first_air_date_year'
  if (year) params.set(yearKey, year)
  const url = `${TMDB_BASE}/search/${kind}?${params.toString()}`
  const data = await getJson(url)
  const results = (data && data.results) || []
  return results[0] || null
}

async function search(title, year, kind, apiKey) {
  const key = `${kind}|${title.trim().toLowerCase()}|${year || ''}`
  return cachedLookup('s', cache, key, async () => {
    // A TMDB failure must not abort the whole library build. Unlike getImages and
    // findByImdbId, this call used to let the error propagate all the way out of
    // buildLibrary, so one bad response emptied the entire catalog. Degrading to null
    // leaves the item in the catalog under its raw title, just without poster/metadata.
    try {
      let result = await searchOnce(title, year, kind, apiKey)
      if (!result && year) {
        result = await searchOnce(title, null, kind, apiKey)
      }
      return result
    } catch (err) {
      console.warn('tmdb: search failed, continuing without a match:', err.message)
      stats.track('tmdb:search_error')
      return null
    }
  })
}

function posterUrl(result) {
  if (!result || !result.poster_path) return null
  return `${TMDB_IMAGE_BASE}${result.poster_path}`
}

async function getImages(kind, tmdbId, apiKey) {
  const key = `${kind}:${tmdbId}`
  return cachedLookup('i', imagesCache, key, async () => {
    try {
      return await getJson(`${TMDB_BASE}/${kind}/${tmdbId}/images?api_key=${apiKey}`)
    } catch {
      return null
    }
  })
}

/** Prefer a logo in the title's own language, then a language-neutral one, then English. */
function logoUrl(images, originalLanguage) {
  const logos = (images && images.logos) || []
  if (!logos.length) return null
  const byLang = (lang) => logos.find((l) => l.iso_639_1 === lang)
  const chosen = byLang(originalLanguage) || byLang(null) || byLang('en') || logos[0]
  return chosen ? `${TMDB_IMAGE_BASE}${chosen.file_path}` : null
}

async function findByImdbId(imdbId, apiKey) {
  const key = `find:${imdbId}`
  return cachedLookup('f', findCache, key, async () => {
    try {
      const url = `${TMDB_BASE}/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`
      const data = await getJson(url)
      const movie = (data && data.movie_results && data.movie_results[0]) || null
      const tv = (data && data.tv_results && data.tv_results[0]) || null
      return movie ? { kind: 'movie', result: movie } : tv ? { kind: 'tv', result: tv } : null
    } catch {
      return null
    }
  })
}

/** The reverse of findByImdbId: TMDB id -> IMDb id. The library builds its own `tmdb-<id>`
 *  canonical keys, but every subtitle provider speaks IMDb, so this is the bridge. */
async function getExternalIds(kind, tmdbId, apiKey) {
  const key = `ext:${kind}:${tmdbId}`
  return cachedLookup('e', externalIdsCache, key, async () => {
    try {
      const params = new URLSearchParams({ api_key: apiKey })
      const data = await getJson(`${TMDB_BASE}/${kind}/${tmdbId}/external_ids?${params.toString()}`)
      return (data && data.imdb_id) ? { imdbId: data.imdb_id } : null
    } catch {
      return null
    }
  })
}

function clearCache() {
  cache.clear()
  imagesCache.clear()
  findCache.clear()
  externalIdsCache.clear()
}

module.exports = { search, posterUrl, getImages, logoUrl, findByImdbId, getExternalIds, clearCache }
