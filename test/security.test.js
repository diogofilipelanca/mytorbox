const assert = require('node:assert/strict')
const { test } = require('node:test')
const express = require('express')

// 0 = no reverse proxy in front, which is what this test process actually is. Express
// honours exactly TRUST_PROXY_HOPS entries of X-Forwarded-For, so testing with 1 here
// would (correctly) accept the forged header and prove nothing.
process.env.TRUST_PROXY_HOPS = '0'
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'test-admin-secret'

const app = require('../src/server')
const { safeUrl } = require('../src/httpUtils')
const { parseAddonId, upstreamId } = require('../src/subtitles')

let server
let base

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`
      resolve()
    })
  })
})

test.after(() => server && server.close())

function configPath(cfg) {
  return Buffer.from(JSON.stringify(cfg)).toString('base64url')
}

// --- Finding 1: reflected XSS via $-substitution in String.replace ---

/** Remove every double-quoted attribute value, so whatever is left is real markup.
 *  Text sitting inside value="..." is inert; the same text outside it is an attribute. */
function markupSkeleton(html) {
  return html.replace(/"[^"]*"/g, '""')
}

test('configure page does not expand $& into an attribute breakout', async () => {
  const payload = '$& onfocus=alert(document.domain) autofocus '
  const res = await fetch(`${base}/${configPath({ torbox_key: payload })}/configure`)
  const html = await res.text()

  assert.equal(res.status, 200)
  // The literal text still appears — inside the quoted value, which is fine and expected.
  assert.ok(html.includes('onfocus=alert(document.domain)'), 'payload should be reflected')
  // What must NOT happen is it becoming a real attribute once quoted values are stripped.
  assert.ok(
    !markupSkeleton(html).includes('onfocus'),
    'live event handler escaped the value attribute'
  )
  assert.ok(!markupSkeleton(html).includes('autofocus'))
})

test("configure page does not expand $' either", async () => {
  const res = await fetch(`${base}/${configPath({ torbox_key: "$'" })}/configure`)
  const html = await res.text()
  assert.ok(!html.includes('value="id="torbox"'), 'attribute breakout via $\' still possible')
})

test('ordinary HTML metacharacters stay escaped', async () => {
  const res = await fetch(`${base}/${configPath({ torbox_key: '<script>alert(1)</script>' })}/configure`)
  const html = await res.text()
  assert.ok(!html.includes('<script>alert(1)</script>'))
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'))
})

// --- Finding 2: rate limiting bypass via forged X-Forwarded-For ---

test('a forged X-Forwarded-For does not become the rate-limit identity', async () => {
  // TRUST_PROXY_HOPS=0: the header is ignored entirely, so all 25 requests share the
  // socket-address bucket and the 20-per-window limit bites.
  const hits = []
  for (let i = 0; i < 25; i++) {
    const res = await fetch(`${base}/api/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}` },
      body: JSON.stringify({ torbox_key: 'x', tmdb_key: 'y' }),
    })
    hits.push(res.status)
  }
  assert.ok(hits.includes(429), 'rotating XFF still bypassed the 20-per-window limit')
})

test('with one proxy configured, only that proxy\'s hop is honoured', async () => {
  // Behind a real proxy, TRUST_PROXY_HOPS=1 is correct — but a client that pads the
  // header with extra entries must not be able to reach past the proxy's own append.
  const probe = express()
  probe.set('trust proxy', 1)
  probe.get('/', (req, res) => res.json({ ip: req.ip }))

  const s = await new Promise((resolve) => {
    const srv = probe.listen(0, () => resolve(srv))
  })
  const url = `http://127.0.0.1:${s.address().port}/`
  try {
    const spoofed = await fetch(url, { headers: { 'X-Forwarded-For': '1.1.1.1, 2.2.2.2, 3.3.3.3' } })
    // The rightmost entry is the one the trusted proxy appended; earlier ones are client-supplied.
    assert.equal((await spoofed.json()).ip, '3.3.3.3')
  } finally {
    s.close()
  }

  // The app must therefore never be reachable except through that proxy — see the
  // deploy config, where the container port is not published to the host.
})

test('non-IP junk in X-Forwarded-For cannot mint unbounded rate-limit keys', () => {
  const { clientKey } = require('../src/rateLimit')
  assert.equal(clientKey({ ip: 'not-an-ip', socket: {} }), 'unknown')
  assert.equal(clientKey({ ip: '0.08439804708188192', socket: {} }), 'unknown')
  assert.equal(clientKey({ ip: '1.2.3.4', socket: {} }), '1.2.3.4')
})

// --- Finding 5: credentials leaking into log lines ---

test('safeUrl redacts credentials from error messages', () => {
  const redacted = safeUrl('https://api.themoviedb.org/3/search/movie?api_key=SECRET123&query=x')
  assert.ok(!redacted.includes('SECRET123'))
  assert.ok(redacted.includes('api_key=%5Bredacted%5D') || redacted.includes('api_key=[redacted]'))
  assert.equal(safeUrl('not a url'), '[unparseable url]')
})

// --- Finding 6: security headers ---

test('security headers are present', async () => {
  const res = await fetch(`${base}/configure`)
  assert.ok(res.headers.get('content-security-policy'), 'missing CSP')
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(/frame-ancestors 'none'/.test(res.headers.get('content-security-policy')))
})

// --- Finding 7: CORS scoping ---

test('stremio protocol routes stay open, the management API does not', async () => {
  const manifest = await fetch(`${base}/manifest.json`, { headers: { Origin: 'https://evil.test' } })
  assert.equal(manifest.headers.get('access-control-allow-origin'), '*')

  const api = await fetch(`${base}/api/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: 'https://evil.test' },
    body: JSON.stringify({}),
  })
  assert.equal(api.headers.get('access-control-allow-origin'), null)
})

// --- Finding 12: malformed extras must not 500 ---

test('malformed percent-encoding in catalog extras is handled', async () => {
  const res = await fetch(`${base}/catalog/movie/torbox-movies/skip=%.json`)
  assert.notEqual(res.status, 500)
})

// --- Admin auth ---

test('admin routes reject a wrong secret and accept the right one', async () => {
  const bad = await fetch(`${base}/api/stats`, { headers: { 'x-admin-secret': 'nope' } })
  assert.equal(bad.status, 401)

  const good = await fetch(`${base}/api/stats`, { headers: { 'x-admin-secret': 'test-admin-secret' } })
  assert.equal(good.status, 200)
})

// --- Subtitles: id translation ---

test('parseAddonId understands every id shape the addon mints', () => {
  assert.deepEqual(parseAddonId('tb:movie:tmdb-550'), {
    kind: 'movie', canonical: 'tmdb-550', season: null, episode: null,
  })
  assert.deepEqual(parseAddonId('tb:series:tmdb-1234:1:5'), {
    kind: 'tv', canonical: 'tmdb-1234', season: 1, episode: 5,
  })
  assert.deepEqual(parseAddonId('tb:custom:movie:tt0137523'), {
    kind: 'movie', canonical: 'tt0137523', season: null, episode: null,
  })
  assert.deepEqual(parseAddonId('tb:custom:series:tt0137523:2:7'), {
    kind: 'tv', canonical: 'tt0137523', season: 2, episode: 7,
  })
  assert.equal(parseAddonId('tt0137523'), null)
  assert.equal(parseAddonId(''), null)
})

test('upstreamId builds the id the subtitle provider expects', () => {
  assert.equal(upstreamId('tt0137523', { kind: 'movie' }), 'tt0137523')
  assert.equal(upstreamId('tt0137523', { kind: 'tv', season: 1, episode: 5 }), 'tt0137523:1:5')
  assert.equal(upstreamId('tt0137523', { kind: 'tv', season: null, episode: null }), null)
})

test('subtitles route answers with a valid shape for an unresolvable id', async () => {
  const cfg = configPath({ torbox_key: 'x', tmdb_key: 'y' })
  const res = await fetch(`${base}/${cfg}/subtitles/movie/tb:movie:raw-unknown-film.json`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { subtitles: [] })
})

test('subtitles route accepts the extra hint segment', async () => {
  const cfg = configPath({ torbox_key: 'x', tmdb_key: 'y' })
  const res = await fetch(
    `${base}/${cfg}/subtitles/series/tb:series:raw-x/videoHash=abc123&videoSize=999.json`
  )
  assert.equal(res.status, 200)
  assert.ok(Array.isArray((await res.json()).subtitles))
})

test('manifest advertises the subtitles resource', async () => {
  const res = await fetch(`${base}/manifest.json`)
  const manifest = await res.json()
  const sub = manifest.resources.find((r) => r && r.name === 'subtitles')
  assert.ok(sub, 'subtitles resource missing from manifest')
  assert.deepEqual(sub.idPrefixes, ['tb:'])
})
