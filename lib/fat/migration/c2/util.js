// ─── C2 transform — deterministic utilities (WORK-190) ──────────────────────
// Pure helpers: canonical JSON, SHA-256, UUIDv5, value normalisation and
// Australia/Melbourne wall-clock composition. No I/O, no Date.now().

import { createHash } from 'node:crypto'

/** Canonical JSON: object keys sorted recursively; undefined dropped. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') {
    const out = {}
    for (const k of Object.keys(v).sort()) {
      if (v[k] !== undefined) out[k] = sortKeys(v[k])
    }
    return out
  }
  return v
}

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export const sha256Json = (value) => sha256(canonicalJson(value))

/** RFC 4122 version-5 UUID (SHA-1, name-based) — deterministic target ids. */
export function uuidv5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const b = Buffer.from(hash.subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const TIMESTAMPTZ = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$/

/**
 * Normalise an extracted value so checksums do not depend on the session
 * TimeZone or DateStyle: every timestamptz string becomes ISO-8601 UTC.
 * Dates (YYYY-MM-DD), numbers and other strings are unchanged.
 */
export function normalise(v) {
  if (Array.isArray(v)) return v.map(normalise)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = normalise(x)
    return out
  }
  if (typeof v === 'string' && TIMESTAMPTZ.test(v)) {
    const t = Date.parse(v.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00'))
    if (!Number.isNaN(t)) return new Date(t).toISOString()
  }
  return v
}

/** Number or null (null/''/non-finite → null). */
export function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Money/quantity equality at 2 dp (prototype numerics are numeric(…,2)). */
export const sameMoney = (a, b) => Math.round((a ?? 0) * 100) === Math.round((b ?? 0) * 100)
export const round2 = (x) => Math.round(x * 100) / 100

/** Parse a 24 h clock string ('HH:MM', 'H:MM' or 'HHMM') → minutes after midnight, or null. */
export function parseClock(s) {
  if (s === null || s === undefined) return null
  const t = String(s).trim()
  let m = t.match(/^(\d{1,2}):(\d{2})$/)
  if (!m) m = t.match(/^(\d{2})(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null
  return h * 60 + mi
}

const MELB = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function melbParts(ms) {
  const p = Object.fromEntries(MELB.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (Number(p.hour) % 24) * 60 + Number(p.minute) }
}

/** Australia/Melbourne calendar date (YYYY-MM-DD) of an instant, or null. */
export function melbourneDate(instant) {
  const ms = Date.parse(String(instant ?? ''))
  return Number.isNaN(ms) ? null : melbParts(ms).date
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/**
 * The instant at which Australia/Melbourne wall clock reads `date` + `minutes`.
 * Returns { iso } (local time with its UTC offset) or { ambiguous } when the
 * wall time does not exist or occurs twice (DST changeover) — fail closed.
 */
export function melbourneInstant(date, minutes) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '')) || minutes == null) return { ambiguous: 'missing date or time' }
  const [y, m, d] = date.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d) + minutes * 60000
  const hits = [10, 11]
    .map((off) => ({ off, ms: wall - off * 3600000 }))
    .filter(({ ms }) => { const p = melbParts(ms); return p.date === date && p.minutes === minutes })
  if (hits.length !== 1) return { ambiguous: hits.length ? 'wall time occurs twice (DST end)' : 'wall time does not exist (DST start)' }
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return { iso: `${date}T${hh}:${mm}:00+${hits[0].off}:00`, offset: hits[0].off }
}

/**
 * A start/end interval from clock times on a claim date, read as the
 * prototype did: an end earlier than the start is on the next day. When either
 * instant is DST-ambiguous, or the interval spans a DST change (absolute and
 * wall-clock durations would differ), the affected instant is withheld.
 */
export function melbourneInterval(date, startMin, endMin) {
  const out = { start: null, end: null, notes: [] }
  if (startMin == null) return out
  const s = melbourneInstant(date, startMin)
  if (s.ambiguous) { out.notes.push(`start: ${s.ambiguous}`); return out }
  out.start = s.iso
  if (endMin == null) return out
  const endDate = endMin < startMin ? addDays(date, 1) : date
  const e = melbourneInstant(endDate, endMin)
  if (e.ambiguous) { out.notes.push(`end: ${e.ambiguous}`); return out }
  if (e.offset !== s.offset) { out.notes.push('interval spans a DST change'); return out }
  out.end = e.iso
  return out
}
