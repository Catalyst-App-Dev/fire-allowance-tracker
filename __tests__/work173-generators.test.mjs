/**
 * WORK-173 — canonical Recall / Retain / Spoilt Meal / Delayed Meal generators
 * against the worked examples of the approved rule spec v0.2 (Linear WORK-173
 * document; docs/architecture/CANONICAL_ENTITLEMENT_RULES.md § 10).
 *
 * Run with: node --test __tests__/work173-generators.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveRateVersion, resolveOvertimeRate } from '../lib/fat/rates/rateModel.js'
import { FIXTURE_CATALOG, FIXTURE_LFF_HISTORY } from '../lib/fat/rates/fixtureCatalog.js'
import { generateRecallEntitlements, recallMealCount } from '../lib/fat/engine/generators/recall.js'
import { generateRetainEntitlements, retainMealCount } from '../lib/fat/engine/generators/retain.js'
import { generateSpoiltMealEntitlements } from '../lib/fat/engine/generators/spoiltMeal.js'
import { generateDelayedMealEntitlements } from '../lib/fat/engine/generators/delayedMeal.js'
import { nearestQuarterHours, MS_MINUTE } from '../lib/fat/engine/generators/shared.js'
import { generateEntitlements } from '../lib/fat/engine/index.js'

// Engine context over the fixture catalog (mirrors lib/fat/engine/context.js).
function ctxFor({ history = FIXTURE_LFF_HISTORY, rostered = 45 } = {}) {
  const skips = []
  return {
    skips,
    onSkip: (s) => skips.push(s),
    profileSnapshot: { id: 'u', rostered_station_id: rostered, rostered_station_name: 'Brooklyn' },
    rateLookup: (code, date) => {
      const h = resolveRateVersion(FIXTURE_CATALOG, code, date)
      return h ? { rate: h.rate, rateVersion: h.version, value: Number(h.value) } : null
    },
    overtimeLookup: (date, multiplierCode) =>
      resolveOvertimeRate(FIXTURE_CATALOG, { date, classificationHistory: history, multiplierCode }),
    matrixLookup: () => null,
  }
}
// Melbourne local timestamps (AEDT +11:00 in Nov; AEST +10:00 in Jun).
const nov = (day, hhmm) => `2025-11-${day}T${hhmm}:00+11:00`
const jun = (day, hhmm) => `2026-06-${day}T${hhmm}:00+10:00`
const by = (drafts, type) => drafts.filter((d) => d.entitlement_type === type)
const one = (drafts, type) => { const r = by(drafts, type); assert.equal(r.length, 1, `${type} count`); return r[0] }

function invariants(drafts) {
  for (const d of drafts) {
    if (d.unit === 'hours') { assert.equal(d.generated_amount, null); assert.ok(d.generated_hours > 0) }
    else if (d.unit === 'dollars') { assert.equal(d.generated_hours, null); assert.ok(d.generated_amount > 0) }
    else assert.fail(`unit ${d.unit}`)
    assert.equal(d.manual_override, false)
    assert.ok(d.rule_id && d.rule_version && d.rate_snapshot)
    assert.ok(['payslip', 'petty_cash'].includes(d.payment_method))
    assert.equal(d.payment_status, d.payment_method === 'petty_cash' ? 'outstanding' : 'pending')
  }
}

// ── Shared rounding (cl 128.1: nearest quarter hour) ───────────────────────

test('nearest quarter hour, half-up — never ceiling', () => {
  assert.equal(nearestQuarterHours(7 * MS_MINUTE), 0)
  assert.equal(nearestQuarterHours(7.5 * MS_MINUTE), 0.25)
  assert.equal(nearestQuarterHours(25 * MS_MINUTE), 0.5)
  assert.equal(nearestQuarterHours(40 * MS_MINUTE), 0.75)
  assert.equal(nearestQuarterHours((12 * 60 + 10) * MS_MINUTE), 12.25)
  assert.equal(nearestQuarterHours((4 * 60 + 1) * MS_MINUTE), 4)
})

// ── Recall ──────────────────────────────────────────────────────────────────

test('R1: night recall 19:50–08:00 to another station (payslip 21.2025)', () => {
  const ctx = ctxFor()
  const drafts = generateRecallEntitlements({ claim_date: '2025-11-10' }, {
    recall_start_at: nov('10', '19:50'), recall_end_at: nov('11', '08:00'), recall_station_id: 44,
    recall_duty: 'night', recall_travel_minutes: 150, recall_travel_sunday_or_ph: false, travel_distance_km: 146,
  }, ctx)
  invariants(drafts)
  const ot = one(drafts, 'recall_overtime')
  assert.equal(ot.generated_hours, 12.25)
  assert.equal(ot.rate_snapshot.estimate, 1237.5)            // payslip $1,237.53 — accepted WORK-246 residual
  assert.equal(ot.rate_snapshot.multiplier, '2')
  assert.equal(ot.rate_version_id, 'base-lff')
  const tr = one(drafts, 'recall_travel_time')
  assert.equal(tr.generated_hours, 2.5)
  assert.equal(tr.rate_snapshot.estimate, 126.28)            // = payslip Excess Travel 2.50 h
  assert.equal(tr.rate_snapshot.multiplier_code, 'single_time_multiplier')
  assert.equal(one(drafts, 'recall_mileage').generated_amount, 219)
  assert.equal(one(drafts, 'relieving_allowance').generated_amount, 35.11)
  const meals = by(drafts, 'recall_meal')
  assert.equal(meals.length, 1)
  assert.equal(meals[0].generated_amount, 20.53)
  assert.equal(by(drafts, 'excess_travel_recall').length, 0)  // no separate recall Excess Travel (D9d)
})

test('R2: day recall 10:05–18:00 at the rostered station → 8 h, 1 meal, no Relieving', () => {
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-13' }, {
    recall_start_at: jun('13', '10:05'), recall_end_at: jun('13', '18:00'), recall_station_id: 45, recall_duty: 'day',
  }, ctxFor())
  assert.equal(one(drafts, 'recall_overtime').generated_hours, 8)
  assert.equal(one(drafts, 'recall_overtime').rate_snapshot.estimate, 808.16)
  assert.equal(by(drafts, 'recall_meal').length, 1)
  assert.equal(by(drafts, 'relieving_allowance').length, 0)
})

test('R3/R4: 4 h minimum; day before 10:00 → 0 meals if ≤ 2 h, 2 meals if > 2 h', () => {
  const r3 = generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_start_at: jun('13', '07:30'), recall_end_at: jun('13', '09:00'), recall_duty: 'day' }, ctxFor())
  assert.equal(one(r3, 'recall_overtime').generated_hours, 4)
  assert.equal(one(r3, 'recall_overtime').rate_snapshot.estimate, 404.08)
  assert.equal(by(r3, 'recall_meal').length, 0)
  const r4 = generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_start_at: jun('13', '08:00'), recall_end_at: jun('13', '10:30'), recall_duty: 'day' }, ctxFor())
  assert.equal(by(r4, 'recall_meal').length, 2)
  assert.deepEqual(by(r4, 'recall_meal').map((m) => m.rate_snapshot.facts.ordinal), [1, 2])
})

test('R5: day recall commencing exactly 10:00 → no meal row, needs operator decision; other rows unaffected', () => {
  const ctx = ctxFor()
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_start_at: jun('13', '10:00'), recall_end_at: jun('13', '14:00'), recall_duty: 'day' }, ctx)
  assert.equal(by(drafts, 'recall_meal').length, 0)
  assert.equal(one(drafts, 'recall_overtime').generated_hours, 4)
  assert.ok(ctx.skips.some((s) => s.entitlement_type === 'recall_meal' && s.reason === 'needs_operator_decision'))
})

test('R6: night recall commencing exactly 20:00 → 0 meals (not "before 20:00")', () => {
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_start_at: jun('13', '20:00'), recall_end_at: jun('13', '23:00'), recall_duty: 'night' }, ctxFor())
  assert.equal(by(drafts, 'recall_meal').length, 0)
  assert.equal(recallMealCount({ duty: 'night', startAt: jun('13', '19:59'), durationMs: 121 * MS_MINUTE }).count, 1)
  assert.equal(recallMealCount({ duty: 'night', startAt: jun('13', '19:00'), durationMs: 120 * MS_MINUTE }).count, 0) // not "more than 2 h"
})

test('Recall meals: day after 10:00 needs more than 3 h; night early-morning start fails closed', () => {
  assert.equal(recallMealCount({ duty: 'day', startAt: jun('13', '10:01'), durationMs: 180 * MS_MINUTE }).count, 0)
  assert.equal(recallMealCount({ duty: 'day', startAt: jun('13', '10:01'), durationMs: 181 * MS_MINUTE }).count, 1)
  assert.ok(recallMealCount({ duty: 'night', startAt: jun('14', '02:00'), durationMs: 5 * 60 * MS_MINUTE }).ambiguous)
  assert.ok(recallMealCount({ duty: null, startAt: jun('13', '08:00'), durationMs: 5 * 60 * MS_MINUTE }).ambiguous)
})

test('R7: Sunday / public-holiday recall travel is estimated at time and one half', () => {
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-14' }, {
    recall_start_at: jun('14', '08:00'), recall_end_at: jun('14', '12:00'), recall_travel_minutes: 60, recall_travel_sunday_or_ph: true,
  }, ctxFor())
  const tr = one(drafts, 'recall_travel_time')
  assert.equal(tr.generated_hours, 1)
  assert.equal(tr.rate_snapshot.multiplier_code, 'time_and_half_multiplier')
  assert.equal(tr.rate_snapshot.estimate, 75.77)
})

test('R8: no classification → hours rows with null estimate; dollar rows unaffected', () => {
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-13' }, {
    recall_start_at: jun('13', '08:00'), recall_end_at: jun('13', '12:00'), recall_station_id: 51, recall_duty: 'day',
    recall_travel_minutes: 90, recall_travel_sunday_or_ph: false, travel_distance_km: 40,
  }, ctxFor({ history: [] }))
  invariants(drafts)
  const ot = one(drafts, 'recall_overtime')
  assert.equal(ot.generated_hours, 4)
  assert.equal(ot.rate_snapshot.estimate, null)
  assert.equal(ot.rate_snapshot.reason, 'no-classification')
  assert.equal(ot.rate_version_id, null)
  assert.equal(one(drafts, 'recall_mileage').generated_amount, 60)
  assert.equal(one(drafts, 'relieving_allowance').generated_amount, 35.11)
})

test('Recall fail-closed: missing travel facts suppress only their rows; Relieving before its first evidenced version → none', () => {
  const ctx = ctxFor()
  const drafts = generateRecallEntitlements({ claim_date: '2022-03-01' }, {
    recall_start_at: '2022-03-01T08:00:00+11:00', recall_end_at: '2022-03-01T13:00:00+11:00', recall_station_id: 51, recall_duty: 'day',
    recall_travel_minutes: 60, // Sunday/PH fact missing → no travel row
  }, ctx)
  assert.equal(by(drafts, 'recall_travel_time').length, 0)
  assert.equal(by(drafts, 'recall_mileage').length, 0)
  assert.equal(by(drafts, 'relieving_allowance').length, 0)    // no relieving version before 2023-06-17
  assert.equal(by(drafts, 'recall_overtime').length, 1)
  assert.equal(by(drafts, 'recall_meal')[0].generated_amount, 18.75) // 2021-01-01 meal version
  const reasons = ctx.skips.map((s) => `${s.entitlement_type}:${s.reason}`)
  assert.ok(reasons.includes('recall_travel_time:missing-sunday-or-public-holiday-fact'))
  assert.ok(reasons.includes('relieving_allowance:rate-unavailable'))
})

test('Recall: no times → no overtime and no meals', () => {
  const drafts = generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_duty: 'day' }, ctxFor())
  assert.equal(drafts.length, 0)
})

// ── Retain ──────────────────────────────────────────────────────────────────

const dayRetain = (hhmm, extra = {}) => ({ retain_start_at: jun('13', '18:00'), retain_end_at: jun('13', hhmm), retain_shift: 'day', ...extra })

test('T1: retained 65 min → 4 h at double time ($404.08 estimate) and 1 meal', () => {
  const drafts = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('19:05'), ctxFor())
  invariants(drafts)
  const ot = one(drafts, 'retain_overtime')
  assert.equal(ot.generated_hours, 4)
  assert.equal(ot.rule_id, 'retain.overtime.v1')
  assert.equal(ot.rate_snapshot.estimate, 404.08)            // payslip Maint Stn $404.09 — accepted residual
  assert.equal(ot.rate_snapshot.is_estimate, true)
  assert.equal(by(drafts, 'retain_meal').length, 1)
  assert.equal(by(drafts, 'retain_meal')[0].generated_amount, 20.53)
})

test('T2–T5: retain meals 1, 2 (> 2 h), 3 (at 4 h); hours to the nearest quarter', () => {
  assert.equal(by(generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('20:10'), ctxFor()), 'retain_meal').length, 2)
  const t4 = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('22:00'), ctxFor())
  assert.equal(by(t4, 'retain_meal').length, 3)
  assert.equal(one(t4, 'retain_overtime').generated_hours, 4)
  const t5 = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('22:55'), ctxFor())
  assert.equal(one(t5, 'retain_overtime').generated_hours, 5)
  assert.equal(one(t5, 'retain_overtime').rate_snapshot.estimate, 505.1)
  assert.equal(by(t5, 'retain_meal').length, 3)
  const t22 = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('22:01'), ctxFor())
  assert.equal(one(t22, 'retain_overtime').generated_hours, 4)   // nearest, not ceiling (prototype says 4.25)
  assert.equal(retainMealCount(2 * 60 * MS_MINUTE), 1)           // exactly 2 h: not "exceeds"
  assert.equal(retainMealCount(6 * 60 * MS_MINUTE), 4)
  assert.equal(retainMealCount(59 * MS_MINUTE), 0)
})

test('T3: under 60 min is ordinary cl 128.1 overtime at double time — no minimum, no meal', () => {
  const drafts = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('18:40'), ctxFor())
  const ot = one(drafts, 'retain_overtime')
  assert.equal(ot.rule_id, 'retain.overtime_short.v1')
  assert.equal(ot.generated_hours, 0.75)
  assert.equal(ot.rate_snapshot.estimate, 75.77)             // = payslip "Fire Call" 0.75 h
  assert.equal(by(drafts, 'retain_meal').length, 0)
})

test('T7: 7 minutes rounds to zero → no overtime row (never a zero row)', () => {
  const ctx = ctxFor()
  const drafts = generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('18:07'), ctx)
  assert.equal(drafts.length, 0)
  assert.ok(ctx.skips.some((s) => s.reason === 'rounds-to-zero'))
})

test('T6: night retention after an interrupted night shift → travel home 1.0 h at ordinary rate', () => {
  const drafts = generateRetainEntitlements({ claim_date: '2026-06-14' }, {
    retain_start_at: jun('14', '08:00'), retain_end_at: jun('14', '09:40'), retain_shift: 'night',
    night_shift_interrupted: true, retain_travel_home_minutes: 60,
  }, ctxFor())
  invariants(drafts)
  assert.equal(one(drafts, 'retain_overtime').generated_hours, 4)
  const th = one(drafts, 'retain_travel_home')
  assert.equal(th.generated_hours, 1)
  assert.equal(th.rate_snapshot.estimate, 50.51)             // = payslip Excess Travel 1.00 h
  assert.equal(th.rate_snapshot.multiplier_code, 'single_time_multiplier')
  assert.equal(by(drafts, 'retain_meal').length, 1)
})

test('Retain travel home: not for a day shift or an uninterrupted night; missing facts fail closed', () => {
  const base = { retain_start_at: jun('14', '08:00'), retain_end_at: jun('14', '09:40'), retain_travel_home_minutes: 60 }
  assert.equal(by(generateRetainEntitlements({ claim_date: '2026-06-14' }, { ...base, retain_shift: 'night', night_shift_interrupted: false }, ctxFor()), 'retain_travel_home').length, 0)
  assert.equal(by(generateRetainEntitlements({ claim_date: '2026-06-14' }, { ...base, retain_shift: 'day', night_shift_interrupted: true }, ctxFor()), 'retain_travel_home').length, 0)
  const ctx = ctxFor()
  assert.equal(by(generateRetainEntitlements({ claim_date: '2026-06-14' }, { ...base, retain_shift: 'night' }, ctx), 'retain_travel_home').length, 0)
  assert.ok(ctx.skips.some((s) => s.entitlement_type === 'retain_travel_home'))
})

test('T8: promotion — SO classification on the claim date → $456.80 estimate; earlier claims keep LFF', () => {
  const history = [{ classification: 'lff', effective_from: '2021-01-01' }, { classification: 'so', effective_from: '2026-09-01' }]
  const after = one(generateRetainEntitlements({ claim_date: '2026-09-01' }, { retain_start_at: '2026-09-01T18:00:00+10:00', retain_end_at: '2026-09-01T19:05:00+10:00' }, ctxFor({ history })), 'retain_overtime')
  assert.equal(after.rate_snapshot.estimate, 456.8)
  assert.equal(after.rate_snapshot.classification, 'so')
  const before = one(generateRetainEntitlements({ claim_date: '2026-08-31' }, { retain_start_at: '2026-08-31T18:00:00+10:00', retain_end_at: '2026-08-31T19:05:00+10:00' }, ctxFor({ history })), 'retain_overtime')
  assert.equal(before.rate_snapshot.estimate, 404.08)
})

// ── Spoilt Meal ─────────────────────────────────────────────────────────────

test('S1: meal interrupted by an emergency response → Spoilt Meal Allowance by date', () => {
  const d = { meal_interrupted_at: jun('13', '12:35'), emergency_response: true, emergency_call_ref: '6933' }
  const drafts = generateSpoiltMealEntitlements({ claim_date: '2026-06-13' }, d, ctxFor())
  invariants(drafts)
  assert.equal(one(drafts, 'spoilt_meal').generated_amount, 20.52)
  assert.equal(drafts[0].rate_snapshot.code, 'spoilt_meal_allowance')
  assert.equal(generateSpoiltMealEntitlements({ claim_date: '2022-05-01' }, d, ctxFor())[0].generated_amount, 18.74)
})

test('S2: non-emergency interruption → none; call reference is NOT a condition; missing facts fail closed', () => {
  assert.equal(generateSpoiltMealEntitlements({ claim_date: '2026-06-13' }, { meal_interrupted_at: jun('13', '12:35'), emergency_response: false }, ctxFor()).length, 0)
  assert.equal(generateSpoiltMealEntitlements({ claim_date: '2026-06-13' }, { meal_interrupted_at: jun('13', '15:10'), emergency_response: true }, ctxFor()).length, 1) // no ref, no clock window
  assert.equal(generateSpoiltMealEntitlements({ claim_date: '2026-06-13' }, { emergency_response: true }, ctxFor()).length, 0)
})

// ── Delayed Meal ────────────────────────────────────────────────────────────

const window = { meal_window_start_at: jun('13', '12:00'), meal_window_end_at: jun('13', '13:00') }

test('D1–D3: 85.6.6 — more than 30 min, no 2 h notice', () => {
  const d1 = generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, actual_meal_at: jun('13', '12:45'), delay_notice_2h: false, delay_cause: 'other' }, ctxFor())
  invariants(d1)
  assert.equal(one(d1, 'delayed_meal').generated_amount, 20.53)
  assert.equal(d1[0].rule_id, 'meal.delayed.v1')
  assert.equal(d1[0].rate_snapshot.code, 'meal_allowance')     // not the spoilt-meal code (D9b)
  assert.equal(generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, actual_meal_at: jun('13', '12:30'), delay_notice_2h: false, delay_cause: 'other' }, ctxFor()).length, 0) // exactly 30
  assert.equal(generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, actual_meal_at: jun('13', '13:00'), delay_notice_2h: true, delay_cause: 'other' }, ctxFor()).length, 0)
})

test('D4/D5: 85.6.7 — fire duty of exactly 3 h spanning the break qualifies; 2.5 h does not', () => {
  const d4 = generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, delay_cause: 'fire_call', duty_start_at: jun('13', '11:30'), duty_end_at: jun('13', '14:30') }, ctxFor())
  assert.equal(one(d4, 'delayed_meal').rule_id, 'meal.fire_call_3h.v1')
  assert.equal(d4[0].generated_amount, 20.53)
  const d5 = generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, actual_meal_at: jun('13', '13:10'), delay_notice_2h: false, delay_cause: 'fire_call', duty_start_at: jun('13', '11:40'), duty_end_at: jun('13', '14:10') }, ctxFor())
  assert.equal(d5.length, 0)
  const notSpanning = generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, delay_cause: 'salvage', duty_start_at: jun('13', '14:00'), duty_end_at: jun('13', '18:00') }, ctxFor())
  assert.equal(notSpanning.length, 0)
})

test('Delayed: missing facts fail closed with a reason', () => {
  const ctx = ctxFor()
  assert.equal(generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window }, ctx).length, 0)
  assert.equal(generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, delay_cause: 'other', actual_meal_at: jun('13', '13:00') }, ctx).length, 0)
  assert.equal(ctx.skips.length, 2)
})

// ── Dispatcher and isolation ────────────────────────────────────────────────

test('dispatcher routes RC/RT/SM/DM to the new generators', () => {
  const ctx = ctxFor()
  assert.ok(generateEntitlements({ claim_type: 'RT', claim_date: '2026-06-13' }, dayRetain('19:05'), ctx).length > 0)
  assert.ok(generateEntitlements({ claim_type: 'SM', claim_date: '2026-06-13' }, { meal_interrupted_at: jun('13', '12:35'), emergency_response: true }, ctx).length === 1)
})

test('no generator reads the workbook small_meal / large_meal codes', () => {
  const ctx = ctxFor()
  const seen = []
  const spy = { ...ctx, rateLookup: (code, date) => { seen.push(code); return ctx.rateLookup(code, date) } }
  generateRecallEntitlements({ claim_date: '2026-06-13' }, { recall_start_at: jun('13', '08:00'), recall_end_at: jun('13', '12:00'), recall_duty: 'day', recall_station_id: 51, travel_distance_km: 10 }, spy)
  generateRetainEntitlements({ claim_date: '2026-06-13' }, dayRetain('21:00'), spy)
  generateSpoiltMealEntitlements({ claim_date: '2026-06-13' }, { meal_interrupted_at: jun('13', '12:35'), emergency_response: true }, spy)
  generateDelayedMealEntitlements({ claim_date: '2026-06-13' }, { ...window, actual_meal_at: jun('13', '12:45'), delay_notice_2h: false, delay_cause: 'other' }, spy)
  assert.ok(seen.length > 0)
  assert.ok(!seen.includes('small_meal') && !seen.includes('large_meal'))
})
