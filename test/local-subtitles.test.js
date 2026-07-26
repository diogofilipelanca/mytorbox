const assert = require('node:assert/strict')
const { test } = require('node:test')

process.env.TRUST_PROXY_HOPS = '0'

const { parseSubtitleItems, parseWorkItems, languageFromFilename, makeGuessResolver } = require('../src/parser')
const { decodeSubtitle, validCoordinates, contentTypeFor } = require('../src/subfile')
const { localSubtitles } = require('../src/subtitles')
const tmdb = require('../src/tmdb')
const { buildLibrary } = require('../src/library')

// buildLibrary enriches via TMDB. These tests are about grouping and subtitle
// attachment, so the network is stubbed out — an unmatched item still gets a catalog
// entry under a `raw-` canonical, which is exactly the path being exercised.
tmdb.search = async () => null
tmdb.getImages = async () => null
tmdb.getExternalIds = async () => null

const resolver = () => makeGuessResolver(null)

// A season pack laid out the way release packs usually are: video files at the top,
// subtitles in a Subs/ folder whose per-episode subfolders carry the identity.
function seasonPackEntry() {
  return {
    id: 42,
    name: 'Some.Show.S02.1080p.WEBRip.x265-GROUP',
    created_at: '2026-07-01T00:00:00Z',
    files: [
      { id: 1, name: 'Some.Show.S02/Some.Show.S02E01.1080p.WEBRip.x265-GROUP.mkv', short_name: 'Some.Show.S02E01.1080p.WEBRip.x265-GROUP.mkv', size: 900_000_000 },
      { id: 2, name: 'Some.Show.S02/Some.Show.S02E02.1080p.WEBRip.x265-GROUP.mkv', short_name: 'Some.Show.S02E02.1080p.WEBRip.x265-GROUP.mkv', size: 900_000_000 },
      { id: 3, name: 'Some.Show.S02/Subs/Some.Show.S02E01.1080p.WEBRip.x265-GROUP/english.srt', short_name: 'english.srt', size: 45_000 },
      { id: 4, name: 'Some.Show.S02/Subs/Some.Show.S02E01.1080p.WEBRip.x265-GROUP/portuguese.srt', short_name: 'portuguese.srt', size: 47_000 },
      { id: 5, name: 'Some.Show.S02/Subs/Some.Show.S02E02.1080p.WEBRip.x265-GROUP/english.srt', short_name: 'english.srt', size: 44_000 },
      { id: 6, name: 'Some.Show.S02/RARBG.txt', short_name: 'RARBG.txt', size: 30 },
    ],
  }
}

test('subtitles inherit episode identity from the parent folder', () => {
  const subs = [...parseSubtitleItems('torrents', seasonPackEntry(), resolver())]
  assert.equal(subs.length, 3, 'expected three subtitle files, ignoring the .txt')

  const e1 = subs.filter((s) => s.episode === 1)
  assert.equal(e1.length, 2)
  assert.equal(e1[0].season, 2, 'season should come from the folder name')
  assert.deepEqual(e1.map((s) => s.lang).sort(), ['eng', 'por'])
  assert.equal(subs.find((s) => s.episode === 2).lang, 'eng')
})

test('non-subtitle files are ignored', () => {
  const subs = [...parseSubtitleItems('torrents', seasonPackEntry(), resolver())]
  assert.ok(!subs.some((s) => s.filename.endsWith('.txt')))
  assert.ok(!subs.some((s) => s.filename.endsWith('.mkv')))
})

test('languageFromFilename copes with the usual labelling styles', () => {
  assert.equal(languageFromFilename('english.srt'), 'eng')
  assert.equal(languageFromFilename('2_English.srt'), 'eng')
  assert.equal(languageFromFilename('Portuguese.srt'), 'por')
  assert.equal(languageFromFilename('3_Portuguese (Brazilian).srt'), 'pob')
  assert.equal(languageFromFilename('Some.Show.S02E01.pt-BR.srt'), 'pob')
  assert.equal(languageFromFilename('Some.Show.S02E01.en.srt'), 'eng')
  assert.equal(languageFromFilename('Some.Show.S02E01.srt'), null)
})

test('forced and SDH tracks are flagged', () => {
  const entry = seasonPackEntry()
  entry.files.push({
    id: 7,
    name: 'Some.Show.S02/Subs/Some.Show.S02E01.1080p.WEBRip.x265-GROUP/english.sdh.srt',
    short_name: 'english.sdh.srt',
    size: 46_000,
  })
  const subs = [...parseSubtitleItems('torrents', entry, resolver())]
  const sdh = subs.find((s) => s.filename.includes('sdh'))
  assert.ok(sdh)
  assert.equal(sdh.forced, true)
  assert.equal(sdh.lang, 'eng')
})

test('a subtitle with no matching video is dropped from the library', async () => {
  const orphan = {
    id: 43,
    name: 'Orphan.Show.S01',
    created_at: '2026-07-01T00:00:00Z',
    files: [
      { id: 1, name: 'Orphan.Show.S01/Subs/Orphan.Show.S01E01.1080p.WEB/english.srt', short_name: 'english.srt', size: 40_000 },
    ],
  }
  const lib = await buildLibrary('k', 't', null, { torrents: [orphan], webdl: [] }, null)
  assert.deepEqual(lib.series, [])
  assert.deepEqual(Object.keys(lib.subtitles), [])
})

test('library attaches subtitles to the matching episode id', async () => {
  const lib = await buildLibrary('k', 't', null, { torrents: [seasonPackEntry()], webdl: [] }, null)

  const seriesId = Object.keys(lib.meta).find((k) => k.startsWith('tb:series:'))
  assert.ok(seriesId, 'series should have been built')

  const e1 = `${seriesId}:2:1`
  const e2 = `${seriesId}:2:2`
  assert.ok(lib.streams[e1], 'episode 1 stream missing')
  assert.equal(lib.subtitles[e1].length, 2)
  assert.equal(lib.subtitles[e2].length, 1)
  assert.deepEqual(lib.subtitles[e1].map((s) => s.lang).sort(), ['eng', 'por'])
})

test('cached subtitle entries never contain the TorBox key', async () => {
  const lib = await buildLibrary('SUPER-SECRET-KEY', 't', null, { torrents: [seasonPackEntry()], webdl: [] }, null)
  assert.ok(!JSON.stringify(lib.subtitles).includes('SUPER-SECRET-KEY'))
  assert.ok(!JSON.stringify(lib.streams).includes('SUPER-SECRET-KEY'))
})

// --- Encoding ---

test('decodeSubtitle handles UTF-8, Windows-1252 and BOMs', () => {
  const utf8 = Buffer.from('Olá, está tudo bem — €', 'utf8')
  assert.equal(decodeSubtitle(utf8).text, 'Olá, está tudo bem — €')
  assert.equal(decodeSubtitle(utf8).encoding, 'utf-8')

  // The same text as a Portuguese release pack would ship it.
  const cp1252 = Buffer.from([0x4f, 0x6c, 0xe1, 0x2c, 0x20, 0x65, 0x73, 0x74, 0xe1, 0x20, 0x97, 0x20, 0x80])
  const decoded = decodeSubtitle(cp1252)
  assert.equal(decoded.encoding, 'windows-1252')
  assert.equal(decoded.text, 'Olá, está — €')

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Olá', 'utf8')])
  assert.equal(decodeSubtitle(withBom).text, 'Olá', 'BOM should be stripped')

  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Olá', 'utf16le')])
  assert.equal(decodeSubtitle(utf16).text, 'Olá')
})

test('mojibake is what we avoid: latin1 bytes read as utf-8 would be lossy', () => {
  const cp1252 = Buffer.from([0x4f, 0x6c, 0xe1])
  assert.notEqual(cp1252.toString('utf8'), 'Olá')
  assert.equal(decodeSubtitle(cp1252).text, 'Olá')
})

// --- Proxy route safety ---

test('subfile coordinates reject anything non-numeric or off-source', () => {
  assert.equal(validCoordinates('torrents', '12', '3'), true)
  assert.equal(validCoordinates('webdl', '12', '3'), true)
  assert.equal(validCoordinates('evil', '12', '3'), false)
  assert.equal(validCoordinates('torrents', '../../etc/passwd', '3'), false)
  assert.equal(validCoordinates('torrents', '12', 'a'), false)
  assert.equal(validCoordinates('torrents', 'http://169.254.169.254/', '3'), false)
})

test('content types map to the subtitle format', () => {
  assert.match(contentTypeFor('a.srt'), /x-subrip/)
  assert.match(contentTypeFor('a.vtt'), /text\/vtt/)
  assert.match(contentTypeFor('a.ass'), /x-ssa/)
  assert.match(contentTypeFor('a.unknown'), /text\/plain/)
  assert.match(contentTypeFor('a.srt'), /charset=utf-8/)
})

test('local subtitle URLs point at our proxy, never at TorBox', () => {
  const entries = [
    { source: 'torrents', itemId: 42, fileId: 3, filename: 'english.srt', lang: 'eng', forced: false },
    { source: 'torrents', itemId: 42, fileId: 4, filename: 'portuguese.srt', lang: 'por', forced: true },
  ]
  const out = localSubtitles(entries, { baseUrl: 'https://addon.example', configPath: 'CFG' })

  assert.equal(out[0].url, 'https://addon.example/CFG/subfile/torrents/42/3/english.srt')
  assert.equal(out[0].lang, 'eng')
  assert.equal(out[1].lang, 'por-forced', 'forced tracks should be distinguishable')
  assert.ok(out.every((s) => !s.url.includes('torbox.app')))
  assert.ok(out.every((s) => !s.url.includes('token=')))
  assert.equal(new Set(out.map((s) => s.id)).size, out.length, 'ids must be unique')
})

test('local subtitle URLs work without a config path (defaults mode)', () => {
  const out = localSubtitles(
    [{ source: 'webdl', itemId: 7, fileId: 1, filename: 'english.srt', lang: 'eng' }],
    { baseUrl: 'https://addon.example', configPath: null }
  )
  assert.equal(out[0].url, 'https://addon.example/subfile/webdl/7/1/english.srt')
})
