// ─── Shared helpers for the Recall / Retain / Spoilt / Delayed generators ────
// WORK-173. Rule authority: Linear WORK-173 document "Recall, Retain, Spoilt
// Meal and Delayed Meal rule specification (v0.2, approved)" and
// docs/architecture/CANONICAL_ENTITLEMENT_RULES.md.
//
// Pure: no I/O, no Date.now(). Times arrive as ISO timestamptz strings.
//
//   * Quarter-hour rounding is NEAREST, half-up (FRV EBA 2020 cl 128.1:
//     overtime "calculated to the nearest quarter hour"). Never ceiling.
//   * Clock comparisons (85.6.3's 10:00 / 20:00) use Australia/Melbourne
//     local time of the stored instant; durations use absolute time.
//   * Overtime-derived rows are HOURS-FIRST: generated_amount stays NULL and
//     the dollar figure is only an estimate inside rate_snapshot, under the
//     WORK-246 FAT estimate convention (ctx.overtimeLookup). ok:false → hours
//     only, estimate null.
//   * Allowance rows are DOLLARS: the exact versioned industrial amount.
//   * A rule that cannot be decided from the facts emits NO row (never a $0
//     row) and reports why through the optional ctx.onSkip callback.

import { overtimeSnapshot, overtimeLineAmount, roundHalfUp, mul, OVERTIME_RULE_ID } from '../../rates/rateModel.js'

export const MS_MINUTE = 60 * 1000
export const MS_HOUR = 60 * MS_MINUTE
const MS_QUARTER = 15 * MS_MINUTE

/** Milliseconds from start to end, or null when either is missing/invalid or end ≤ start. */
export function spanMs(startIso, endIso) {
  if (!startIso || !endIso) return null
  const a = Date.parse(startIso)
  const b = Date.parse(endIso)
  if (Number.isNaN(a) || Number.isNaN(b) || b <= a) return null
  return b - a
}

/** Nearest quarter hour, half-up (cl 128.1). 7 min → 0, 7.5 min → 0.25, 12 h 10 m → 12.25. */
export function nearestQuarterHours(ms) {
  if (ms == null || !(ms >= 0)) return null
  return Math.floor(ms / MS_QUARTER + 0.5) * 0.25
}

/** Minutes (number ≥ 0) → nearest-quarter hours, or null. */
export function minutesToQuarterHours(minutes) {
  if (minutes == null || minutes === '') return null
  const m = Number(minutes)
  if (!Number.isFinite(m) || m < 0) return null
  return nearestQuarterHours(Math.round(m * MS_MINUTE))
}

const MELBOURNE = new Intl.DateTimeFormat('en-AU', {
  timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
})

/** Seconds since local midnight in Australia/Melbourne for an ISO instant, or null. */
export function melbourneSecondOfDay(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  const parts = Object.fromEntries(MELBOURNE.formatToParts(new Date(t)).map((p) => [p.type, p.value]))
  const h = Number(parts.hour) % 24
  return h * 3600 + Number(parts.minute) * 60 + Number(parts.second)
}

/** Report a rule that produced no row (never throws; optional ctx.onSkip). */
export function skip(ctx, entitlementType, reason, detail) {
  if (typeof ctx?.onSkip === 'function') ctx.onSkip({ entitlement_type: entitlementType, reason, detail: detail ?? null })
}

const baseDraft = () => ({
  edited_amount:  null,
  edited_hours:   null,
  edited_note:    null,
  manual_override: false,
})

/**
 * Hours-first overtime-derived draft. The estimate (WORK-246 convention) is
 * frozen in rate_snapshot only; generated_amount stays NULL.
 */
export function overtimeHoursDraft({
  ctx, claimDate, entitlementType, hours, multiplierCode, ruleId, explanation, formula, facts, paymentMethod = 'payslip',
}) {
  const ot = typeof ctx?.overtimeLookup === 'function'
    ? ctx.overtimeLookup(claimDate, multiplierCode)
    : { ok: false, reason: 'no-overtime-lookup' }
  const snapshot = ot?.ok
    ? { ...overtimeSnapshot(ot), multiplier_code: multiplierCode, hours, estimate: overtimeLineAmount(hours, ot), facts: facts ?? null }
    : { ok: false, rule_id: OVERTIME_RULE_ID, reason: ot?.reason ?? 'unavailable', multiplier_code: multiplierCode, hours, estimate: null, facts: facts ?? null }
  return {
    entitlement_type:    entitlementType,
    unit:                'hours',
    generated_amount:    null,
    generated_hours:     hours,
    ...baseDraft(),
    rule_id:             ruleId,
    rule_version:        'v1',
    rule_explanation:    explanation,
    formula_explanation: formula,
    rate_id:             null,
    rate_version_id:     ot?.ok ? ot.components.basePayWeekly.rate_version_id : null,
    rate_snapshot:       snapshot,
    payment_method:      paymentMethod,
    payment_status:      paymentMethod === 'petty_cash' ? 'outstanding' : 'pending',
  }
}

/**
 * Dollars allowance draft: amount = round_half_up(rate × quantity, 2) from the
 * versioned industrial rate. Returns null when no version applies on the date
 * (fail closed).
 */
export function allowanceDraft({
  ctx, claimDate, entitlementType, code, quantity = 1, ruleId, explanation, formula, facts, paymentMethod,
}) {
  const hit = ctx?.rateLookup?.(code, claimDate)
  if (!hit) return null
  const value = String(hit.rateVersion?.value ?? hit.value)
  const amount = Number(roundHalfUp(mul(value, String(quantity)), 2))
  return {
    entitlement_type:    entitlementType,
    unit:                'dollars',
    generated_amount:    amount,
    generated_hours:     null,
    ...baseDraft(),
    rule_id:             ruleId,
    rule_version:        'v1',
    rule_explanation:    explanation,
    formula_explanation: formula,
    rate_id:             hit.rate?.id ?? null,
    rate_version_id:     hit.rateVersion?.id ?? null,
    rate_snapshot: {
      code,
      rate_version_id: hit.rateVersion?.id ?? null,
      value,
      version_label:   hit.rateVersion?.version_label ?? null,
      effective_from:  hit.rateVersion?.effective_from ? String(hit.rateVersion.effective_from).slice(0, 10) : null,
      source_kind:     hit.rateVersion?.source_kind ?? null,
      source_ref:      hit.rateVersion?.source_ref ?? null,
      quantity,
      amount,
      facts:           facts ?? null,
    },
    payment_method:      paymentMethod,
    payment_status:      paymentMethod === 'petty_cash' ? 'outstanding' : 'pending',
  }
}

/** n one-per-allowance meal drafts (each a discrete industrial allowance). */
export function mealDrafts({ ctx, claimDate, entitlementType, code, count, ruleId, clause, facts }) {
  const out = []
  for (let i = 1; i <= count; i++) {
    const d = allowanceDraft({
      ctx, claimDate, entitlementType, code, ruleId,
      explanation: `${clause} — meal allowance ${i} of ${count} (Schedule 4 / versioned ${code}).`,
      formula: `amount = ${code}[claim_date]`,
      facts: { ...facts, ordinal: i, of: count },
      paymentMethod: 'petty_cash',
    })
    if (!d) { skip(ctx, entitlementType, 'rate-unavailable', `${code} on ${claimDate}`); return [] }
    out.push(d)
  }
  return out
}
