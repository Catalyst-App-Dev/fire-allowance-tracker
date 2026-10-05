/**
 * Versioned rate/rule model (WORK-172) — pure lookup + overtime arithmetic.
 * Overtime $ is a FAT best-fit ESTIMATE convention (WORK-246), not FRV payroll's formula.
 *
 * Run with: node --test __tests__/rate-model.test.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveRateVersion, resolveClassification, resolveOvertimeRate,
  overtimeLineAmount, overtimeSnapshot, roundHalfUp, mul, div, toFixedString,
  OVERTIME_ESTIMATE_CONVENTION, OVERTIME_EVIDENCE,
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

// Promotion boundary (WORK-246): uses the seeded classification Base Pay
// versions (LFF $1,999.60, SO $2,260.73). The 2026-09-01 date and the SO rank
// are TEST VALUES ONLY — the member's real promotion is recorded in /settings
// when known and is not invented here.
const PROMOTION = Object.freeze([
  { classification: 'lff', effective_from: '2021-01-01' },
  { classification: 'so',  effective_from: '2026-09-01' },
])

test('promotion: classification A before the effective date → rate A', () => {
  const ot = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-08-31', classificationHistory: PROMOTION })
  assert.equal(ot.classification, 'lff')
  assert.equal(ot.components.basePayWeekly.rate_version_id, 'base-lff')
  assert.equal(ot.baseHourly, '50.51')              // round(1999.60 × 0.9093 ÷ 36, 2)
  assert.equal(overtimeLineAmount(4, ot), 404.08)
})

test('promotion: classification B on the effective date (inclusive) → rate B', () => {
  const ot = resolveOvertimeRate(FIXTURE_CATALOG, { date: '2026-09-01', classificationHistory: PROMOTION })
  assert.equal(ot.classification, 'so')
  assert.equal(ot.components.basePayWeekly.rate_version_id, 'base-so')
  assert.equal(ot.baseHourlyExact, '57.102271916666')   // 2260.73 × 0.9093 ÷ 36
  assert.equal(ot.baseHourly, '57.10')
  assert.equal(overtimeLineAmount(4, ot), 456.80)
})

test('promotion: recording it does not change an earlier claim; a later claim uses rate B', () => {
  const earlier = '2026-06-13', later = '2026-10-05'
  const beforeRecorded = resolveOvertimeRate(FIXTURE_CATALOG, { date: earlier, classificationHistory: FIXTURE_LFF_HISTORY })
  const afterRecorded  = resolveOvertimeRate(FIXTURE_CATALOG, { date: earlier, classificationHistory: PROMOTION })
  assert.deepEqual(overtimeSnapshot(afterRecorded), overtimeSnapshot(beforeRecorded))
  assert.equal(overtimeLineAmount(4, afterRecorded), 404.08)
  const laterOt = resolveOvertimeRate(FIXTURE_CATALOG, { date: later, classificationHistory: PROMOTION })
  assert.equal(laterOt.classification, 'so')
  assert.equal(overtimeLineAmount(4, laterOt), 456.80)
})

test('promotion: the rate comes from the catalog, never a hard-coded LFF $50.51', () => {
  const rates = FIXTURE_CATALOG.versions.filter((v) => v.rate_id === 'r-base')
  const bumped = { ...FIXTURE_CATALOG, versions: FIXTURE_CATALOG.versions.map((v) =>
    v.id === 'base-lff' ? { ...v, value: 2049.59 } : v) }
  assert.ok(rates.length >= 3)
  const ot = resolveOvertimeRate(bumped, { date: '2026-06-13', classificationHistory: FIXTURE_LFF_HISTORY })
  assert.equal(ot.baseHourly, '51.77')              // round(2049.59 × 0.9093 ÷ 36, 2) = 51.7692… → 51.77
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

test('LFF rule: full-precision base retained alongside the FAT cents-rounded estimate base', () => {
  const ot = LFF()
  assert.equal(ot.ok, true)
  assert.equal(ot.baseHourlyExact, '50.506563333333')
  assert.equal(ot.baseHourly, '50.51')
  assert.equal(ot.hourly, '101.0200')
})

// ── Payslip reconciliation matrix (LFF, WORK-246) ──────────────────────────
// Every applicable Base-Pay-basis line on the 19 FRV payslips (Pay 51.2024 →
// 45.2025), see WORK-246 comment 31e2b7e9. Payslips are reconciliation
// evidence only. The FAT convention is an ESTIMATE: residuals are accepted
// and must not be fitted away.
const PAYSLIP_LINES = [
  // [pay, line, hours, multiplier, payslip $]
  ['51.2024', 'Fire Call',          0.75, 2, 75.77],
  ['51.2024', 'Clean Up',           0.25, 2, 25.26],
  ['51.2024', 'Excess Travel',      1.00, 1, 50.51],
  ['52.2024', 'Excess Travel',      1.00, 1, 50.51],
  ['52.2024', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['52.2024', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['21.2025', 'Excess Travel',      2.50, 1, 126.28],
  ['21.2025', 'Callback-Ops',      12.25, 2, 1237.53],
  ['25.2025', 'Excess Travel',      1.00, 1, 50.51],
  ['25.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['28.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['29.2025', 'Standby&Dismi',      0.50, 2, 50.51],
  ['29.2025', 'Excess Travel',      0.25, 1, 12.63],
  ['32.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['33.2025', 'Fire Call',          4.00, 2, 404.09],
  ['33.2025', 'Standby&Dismi',      0.50, 2, 50.51],
  ['33.2025', 'Standby&Dismi',      0.50, 2, 50.51],
  ['33.2025', 'Excess Travel',      0.25, 1, 12.63],
  ['33.2025', 'Excess Travel',      0.50, 1, 25.26],
  ['33.2025', 'Excess Travel',      1.25, 1, 63.14],
  ['39.2025', 'Excess Travel (re-issue 16/06)', 1.00, 1, 50.51],
  ['39.2025', 'Maint Stn N/N (re-issue 16/06)', 4.00, 2, 404.09],
  ['40.2025', 'Excess Travel',      1.25, 1, 63.14],
  ['40.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['41.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['42.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['43.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
  ['43.2025', 'Maint Stn N/N',      4.00, 2, 404.09],
]
// Known residuals under the approved convention (estimate − payslip), in cents.
const EXPECTED_RESIDUAL_CENTS = { 4: -1, 12.25: -3 }

const estimateFor = (hours, multiplier) =>
  overtimeLineAmount(hours, { ...LFF(), multiplier: String(multiplier) })

test('reconciliation matrix: every payslip line matches except the known residuals', () => {
  for (const [pay, line, h, m, payslip] of PAYSLIP_LINES) {
    const diffCents = Math.round((estimateFor(h, m) - payslip) * 100)
    const expected = m === 2 && h in EXPECTED_RESIDUAL_CENTS ? EXPECTED_RESIDUAL_CENTS[h] : 0
    assert.equal(diffCents, expected, `${pay} ${line} ${h} h ×${m}`)
  }
})

test('reconciliation matrix: 15/28 lines exact, net −$0.15 (accepted estimate error)', () => {
  const diffs = PAYSLIP_LINES.map(([, , h, m, p]) => Math.round((estimateFor(h, m) - p) * 100))
  assert.equal(diffs.length, 28)
  assert.equal(diffs.filter((d) => d === 0).length, 15)
  assert.equal(diffs.reduce((a, b) => a + b, 0), -15)
  assert.ok(diffs.every((d) => d <= 0 && d >= -3))
})

test('4 h double time estimates $404.08 — not the payslip $404.09 (no exact-payroll claim)', () => {
  const amt = overtimeLineAmount(4, LFF())
  assert.equal(amt, 404.08)
  assert.notEqual(amt, 404.09)
})

test('12.25 h double time estimates $1,237.50 — not the payslip $1,237.53', () => {
  const amt = overtimeLineAmount(12.25, LFF())
  assert.equal(amt, 1237.50)
  assert.notEqual(amt, 1237.53)
})

test('single-time (ordinary) lines use the same base with multiplier 1', () => {
  const single = { ...LFF(), multiplier: '1' }
  assert.equal(overtimeLineAmount(1, single), 50.51)
  assert.equal(overtimeLineAmount(2.5, single), 126.28)
  assert.equal(overtimeLineAmount(1.25, single), 63.14)
  assert.equal(overtimeLineAmount(0.5, single), 25.26)
  assert.equal(overtimeLineAmount(0.25, single), 12.63)
})

// ── Base Pay is not contaminated by separate allowances ────────────────────

test('a separately itemised allowance never enters the overtime base', () => {
  // Classification-keyed, effective allowance versions that would distort the
  // base if they were ever read: none of them may enter the rule.
  const ITEMISED = ['emr_allowance', 'cert_iv_allowance', 'academy_rcrs_instructor_allowance',
    'day_duty_allowance', 'meal_allowance', 'travel_per_km', 'retain_allowance', 'md_allowance',
    'excess_travel', 'reimbursement']
  const catalog = {
    rates: [...FIXTURE_CATALOG.rates, ...ITEMISED.map((code) => ({ id: `x-${code}`, code, unit: 'dollars' }))],
    versions: [...FIXTURE_CATALOG.versions, ...ITEMISED.map((code) => ({
      id: `xv-${code}`, rate_id: `x-${code}`, version_label: code, value: 999.99,
      effective_from: '2020-07-01', classification: 'lff', source_kind: 'fwc_order', source_ref: 'test', withdrawn_at: null }))],
  }
  const ot = resolveOvertimeRate(catalog, { date: '2026-06-13', classificationHistory: FIXTURE_LFF_HISTORY })
  assert.equal(ot.components.basePayWeekly.value, '1999.6')
  assert.equal(ot.components.basePayWeekly.code, 'enterprise_base_pay_weekly')
  assert.deepEqual(Object.values(ot.components).map((c) => c.code).sort(),
    ['double_time_multiplier', 'enterprise_base_pay_weekly', 'overtime_hourly_divisor', 'overtime_rate_factor'])
  for (const code of [...ITEMISED, 'emr_allowance_example']) {
    assert.ok(!Object.values(ot.components).some((c) => c.code === code), code)
  }
  assert.equal(overtimeLineAmount(4, ot), 404.08)
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

test('snapshot distinguishes instrument, payroll-reconciled and FAT-convention parts', () => {
  const s = overtimeSnapshot(LFF())
  assert.equal(s.is_estimate, true)
  assert.equal(s.estimate_convention.id, 'fat.overtime_estimate.cents_base.v1')
  assert.equal(s.estimate_convention.kind, 'fat_estimate_convention')
  assert.match(s.estimate_convention.decision_ref, /WORK-246/)
  assert.equal(s.formula, OVERTIME_ESTIMATE_CONVENTION.formula)
  assert.deepEqual({ ...s.evidence, versions: undefined }, { ...OVERTIME_EVIDENCE, versions: undefined })
  assert.equal(s.evidence.factor, 'industrial_instrument')
  assert.equal(s.evidence.multiplier, 'industrial_instrument')
  assert.equal(s.evidence.divisor, 'payroll_reconciled_approximation')
  assert.equal(s.evidence.base_cents_rounding, 'fat_estimate_convention')
  assert.deepEqual(s.evidence.versions, {
    basePayWeekly: 'fwc_order', factor: 'industrial_instrument', divisor: 'payroll_reconciled', multiplier: 'industrial_instrument',
  })
})

test('no provenance text claims the cents base is FRV payroll behaviour', () => {
  const text = JSON.stringify(overtimeSnapshot(LFF())).toLowerCase()
  assert.ok(!/payroll (uses|publishes|rounds)|published.rate/.test(text))
  assert.match(OVERTIME_ESTIMATE_CONVENTION.note, /not FRV payroll/)
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
