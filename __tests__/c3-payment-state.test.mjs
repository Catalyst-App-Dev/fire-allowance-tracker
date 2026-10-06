/**
 * WORK-191 — C3 historical payment-state mapping (extends the C2 tool):
 * prototype payment toggles → canonical payment_records + entitlement links,
 * derived status, gate 6, fail-closed evidence and idempotent SQL.
 *
 * Run with: node --test __tests__/c3-payment-state.test.mjs
 * DB-side behaviour (link_entitlement_payment, recompute, audit, conflict
 * raises, rollback) is rehearsed on Supabase DEV — see
 * docs/architecture/C3_PAYMENT_STATE_CONTRACT.md § 8.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { FIXTURE_CATALOG, FIXTURE_LFF_HISTORY } from '../lib/fat/rates/fixtureCatalog.js'
import {
  planC2, applySql, verifySql, syntheticHarnessSql, bindFixture, mutateSourceForConflict, mutateSourceForPaymentChange,
  canonicalJson, sourcePaymentState, paymentSourceKey, paymentRecordId,
} from '../lib/fat/migration/c2/index.js'
import { uuidv5, melbourneDate } from '../lib/fat/migration/c2/util.js'

const OWNER = '11111111-1111-4111-8111-111111111111'
const FY = '22222222-2222-4222-8222-222222222222'
const NS = '1b671a64-40d5-491e-99b0-da01ff1504c9'
const id = (n) => `c2f00000-0000-4000-8000-000000000${n}`
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/c2/synthetic-source.json', import.meta.url), 'utf8'))

function envSnapshot() {
  return {
    schema: 'fat.c2.source-snapshot/v1',
    source: {},
    reference: {
      financial_years: [{ id: FY, user_id: OWNER, label: '2026FY', start_date: '2025-07-01', end_date: '2026-06-30' }],
      stations: [{ id: 44, name: 'Station A' }, { id: 45, name: 'Station B' }],
      profiles: [OWNER],
      rates: FIXTURE_CATALOG.rates,
      rate_versions: FIXTURE_CATALOG.versions,
      member_classifications: FIXTURE_LFF_HISTORY.map((h) => ({ owner_id: OWNER, ...h })),
    },
    target: { native_claims: [] },
  }
}
const synthetic = () => bindFixture(fixture, envSnapshot())
const plan = (snap) => planC2(snap, { environment: 'dev', evidenceClass: 'synthetic' })
const rowOf = (snap, table, n) => snap.source[table].find((r) => r.id === id(n))
const entFor = (p, table, n) => p.entitlements.filter((e) => e.prototype_source === table && e.prototype_row_id === id(n))
const recFor = (p, table, n, comp) => p.payment_records.find((r) => r.migration_source_key === paymentSourceKey(table, id(n), comp))
const gate6 = (report) => report.gates['6']

test('source payment evidence: Paid ⇔ Paid + payment_date; every undetermined shape fails closed', () => {
  assert.equal(sourcePaymentState({ payment_status: 'Paid', payment_date: '2026-01-01T00:00:00Z' }).state, 'paid')
  assert.equal(sourcePaymentState({ payment_status: 'paid', payment_date: '2026-01-01T00:00:00Z' }).state, 'paid')
  assert.equal(sourcePaymentState({ payment_status: 'Pending', payment_date: null }).state, 'unpaid')
  assert.equal(sourcePaymentState({ payment_status: null, payment_date: null, status: 'Pending' }).state, 'unpaid')
  assert.equal(sourcePaymentState({}).state, 'unpaid') // NULL everywhere: both prototype readers say Pending
  assert.equal(sourcePaymentState({ payment_status: 'Paid', payment_date: null }).fail, 'C3_PAID_WITHOUT_DATE')
  assert.equal(sourcePaymentState({ payment_status: 'Pending', payment_date: '2026-01-01T00:00:00Z' }).fail, 'C3_PENDING_WITH_DATE')
  assert.equal(sourcePaymentState({ payment_status: null, payment_date: '2026-01-01T00:00:00Z' }).fail, 'C3_UNPAID_WITH_DATE')
  assert.equal(sourcePaymentState({ payment_status: null, status: 'Paid' }).fail, 'C3_LEGACY_STATUS_CONFLICT')
  assert.equal(sourcePaymentState({ payment_status: null, status: 'Disputed' }).fail, 'C3_LEGACY_STATUS_CONFLICT')
  assert.equal(sourcePaymentState({ payment_status: 'Disputed' }).fail, 'C3_UNKNOWN_PAYMENT_STATUS')
  // A non-null payment_status wins over the legacy column in both prototype readers.
  assert.equal(sourcePaymentState({ payment_status: 'Pending', status: 'Paid' }).state, 'unpaid')
})

test('unpaid entitlements: no payment record or link; canonical open status of their route', () => {
  const { plan: p } = plan(synthetic())
  for (const [table, n] of [['spoilt_meals', 104], ['retain', 302], ['spoilt_meals', 303], ['spoilt_meals', 403], ['standby', 502]]) {
    const [e] = entFor(p, table, n)
    assert.ok(e, `${table}:${n}`)
    assert.equal(e.payment_status, e.payment_method === 'payslip' ? 'pending' : 'outstanding')
    assert.equal(p.payment_links.filter((l) => l.entitlement_id === e.id).length, 0)
    assert.equal(recFor(p, table, n, e.prototype_component), undefined)
  }
})

test('paid entitlement → one prototype_migration record + one manual link; status paid (payslip) / claimed (petty cash)', () => {
  const { plan: p } = plan(synthetic())
  const [e] = entFor(p, 'recalls', 102)
  const r = recFor(p, 'recalls', 102, 'travel_amount')
  assert.equal(e.payment_status, 'paid')
  assert.equal(r.source, 'prototype_migration')
  assert.equal(r.stream, 'payslip')
  assert.equal(r.owner_id, OWNER)
  assert.equal(r.gross_amount, 75)
  assert.equal(r.reference, 'PN-0042') // payslip_pay_nbr preserved as the reference
  const links = p.payment_links.filter((l) => l.entitlement_id === e.id)
  assert.deepEqual(links, [{ entitlement_id: e.id, payment_record_id: r.id, allocated_amount: 75, link_kind: 'manual', note: `prototype_migration ${r.migration_source_key} (C3, WORK-191)`, actor_id: OWNER }])
  const [sm] = entFor(p, 'spoilt_meals', 601)
  assert.equal(sm.payment_method, 'petty_cash')
  assert.equal(sm.payment_status, 'claimed')
  assert.equal(recFor(p, 'spoilt_meals', 601, 'meal_amount').reference, null) // no pay number recorded → none invented
})

test('payment date: record_date is the Melbourne calendar date; the exact instant stays in raw_payload', () => {
  const { plan: p } = plan(synthetic())
  const rc = recFor(p, 'recalls', 102, 'travel_amount') // 2026-02-12T13:30Z = 2026-02-13 00:30 AEDT
  assert.equal(rc.record_date, '2026-02-13')
  assert.equal(rc.raw_payload.payment_date, '2026-02-12T13:30:00.000Z')
  const dm = recFor(p, 'spoilt_meals', 701, 'meal_amount') // 2026-05-02T14:10Z = 2026-05-03 00:10 AEST
  assert.equal(dm.record_date, '2026-05-03')
  assert.equal(melbourneDate('2026-06-01T00:00:00Z'), '2026-06-01')
  for (const r of p.payment_records) {
    assert.equal(r.raw_payload.kind, 'prototype_payment_state')
    assert.match(r.raw_payload.note, /Not a payslip line, bank settlement or payroll identifier/)
  }
})

test('deterministic, batch-independent migration_source_key and record id', () => {
  const { plan: p } = plan(synthetic())
  const r = recFor(p, 'standby', 402, 'travel_amount')
  assert.equal(r.migration_source_key, `c3:standby:${id(402)}:travel_amount`)
  assert.equal(r.id, uuidv5(`payment_record:${r.migration_source_key}`, NS))
  assert.equal(r.id, paymentRecordId(r.migration_source_key))
  // A different environment (different batch key) plans the same identities.
  const prod = planC2(synthetic(), { environment: 'prod', evidenceClass: 'synthetic' })
  assert.notEqual(prod.plan.batch_key, p.batch_key)
  assert.deepEqual(prod.plan.payment_records.map((x) => [x.id, x.migration_source_key]), p.payment_records.map((x) => [x.id, x.migration_source_key]))
})

test('allocation equals the effective historical amount; adjusted entitlement is paid at its adjusted amount', () => {
  const { plan: p } = plan(synthetic())
  const [meal] = entFor(p, 'spoilt_meals', 203) // stored 42.35, adjusted 40.00
  assert.equal(meal.generated_amount, 42.35)
  assert.equal(p.adjustments.find((a) => a.id === meal.id).edited_amount, 40)
  assert.equal(recFor(p, 'spoilt_meals', 203, 'meal_amount').gross_amount, 40)
  assert.equal(p.payment_links.find((l) => l.entitlement_id === meal.id).allocated_amount, 40)
  const legacy = recFor(p, 'spoilt_meals', 801, 'meal_amount') // legacy Spoilt / Meal 10.90 adjusted to 12.00
  assert.equal(legacy.gross_amount, 12)
  assert.match(legacy.raw_payload.amount_basis, /edited_amount/)
})

test('hours-first entitlement is allocated its stored historical dollars, never a conversion of hours', () => {
  const { plan: p } = plan(synthetic())
  const [ot] = entFor(p, 'retain', 202)
  assert.equal(ot.unit, 'hours')
  assert.equal(ot.generated_amount, null)
  const r = recFor(p, 'retain', 202, 'generated_hours')
  assert.equal(r.gross_amount, ot.rate_snapshot.historical_amount.value)
  assert.equal(r.gross_amount, 429.35)
  assert.match(r.raw_payload.amount_basis, /never derived from hours/)
  assert.equal(ot.payment_status, 'paid')
  // Missing historical dollars on a paid hours row → fail closed.
  const snap = synthetic()
  delete rowOf(snap, 'retain', 202).retain_amount
  rowOf(snap, 'retain', 202).total_amount = null
  rowOf(snap, 'retain', 201).total_amount = 42.35 // keep C2's parent/child total consistent
  const { report } = plan(snap)
  assert.equal(gate6(report).status, 'fail')
  assert.deepEqual(report.payments.failures.map((f) => f.code), ['C3_ALLOCATION_UNESTABLISHED'])
})

test('mixed claims: payment is entitlement-level — one paid child never pays its siblings', () => {
  const { plan: p, report } = plan(synthetic())
  const rc = report.events.find((e) => e.claim_type === 'RC')
  const status = Object.fromEntries(rc.entitlements.map((e) => [e.type, p.entitlements.find((x) => x.id === e.id).payment_status]))
  assert.deepEqual(status, { recall_mileage: 'paid', recall_meal: 'outstanding' })
  const sb = report.events.find((e) => e.claim_type === 'SB')
  assert.deepEqual(sb.entitlements.map((e) => p.entitlements.find((x) => x.id === e.id).payment_status).sort(), ['outstanding', 'paid'])
})

test('container parent and G12 rows carry no payable entitlement: their state is a reported structural difference', () => {
  const { report } = plan(synthetic())
  const s = report.payments.structural
  const container = s.find((x) => x.source === `recalls:${id(101)}`)
  assert.equal(container.code, 'CONTAINER_ROW_NOT_PAYABLE')
  assert.equal(container.source_state, 'paid') // the fixture's container toggle is Paid — still not mapped
  assert.equal(s.find((x) => x.source === `recalls:${id(103)}`).code, 'EXCLUDED_ARTIFACT_NOT_PAYABLE')
  assert.equal(gate6(report).evidence.intended_structural_differences.with_paid_or_anomalous_state, 1)
  assert.equal(gate6(report).status, 'pass')
})

test('a legacy row carrying two components applies its single toggle to both (row-level inference, reported)', () => {
  const snap = synthetic()
  snap.source.recalls.push({
    id: id(901), user_id: OWNER, date: '2026-01-20', claim_group_id: null, claim_number: 9, financial_year_id: FY,
    rostered_stn_id: 44, recall_stn_id: 45, shift: 'Day', arrived: '09:00', travel_amount: 30, mealie_amount: 20.55, total_amount: 50.55,
    created_at: '2026-01-20T09:00:00Z', payment_status: 'Paid', payment_date: '2026-01-25T02:00:00Z', status: 'Pending', calculation_inputs: {},
  })
  const { plan: p, report } = plan(snap)
  assert.equal(report.outcome, 'pass')
  const ents = entFor(p, 'recalls', 901)
  assert.equal(ents.length, 2)
  assert.deepEqual(ents.map((e) => e.payment_status).sort(), ['claimed', 'paid'])
  assert.equal(recFor(p, 'recalls', 901, 'travel_amount').stream, 'payslip')
  assert.equal(recFor(p, 'recalls', 901, 'mealie_amount').stream, 'petty_cash')
  assert.equal(gate6(report).evidence.inference_boundaries.row_level_shared_toggle, 2)
})

test('contradictory or insufficient evidence fails gate 6 closed: no apply SQL, every failure named', () => {
  const cases = [
    ['recalls', 102, { payment_status: 'Paid', payment_date: null }, 'C3_PAID_WITHOUT_DATE'],
    ['spoilt_meals', 104, { payment_status: 'Pending', payment_date: '2026-02-01T00:00:00Z' }, 'C3_PENDING_WITH_DATE'],
    ['standby', 502, { payment_status: null, status: 'Paid' }, 'C3_LEGACY_STATUS_CONFLICT'],
    ['spoilt_meals', 601, { payment_status: 'Disputed', payment_date: null }, 'C3_UNKNOWN_PAYMENT_STATUS'],
  ]
  for (const [table, n, patch, code] of cases) {
    const snap = synthetic()
    Object.assign(rowOf(snap, table, n), patch)
    const { plan: p, report } = plan(snap)
    assert.equal(report.outcome, 'fail', code)
    assert.equal(gate6(report).status, 'fail')
    for (const g of ['1', '2', '3', '4', '5', '7']) assert.equal(report.gates[g].status, 'pass', `${code} gate ${g}`)
    assert.deepEqual(report.payments.failures.map((f) => f.code), [code])
    assert.equal(gate6(report).evidence.genuine_failures, 1)
    assert.equal(p.payment_links.some((l) => l.entitlement_id === entFor(p, table, n)[0].id), false) // never silently chosen
    assert.throws(() => applySql(p), /acceptance gates fail \(6\)/)
  }
})

test('gate 6 report: source paid/unpaid totals reconcile exactly to canonical records, links and allocation', () => {
  const { plan: p, report } = plan(synthetic())
  const g = gate6(report)
  assert.equal(g.status, 'pass')
  const ev = g.evidence
  assert.equal(ev.source_payable_entitlements, 12)
  assert.deepEqual([ev.source_paid.count, ev.source_paid.amount], [7, 623.15])
  assert.deepEqual([ev.source_unpaid.count, ev.source_unpaid.amount], [5, 489.48])
  assert.deepEqual([ev.canonical.payment_records, ev.canonical.payment_links, ev.canonical.allocated_amount], [7, 7, 623.15])
  assert.deepEqual(ev.canonical.entitlement_status, { claimed: 4, outstanding: 3, paid: 3, pending: 2 })
  for (const k of ['unmatched_source_payment_state', 'over_allocated', 'under_allocated', 'duplicate_migration_payment_identities', 'contradictory_or_insufficient_source_states', 'genuine_failures', 'status_mismatches']) {
    assert.equal(ev[k], 0, k)
  }
  assert.deepEqual(ev.source_paid.by_owner_type_fy, ev.canonical.allocated_by_owner_type_fy) // by owner / type / FY
  assert.deepEqual([report.planned.payment_records, report.planned.payment_links], [7, 7])
  assert.equal(report.gates['7'].evidence.orphan_payment_links, 0)
  assert.equal(report.outcome, 'pass')
  assert.deepEqual(report.acceptance.required_gates, ['1', '2', '3', '4', '5', '6', '7'])
})

test('empty source (DEV reality): gate 6 passes with zero payments', () => {
  const { plan: p, report } = planC2({ ...envSnapshot(), source: {} }, { environment: 'dev' })
  assert.equal(gate6(report).status, 'pass')
  assert.equal(gate6(report).evidence.source_payable_entitlements, 0)
  assert.deepEqual([p.payment_records.length, p.payment_links.length], [0, 0])
  assert.equal(report.outcome, 'pass')
})

test('identical input → byte-identical report and plan (payments included); key order irrelevant', () => {
  const a = plan(synthetic())
  const shuffled = synthetic()
  for (const t of Object.keys(shuffled.source)) shuffled.source[t] = [...shuffled.source[t]].reverse().map((r) => Object.fromEntries(Object.entries(r).reverse()))
  const b = plan(shuffled)
  assert.equal(canonicalJson(a.report), canonicalJson(b.report))
  assert.equal(canonicalJson(a.plan), canonicalJson(b.plan))
  assert.equal(applySql(a.plan), applySql(b.plan))
})

test('changed payment source (paid → unpaid): same ids, one record fewer, status reverts → the DB proof must raise', () => {
  const snap = synthetic()
  const a = plan(snap).plan
  const c = plan(mutateSourceForPaymentChange(snap)).plan
  assert.notEqual(c.batch_key, a.batch_key)
  assert.equal(c.payment_records.length, a.payment_records.length - 1)
  assert.equal(c.payment_links.length, a.payment_links.length - 1)
  assert.deepEqual(c.entitlements.map((e) => e.id), a.entitlements.map((e) => e.id))
  const changed = c.entitlements.filter((e, i) => e.payment_status !== a.entitlements[i].payment_status)
  assert.equal(changed.length, 1)
})

test('apply SQL: insert-if-absent records, link only with a newly inserted record, every proof raises (fail closed)', () => {
  const { plan: p } = plan(synthetic())
  const sql = applySql(p)
  assert.match(sql, /insert into fat\.payment_records \(id, owner_id, stream, record_date, reference, gross_amount, raw_payload, source, migration_source_key, migration_batch_id\)/)
  assert.match(sql, /on conflict do nothing;\s+get diagnostics n = row_count; ins_pay/)
  assert.match(sql, /C2 conflict: payment_records % differs from the planned migrated payment record/)
  assert.match(sql, /if not \(lk\.payment_record_id = any\(new_recs\)\) then\s+raise exception 'C2 conflict: planned payment link/)
  assert.match(sql, /perform fat\.link_entitlement_payment\(lk\.entitlement_id, lk\.payment_record_id, lk\.allocated_amount, lk\.link_kind, lk\.actor_id, lk\.note, true\)/)
  assert.match(sql, /link_payment audit row\(s\), expected exactly 1/)
  assert.match(sql, /payment link\(s\) on migrated entitlements are not in the plan/)
  assert.match(sql, /select r\.changed into ch from fat\._reconc_recompute\(ps\.id\) r;/)
  assert.match(sql, /payment record\(s\) tagged to batch % are not in the plan/)
  // Entitlements enter with the open status of their route; the C3 phase runs before the ledger.
  assert.match(sql, /re\.payment_status := case re\.payment_method when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;/)
  assert.ok(sql.indexOf('fat.payment_records (') < sql.indexOf('fat.migration_source_rows ('))
  // The service-only create_payment_record RPC is not used for migrated records.
  assert.doesNotMatch(sql, /create_payment_record/)
})

test('verify SQL re-derives gate 6 from the prototype source and canonical tables', () => {
  const v = verifySql('c2:dev:1.1.0:abc')
  for (const k of ['gate6_source_invalid', 'gate6_paid_without_exactly_one_migration_link', 'gate6_unpaid_with_links', 'gate6_allocation_mismatches',
    'gate6_record_date_mismatches', 'gate6_status_mismatches', 'gate6_audit_mismatches', 'gate6_unlinked_migration_records', 'gate6_duplicate_source_keys', 'gate6_totals']) {
    assert.match(v, new RegExp(`'${k}'`))
  }
  assert.match(v, /at time zone 'Australia\/Melbourne'/)
})

test('synthetic harness covers C3 tamper and changed-payment steps and resets payment records', () => {
  const x = synthetic()
  const sql = syntheticHarnessSql({
    fixtureSource: x.source, planA: plan(x).plan, planB: plan(mutateSourceForConflict(x)).plan, planC: plan(mutateSourceForPaymentChange(x)).plan,
  })
  assert.match(sql, /for step in 1\.\.7 loop/)
  assert.match(sql, /if step = 5 then update fat\.payment_records set gross_amount = gross_amount \+ 1/)
  assert.match(sql, /if step = 6 then delete from fat\.entitlement_payment_links/)
  assert.match(sql, /delete from fat\.payment_records where migration_batch_id = \(select id from fat\.migration_batches where batch_key = /)
  assert.match(sql, /raise exception 'C2_SYNTHETIC_RESULT %'/)
})
