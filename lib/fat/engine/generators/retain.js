// ─── Retain (RT) Entitlement Generator ───────────────────────────────────────
// Pure function. Rule authority: WORK-173 rule spec v0.2 (operator-approved,
// PROMPT #15) § 3 and docs/architecture/CANONICAL_ENTITLEMENT_RULES.md.
// Source: FRV EBA 2020 Division A cl 128.1, 128.5, 128.7, 85.6.4, 85.8.9.
//
// retain_start_at = conclusion of the rostered shift; retain_end_at = release.
// Emits, when its facts are present:
//   1. retain_overtime     hours  D ≥ 60 min → max(4.0, q(D)) at double time (128.5)
//                                 0 < D < 60 min → q(D) at double time (ordinary 128.1 overtime)
//   2. retain_travel_home  hours  night shift interrupted by a fire call / incident /
//                                 fire duty → q(travel minutes) at ordinary rate (85.8.9)
//   3. retain_meal × n     dollars 128.5 retention only: 1, +1 once D > 2 h, +1 at the end
//                                 of each further 2 h (85.6.4)
// Notice is irrelevant (128.7). Hours-first: no hard-coded rate; the $ figure
// is a WORK-246 estimate inside rate_snapshot only.

import {
  spanMs, nearestQuarterHours, minutesToQuarterHours,
  overtimeHoursDraft, mealDrafts, skip, MS_HOUR,
} from './shared.js'
import { RATE_CODES } from '../../rates/rateModel.js'

/** @typedef {import('../types.js').EntitlementDraft} EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}    EngineContext */
/** @typedef {import('../types.js').RetainDetails}    RetainDetails */
/** @typedef {import('../types.js').OperationalClaim} OperationalClaim */

/** 85.6.4 meal count for a 128.5 retention of `ms` (0 when not a 128.5 retention). Exported for tests. */
export function retainMealCount(ms) {
  if (ms == null || ms < MS_HOUR) return 0
  const over = ms - 2 * MS_HOUR
  return over > 0 ? 2 + Math.floor(over / (2 * MS_HOUR)) : 1
}

/**
 * @param {OperationalClaim} claim
 * @param {RetainDetails}    details
 * @param {EngineContext}    ctx
 * @returns {EntitlementDraft[]}
 */
export function generateRetainEntitlements(claim, details, ctx) {
  const drafts = []
  const date = claim?.claim_date
  const d = details || {}
  const ms = spanMs(d.retain_start_at, d.retain_end_at)
  const facts = { retain_start_at: d.retain_start_at, retain_end_at: d.retain_end_at }

  // 1. Retain overtime.
  if (ms == null) {
    skip(ctx, 'retain_overtime', 'missing-or-invalid-times')
  } else {
    const actual = nearestQuarterHours(ms)
    if (ms >= MS_HOUR) {
      const hours = Math.max(4, actual)
      drafts.push(overtimeHoursDraft({
        ctx, claimDate: date, entitlementType: 'retain_overtime', hours,
        multiplierCode: RATE_CODES.DOUBLE_TIME, ruleId: 'retain.overtime.v1',
        explanation: `Retained ${actual} h after the rostered shift (60 min or more) — minimum 4 h at double time (EBA 2020 cl 128.5), nearest quarter hour (cl 128.1); notice irrelevant (cl 128.7).`,
        formula: 'hours = max(4.0, nearest_quarter_hour(retain_end_at − retain_start_at)); estimate per WORK-246 at ×2',
        facts: { ...facts, actual_hours: actual },
      }))
    } else if (actual === 0) {
      skip(ctx, 'retain_overtime', 'rounds-to-zero')
    } else {
      drafts.push(overtimeHoursDraft({
        ctx, claimDate: date, entitlementType: 'retain_overtime', hours: actual,
        multiplierCode: RATE_CODES.DOUBLE_TIME, ruleId: 'retain.overtime_short.v1',
        explanation: `Worked ${actual} h after the rostered shift (under 60 min, so not a cl 128.5 retention) — overtime at double time to the nearest quarter hour (EBA 2020 cl 128.1).`,
        formula: 'hours = nearest_quarter_hour(retain_end_at − retain_start_at); estimate per WORK-246 at ×2',
        facts: { ...facts, actual_hours: actual },
      }))
    }
  }

  // 2. Travel home after a night-shift retention that followed a fire call / incident / fire duty (85.8.9).
  if (d.retain_shift == null || typeof d.night_shift_interrupted !== 'boolean') {
    if (d.retain_shift !== 'day') skip(ctx, 'retain_travel_home', 'missing-shift-or-interruption-fact')
  } else if (d.retain_shift === 'night' && d.night_shift_interrupted === true && ms != null) {
    const hours = minutesToQuarterHours(d.retain_travel_home_minutes)
    if (hours == null) {
      skip(ctx, 'retain_travel_home', 'missing-travel-minutes')
    } else if (hours === 0) {
      skip(ctx, 'retain_travel_home', 'rounds-to-zero')
    } else {
      drafts.push(overtimeHoursDraft({
        ctx, claimDate: date, entitlementType: 'retain_travel_home', hours,
        multiplierCode: RATE_CODES.SINGLE_TIME, ruleId: 'retain.travel_home.v1',
        explanation: 'Travel allowance: reasonable travelling time to residence after retention following a night shift interrupted by a fire call, incident or fire duty (EBA 2020 cl 85.8.9), at ordinary rate.',
        formula: 'hours = nearest_quarter_hour(retain_travel_home_minutes); estimate per WORK-246 at ×1',
        facts: { retain_shift: d.retain_shift, night_shift_interrupted: true, retain_travel_home_minutes: Number(d.retain_travel_home_minutes) },
      }))
    }
  }

  // 3. Retain meals (85.6.4) — only for a 128.5 retention.
  const count = retainMealCount(ms)
  if (ms == null) {
    skip(ctx, 'retain_meal', 'missing-or-invalid-times')
  } else if (count > 0) {
    drafts.push(...mealDrafts({
      ctx, claimDate: date, entitlementType: 'retain_meal', code: RATE_CODES.MEAL_ALLOWANCE,
      count, ruleId: 'meal.retain.v1',
      clause: 'EBA 2020 cl 85.6.4: retained within cl 128.5 (one, a further one once over 2 h, then one at the end of each additional 2 h)',
      facts: { ...facts, retention_hours: ms / MS_HOUR },
    }))
  }

  return drafts
}
