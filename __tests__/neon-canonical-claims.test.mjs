// WORK-256 — canonical claim model for the Neon DEV runtime (pure units).
// node --test __tests__/neon-canonical-claims.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildCanonicalDetail, projectClaims, missingFacts, APP_TO_CANONICAL, CANONICAL_TO_APP } from '../lib/claims/canonical/model.js'
import { calcCanonicalTaxSummary } from '../lib/claims/canonical/tax.js'
import { generateStandbyEntitlements } from '../lib/fat/engine/generators/standby.js'

const stations = new Set([9001, 9002, 9003])
const exists = (id) => stations.has(id)

test('type map covers the six FAT claim types both ways', () => {
  assert.deepEqual(Object.keys(APP_TO_CANONICAL).sort(), ['delayed_meal', 'md', 'recalls', 'retain', 'spoilt', 'standby'])
  for (const [app, c] of Object.entries(APP_TO_CANONICAL)) assert.equal(CANONICAL_TO_APP[c], app)
})

test('RC: C2 §4 Melbourne interval, duty from shift, explicit travel facts', () => {
  const b = buildCanonicalDetail({
    appType: 'recalls', date: '2026-09-10',
    fields: { shift: 'Day', arrivalTime: '08:00', bookedOffTime: '13:30', recallStnId: 9002, rosteredStnId: 9001 },
    facts: { travelMinutes: '50', travelSundayOrPh: false, travelDistanceKm: 42.5 },
    stationExists: exists,
  })
  assert.equal(b.claimType, 'RC')
  assert.equal(b.detailTable, 'recall_details')
  assert.equal(b.detail.recall_start_at, '2026-09-10T08:00:00+10:00')
  assert.equal(b.detail.recall_end_at, '2026-09-10T13:30:00+10:00')
  assert.equal(b.detail.recall_duty, 'day')
  assert.equal(b.detail.recall_station_id, 9002)
  assert.equal(b.detail.recall_travel_minutes, 50)
  assert.equal(b.detail.recall_travel_sunday_or_ph, false)
  assert.equal(b.detail.travel_distance_km, 42.5)
  assert.equal(b.detail.travel_source, 'manual')
  assert.equal(b.stationIdSnapshot, 9001)
})

test('RC: booked-off before arrival rolls to the next day; DST-summer offset', () => {
  const b = buildCanonicalDetail({ appType: 'recalls', date: '2026-12-01', fields: { shift: 'Night', arrivalTime: '22:00', bookedOffTime: '02:00' }, stationExists: exists })
  assert.equal(b.detail.recall_start_at, '2026-12-01T22:00:00+11:00')
  assert.equal(b.detail.recall_end_at, '2026-12-02T02:00:00+11:00')
})

test('RC: missing facts stay NULL (nothing guessed) and unknown stations are dropped', () => {
  const b = buildCanonicalDetail({ appType: 'recalls', date: '2026-09-10', fields: { shift: 'Day', arrivalTime: '08:00', recallStnId: 4242 }, stationExists: exists })
  assert.equal(b.detail.recall_end_at, null)
  assert.equal(b.detail.recall_travel_minutes, null)
  assert.equal(b.detail.recall_travel_sunday_or_ph, null)
  assert.equal(b.detail.travel_distance_km, null)
  assert.equal(b.detail.recall_station_id, null)
  assert.deepEqual(missingFacts('RC', b.detail, 9001).sort(), ['recall_end_at', 'recall_station_id', 'recall_travel_minutes', 'recall_travel_sunday_or_ph', 'travel_distance_km'].sort())
})

test('RT: rostered finish basis (Night 08:00) and explicit night-interruption facts', () => {
  const b = buildCanonicalDetail({ appType: 'retain', date: '2026-09-11', fields: { shift: 'Night', bookedOffTime: '09:30' }, facts: { nightShiftInterrupted: true, travelHomeMinutes: 45 }, stationExists: exists })
  assert.equal(b.detail.retain_start_at, '2026-09-11T08:00:00+10:00')
  assert.equal(b.detail.retain_end_at, '2026-09-11T09:30:00+10:00')
  assert.equal(b.detail.retain_shift, 'night')
  assert.equal(b.detail.night_shift_interrupted, true)
  assert.equal(b.detail.retain_travel_home_minutes, 45)
})

test('SB/MD: arrival instant, matrix version from routing or the active version', () => {
  const sb = buildCanonicalDetail({ appType: 'standby', date: '2026-09-12', fields: { arrivedTime: '19:30', standbyStnId: 9002 }, routingMeta: { standby: { matrixVersionId: 'v-1', matrixHours: 1.25 } }, stationExists: exists })
  assert.equal(sb.detail.standby_start_at, '2026-09-12T19:30:00+10:00')
  assert.equal(sb.detail.matrix_version, 'v-1')
  assert.equal(sb.detail.matrix_hours, 1.25)
  assert.equal(sb.sourceCalculationMode, 'frv_matrix')
  const md = buildCanonicalDetail({ appType: 'md', date: '2026-09-13', fields: { arrivedTime: '07:30', standbyStnId: 9003, mdHomeToRosteredKm: 30, mdHomeToMdKm: 12 }, activeMatrixVersion: 'active-v', stationExists: exists })
  assert.equal(md.claimType, 'MD')
  assert.equal(md.detail.md_event_at, '2026-09-13T07:30:00+10:00')
  assert.equal(md.detail.matrix_version, 'active-v')
  assert.equal(md.detail.home_to_rostered_km, 30)
  assert.equal(md.detail.home_to_target_km, 12)
})

test('SM / DM: meal facts are explicit; the firecall number is evidence only', () => {
  const sm = buildCanonicalDetail({ appType: 'spoilt', date: '2026-09-14', fields: { incidentTime: '12:15', firecallNumber: '12345' }, facts: { emergencyResponse: true }, stationExists: exists })
  assert.equal(sm.detail.meal_interrupted_at, '2026-09-14T12:15:00+10:00')
  assert.equal(sm.detail.emergency_response, true)
  assert.equal(sm.detail.emergency_call_ref, '12345')
  const smNoFact = buildCanonicalDetail({ appType: 'spoilt', date: '2026-09-14', fields: { incidentTime: '12:15', firecallNumber: '12345' }, stationExists: exists })
  assert.equal(smNoFact.detail.emergency_response, null, 'a firecall number does not imply an emergency response')
  const dm = buildCanonicalDetail({ appType: 'delayed_meal', date: '2026-09-15', fields: {}, facts: { mealWindowStart: '12:00', mealWindowEnd: '13:00', actualMealTime: '13:15', delayNotice2h: false, delayCause: 'other' }, stationExists: exists })
  assert.equal(dm.detail.meal_window_start_at, '2026-09-15T12:00:00+10:00')
  assert.equal(dm.detail.actual_meal_at, '2026-09-15T13:15:00+10:00')
  assert.equal(dm.detail.delay_cause, 'other')
  const dmBad = buildCanonicalDetail({ appType: 'delayed_meal', date: '2026-09-15', facts: { delayCause: 'lunch' }, stationExists: exists })
  assert.equal(dmBad.detail.delay_cause, null)
})

test('SB small-meal trigger reads Australia/Melbourne time whatever the runtime TZ (WORK-256 root cause)', () => {
  const ctx = {
    profileSnapshot: { rostered_station_id: 9001 },
    matrixLookup: () => null,
    rateLookup: (code) => ({ rate: { id: 'r-' + code }, rateVersion: { id: 'v-' + code, version_label: 'x', effective_from: '2025-06-01', value: code === 'small_meal' ? 10.9 : 0.5 }, value: code === 'small_meal' ? 10.9 : 0.5 }),
  }
  const original = process.env.TZ
  try {
    for (const tz of ['UTC', 'Australia/Melbourne', 'America/Los_Angeles']) {
      process.env.TZ = tz
      const evening = generateStandbyEntitlements({ claim_type: 'SB', claim_date: '2026-09-12' }, { standby_station_id: 9001, standby_start_at: '2026-09-12T19:30:00+10:00' }, ctx)
      assert.ok(evening.some((d) => d.entitlement_type === 'small_meal'), `19:30 Melbourne → small meal under TZ=${tz}`)
      const before = generateStandbyEntitlements({ claim_type: 'SB', claim_date: '2026-09-12' }, { standby_station_id: 9001, standby_start_at: '2026-09-12T18:59:00+10:00' }, ctx)
      assert.ok(!before.some((d) => d.entitlement_type === 'small_meal'), `18:59 Melbourne → none under TZ=${tz}`)
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})

const claimRow = (o) => ({ id: 'c1', owner_id: 'o', claim_type: 'RC', claim_date: '2026-09-10', station_id_snapshot: 9001, station_name_snapshot: 'Alpha', status: 'submitted', notes: null, claim_number: 3, financial_year_id: 'fy', created_at: '2026-09-10T00:00:00.000Z', migration_batch_id: null, ...o })
const ent = (o) => ({ id: o.id, claim_id: 'c1', owner_id: 'o', entitlement_type: o.type, unit: o.unit, generated_amount: o.amount ?? null, generated_hours: o.hours ?? null, edited_amount: o.editedAmount ?? null, edited_hours: o.editedHours ?? null, edited_note: o.note ?? null, manual_override: !!o.override, rule_id: 'r', rule_version: 'v1', rate_snapshot: o.snapshot ?? {}, payment_method: o.method, payment_status: o.status ?? 'pending', generated_at: o.at ?? '2026-09-10T01:00:00.000Z' })

test('projection: one group per claim, one child per entitlement, UI contract fields', () => {
  const { claims, claimGroups } = projectClaims({
    claims: [claimRow()],
    details: new Map([['c1', { claim_id: 'c1', recall_duty: 'day', recall_station_id: 9002, recall_start_at: '2026-09-10T08:00:00+10:00', recall_end_at: '2026-09-10T13:30:00+10:00' }]]),
    entitlements: [
      ent({ id: 'e1', type: 'recall_overtime', unit: 'hours', hours: 5.5, method: 'payslip', snapshot: { estimate: 555.61 } }),
      ent({ id: 'e2', type: 'recall_mileage', unit: 'dollars', amount: 63.75, method: 'petty_cash', status: 'outstanding', snapshot: { quantity: 42.5, value: '1.5' } }),
      ent({ id: 'e3', type: 'recall_meal', unit: 'dollars', amount: 20.53, method: 'petty_cash', status: 'paid', editedAmount: 18, override: true, note: 'x' }),
    ],
    linkedEntitlementIds: new Set(['e3']),
    stationNames: new Map([[9001, 'Alpha'], [9002, 'Bravo']]),
  })
  assert.equal(claimGroups.length, 1)
  const g = claimGroups[0]
  assert.equal(g.claim_type, 'recalls')
  assert.equal(g.claim_number, 3)
  assert.match(g.label, /#3/)
  assert.equal(g.overdue_at, '2026-10-08T00:00:00.000Z')
  assert.equal(g.canonical.paymentLinked, true)
  assert.equal(claims.length, 3)
  const [ot, mi, meal] = ['e1', 'e2', 'e3'].map((id) => claims.find((c) => c.id === id))
  assert.equal(ot.claim_group_id, 'c1')
  assert.equal(ot.total_amount, 0, 'hours rows never carry dollars')
  assert.equal(ot.canonical.hours, 5.5)
  assert.equal(ot.canonical.estimate, 555.61)
  assert.equal(ot.payment_method, 'Payslip')
  assert.equal(ot.calculation_inputs.autoChild, 'recall_overtime')
  assert.equal(ot.shift, 'Day')
  assert.equal(ot.recall_stn_label, 'Bravo')
  assert.equal(ot.rostered_stn_label, 'Alpha')
  assert.equal(mi.payment_status, 'Pending', 'outstanding displays as Pending')
  assert.equal(mi.payment_method, 'Petty Cash')
  assert.equal(mi.canonical.quantity, 42.5)
  assert.equal(meal.payment_status, 'Paid')
  assert.equal(meal.total_amount, 20.53, 'generated amount kept')
  assert.equal(meal.adjusted_amount, 18)
  assert.equal(meal.component_amount, 18, 'effective (overridden) amount')
  assert.equal(meal.canonical.paymentLinked, true)
})

test('projection: a claim with no entitlements still lists, with its missing facts', () => {
  const { claims, claimGroups } = projectClaims({ claims: [claimRow({ claim_type: 'DM' })], details: new Map([['c1', { claim_id: 'c1' }]]), entitlements: [] })
  assert.equal(claims.length, 0)
  assert.equal(claimGroups[0].claim_type, 'delayed_meal')
  assert.ok(claimGroups[0].canonical.missingFacts.includes('delay_cause'))
})

test('tax summary from canonical entitlements (actual amounts, never hours→$)', () => {
  const row = (type, unit, amount, extra = {}) => ({ canonical: { entitlementType: type, unit, generatedAmount: amount, editedAmount: null, ...extra } })
  const s = calcCanonicalTaxSummary([
    row('small_meal', 'dollars', 10.9),
    row('recall_meal', 'dollars', 20.53),
    row('retain_meal', 'dollars', 20.53, { editedAmount: 19 }),
    row('recall_mileage', 'dollars', 63.75, { quantity: 42.5 }),
    row('recall_overtime', 'hours', null),
    { claimType: 'recalls' },
  ])
  assert.equal(s.smallMealCount, 1)
  assert.equal(s.smallMealTotal, 10.9)
  assert.equal(s.largeMealCount, 2)
  assert.equal(s.largeMealTotal, 39.53)
  assert.equal(s.travelKm, 42.5)
  assert.equal(s.travelTotal, 63.75)
  assert.equal(s.travelRate, 1.5)
  assert.equal(s.grandTotal, 114.18)
})
