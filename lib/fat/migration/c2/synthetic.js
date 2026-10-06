// ─── Synthetic cross-database source (WORK-255) ─────────────────────────────
// Builds a fat.c2.source-snapshot/v2 — exactly the shape sourceExtractSql()
// returns from Supabase — from the repository's synthetic prototype fixture
// (__tests__/fixtures/c2/synthetic-source.json). Deterministic; every identifier
// is synthetic: owners and FYs use the reserved 5eed0255… prefix, e-mails the
// reserved .invalid TLD, stations the synthetic Neon DEV ids 9001/9002
// (WORK-254 fixture). Nothing is copied from Supabase DEV or PROD.

import { SOURCE_SNAPSHOT_SCHEMA } from './constants.js'
import { bindSource } from './index.js'

export const SYNTHETIC_N3 = Object.freeze({
  owners: [
    { id: '5eed0255-0000-4000-8000-00000000000a', email: 'synthetic.n3.member.a@example.invalid' },
    { id: '5eed0255-0000-4000-8000-00000000000b', email: 'synthetic.n3.member.b@example.invalid' },
  ],
  financial_years: [
    { id: '5eed0255-0000-4000-8000-0000000000a1', user_id: '5eed0255-0000-4000-8000-00000000000a', label: '2025-26', start_date: '2025-07-01', end_date: '2026-06-30', is_active: true, created_at: '2025-07-01T00:00:00+00:00' },
    { id: '5eed0255-0000-4000-8000-0000000000b1', user_id: '5eed0255-0000-4000-8000-00000000000b', label: '2025-26', start_date: '2025-07-01', end_date: '2026-06-30', is_active: true, created_at: '2025-07-01T00:00:00+00:00' },
  ],
  stations: [{ id: 9001, name: 'Synthetic Station Alpha' }, { id: 9002, name: 'Synthetic Station Bravo' }],
  // Default rehearsal events (fixture claim_groups suffixes): RC (paid callback, $0 G12 excess travel,
  // unpaid petty-cash meal), RT (paid hours-first overtime + paid retain meal), SM (paid).
  groups: ['0001', '0002', '0006'],
  // EMPTY_CLAIM_GROUP: one for owner A (alongside valid claims), two for owner B (who has nothing else).
  empty: [
    { id: '5eed0255-0000-4000-8000-0000000e0001', owner: 0, fy: 0, claim_type: 'recalls', claim_number: 2, label: 'recalls #2', created_at: '2026-06-11T01:00:00+00:00' },
    { id: '5eed0255-0000-4000-8000-0000000e0002', owner: 1, fy: 1, claim_type: 'recalls', claim_number: 1, label: 'recalls #1', created_at: '2026-06-11T01:05:00+00:00' },
    { id: '5eed0255-0000-4000-8000-0000000e0003', owner: 1, fy: 1, claim_type: 'spoilt', claim_number: 1, label: 'spoilt #1', created_at: '2026-06-11T01:10:00+00:00' },
  ],
})

const suffix = (id) => String(id).slice(-4)

/**
 * @param {object} fixture  the v1 synthetic fixture ({ source: { five tables } } with placeholders)
 * @param {object} opts     { groups: fixture group suffixes to keep, empty: empty-group specs }
 */
export function syntheticCrossDbSource(fixture, { groups = SYNTHETIC_N3.groups, empty = SYNTHETIC_N3.empty } = {}) {
  const [A] = SYNTHETIC_N3.owners
  const bound = bindSource(fixture, { owner: A.id, fy: SYNTHETIC_N3.financial_years[0].id, stations: SYNTHETIC_N3.stations.map((s) => s.id) })
  const keep = new Set(bound.claim_groups.filter((g) => groups.includes(suffix(g.id))).map((g) => g.id))
  const tables = {
    claim_groups: bound.claim_groups.filter((g) => keep.has(g.id)),
    recalls: bound.recalls.filter((r) => keep.has(r.claim_group_id)),
    retain: bound.retain.filter((r) => keep.has(r.claim_group_id)),
    standby: bound.standby.filter((r) => keep.has(r.claim_group_id)),
    spoilt_meals: bound.spoilt_meals.filter((r) => keep.has(r.claim_group_id)),
  }
  for (const e of empty) {
    const owner = SYNTHETIC_N3.owners[e.owner]
    tables.claim_groups.push({
      id: e.id, user_id: owner.id, claim_type: e.claim_type, claim_number: e.claim_number, label: e.label,
      financial_year_id: SYNTHETIC_N3.financial_years[e.fy].id, notes: 'Synthetic empty prototype group (EMPTY_CLAIM_GROUP, WORK-255)',
      parent_status: null, created_at: e.created_at,
    })
  }
  const owners = new Set([...Object.values(tables).flat().map((r) => r.user_id)])
  const fys = SYNTHETIC_N3.financial_years.filter((f) => owners.has(f.user_id))
  // Prototype claim_sequences as the app leaves them: next number per owner/FY/type after the groups used.
  const seq = new Map()
  for (const g of tables.claim_groups) {
    const k = `${g.user_id}|${g.financial_year_id}|${g.claim_type}`
    seq.set(k, Math.max(seq.get(k) ?? 1, Number(g.claim_number) + 1))
  }
  const claim_sequences = [...seq.entries()].sort().map(([k, next], i) => {
    const [user_id, financial_year_id, claim_type] = k.split('|')
    return { id: `5eed0255-0000-4000-8000-00000005${String(i + 1).padStart(4, '0')}`, user_id, financial_year_id, claim_type, next_seq: next }
  })
  const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : 1)
  for (const t of Object.keys(tables)) tables[t].sort(byId)
  // Deep copies: callers (tests, mutations) must never be able to change SYNTHETIC_N3 itself.
  return JSON.parse(JSON.stringify({
    schema: SOURCE_SNAPSHOT_SCHEMA,
    provider: 'supabase',
    tables: { ...tables, claim_sequences, financial_years: fys },
    reference: {
      profiles: SYNTHETIC_N3.owners.filter((o) => owners.has(o.id)),
      stations: SYNTHETIC_N3.stations,
      member_classifications: [{ owner_id: A.id, classification: 'lff', effective_from: '2021-01-01' }],
    },
  }))
}

/**
 * Changed-source variants for the conflict proofs (deterministic):
 *   sm-amount          the standalone Spoilt Meal's stored amount +$1.00 (meal_amount and total_amount)
 *   empty-group-notes  the first EMPTY_CLAIM_GROUP row's notes changed (its checksum changes)
 */
export function mutateSyntheticSource(source, kind) {
  const s = JSON.parse(JSON.stringify(source))
  if (kind === 'sm-amount') {
    const groups = new Map(s.tables.claim_groups.map((g) => [g.id, g]))
    const row = s.tables.spoilt_meals.find((r) => groups.get(r.claim_group_id)?.claim_type === 'spoilt')
    if (!row) throw new Error('mutateSyntheticSource: no grouped spoilt meal')
    row.meal_amount = Number(row.meal_amount) + 1
    row.total_amount = Number(row.total_amount) + 1
  } else if (kind === 'empty-group-notes') {
    const g = s.tables.claim_groups.find((x) => x.id === SYNTHETIC_N3.empty[0].id)
    if (!g) throw new Error('mutateSyntheticSource: empty group not present')
    g.notes = `${g.notes} (changed)`
  } else throw new Error(`mutateSyntheticSource: unknown kind ${kind}`)
  return s
}
