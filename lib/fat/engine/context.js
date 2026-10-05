// ─── Entitlement Engine — Supabase-backed context ────────────────────────────
// Builds the EngineContext the pure generators consume (lib/fat/engine/types.js
// § EngineContext). The engine's lookups are SYNCHRONOUS — generators call
// ctx.rateLookup(...) / ctx.matrixLookup(...) inline — so this module PREFETCHES
// the needed rows from Supabase and exposes synchronous closures over in-memory
// maps. The engine itself never touches the database (contracts § 7.6).
//
// The Supabase client passed in MUST be scoped to the `fat` schema
// (supabase.schema('fat') or createClient(url, key, { db: { schema: 'fat' } })).
//
// Contract: ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md § 2 (boundary, lookup contracts).

/** @typedef {import('./types.js').EngineContext}     EngineContext */
/** @typedef {import('./types.js').RateLookupResult}  RateLookupResult */
/** @typedef {import('./types.js').StationMatrixHit}  StationMatrixHit */

import { RATE_CODES, resolveRateVersion, resolveOvertimeRate } from '../rates/rateModel.js'

// Rate codes the generators look up. Prefetched up front so the synchronous
// lookups never have to await. The overtime codes (WORK-172) back
// ctx.overtimeLookup for retain / overtime-allowance generators (WORK-173).
const SB_MD_RATE_CODES = ['standby_hours', 'md_hours', 'small_meal']
const OVERTIME_RATE_CODES = [
  RATE_CODES.BASE_PAY_WEEKLY, RATE_CODES.OVERTIME_FACTOR, RATE_CODES.HOURLY_DIVISOR, RATE_CODES.DOUBLE_TIME,
]

/**
 * Resolve the active FRV hours matrix version. The canonical
 * fat.station_time_matrix stores `matrix_version` as the text form of the
 * fat.travel_matrix_versions.id for the active `hours`-unit version. Activation
 * is scoped per-unit (km + hours can both be active), so we filter on unit.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} fatClient — fat-scoped
 * @returns {Promise<string>} the matrix_version identifier to pin on a claim
 */
export async function resolveActiveMatrixVersion(fatClient) {
  const { data, error } = await fatClient
    .from('travel_matrix_versions')
    .select('id, label, unit, is_active')
    .eq('is_active', true)
    .eq('unit', 'hours')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`resolveActiveMatrixVersion: ${error.message}`)
  if (data?.id) return String(data.id)

  // Fallback: the version table linkage is absent — derive from the cells.
  const { data: cell, error: cellErr } = await fatClient
    .from('station_time_matrix')
    .select('matrix_version')
    .limit(1)
    .maybeSingle()
  if (cellErr) throw new Error(`resolveActiveMatrixVersion fallback: ${cellErr.message}`)
  if (!cell?.matrix_version) {
    throw new Error('resolveActiveMatrixVersion: no active hours matrix version and station_time_matrix is empty.')
  }
  return String(cell.matrix_version)
}

/**
 * Build the synchronous EngineContext for one claim generation.
 *
 * Prefetches: the owner's profile snapshot, the SB/MD rate catalogue + version
 * history (date-resolved at lookup time), and the station_time_matrix cells for
 * the (rostered, destination) pair under the pinned matrix version.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} fatClient — fat-scoped
 * @param {object} opts
 * @param {string}      opts.ownerId        — fat.profiles.id of the claim owner
 * @param {string}      opts.claimDate      — ISO 'YYYY-MM-DD' (rate-version resolution)
 * @param {string|null} [opts.matrixVersion]— pinned hours matrix version (from the detail row)
 * @param {number|null} [opts.destStationId]— standby_station_id / md_station_id
 * @returns {Promise<EngineContext>}
 */
export async function buildEngineContext(fatClient, { ownerId, claimDate, matrixVersion = null, destStationId = null }) {
  if (!ownerId) throw new Error('buildEngineContext: ownerId is required.')
  if (!claimDate) throw new Error('buildEngineContext: claimDate is required.')

  // ── 1. Profile snapshot (bare station name; no prefix-strip) ────────────────
  const { data: profile, error: pErr } = await fatClient
    .from('profiles')
    .select('id, rostered_station_id')
    .eq('id', ownerId)
    .maybeSingle()
  if (pErr) throw new Error(`buildEngineContext profile: ${pErr.message}`)
  if (!profile) throw new Error(`buildEngineContext: no fat.profiles row for owner ${ownerId}.`)

  let rosteredStationName = null
  if (profile.rostered_station_id != null) {
    const { data: stn, error: sErr } = await fatClient
      .from('stations')
      .select('name')
      .eq('id', profile.rostered_station_id)
      .maybeSingle()
    if (sErr) throw new Error(`buildEngineContext station: ${sErr.message}`)
    rosteredStationName = stn?.name ?? null
  }

  const profileSnapshot = {
    id:                    profile.id,
    rostered_station_id:   profile.rostered_station_id ?? null,
    rostered_station_name: rosteredStationName,
  }

  // ── 2. Rate catalogue + live version history (resolve by date in lookup) ──
  const { data: rates, error: rErr } = await fatClient
    .from('rates')
    .select('id, code, display_name, unit, active_version_id')
    .in('code', [...SB_MD_RATE_CODES, ...OVERTIME_RATE_CODES])
  if (rErr) throw new Error(`buildEngineContext rates: ${rErr.message}`)

  const rateIds = (rates || []).map((r) => r.id)
  let versions = []
  if (rateIds.length > 0) {
    const { data, error: vErr } = await fatClient
      .from('rate_versions')
      .select('id, rate_id, version_label, value, effective_from, classification, source_kind, source_ref, withdrawn_at, created_at, created_by')
      .in('rate_id', rateIds)
      .is('withdrawn_at', null)
    if (vErr) throw new Error(`buildEngineContext rate_versions: ${vErr.message}`)
    versions = data || []
  }
  const catalog = { rates: rates || [], versions }

  // Member classification history (overtime is classification-keyed).
  const { data: classificationHistory, error: cErr } = await fatClient
    .from('member_classifications')
    .select('classification, effective_from')
    .eq('owner_id', ownerId)
  if (cErr) throw new Error(`buildEngineContext member_classifications: ${cErr.message}`)

  /** @type {import('./types.js').RateLookup} */
  const rateLookup = (code, lookupDate) => {
    // Unclassified versions only; latest effective_from <= claim date (contracts § 2).
    const hit = resolveRateVersion(catalog, code, lookupDate)
    if (!hit) return null
    return { rate: hit.rate, rateVersion: hit.version, value: Number(hit.value) }
  }

  /** @type {import('./types.js').OvertimeLookup} */
  const overtimeLookup = (lookupDate, multiplierCode = RATE_CODES.DOUBLE_TIME) =>
    resolveOvertimeRate(catalog, { date: lookupDate, classificationHistory: classificationHistory || [], multiplierCode })

  // ── 3. Matrix cells for the (rostered, destination) pair, pinned version ────
  /** @type {Map<string, number>} `${from}:${to}:${version}` → hours */
  const matrixMap = new Map()
  const stationIds = [...new Set(
    [profileSnapshot.rostered_station_id, destStationId].filter((x) => x != null),
  )]
  if (matrixVersion != null && stationIds.length >= 2) {
    const { data: cells, error: mErr } = await fatClient
      .from('station_time_matrix')
      .select('from_station_id, to_station_id, hours, matrix_version')
      .eq('matrix_version', matrixVersion)
      .in('from_station_id', stationIds)
      .in('to_station_id', stationIds)
    if (mErr) throw new Error(`buildEngineContext station_time_matrix: ${mErr.message}`)
    for (const c of cells || []) {
      matrixMap.set(`${c.from_station_id}:${c.to_station_id}:${c.matrix_version}`, Number(c.hours))
    }
  }

  /** @type {import('./types.js').StationMatrixLookup} */
  const matrixLookup = (from, to, version) => {
    const hours = matrixMap.get(`${from}:${to}:${version}`)
    if (hours == null) return null
    return { hours, matrixVersion: version }
  }

  return { rateLookup, overtimeLookup, matrixLookup, profileSnapshot }
}
