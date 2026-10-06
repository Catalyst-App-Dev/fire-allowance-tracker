// ─── Travel Matrix Client (browser) ──────────────────────────────────────────
// Thin client wrapper around the active FRV Index(hr) matrix. Used by the
// Standby / M&D dual-output flow to fetch the decimal-hours value for a
// rostered ↔ standby station pair.
//
// The matrix data is read-only reference data exposed via PostgREST under the
// `fat` schema, so we can query it directly with the anon-key Supabase client
// — no server route required for the read path. (The /api/travel/* routes
// remain the server side of the subsystem, used for Google Maps where the API
// key MUST stay server-only.)
//
// In-memory session caching dedupes repeat lookups for the same pair across
// a single page load.
// ─────────────────────────────────────────────────────────────────────────────

import { fat } from '@/lib/supabaseClient'
import { isNeonBackend } from '@/lib/backend'
import { callFat } from '@/lib/data/fatApi'

const pairCache    = new Map() // "unit:a:b" → { value, unit, versionId, versionLabel }
const versionCache = { ref: null }                    // most-recent active version (any unit)
const versionByUnit = new Map() // unit → { id, label, unit, ... } | null

function pairKey(a, b, unit = 'hours') {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return `${unit}:${lo}:${hi}`
}

/**
 * Resolve the currently-active matrix version for a given unit. Memoised per
 * unit so the recall + standby flows don't re-fetch the version row on every
 * pair lookup.
 */
// ── Raw queries, client-parameterised (WORK-256): the browser `fat` client on
// the Supabase backend, the server adapter on Neon (lib/server/ops). Reference
// data only — no member rows.
async function queryActiveVersionByUnit(client, unit) {
  const { data, error } = await client
    .from('travel_matrix_versions')
    .select('id, label, unit, imported_at, cell_count, station_count')
    .eq('is_active', true)
    .eq('unit', unit)
    .order('imported_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.warn(`[matrixClient] active ${unit} version fetch error:`, error)
    return null
  }
  return data || null
}

async function queryHoursRows(client, originId, destId) {
  const { data, error } = await client.rpc('travel_matrix_lookup', {
    p_origin_id: originId,
    p_dest_id:   destId,
  })
  if (error) {
    console.warn('[matrixClient] lookup error:', error)
    return null
  }
  return data
}

async function queryKmCell(client, versionId, a, b) {
  const { data, error } = await client
    .from('travel_matrix_cells')
    .select('value')
    .eq('version_id', versionId)
    .eq('station_a_id', a)
    .eq('station_b_id', b)
    .maybeSingle()
  if (error) {
    console.warn('[matrixClient] km cell lookup error:', error)
    return { error }
  }
  return { cell: data || null }
}

async function queryActiveVersion(client) {
  const { data, error } = await client
    .from('travel_matrix_versions')
    .select('id, label, unit, imported_at, cell_count, station_count')
    .eq('is_active', true)
    .maybeSingle()
  if (error) {
    console.warn('[matrixClient] version fetch error:', error)
    return null
  }
  return data || null
}

/** Server-side query surface for the Neon domain operations (matrix.*). */
export const matrixQueries = {
  activeVersionByUnit: queryActiveVersionByUnit,
  hoursRows: queryHoursRows,
  kmCell: queryKmCell,
  activeVersion: queryActiveVersion,
}

async function getActiveVersionByUnit(unit) {
  if (versionByUnit.has(unit)) return versionByUnit.get(unit)
  const data = isNeonBackend()
    ? await callFat('matrix.activeVersionByUnit', { unit })
    : await queryActiveVersionByUnit(fat, unit)
  versionByUnit.set(unit, data || null)
  return data || null
}

/**
 * Look up the active hours-matrix value for two station ids. Order-independent.
 *
 * Uses the fat.travel_matrix_lookup RPC and defensively filters by unit so a
 * concurrently-active KM matrix version cannot leak into hours consumers.
 *
 * @param {number} originId
 * @param {number} destId
 * @returns {Promise<null | { value:number, unit:string, versionId:string, versionLabel:string }>}
 */
export async function lookupMatrixHours(originId, destId) {
  if (originId == null || destId == null) return null
  if (originId === destId) {
    return { value: 0, unit: 'hours', versionId: null, versionLabel: 'self' }
  }

  const key = pairKey(originId, destId, 'hours')
  if (pairCache.has(key)) return pairCache.get(key)

  const data = isNeonBackend()
    ? await callFat('matrix.hoursRows', { originId, destId }).catch(() => null)
    : await queryHoursRows(fat, originId, destId)
  if (!Array.isArray(data) || data.length === 0) return null

  const row = data.find((r) => (r?.unit || 'hours') === 'hours')
  if (!row) return null

  const result = {
    value:        Number(row.value),
    unit:         row.unit || 'hours',
    versionId:    row.version_id,
    versionLabel: row.version_label,
  }
  pairCache.set(key, result)
  return result
}

/**
 * Look up the active KM-matrix value for two station ids. Order-independent.
 * Backed by the FRV "Index (KM)" version row — pure deterministic lookup, no
 * routing API call. Returns null when no cell exists for the pair so callers
 * can surface a controlled "no indexed match" state instead of silently
 * falling back to a routing provider.
 *
 * @param {number} originId
 * @param {number} destId
 * @returns {Promise<null | { value:number, unit:'km', versionId:string|null, versionLabel:string }>}
 */
export async function lookupMatrixKm(originId, destId) {
  if (originId == null || destId == null) return null
  if (originId === destId) {
    return { value: 0, unit: 'km', versionId: null, versionLabel: 'self' }
  }

  const key = pairKey(originId, destId, 'km')
  if (pairCache.has(key)) return pairCache.get(key)

  const version = await getActiveVersionByUnit('km')
  if (!version) return null

  const a = Math.min(originId, destId)
  const b = Math.max(originId, destId)

  const res = isNeonBackend()
    ? await callFat('matrix.kmCell', { versionId: version.id, a, b }).catch((error) => ({ error }))
    : await queryKmCell(fat, version.id, a, b)
  if (res.error) return null
  const cell = res.cell
  if (!cell) return null

  const result = {
    value:        Number(cell.value),
    unit:         'km',
    versionId:    version.id,
    versionLabel: version.label,
  }
  pairCache.set(key, result)
  return result
}

/**
 * Get the currently active matrix version (label + id) for display.
 */
export async function getActiveMatrixVersion() {
  if (versionCache.ref) return versionCache.ref
  const data = isNeonBackend()
    ? await callFat('matrix.activeVersion').catch(() => null)
    : await queryActiveVersion(fat)
  versionCache.ref = data || null
  return versionCache.ref
}

/**
 * Test-only clear for the session caches.
 */
export function _clearMatrixCaches() {
  pairCache.clear()
  versionCache.ref = null
  versionByUnit.clear()
}
