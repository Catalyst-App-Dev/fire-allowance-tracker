/**
 * Versioned rate/rule model (WORK-172) — pure lookup + overtime arithmetic.
 *
 * Run with: node --test __tests__/rate-model.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveRateVersion, resolveClassification, resolveOvertimeRate,
  overtimeLineAmount, overtimeSnapshot, roundHalfUp, mul, div, toFixedString,
} from '../lib/fat/rates/rateModel.js'
import { FIXTURE_CATALOG, FIXTURE_LFF_HISTORY } from '../lib/fat/rates/fixtureCatalog.js'
import { buildRatesForDate } from '../lib/calculations/ratesForDate.js'
import { generateMusterDismissEntitlements } from '../lib/fat/engine/generators/musterDismiss.js'
import { generateStandbyEntitlements } from '../lib/fat/engine/generators/standby.js'

const LFF = (date = '2026-06-13') =>
  resolveOvertimeRate(FIXTURE_CATALOG, { date, classificationHistory: FIXTURE_LFF_HISTORY })

// ── Effective-date boundaries ──────────────────────────────────────────────

test('km: day before the PR765587 boundary resolves the prior version', () => {
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'travel_per_km', '2023-06-16').value, '1.37')
})

test('km: boundary day (effective_from inclusive) resolves the new version', () => {
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'travel_per_km', '2023-06-17').value, '1.5')
})

test('km: current lookup ignores the withdrawn $1.20 workbook version', () => {
  const r = resolveRateVersion(FIXTURE_CATALOG, 'travel_per_km', '2026-10-05')
  assert.equal(r.value, '1.5')
  assert.equal(r.version.id, 'km-2023')
})

test('historical lookup before any version → null (fail closed)', () => {
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'travel_per_km', '2020-12-31'), null)
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'meal_allowance', '2020-12-31'), null)
})

test('meal_allowance history: 18.75 then 20.53', () => {
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'meal_allowance', '2022-01-01').value, '18.75')
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'meal_allowance', '2026-01-01').value, '20.53')
})

// ── Classification lookup ──────────────────────────────────────────────────

test('classification history: latest effective_from on or before the date', () => {
  const h = [
    { classification: 'lff', effective_from: '2021-01-01' },
    { classification: 'so',  effective_from: '2026-09-01' },
  ]
  assert.equal(resolveClassification(h, '2026-08-31'), 'lff')
  assert.equal(resolveClassification(h, '2026-09-01'), 'so')
  assert.equal(resolveClassification(h, '2020-12-31'), null)
})

test('a later promotion changes the rate from its effective date only', () => {
  const h = [
    { classification: 'lff', effective_from: '2021-01-01' },
    { classification: 'so',  effective_from: '2026-09-01' },
  ]
  const before = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-08-31', classificationHistory: h })
  const after  = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-09-01', classificationHistory: h })
  assert.equal(before.baseHourly, '50.51')          // 1999.60 × 0.9093 ÷ 36
  assert.equal(after.classification, 'so')
  assert.equal(after.baseHourly, '57.10')           // 2260.73 × 0.9093 ÷ 36 = 57.1018… → 57.10
})

test('classified rate is not used for another classification', () => {
  const slff = resolveRateVersion(FIXTURE_CATALOG, 'enterprise_base_pay_weekly', '2026-01-01', 'slff')
  assert.equal(slff.value, '2121.41')
  assert.equal(resolveRateVersion(FIXTURE_CATALOG, 'enterprise_base_pay_weekly', '2026-01-01', 'qff'), null)
})

// ── Precision and rounding ─────────────────────────────────────────────────

test('exact arithmetic: no binary floating point in the rule', () => {
  // 0.1 + 0.2 style traps: 1999.60 × 0.9093 = 1818.23628 exactly.
  assert.equal(toFixedString(mul('1999.60', '0.9093'), 8), '1818.23628')
  assert.equal(toFixedString(div(mul('1999.60', '0.9093'), '36'), 12), '50.506563333333')
})

test('round half-up at cents', () => {
  assert.equal(roundHalfUp('429.335', 2), '429.34')
  assert.equal(roundHalfUp('126.275', 2), '126.28')
  assert.equal(roundHalfUp('50.505', 2), '50.51')
  assert.equal(roundHalfUp('50.50499', 2), '50.50')
})

test('LFF rule: full-precision base retained alongside the published cents base', () => {
  const ot = LFF()
  assert.equal(ot.ok, true)
  assert.equal(ot.baseHourlyExact, '50.506563333333')
  assert.equal(ot.baseHourly, '50.51')
  assert.equal(ot.hourly, '101.0200')
})

// ── Payslip reconciliation (LFF, operator decision D-172-1) ────────────────

test('four-hour retain reconciles within the accepted one-cent tolerance', () => {
  const amt = overtimeLineAmount(4, LFF())
  assert.equal(amt, 404.08)
  assert.ok(Math.abs(amt - 404.09) <= 0.01 + 1e-9)
})

test('payslip lines that reconcile exactly', () => {
  const ot = LFF()
  assert.equal(overtimeLineAmount(0.5, ot), 50.51)    // Standby&Dismi 0.5 h ×2
  assert.equal(overtimeLineAmount(0.75, ot), 75.77)   // Fire Call 0.75 h ×2
})

test('single-time (ordinary) lines use the same base with multiplier 1', () => {
  const single = { ...LFF(), multiplier: '1' }
  assert.equal(overtimeLineAmount(1, single), 50.51)
  assert.equal(overtimeLineAmount(2.5, single), 126.28)
  assert.equal(overtimeLineAmount(1.25, single), 63.14)
  assert.equal(overtimeLineAmount(0.25, single), 12.63)
})

// ── Base Pay is not contaminated by separate allowances ────────────────────

test('a separately itemised allowance never enters the overtime base', () => {
  const ot = LFF()
  assert.equal(ot.components.basePayWeekly.value, '1999.6')
  assert.equal(ot.components.basePayWeekly.code, 'enterprise_base_pay_weekly')
  const codes = Object.values(ot.components).map((c) => c.code)
  assert.ok(!codes.includes('emr_allowance_example'))
})

// ── Fail closed ────────────────────────────────────────────────────────────

test('no classification → ok:false, no $ line', () => {
  const ot = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-06-13', classificationHistory: [] })
  assert.equal(ot.ok, false)
  assert.equal(ot.reason, 'no-classification')
  assert.equal(overtimeLineAmount(4, ot), null)
})

test('classification without a Base Pay version → ok:false', () => {
  const ot = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-06-13', classificationHistory: [{ classification: 'qff', effective_from: '2021-01-01' }] })
  assert.equal(ot.ok, false)
  assert.equal(ot.reason, 'rate-unavailable')
})

// ── Snapshot preserves version identity ────────────────────────────────────

test('snapshot freezes every applied version id and the rule id', () => {
  const s = overtimeSnapshot(LFF())
  assert.equal(s.rule_id, 'overtime.enterprise_rate.v1')
  assert.equal(s.classification, 'lff')
  assert.deepEqual(
    Object.values(s.components).map((c) => c.rate_version_id).sort(),
    ['base-lff', 'div36', 'factor', 'x2'],
  )
  assert.equal(s.components.divisor.source_kind, 'payroll_reconciled')
  assert.equal(s.components.factor.source_kind, 'industrial_instrument')
})

// ── Prototype rates object per date ────────────────────────────────────────

test('ratesForDate resolves km per claim date and carries the overtime rule', () => {
  const r2022 = buildRatesForDate(FIXTURE_CATALOG, FIXTURE_LFF_HISTORY, '2022-05-01')
  const r2026 = buildRatesForDate(FIXTURE_CATALOG, FIXTURE_LFF_HISTORY, '2026-06-13')
  assert.equal(r2022.kilometreRate, 1.37)
  assert.equal(r2026.kilometreRate, 1.5)
  assert.equal(r2026.overtime.ok, true)
  assert.equal(r2026.rateVersions.travel_per_km.rate_version_id, 'km-2023')
})

// ── WORK-170 SB/M&D stay hours-first ───────────────────────────────────────

test('SB/M&D overtime-allowance entitlements stay hours (no $ conversion)', () => {
  const ctx = {
    profileSnapshot: { id: 'p', rostered_station_id: null, rostered_station_name: null },
    rateLookup: (code) => (code === 'md_hours' ? { rate: { id: 'r' }, rateVersion: { id: 'v', version_label: 'x', effective_from: '2025-06-01' }, value: 1 }
      : code === 'standby_hours' ? { rate: { id: 'r' }, rateVersion: { id: 'v', version_label: 'x', effective_from: '2025-06-01' }, value: 0.5 } : null),
    matrixLookup: () => null,
  }
  const claim = { id: 'c', claim_date: '2026-06-13', claim_type: 'MD', owner_id: 'p' }
  for (const d of [...generateMusterDismissEntitlements(claim, {}, ctx), ...generateStandbyEntitlements({ ...claim, claim_type: 'SB' }, {}, ctx)]) {
    if (d.entitlement_type === 'muster_dismis' || d.entitlement_type === 'standby_dismi') {
      assert.equal(d.unit, 'hours')
      assert.equal(d.generated_amount, null)
    }
  }
})
