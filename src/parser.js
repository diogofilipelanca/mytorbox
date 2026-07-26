const { guessit } = require('guessit-js')
const PTT = require('parse-torrent-title') // narrow fallback: guessit truncates some numeric-leading titles
const { isVideo, isSubtitleFile, extensionOf } = require('./torbox')
const { MIN_FILE_SIZE_BYTES } = require('./config')

/** Language names and codes as they appear in subtitle filenames. Release packs label
 *  them inconsistently — "english.srt", "2_English.srt", "Show.S01E01.en.srt", "pt-BR.srt". */
const RAW_LANGUAGE_ALIASES = {
  english: 'eng', eng: 'eng', en: 'eng',
  portuguese: 'por', portugues: 'por', por: 'por', pt: 'por', 'pt-pt': 'por',
  'portuguese(brazilian)': 'pob', brazilian: 'pob', 'pt-br': 'pob', pob: 'pob',
  spanish: 'spa', espanol: 'spa', spa: 'spa', es: 'spa',
  french: 'fre', francais: 'fre', fre: 'fre', fra: 'fre', fr: 'fre',
  german: 'ger', deutsch: 'ger', ger: 'ger', deu: 'ger', de: 'ger',
  italian: 'ita', italiano: 'ita', ita: 'ita', it: 'ita',
  dutch: 'dut', dut: 'dut', nld: 'dut', nl: 'dut',
  danish: 'dan', dan: 'dan', da: 'dan',
  swedish: 'swe', swe: 'swe', sv: 'swe',
  norwegian: 'nor', nor: 'nor', no: 'nor',
  finnish: 'fin', fin: 'fin', fi: 'fin',
  polish: 'pol', pol: 'pol', pl: 'pol',
  russian: 'rus', rus: 'rus', ru: 'rus',
  japanese: 'jpn', jpn: 'jpn', ja: 'jpn',
  korean: 'kor', kor: 'kor', ko: 'kor',
  chinese: 'chi', chi: 'chi', zho: 'chi', zh: 'chi',
  arabic: 'ara', ara: 'ara', ar: 'ara',
  turkish: 'tur', tur: 'tur', tr: 'tur',
  czech: 'cze', cze: 'cze', cs: 'cze',
  greek: 'gre', gre: 'gre', el: 'gre',
  hebrew: 'heb', heb: 'heb', he: 'heb',
  hungarian: 'hun', hun: 'hun', hu: 'hun',
  romanian: 'rum', rum: 'rum', ro: 'rum',
}

// "2_English.srt" / "3_Portuguese (Brazilian).srt" — Bluray rips number their tracks.
const TRACK_NUMBER_PREFIX_RE = /^\d+[_\-. ]+/
const SDH_RE = /\b(sdh|hi|forced|cc)\b/i

function normaliseLanguageToken(token) {
  return token.toLowerCase().replace(/[\s_]+/g, '').replace(/[()]/g, '')
}

// Keys are normalised the same way lookups are, so "Portuguese (Brazilian)" and the
// alias table can't drift apart over punctuation.
const LANGUAGE_ALIASES = new Map(
  Object.entries(RAW_LANGUAGE_ALIASES).map(([k, v]) => [normaliseLanguageToken(k), v])
)

/** Pull a language out of a subtitle filename. Tries the whole basename first
 *  ("english.srt"), then each dot-separated tail segment ("Show.S01E01.pt-BR.srt"). */
function languageFromFilename(filename) {
  const base = filename.slice(0, filename.length - extensionOf(filename).length)
  const cleaned = base.replace(TRACK_NUMBER_PREFIX_RE, '')

  const whole = LANGUAGE_ALIASES.get(normaliseLanguageToken(cleaned))
  if (whole) return whole

  // Two passes, coarse first. Splitting only on dots keeps region-qualified tags like
  // "pt-BR" intact; splitting on hyphens too would strand a bare "pt" and mislabel a
  // Brazilian track as European Portuguese. The finer pass then catches "Show_en".
  for (const pattern of [/\./, /[.\-_]/]) {
    const segments = cleaned.split(pattern).filter(Boolean)
    for (let i = segments.length - 1; i >= 0; i--) {
      const hit = LANGUAGE_ALIASES.get(normaliseLanguageToken(segments[i]))
      if (hit) return hit
    }
  }
  return null
}

function isForcedOrSdh(filename) {
  return SDH_RE.test(filename)
}

/** Episode info for a subtitle usually isn't in its own filename — a season pack keeps
 *  `Subs/<Release.Name.S02E01.../english.srt`, so the identity lives in a parent folder.
 *  Walk the path from the file outwards and take the first segment that parses. */
function locateEpisodeInPath(path, resolver) {
  const segments = path.split('/').filter(Boolean)
  for (let i = segments.length - 1; i >= 0; i--) {
    const candidate = stripJunkPrefixes(
      i === segments.length - 1
        ? segments[i].slice(0, segments[i].length - extensionOf(segments[i]).length)
        : segments[i]
    )
    if (!candidate) continue
    const guess = resolver.resolve(candidate)
    const title = fixTruncatedNumericTitle(candidate, titleToString(guess.title))
    if (!title) continue
    const isEpisode = guess.type === 'episode'
    const episode = isEpisode ? (guess.episode ?? guess.absolute_episode ?? null) : null
    if (isEpisode && episode == null) continue
    return {
      title,
      year: guess.year || null,
      isEpisode,
      season: isEpisode ? guess.season || 1 : null,
      episode,
    }
  }
  return null
}

function slugify(text) {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'unknown'
}

// Piracy release groups (TamilMV, TamilBlasters, MovieRulz, TamilRockers, ...) prepend their
// site domain as a fake title, e.g. "www.1TamilMV.wtf - Real Movie Name (2024)...". guessit has
// no way to know this isn't the title, so strip it before parsing.
const SITE_PREFIX_RE = /^www\.\S+?\s*[-–—]\s*/i
// RiffTrax comedy-commentary releases prepend their own brand before the real movie title.
const RIFFTRAX_PREFIX_RE = /^rifftrax\s*[-–—:]\s*/i
// Anime Music Videos have no real "movie" title (it's an artist/song, not a film) — skip entirely.
const AMV_TAG_RE = /^\[amv\]/i

function stripJunkPrefixes(name) {
  let cleaned = name
  let changed = true
  while (changed) {
    changed = false
    for (const re of [SITE_PREFIX_RE, RIFFTRAX_PREFIX_RE]) {
      if (re.test(cleaned)) {
        cleaned = cleaned.replace(re, '')
        changed = true
      }
    }
  }
  return cleaned
}

// Despite its own types claiming `title?: string`, guessit-js frequently returns an array
// (e.g. ["Apocalypse Now", "Final Cut"]) when it can't cleanly separate the title from a
// trailing fragment like an edition or language name. The first element is always the title.
function titleToString(title) {
  return Array.isArray(title) ? title[0] : title
}

/** guessit sometimes truncates a numbered title to just the number (e.g. "10 Things I Hate
 * About You" -> "10"). parse-torrent-title doesn't share that bug, so cross-check and prefer
 * its title only when it plausibly extends the same number. */
function fixTruncatedNumericTitle(cleanedName, title) {
  if (!title || !/^\d+$/.test(title.trim())) return title
  const alt = titleToString(PTT.parse(cleanedName).title)
  if (alt && alt.trim() !== title.trim() && alt.trim().startsWith(title.trim())) {
    return alt.trim()
  }
  return title
}
function makeGuessResolver(loaded) {
  const current = new Map()
  return {
    resolve(str) {
      if (current.has(str)) return current.get(str)
      const g = loaded && loaded.has(str) ? loaded.get(str) : guessit(str)
      current.set(str, g)
      return g
    },
    current,
  }
}

// Default resolver: no caching, straight through to guessit.
const DIRECT_RESOLVER = { resolve: (str) => guessit(str), current: null }

/** Yield one work item per subtitle file in a mylist entry. Kept separate from the video
 *  pass because the two need different identity resolution: a video carries its own name,
 *  a subtitle usually inherits it from the folder it sits in. */
function* parseSubtitleItems(source, entry, resolver = DIRECT_RESOLVER) {
  const itemId = entry.id
  const createdAt = Date.parse(entry.created_at) || 0

  for (const f of entry.files || []) {
    // Full path, not short_name — the episode identity lives in the parent folders.
    const path = f.name || f.short_name || ''
    const base = f.short_name || path.split('/').pop() || ''
    if (!isSubtitleFile(base)) continue

    let located = locateEpisodeInPath(path, resolver)
    // A pack whose subtitle folders are unnamed still has the parent torrent name.
    if (!located && entry.name) {
      located = locateEpisodeInPath(stripJunkPrefixes(entry.name), resolver)
    }
    if (!located) continue

    yield {
      source,
      itemId,
      fileId: f.id,
      filename: base,
      path,
      size: f.size,
      createdAt,
      lang: languageFromFilename(base) || 'unknown',
      forced: isForcedOrSdh(base),
      ...located,
    }
  }
}

/** Yield one work item per video file in a torbox/webdl mylist entry. */
function* parseWorkItems(source, entry, resolver = DIRECT_RESOLVER) {
  const itemId = entry.id
  const createdAt = Date.parse(entry.created_at) || 0
  let entryGuess // lazily parsed parent-torrent name, shared across a season pack's files

  for (const f of entry.files || []) {
    const name = f.short_name || f.name || ''
    if (!isVideo(name)) continue
    if (AMV_TAG_RE.test(name.trim())) continue

    const cleanedName = stripJunkPrefixes(name)
    const guess = resolver.resolve(cleanedName)

    let title = fixTruncatedNumericTitle(cleanedName, titleToString(guess.title))
    let year = guess.year || null
    let isEpisode = guess.type === 'episode'
    let season = isEpisode ? guess.season || 1 : null
    let episode = isEpisode ? guess.episode ?? guess.absolute_episode ?? null : null

    // Season-pack files sometimes have no show name at all (e.g. "01. Episode Title.mkv") —
    // the real title only lives on the parent torrent/webdl entry.
    if (isEpisode && !title && entry.name) {
      if (entryGuess === undefined) entryGuess = resolver.resolve(stripJunkPrefixes(entry.name))
      title = fixTruncatedNumericTitle(entry.name, titleToString(entryGuess.title))
      year = year || entryGuess.year || null
      season = season || entryGuess.season || 1
    }

    if (!title) continue
    if (isEpisode && episode == null) continue
    if (!isEpisode && (f.size || 0) < MIN_FILE_SIZE_BYTES) continue

    yield {
      source,
      itemId,
      fileId: f.id,
      filename: name,
      size: f.size,
      createdAt,
      title,
      year,
      isEpisode,
      season,
      episode,
    }
  }
}

module.exports = {
  slugify,
  parseWorkItems,
  parseSubtitleItems,
  makeGuessResolver,
  languageFromFilename,
  locateEpisodeInPath,
}
