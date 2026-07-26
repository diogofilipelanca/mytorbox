const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

// Query params that must never reach a log line or an error message.
const SECRET_PARAMS = ['api_key', 'apikey', 'token', 'access_token', 'key']

/** Strip credentials from a URL before it goes into an Error message. Error messages
 *  end up in console.error() in the route handlers, and TMDB/TorBox both accept their
 *  credential as a query param — so an unsanitised URL writes a live API key to the logs. */
function safeUrl(raw) {
  try {
    const parsed = new URL(raw)
    for (const param of SECRET_PARAMS) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, '[redacted]')
    }
    return parsed.toString()
  } catch {
    return '[unparseable url]'
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function getJson(url, options = {}, retries = 5) {
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    let res
    try {
      res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) })
    } catch (e) {
      lastErr = e
      await sleep(1500 * (attempt + 1))
      continue
    }
    if (RETRYABLE_STATUS.has(res.status)) {
      lastErr = new Error(`retryable status ${res.status} for ${safeUrl(url)}`)
      await sleep(1500 * (attempt + 1))
      continue
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${safeUrl(url)}`)
    }
    return res.json()
  }
  throw lastErr
}

module.exports = { getJson, sleep, safeUrl }
