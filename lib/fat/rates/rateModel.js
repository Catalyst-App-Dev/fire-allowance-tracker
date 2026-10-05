// ─── Versioned rate/rule model — pure lookup + overtime arithmetic (WORK-172) ─
// Portable core: no Supabase, no React, no I/O. The same functions serve the
// prototype engine (via RatesContext), the canonical engine context and tests,
// and carry unchanged into the Neon backend (GOV-481).
//
// Catalog shape (rows exactly as read from fat.rates / fat.rate_versions):
//   { rates: [{ id, code, unit, ... }],
//     versions: [{ id, rate_id, version_label, value, effective_from,
//                  classification, source_kind, source_ref, withdrawn_at }] }
//
// Lookup semantics (docs/architecture/RATE_RULE_MODEL.md):
//   * effective_from is inclusive; a version applies until the next
//     effective_from for the same (rate, classification). No effective_to.
//   * Withdrawn versions are never selected (they stay as history).
//   * An exact classification match is preferred, else a NULL-classification
//     version. Nothing applicable → null (callers fail closed).
//
// Overtime ESTIMATE — FAT best-fit estimate convention (operator-approved,
// Linear WORK-246 comment f8ce703b; supersedes the WORK-172 wording):
//   base     = round_half_up(BasePayWeekly[classification, claim date] × 0.9093 ÷ 36, 2)
//   estimate = round_half_up(hours × base × multiplier, 2)
// Evidence classes (kept distinct, and frozen into every snapshot):
//   * 0.9093 factor, ×multiplier ...... industrial instrument (FRV EBA 2020)
//   * weekly Base Pay per classification FWC order (PR765587 Annexure A)
//   * ÷36 ............................. payroll-reconciled approximation (the
//                                        EBA does not state a divisor)
//   * cents-rounding of the hourly base FAT estimate convention, chosen because
//                                        it best fits the available payslips.
// This is NOT FRV payroll's formula: payslips imply payroll holds an hourly
// rate of ≈ $50.5112–50.5116 (LFF) to ≥4 dp and rounds once per line, so the
// estimate under-reads by a few cents (LFF 4 h: $404.08 vs $404.09; 12.25 h:
// $1,237.50 vs $1,237.53). Those residuals are accepted estimate error and are
// deliberately not fitted away (WORK-246 comments 31e2b7e9 / f8ce703b).
// Arithmetic is exact (BigInt rationals) — no binary floating point — so the
// only rounding is at those two documented boundaries.
// ─────────────────────────────────────────────────────────────────────────────

export const RATE_CODES = Object.freeze({
  BASE_PAY_WEEKLY:   'enterprise_base_pay_weekly',
  OVERTIME_FACTOR:   'overtime_rate_factor',
  HOURLY_DIVISOR:    'overtime_hourly_divisor',
  DOUBLE_TIME:       'double_time_multiplier',
  SINGLE_TIME:       'single_time_multiplier',    // EBA 2020 "ordinary rates" (cl 128.4, 85.8) — WORK-173
  TIME_AND_HALF:     'time_and_half_multiplier',  // EBA 2020 cl 128.4 recall travel on Sundays / public holidays — WORK-173
  TRAVEL_PER_KM:     'travel_per_km',
  SMALL_MEAL:        'small_meal',
  LARGE_MEAL:        'large_meal',
  MEAL_ALLOWANCE:    'meal_allowance',
  SPOILT_MEAL:       'spoilt_meal_allowance',
  RELIEVING:         'relieving_allowance',       // EBA 2020 cl 85.8.10 (per shift) — WORK-173
})

export const OVERTIME_RULE_ID = 'overtime.enterprise_rate.v1'

/**
 * The approved FAT estimate convention for turning the industrial overtime
 * rule into dollars. Recorded on every result and snapshot so a stored estimate
 * says truthfully what it is (an estimate under a FAT convention) and never
 * implies FRV payroll's internal method.
 */
export const OVERTIME_ESTIMATE_CONVENTION = Object.freeze({
  id:           'fat.overtime_estimate.cents_base.v1',
  kind:         'fat_estimate_convention',
  decision_ref: 'Linear WORK-246 comment f8ce703b (operator Option A, 2026-10-05)',
  formula:      'round_half_up(hours × round_half_up(base_pay_weekly × factor ÷ divisor, 2) × multiplier, 2)',
  note:         'Best fit to available FRV payslips; not FRV payroll\'s published or internal formula. Residual estimate error vs payslips is accepted.',
})

/** Evidence class of each part of the overtime estimate. */
export const OVERTIME_EVIDENCE = Object.freeze({
  factor:              'industrial_instrument',
  multiplier:          'industrial_instrument',
  base_pay_weekly:     'fwc_order',
  divisor:             'payroll_reconciled_approximation',
  base_cents_rounding: 'fat_estimate_convention',
})

/** FRV Division A classifications (fat.frv_classification). */
export const CLASSIFICATIONS = Object.freeze([
  { code: 'recruit',           label: 'Recruit' },
  { code: 'ff1',               label: 'Firefighter Level 1' },
  { code: 'ff2',               label: 'Firefighter Level 2' },
  { code: 'ff3',               label: 'Firefighter Level 3' },
  { code: 'qff',               label: 'Qualified Firefighter' },
  { code: 'sff',               label: 'Senior Firefighter' },
  { code: 'lff',               label: 'Leading Firefighter' },
  { code: 'slff',              label: 'Senior Leading Firefighter' },
  { code: 'so',                label: 'Station Officer' },
  { code: 'sso',               label: 'Senior Station Officer' },
  { code: 'cmdr_commencement', label: 'Commander (commencement)' },
  { code: 'cmdr_12m',          label: 'Commander (after 12 months)' },
  { code: 'cmdr_24m',          label: 'Commander (after 24 months / L4)' },
  { code: 'fscc',              label: 'FSCC' },
  { code: 'sfscc',             label: 'Senior FSCC' },
])

// ─── Exact decimal arithmetic (rationals over BigInt) ────────────────────────

function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b] } return a }
function norm(n, d) { if (d < 0n) { n = -n; d = -d } const g = gcd(n, d) || 1n; return { n: n / g, d: d / g } }

/** Parse a decimal (string or number) into an exact rational. */
export function dec(v) {
  if (v && typeof v === 'object' && 'n' in v) return v
  const s = String(v).trim()
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s)
  if (!m) throw new Error(`rateModel: not a decimal: ${s}`)
  const frac = m[3] || ''
  const n = BigInt(m[2] + frac) * (m[1] ? -1n : 1n)
  return norm(n, 10n ** BigInt(frac.length))
}
export const mul = (a, b) => { a = dec(a); b = dec(b); return norm(a.n * b.n, a.d * b.d) }
export const div = (a, b) => { a = dec(a); b = dec(b); if (b.n === 0n) throw new Error('rateModel: divide by zero'); return norm(a.n * b.d, a.d * b.n) }

/** Round half-up (away from zero) to `dp` decimal places; returns a string. */
export function roundHalfUp(x, dp = 2) {
  x = dec(x)
  const scale = 10n ** BigInt(dp)
  const neg = x.n < 0n
  const n = neg ? -x.n : x.n
  let q = (n * scale) / x.d
  const r = (n * scale) % x.d
  if (r * 2n >= x.d) q += 1n
  const s = q.toString().padStart(dp + 1, '0')
  const out = dp ? `${s.slice(0, -dp)}.${s.slice(-dp)}` : s
  return neg && q !== 0n ? `-${out}` : out
}

/** Exact rational → decimal string with up to `dp` places (truncated, for display/snapshot). */
export function toFixedString(x, dp = 12) {
  x = dec(x)
  const scale = 10n ** BigInt(dp)
  const neg = x.n < 0n
  const q = ((neg ? -x.n : x.n) * scale) / x.d
  const s = q.toString().padStart(dp + 1, '0')
  const out = `${s.slice(0, -dp)}.${s.slice(-dp)}`.replace(/\.?0+$/, '')
  return neg ? `-${out}` : out
}

// ─── Lookup ──────────────────────────────────────────────────────────────────

const iso = (d) => String(d).slice(0, 10)

/**
 * Resolve the applicable version of `code` on `date` for `classification`.
 * @returns {{ rate, version, value: string } | null}
 */
export function resolveRateVersion(catalog, code, date, classification = null) {
  if (!catalog || !date) return null
  const rate = (catalog.rates || []).find((r) => r.code === code)
  if (!rate) return null
  const day = iso(date)
  const live = (catalog.versions || []).filter((v) =>
    v.rate_id === rate.id && !v.withdrawn_at && iso(v.effective_from) <= day)
  const pick = (cls) => live
    .filter((v) => (v.classification ?? null) === cls)
    .sort((a, b) => (iso(a.effective_from) < iso(b.effective_from) ? 1 : -1))[0]
  const version = (classification ? pick(classification) : null) || pick(null)
  if (!version) return null
  return { rate, version, value: String(version.value) }
}

/** Classification in force on `date` from a member's history (latest effective_from ≤ date). */
export function resolveClassification(history, date) {
  if (!date) return null
  const day = iso(date)
  const row = (history || [])
    .filter((h) => iso(h.effective_from) <= day)
    .sort((a, b) => (iso(a.effective_from) < iso(b.effective_from) ? 1 : -1))[0]
  return row ? row.classification : null
}

const versionRef = (r) => ({
  rate_version_id: r.version.id,
  code:            r.rate.code,
  value:           r.value,
  version_label:   r.version.version_label,
  effective_from:  iso(r.version.effective_from),
  classification:  r.version.classification ?? null,
  source_kind:     r.version.source_kind ?? null,
})

/**
 * Overtime rate for a member on a date. Fails closed (ok:false + reason) when
 * the classification or any rule component is not resolvable.
 *
 * Only the classification's enterprise Base Pay enters the calculation —
 * separately itemised allowances are different rate codes and never read here.
 */
export function resolveOvertimeRate(catalog, { date, classificationHistory, multiplierCode = RATE_CODES.DOUBLE_TIME }) {
  const classification = resolveClassification(classificationHistory, date)
  if (!classification) {
    return { ok: false, reason: 'no-classification', message: 'No FRV classification recorded for this date — set it in Settings.' }
  }
  const base    = resolveRateVersion(catalog, RATE_CODES.BASE_PAY_WEEKLY, date, classification)
  const factor  = resolveRateVersion(catalog, RATE_CODES.OVERTIME_FACTOR, date)
  const divisor = resolveRateVersion(catalog, RATE_CODES.HOURLY_DIVISOR, date)
  const mult    = resolveRateVersion(catalog, multiplierCode, date)
  const missing = [['base pay', base], ['overtime factor', factor], ['hourly divisor', divisor], ['multiplier', mult]]
    .filter(([, r]) => !r).map(([n]) => n)
  if (missing.length) {
    return { ok: false, reason: 'rate-unavailable', classification, message: `No applicable ${missing.join(', ')} for ${classification} on ${iso(date)}.` }
  }

  const baseExact  = div(mul(base.value, factor.value), divisor.value)   // single-time hourly, exact
  const baseCents  = roundHalfUp(baseExact, 2)                            // FAT estimate convention (not FRV payroll's rule)
  const hourly     = mul(baseCents, mult.value)                           // e.g. ×2, exact
  return {
    ok: true,
    ruleId: OVERTIME_RULE_ID,
    convention: OVERTIME_ESTIMATE_CONVENTION.id,
    classification,
    baseHourlyExact: toFixedString(baseExact, 12),
    baseHourly:      baseCents,
    multiplier:      mult.value,
    hourly:          roundHalfUp(hourly, 4),
    hourlyNumber:    Number(roundHalfUp(hourly, 4)),
    components: {
      basePayWeekly: versionRef(base),
      factor:        versionRef(factor),
      divisor:       versionRef(divisor),
      multiplier:    versionRef(mult),
    },
  }
}

/**
 * Estimated line amount under the FAT convention:
 * round_half_up(hours × base × multiplier, 2). An estimate, not the payslip
 * figure. Returns a Number.
 */
export function overtimeLineAmount(hours, overtime) {
  if (!overtime?.ok) return null
  return Number(roundHalfUp(mul(mul(String(hours), overtime.baseHourly), overtime.multiplier), 2))
}

/** Frozen snapshot for an entitlement / prototype row (rule + every applied version). */
export function overtimeSnapshot(overtime) {
  if (!overtime?.ok) return { ok: false, reason: overtime?.reason ?? 'unavailable' }
  return {
    rule_id:           overtime.ruleId,
    is_estimate:       true,
    estimate_convention: { ...OVERTIME_ESTIMATE_CONVENTION },
    classification:    overtime.classification,
    base_hourly_exact: overtime.baseHourlyExact,
    base_hourly:       overtime.baseHourly,
    multiplier:        overtime.multiplier,
    hourly:            overtime.hourly,
    formula:           OVERTIME_ESTIMATE_CONVENTION.formula,
    evidence: {
      ...OVERTIME_EVIDENCE,
      // as recorded on the applied versions (authoritative for this snapshot)
      versions: Object.fromEntries(Object.entries(overtime.components).map(([k, c]) => [k, c.source_kind])),
    },
    components:        overtime.components,
  }
}

/** Plain (non-classified) rate value on a date as a Number, or null. */
export function resolveRateNumber(catalog, code, date) {
  const r = resolveRateVersion(catalog, code, date)
  return r ? Number(r.value) : null
}
