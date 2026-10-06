// Shared helpers for the cross-database C2/C3 tests (WORK-255): build the two snapshots the
// tool reads (Supabase source v2, Neon target v1) from a combined planner input or from the
// synthetic fixture, without any database.

import { targetScope, planCrossDb } from '../../lib/fat/migration/c2/index.js'
import { FIXTURE_CATALOG } from '../../lib/fat/rates/fixtureCatalog.js'

export const MD5 = '0123456789abcdef0123456789abcdef'
export const BINDING = { project: 'cool-meadow-70196410', target: 'dev', target_id: 'br-wispy-dew-a7vd4v6k' }

const emptyState = () => ({ identities: [], profiles: [], financial_years: [], claims_in_scope: [], ledger: [], batches: [] })

/** A Neon target snapshot for this source: reference from the given stations/rates, empty (or given) state. */
export function targetFor(source, { stations, rates = FIXTURE_CATALOG.rates, versions = FIXTURE_CATALOG.versions, native = [], state = {}, md5 = MD5 } = {}) {
  const scope = targetScope(source)
  const st = stations ?? source.reference.stations
  return {
    schema: 'fat.c2.target-snapshot/v1',
    provider: 'neon',
    scope,
    reference: {
      stations: st.filter((s) => scope.stations.includes(Number(s.id))).map((s) => ({ id: Number(s.id), name: s.name })),
      rates: scope.has_source ? rates.map((r) => ({ id: r.id, code: r.code, unit: r.unit })) : [],
      rate_versions: scope.has_source ? versions.map(({ withdrawn_at, created_at, created_by, ...v }) => ({ ...v, value: String(v.value), withdrawn: !!withdrawn_at })) : [],
      native_claims: native,
    },
    reference_md5: md5,
    state: { ...emptyState(), ...state },
  }
}

/** Combined (v1) planner input → the cross-database source snapshot (owners get reserved test e-mails). */
export function sourceFromCombined(snap) {
  const profiles = (snap.reference.profiles || []).map((id, i) => ({ id, email: `member.${i}@example.invalid` }))
  return {
    schema: 'fat.c2.source-snapshot/v2',
    provider: 'supabase',
    tables: {
      claim_groups: snap.source.claim_groups || [], recalls: snap.source.recalls || [], retain: snap.source.retain || [],
      standby: snap.source.standby || [], spoilt_meals: snap.source.spoilt_meals || [],
      claim_sequences: [], financial_years: (snap.reference.financial_years || []).map((f) => ({ ...f, is_active: true })),
    },
    reference: { profiles, stations: snap.reference.stations || [], member_classifications: snap.reference.member_classifications || [] },
  }
}

/** planCrossDb over a combined input (the shape the planner tests build). */
export function planCross(snap, opts = {}) {
  const source = sourceFromCombined(snap)
  const target = targetFor(source, { native: snap.target?.native_claims || [] })
  return { ...planCrossDb(source, target, { environment: 'dev', evidenceClass: 'synthetic', binding: BINDING, ...opts }), source, target }
}
