/**
 * WORK-190 — C2 deterministic transform-copy tool: planner, mapping, parity
 * classification, report determinism and SQL safety.
 *
 * Run with: node --test __tests__/c2-transform.test.mjs
 * DB-side behaviour (insert-if-absent + equivalence proof, conflict raise,
 * rollback) is rehearsed on Supabase DEV with the same fixtures — see
 * docs/architecture/C2_TRANSFORM_CONTRACT.md § 9.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { FIXTURE_CATALOG, FIXTURE_LFF_HISTORY } from '../lib/fat/rates/fixtureCatalog.js'
import {
  planC2, applySql, verifySql, rollbackSql, checkVerify, bindFixture, mutateSourceForConflict, canonicalJson,
} from '../lib/fat/migration/c2/index.js'
import { melbourneInstant, melbourneInterval, uuidv5 } from '../lib/fat/migration/c2/util.js'
import { INTENDED_DIFFERENCES } from '../lib/fat/migration/c2/constants.js'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '33333333-3333-4333-8333-333333333333'
const FY = '22222222-2222-4222-8222-222222222222'
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/c2/${name}`, import.meta.url), 'utf8'))

function envSnapshot({ native = [] } = {}) {
  return {
    schema: 'fat.c2.source-snapshot/v1',
    source: {},
    reference: {
      financial_years: [{ id: FY, user_id: OWNER, label: '2026FY', start_date: '2025-07-01', end_date: '2026-06-30' }],
      stations: [{ id: 44, name: 'Station A' }, { id: 45, name: 'Station B' }],
      profiles: [OWNER, OTHER],
      rates: FIXTURE_CATALOG.rates,
      rate_versions: FIXTURE_CATALOG.versions,
      member_classifications: FIXTURE_LFF_HISTORY.map((h) => ({ owner_id: OWNER, ...h })),
    },
    target: { native_claims: native },
  }
}
const synthetic = (opts) => bindFixture(fixture('synthetic-source.json'), envSnapshot(opts))
const plan = (snap) => planC2(snap, { environment: 'dev', evidenceClass: 'synthetic' })
const clone = (x) => JSON.parse(JSON.stringify(x))
const ev = (report, type) => report.events.filter((e) => e.claim_type === type)
const items = (report, type) => report.generator_parity.items.filter((i) => i.entitlement_type === type)

test('every prototype type maps to exactly one canonical claim + one correct detail row', () => {
  const { plan: p, report } = plan(synthetic())
  assert.equal(report.outcome, 'pass')
  assert.deepEqual(report.source.migrated_by_type, { RC: 1, RT: 2, SB: 1, MD: 1, SM: 2, DM: 1 })
  assert.equal(p.claims.length, 8)
  const details = Object.fromEntries(Object.entries(p.details).map(([t, r]) => [t, r.length]))
  assert.deepEqual(details, { recall_details: 1, retain_details: 2, standby_details: 1, muster_dismiss_details: 1, spoilt_meal_details: 2, delayed_meal_details: 1 })
  for (const g of ['1', '2', '3', '4', '5', '6', '7']) assert.equal(report.gates[g].status, 'pass', `gate ${g}`)
  for (const g of ['8', '9']) assert.equal(report.gates[g].status, 'not_evaluated')
})

test('claim number and financial year are preserved exactly; status submitted', () => {
  const snap = synthetic()
  const { plan: p } = plan(snap)
  for (const g of snap.source.claim_groups) {
    const parent = Object.values(snap.source).flat().find((r) => r.claim_group_id === g.id && r.claim_number != null)
    const c = p.claims.find((x) => x.prototype_claim_group_id === g.id)
    assert.equal(c.claim_number, g.claim_number)
    assert.equal(c.financial_year_id, g.financial_year_id)
    assert.equal(c.prototype_row_id, parent.id)
    assert.equal(c.status, 'submitted')
  }
  const legacy = p.claims.find((c) => c.prototype_claim_group_id === null)
  assert.equal(legacy.claim_number, 2)
  assert.equal(legacy.claim_type, 'SM')
})

test('Standby vs M&D split comes from the group type and parent discriminator; raw M&D distances, never the reversed formula', () => {
  const { plan: p } = plan(synthetic())
  const sb = p.claims.find((c) => c.claim_type === 'SB')
  const md = p.claims.find((c) => c.claim_type === 'MD')
  assert.ok(sb && md)
  const mdd = p.details.muster_dismiss_details[0]
  assert.equal(mdd.claim_id, md.id)
  assert.equal(mdd.home_to_rostered_km, 25)
  assert.equal(mdd.home_to_target_km, 10)
  assert.equal(p.details.standby_details[0].standby_start_at, '2026-06-05T19:30:00+10:00')
  const types = p.entitlements.filter((e) => [sb.id, md.id].includes(e.claim_id)).map((e) => e.entitlement_type).sort()
  assert.deepEqual(types, ['excess_travel_md', 'excess_travel_standby', 'small_meal'])
  // The SB night-meal child is meal_type 'Spoilt' but is NOT a Spoilt Meal claim.
  assert.equal(p.claims.filter((c) => c.claim_type === 'SM').length, 2)
})

test('a standby group whose parent says M&D is refused, never silently re-typed', () => {
  const snap = synthetic()
  snap.source.standby.find((r) => r.calculation_inputs.autoChild === 'standby_and_dismi').standby_type = 'M&D'
  const { report } = plan(snap)
  assert.equal(report.outcome, 'fail')
  assert.equal(report.refused[0].code, 'type_conflict')
  assert.equal(report.gates['1'].status, 'fail')
})

test('Spoilt vs Delayed split: evidence only (group type + meal_type); legacy "Spoilt / Meal" is Spoilt; NULL is not evidence', () => {
  const { plan: p } = plan(synthetic())
  assert.equal(p.claims.filter((c) => c.claim_type === 'DM').length, 1)
  assert.equal(p.claims.filter((c) => c.claim_type === 'SM').length, 2)
  const { report } = plan(bindFixture(fixture('anomaly-source.json'), envSnapshot()))
  const codes = report.refused.map((r) => r.code)
  assert.ok(codes.includes('meal_type_unestablished'))
  assert.ok(report.refused.some((r) => r.code === 'type_conflict' && /delayed_meal/.test(r.reason)))
  // Amount never decides type: a Delayed row with the Spoilt amount stays Delayed.
  assert.equal(p.entitlements.find((e) => e.entitlement_type === 'delayed_meal').generated_amount, 10.9)
})

test('provenance and lineage: deterministic ids, batch-independent identity, a ledger row for every consumed row', () => {
  const snap = synthetic()
  const { plan: p } = plan(snap)
  const consumed = Object.values(snap.source).flat().length
  assert.equal(p.ledger.length, consumed)
  assert.equal(new Set(p.ledger.map((l) => `${l.source_table}:${l.source_row_id}`)).size, consumed)
  for (const c of p.claims) assert.equal(c.id, uuidv5(`claim:${c.prototype_source}:${c.prototype_row_id}`, '1b671a64-40d5-491e-99b0-da01ff1504c9'))
  for (const e of p.entitlements) {
    assert.ok(e.prototype_source && e.prototype_row_id && e.prototype_component)
    assert.equal(e.rule_id, 'prototype.preserved.v1')
    assert.ok(['pending', 'outstanding', 'paid', 'claimed'].includes(e.payment_status)) // C3 (WORK-191) derives it
    assert.equal(e.rate_snapshot.kind, 'prototype_preserved')
  }
  const leg = p.ledger.find((l) => l.source_table === 'recalls' && l.disposition === 'claim')
  assert.equal(leg.source_checksum.length, 64)
  assert.equal(leg.source_snapshot, null) // only exclusions carry a snapshot (C1 contract § 4)
  assert.ok(p.ledger.filter((l) => l.disposition === 'excluded').every((l) => l.source_snapshot?.calculation_inputs))
})

test('fake $0 Recall Excess Travel is excluded with its snapshot, never an entitlement', () => {
  const { plan: p, report } = plan(synthetic())
  const ex = p.ledger.filter((l) => l.disposition === 'excluded')
  assert.equal(ex.length, 1)
  assert.equal(ex[0].exclusion_code, 'G12_FAKE_RECALL_EXCESS_TRAVEL')
  assert.equal(ex[0].source_snapshot.calculation_inputs.autoChild, 'excess_travel')
  assert.ok(!p.entitlements.some((e) => e.prototype_row_id === ex[0].source_row_id))
  assert.equal(report.generator_parity.by_type.RC.excluded_artifact, 1)
  assert.equal(report.exclusions[0].exclusion_code, 'G12_FAKE_RECALL_EXCESS_TRAVEL')
})

test('a non-zero recall excess travel child is refused (no rule establishes it)', () => {
  const snap = synthetic()
  const x = snap.source.recalls.find((r) => r.calculation_inputs.autoChild === 'excess_travel')
  x.travel_amount = 5; x.total_amount = 5
  const { report } = plan(snap)
  assert.equal(report.refused[0].code, 'recall_excess_travel_nonzero')
})

test('historical values are preserved, never recalculated; hours-first retain keeps $ only in the snapshot', () => {
  const { plan: p, report } = plan(synthetic())
  const rt = p.entitlements.filter((e) => e.entitlement_type === 'retain_overtime').sort((a, b) => a.generated_hours - b.generated_hours)
  assert.deepEqual(rt.map((e) => e.generated_hours), [4, 4.25])
  for (const e of rt) {
    assert.equal(e.unit, 'hours')
    assert.equal(e.generated_amount, null)
  }
  assert.equal(rt[1].rate_snapshot.historical_amount.value, 429.35)
  assert.equal(p.entitlements.find((e) => e.entitlement_type === 'recall_meal').generated_amount, 31.45) // workbook $, not 2 × 20.53
  assert.equal(report.gates['5'].evidence.dollars.source_total, report.gates['5'].evidence.dollars.target_total)
})

test('manual adjustments go through the audited override path (insert, then edited_*)', () => {
  const { plan: p } = plan(synthetic())
  assert.equal(p.adjustments.length, 2)
  for (const a of p.adjustments) {
    assert.match(a.edited_source, /^prototype:spoilt_meals:.*\.adjusted_amount$/)
    assert.ok(a.edited_note.length > 0)
    const e = p.entitlements.find((x) => x.id === a.id)
    assert.notEqual(e.generated_amount, a.edited_amount) // generation fields stay the stored value
  }
  const sql = applySql(p)
  assert.match(sql, /update fat\.claim_entitlements set edited_amount = re\.edited_amount/)
})

test('a parent-level adjustment that cannot be attributed is refused', () => {
  const snap = synthetic()
  snap.source.recalls.find((r) => r.claim_number === 1).adjusted_amount = 99
  const { report } = plan(snap)
  assert.equal(report.refused[0].code, 'unattributable_parent_adjustment')
  assert.equal(report.gates['5'].status, 'fail')
})

test('missing generator inputs stay NULL and the dependent entitlement fails closed (reported, never guessed)', () => {
  const { plan: p, report } = plan(synthetic())
  const rc = p.details.recall_details[0]
  assert.equal(rc.recall_travel_minutes, null)
  assert.equal(rc.travel_distance_km, null)
  assert.equal(rc.recall_travel_sunday_or_ph, null)
  assert.equal(p.details.spoilt_meal_details.every((d) => d.emergency_response === null), true)
  assert.deepEqual(items(report, 'recall_travel_time')[0].missing_inputs, ['recall_travel_minutes', 'recall_travel_sunday_or_ph'])
  assert.equal(items(report, 'recall_mileage')[0].classification, 'unable_to_generate')
  assert.ok(items(report, 'spoilt_meal').every((i) => i.classification === 'unable_to_generate'))
  assert.equal(items(report, 'delayed_meal')[0].classification, 'unable_to_generate')
  assert.ok(report.generator_parity.missing_inputs['RC.travel_distance_km'] >= 1)
})

test('recall end is withheld when no booked-off time was recorded (no prototype end-of-shift default)', () => {
  const snap = synthetic()
  delete snap.source.recalls.find((r) => r.claim_number === 1).calculation_inputs.bookedOffTime
  const { plan: p, report } = plan(snap)
  assert.equal(p.details.recall_details[0].recall_end_at, null)
  assert.equal(items(report, 'recall_overtime')[0].classification, 'unable_to_generate')
})

test('intended differences carry a registered class; genuine failures are separated', () => {
  const { report } = plan(synthetic())
  const rt = items(report, 'retain_overtime')
  assert.ok(rt.some((i) => i.classification === 'intended_difference' && i.intended_classes.includes('RT_NEAREST_QUARTER_128_1')))
  assert.ok(rt.some((i) => i.classification === 'exact_match'))
  assert.deepEqual(items(report, 'relieving_allowance')[0].intended_classes, ['RC_RELIEVING_85_8_10'])
  assert.deepEqual(items(report, 'recall_overtime')[0].intended_classes, ['RC_OVERTIME_128_2'])
  assert.ok(items(report, 'recall_meal')[0].intended_classes.includes('MEAL_RATE_SCHEDULE_4'))
  for (const i of report.generator_parity.items) for (const c of i.intended_classes || []) assert.ok(INTENDED_DIFFERENCES[c].refs.length)
  for (const t of ['RC', 'RT', 'SM', 'DM']) assert.equal(report.generator_parity.by_type[t].genuine_failure, 0)

  // Stored prototype hours that its own rule cannot reproduce → genuine failure, not "intended".
  const snap = synthetic()
  for (const r of snap.source.retain.filter((x) => x.booked_off_time === '22:01')) { r.generated_hours = 6 }
  const bad = plan(snap)
  assert.equal(bad.report.generator_parity.by_type.RT.genuine_failure, 1)
})

test('retain ceiling vs nearest quarter hour (WORK-250) is classified as intended', () => {
  const { report } = plan(synthetic())
  const i = items(report, 'retain_overtime').find((x) => x.prototype.hours === 4.25)
  assert.equal(i.canonical.hours, 4)
  assert.deepEqual(i.intended_classes, ['RT_NEAREST_QUARTER_128_1'])
})

test('idempotent plan: identical input → identical plan, report bytes and batch key; key order irrelevant', () => {
  const a = plan(synthetic())
  const b = plan(synthetic())
  assert.equal(canonicalJson(a.plan), canonicalJson(b.plan))
  assert.equal(canonicalJson(a.report), canonicalJson(b.report))
  const shuffled = synthetic()
  for (const t of Object.keys(shuffled.source)) shuffled.source[t] = shuffled.source[t].reverse().map((r) => Object.fromEntries(Object.entries(r).reverse()))
  const c = plan(shuffled)
  assert.equal(canonicalJson(c.report), canonicalJson(a.report))
  assert.equal(c.plan.batch_key, a.plan.batch_key)
  assert.ok(!/"(snapshotAt|now|run_at|generated_on)"/.test(canonicalJson(a.report)))
})

test('timestamps are normalised so the session TimeZone cannot change checksums', () => {
  const a = synthetic()
  const b = clone(a)
  b.source.recalls[0].created_at = '2026-06-03 19:05:00+10'
  a.source.recalls[0].created_at = '2026-06-03T09:05:00Z'
  assert.equal(plan(a).plan.source_checksum, plan(b).plan.source_checksum)
})

test('source change → same target ids with different content (the DB equivalence proof raises); new batch key', () => {
  const a = plan(synthetic())
  const b = plan(mutateSourceForConflict(synthetic()))
  assert.notEqual(a.plan.batch_key, b.plan.batch_key)
  const ea = a.plan.entitlements.find((e) => e.entitlement_type === 'spoilt_meal' && e.generated_amount === 10.9 && !a.plan.adjustments.some((x) => x.id === e.id))
  const eb = b.plan.entitlements.find((e) => e.id === ea.id)
  assert.notEqual(eb.generated_amount, ea.generated_amount)
  const sql = applySql(b.plan)
  assert.match(sql, /raise exception 'C2 conflict: claim_entitlements % differs/)
  assert.match(sql, /on conflict do nothing/)
})

test('apply refuses to emit SQL when acceptance gates fail; batch keys are validated', () => {
  const { plan: p } = plan(bindFixture(fixture('anomaly-source.json'), envSnapshot()))
  assert.throws(() => applySql(p), /apply refused/)
  assert.throws(() => verifySql("x'; drop table fat.recalls; --"), /unsafe batch key/)
  assert.match(rollbackSql('c2:dev:1.0.0:abc'), /where batch_key = 'c2:dev:1\.0\.0:abc'/)
})

test('plan data enters SQL as one dollar-quoted literal (quotes in notes are inert)', () => {
  const snap = synthetic()
  snap.source.recalls.find((r) => r.claim_number === 1).notes = "O'Brien's $$ note; drop table x; --"
  const { plan: p } = plan(snap)
  const sql = applySql(p)
  const tag = sql.match(/c2_plan_text text := (\$c2plan_[0-9a-f]{12}\$)/)[1]
  assert.equal(sql.split(tag).length, 3)
  assert.ok(sql.includes("O'Brien's $$ note"))
})

test('owner binding: a group whose rows belong to two owners is refused (gate 7)', () => {
  const snap = synthetic()
  snap.source.spoilt_meals.find((r) => r.calculation_inputs.autoChild === 'petty_cash_meal').user_id = OTHER
  const { report } = plan(snap)
  assert.equal(report.refused[0].code, 'cross_owner_group')
  assert.equal(report.gates['7'].status, 'fail')
})

test('duplicate claim numbers in the established scope are refused, missing FY is refused', () => {
  const { report } = plan(bindFixture(fixture('anomaly-source.json'), envSnapshot()))
  assert.equal(report.refused.filter((r) => r.code === 'duplicate_claim_number').length, 2)
  assert.equal(report.gates['2'].status, 'fail')
  const snap = synthetic()
  for (const r of Object.values(snap.source).flat()) r.financial_year_id = null
  const r2 = plan(snap).report
  assert.ok(r2.refused.every((r) => r.code === 'missing_financial_year' || r.code === 'duplicate_claim_number'))
})

test('native canonical claims are reported as bridge-mirror candidates, never adopted', () => {
  const { plan: p0 } = plan(synthetic())
  const sb = p0.claims.find((c) => c.claim_type === 'SB')
  const native = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', owner_id: OWNER, claim_type: 'SB', claim_date: sb.claim_date, station_id_snapshot: sb.station_id_snapshot, dest_station_id: 45 },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', owner_id: OWNER, claim_type: 'MD', claim_date: '2026-01-01', station_id_snapshot: null, dest_station_id: null }]
  const { plan: p, report } = plan(synthetic({ native }))
  assert.equal(report.bridge_mirrors.native_claims, 2)
  assert.equal(report.bridge_mirrors.matched.length, 1)
  assert.equal(report.bridge_mirrors.unmatched, 1)
  assert.ok(!p.claims.some((c) => native.some((n) => n.id === c.id)))
})

test('empty source (DEV reality) plans an empty, passing batch', () => {
  const snap = envSnapshot()
  for (const t of ['claim_groups', 'recalls', 'retain', 'standby', 'spoilt_meals']) snap.source[t] = []
  const { plan: p, report } = planC2(snap, { environment: 'dev' })
  assert.equal(report.outcome, 'pass')
  assert.equal(p.claims.length, 0)
  assert.equal(report.evidence_class, 'real')
  assert.match(applySql(p), /do \$c2apply\$/)
})

test('Melbourne wall time: offsets, next-day roll, DST gaps/overlaps fail closed', () => {
  assert.equal(melbourneInstant('2026-06-03', 8 * 60).iso, '2026-06-03T08:00:00+10:00')
  assert.equal(melbourneInstant('2025-11-10', 19 * 60 + 50).iso, '2025-11-10T19:50:00+11:00')
  assert.ok(melbourneInstant('2025-10-05', 2 * 60 + 30).ambiguous) // spring forward gap
  assert.ok(melbourneInstant('2026-04-05', 2 * 60 + 30).ambiguous) // fall back overlap
  const iv = melbourneInterval('2026-06-03', 22 * 60, 2 * 60)
  assert.equal(iv.end, '2026-06-04T02:00:00+10:00')
  const dst = melbourneInterval('2026-04-04', 22 * 60, 6 * 60)
  assert.equal(dst.end, null)
  assert.ok(dst.notes.some((n) => /DST/.test(n)))
})

test('checkVerify accepts a clean verify and names every failing check', () => {
  const { report } = plan(synthetic())
  const clean = {
    batch: { status: 'completed', outcome: 'pass' }, gate5_totals: { dollars_source: 1, dollars_target: 1, hours_source: 2, hours_target: 2 },
    gate2_number_or_fy_mismatch: 0, gate2_scope_duplicates: 0, gate3_bad_detail: 0, gate3_parents_without_claim: 0, gate4_child_violations: 0,
    gate5_missing_source_rows: 0, gate5_value_mismatches: 0, gate5_adjustment_mismatches: 0, gate7_cross_owner_entitlements: 0, gate7_cross_owner_fy: 0,
    gate7_ledger_orphan_or_cross_owner: 0, gate7_orphan_details: 0, gate7_payment_links_cross_owner_or_stream: 0, gate7_rls_disabled: 0, gate7_api_privileges_on_migration_tables: 0,
    gate6_source_invalid: 0, gate6_paid_without_exactly_one_migration_link: 0, gate6_unpaid_with_links: 0, gate6_allocation_mismatches: 0,
    gate6_record_date_mismatches: 0, gate6_status_mismatches: 0, gate6_audit_mismatches: 0, gate6_unlinked_migration_records: 0, gate6_duplicate_source_keys: 0,
    gate6_totals: { source_paid_entitlements: 1, source_paid_amount: 5, migration_records: 1, links_on_lineage: 1, allocated_amount: 5 },
  }
  assert.equal(checkVerify(report, clean).ok, true)
  const bad = checkVerify(report, { ...clean, gate5_value_mismatches: 2, gate7_rls_disabled: 1 })
  assert.deepEqual(bad.failures, ['gate5_value_mismatches = 2', 'gate7_rls_disabled = 1'])
})

test('apply SQL returns the SHA-256 of the exact plan text it embeds', async () => {
  const { planSha256 } = await import('../lib/fat/migration/c2/index.js')
  const { createHash } = await import('node:crypto')
  const { plan: p } = plan(synthetic())
  const sql = applySql(p)
  const tag = sql.match(/c2_plan_text text := (\$c2plan_[0-9a-f]{12}\$)/)[1]
  const embedded = sql.split(tag)[1]
  assert.equal(createHash('sha256').update(embedded, 'utf8').digest('hex'), planSha256(p))
  assert.match(sql, /'plan_sha256', encode\(sha256\(convert_to\(c2_plan_text, 'UTF8'\)\), 'hex'\)/)
})
