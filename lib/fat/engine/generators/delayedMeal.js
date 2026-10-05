// ─── Delayed Meal (DM) Entitlement Generator ─────────────────────────────────
// Pure function. Rule authority: WORK-173 rule spec v0.2 (operator-approved,
// PROMPT #15) § 5. Source: FRV EBA 2020 Division A
//   85.6.6 — normal meal break delayed MORE THAN 30 minutes, without 2 hours'
//            prior notice, other than for the 85.6.7 reason → a meal allowance;
//   85.6.7 — fire call / salvage / watching duty of 3 HOURS OR MORE that
//            includes a normal meal break → a meal allowance;
//   85.6.8 — the amount is the Schedule 4 Meal Allowance (versioned meal_allowance).
// Separate semantic type from Spoilt (D9b): different clause, trigger and rate.
// meal_window_start_at / meal_window_end_at are the member's normal meal break
// as recorded on the claim (cl 127.2: regular times) — no fixed clock window.

import { spanMs, allowanceDraft, skip, MS_MINUTE, MS_HOUR } from './shared.js'
import { RATE_CODES } from '../../rates/rateModel.js'

/** @typedef {import('../types.js').EntitlementDraft}   EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}      EngineContext */
/** @typedef {import('../types.js').DelayedMealDetails} DelayedMealDetails */
/** @typedef {import('../types.js').OperationalClaim}   OperationalClaim */

const FIRE_DUTY = new Set(['fire_call', 'salvage', 'watching'])

/** Which basis applies: { basis: '85.6.6' | '85.6.7' } | { none } | { missing }. Exported for tests. */
export function delayedMealBasis(d) {
  if (!d?.delay_cause) return { missing: 'delay_cause is required' }
  if (d.delay_cause === 'other') {
    if (!d.meal_window_start_at || !d.actual_meal_at || typeof d.delay_notice_2h !== 'boolean') {
      return { missing: 'normal break start, actual meal time and the 2 h notice fact are required' }
    }
    const a = Date.parse(d.meal_window_start_at)
    const b = Date.parse(d.actual_meal_at)
    if (Number.isNaN(a) || Number.isNaN(b)) return { missing: 'invalid times' }
    const delay = b - a
    if (delay > 30 * MS_MINUTE && d.delay_notice_2h === false) return { basis: '85.6.6', delayMinutes: delay / MS_MINUTE }
    return { none: delay <= 30 * MS_MINUTE ? 'delay not more than 30 minutes' : '2 hours prior notice given' }
  }
  if (FIRE_DUTY.has(d.delay_cause)) {
    const dur = spanMs(d.duty_start_at, d.duty_end_at)
    if (dur == null || !d.meal_window_start_at || !d.meal_window_end_at) {
      return { missing: 'duty start/end and the normal meal break window are required' }
    }
    const ws = Date.parse(d.meal_window_start_at)
    const we = Date.parse(d.meal_window_end_at)
    const overlaps = Date.parse(d.duty_start_at) < we && Date.parse(d.duty_end_at) > ws
    if (dur >= 3 * MS_HOUR && overlaps) return { basis: '85.6.7', dutyHours: dur / MS_HOUR }
    // 85.6.6 excludes the 85.6.7 reason, so a shorter fire-duty delay earns nothing.
    return { none: dur < 3 * MS_HOUR ? 'fire call / salvage / watching duty under 3 hours' : 'duty did not include the normal meal break' }
  }
  return { missing: `unknown delay_cause '${d.delay_cause}'` }
}

/**
 * @param {OperationalClaim}   claim
 * @param {DelayedMealDetails} details
 * @param {EngineContext}      ctx
 * @returns {EntitlementDraft[]}
 */
export function generateDelayedMealEntitlements(claim, details, ctx) {
  const d = details || {}
  const r = delayedMealBasis(d)
  if (r.missing) { skip(ctx, 'delayed_meal', 'missing-facts', r.missing); return [] }
  if (r.none) return []

  const is666 = r.basis === '85.6.6'
  const draft = allowanceDraft({
    ctx, claimDate: claim?.claim_date, entitlementType: 'delayed_meal', code: RATE_CODES.MEAL_ALLOWANCE,
    ruleId: is666 ? 'meal.delayed.v1' : 'meal.fire_call_3h.v1',
    explanation: is666
      ? `Normal meal break delayed ${r.delayMinutes} min (more than 30) without 2 hours' prior notice — Meal Allowance (EBA 2020 cl 85.6.6; Schedule 4).`
      : `${d.delay_cause.replace('_', ' ')} duty of ${r.dutyHours} h (3 h or more) including the normal meal break — Meal Allowance (EBA 2020 cl 85.6.7; Schedule 4).`,
    formula: 'amount = meal_allowance[claim_date]',
    facts: {
      basis: r.basis,
      delay_cause: d.delay_cause,
      meal_window_start_at: d.meal_window_start_at ?? null,
      meal_window_end_at: d.meal_window_end_at ?? null,
      actual_meal_at: d.actual_meal_at ?? null,
      delay_notice_2h: d.delay_notice_2h ?? null,
      duty_start_at: d.duty_start_at ?? null,
      duty_end_at: d.duty_end_at ?? null,
    },
    paymentMethod: 'petty_cash',
  })
  if (!draft) {
    skip(ctx, 'delayed_meal', 'rate-unavailable', `meal_allowance on ${claim?.claim_date}`)
    return []
  }
  return [draft]
}
