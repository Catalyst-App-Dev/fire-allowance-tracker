// ─── Recall (RC) Entitlement Generator ───────────────────────────────────────
// Pure function. Rule authority: WORK-173 rule spec v0.2 (operator-approved,
// PROMPT #15) § 2 and docs/architecture/CANONICAL_ENTITLEMENT_RULES.md.
// Source: FRV EBA 2020 Division A cl 128.1, 128.2, 128.4, 128.7, 85.6.3,
// 85.8.10; Schedule 4 / FWC PR765587 for allowance values.
//
// Emits, when its facts are present:
//   1. recall_overtime      hours  max(4.0, q(end − start)) at double time (cl 128.2, 128.1)
//   2. recall_travel_time   hours  q(actual home → recall location → home minutes),
//                                  ordinary rate; time and a half on Sundays /
//                                  public holidays (cl 128.4). EVERY recall — no
//                                  further-from-home gate, and NOT the SB/M&D
//                                  radius-band rule (cl 85.8.1/85.8.4 are not copied).
//   3. recall_mileage       dollars actual round-trip km × travel_per_km (cl 128.4)
//   4. relieving_allowance  dollars once per recall shift when the recall work
//                                  location differs from the rostered station (cl 85.8.10)
//   5. recall_meal × n      dollars 85.6.3 (explicit day/night duty fact)
// There is no separate recall "Excess Travel" entitlement: recall travel is
// fully recall_travel_time + recall_mileage (D9d).

import {
  spanMs, nearestQuarterHours, minutesToQuarterHours, melbourneSecondOfDay,
  overtimeHoursDraft, allowanceDraft, mealDrafts, skip, MS_HOUR,
} from './shared.js'
import { RATE_CODES } from '../../rates/rateModel.js'

/** @typedef {import('../types.js').EntitlementDraft} EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}    EngineContext */
/** @typedef {import('../types.js').RecallDetails}    RecallDetails */
/** @typedef {import('../types.js').OperationalClaim} OperationalClaim */

const TEN_AM = 10 * 3600
const EIGHT_PM = 20 * 3600
const NOON = 12 * 3600

/**
 * Number of 85.6.3 meal allowances, or { ambiguous } when the clause does not
 * decide the case. Exported for tests.
 */
export function recallMealCount({ duty, startAt, durationMs }) {
  if (duty !== 'day' && duty !== 'night') return { ambiguous: 'recall_duty is required (day | night)' }
  const t = melbourneSecondOfDay(startAt)
  if (t == null || durationMs == null) return { ambiguous: 'start and end times are required' }
  if (duty === 'day') {
    if (t < TEN_AM) return { count: durationMs > 2 * MS_HOUR ? 2 : 0 }
    if (t === TEN_AM) return { ambiguous: '85.6.3 covers "before 10:00" and "after 10:00" only — a 10:00 start needs an operator decision' }
    return { count: durationMs > 3 * MS_HOUR ? 1 : 0 }
  }
  // Night duty: "before 20:00" read on the duty's evening. An early-morning
  // commencement (00:00–11:59) is a modelling ambiguity — fail closed.
  if (t < NOON) return { ambiguous: 'night-duty recall commencing 00:00–11:59: "before 20:00" is not decidable from the clause' }
  return { count: t < EIGHT_PM && durationMs > 2 * MS_HOUR ? 1 : 0 }
}

/**
 * @param {OperationalClaim} claim
 * @param {RecallDetails}    details
 * @param {EngineContext}    ctx
 * @returns {EntitlementDraft[]}
 */
export function generateRecallEntitlements(claim, details, ctx) {
  const drafts = []
  const date = claim?.claim_date
  const d = details || {}
  const durationMs = spanMs(d.recall_start_at, d.recall_end_at)

  // 1. Recall overtime — minimum 4 h at double time (128.2), nearest quarter hour (128.1).
  if (durationMs == null) {
    skip(ctx, 'recall_overtime', 'missing-or-invalid-times')
  } else {
    const actual = nearestQuarterHours(durationMs)
    const hours = Math.max(4, actual)
    drafts.push(overtimeHoursDraft({
      ctx, claimDate: date, entitlementType: 'recall_overtime', hours,
      multiplierCode: RATE_CODES.DOUBLE_TIME, ruleId: 'recall.overtime.v1',
      explanation: `Recall — minimum 4 h at double time (EBA 2020 cl 128.2); actual ${actual} h to the nearest quarter hour (cl 128.1).`,
      formula: 'hours = max(4.0, nearest_quarter_hour(recall_end_at − recall_start_at)); estimate per WORK-246 at ×2',
      facts: { recall_start_at: d.recall_start_at, recall_end_at: d.recall_end_at, actual_hours: actual },
    }))
  }

  // 2. Recall travelling time — every recall, ordinary rate; ×1.5 Sundays / public holidays (128.4).
  const travelHours = minutesToQuarterHours(d.recall_travel_minutes)
  if (travelHours == null) {
    skip(ctx, 'recall_travel_time', 'missing-travel-minutes')
  } else if (typeof d.recall_travel_sunday_or_ph !== 'boolean') {
    skip(ctx, 'recall_travel_time', 'missing-sunday-or-public-holiday-fact')
  } else if (travelHours === 0) {
    skip(ctx, 'recall_travel_time', 'rounds-to-zero')
  } else {
    const sundayOrPh = d.recall_travel_sunday_or_ph
    drafts.push(overtimeHoursDraft({
      ctx, claimDate: date, entitlementType: 'recall_travel_time', hours: travelHours,
      multiplierCode: sundayOrPh ? RATE_CODES.TIME_AND_HALF : RATE_CODES.SINGLE_TIME,
      ruleId: 'recall.travel_time.v1',
      explanation: `Recall travelling time at ${sundayOrPh ? 'time and one half (Sunday / public holiday)' : 'ordinary rates'} for the actual home → recall work location → home trip (EBA 2020 cl 128.4).`,
      formula: 'hours = nearest_quarter_hour(recall_travel_minutes); estimate per WORK-246 at ×1 (×1.5 Sunday / public holiday)',
      facts: { recall_travel_minutes: Number(d.recall_travel_minutes), sunday_or_public_holiday: sundayOrPh },
    }))
  }

  // 3. Mileage — actual home → recall work location → home km (128.4).
  const km = d.travel_distance_km == null || d.travel_distance_km === '' ? null : Number(d.travel_distance_km)
  if (km == null || !Number.isFinite(km) || km <= 0) {
    skip(ctx, 'recall_mileage', 'missing-distance')
  } else {
    const m = allowanceDraft({
      ctx, claimDate: date, entitlementType: 'recall_mileage', code: RATE_CODES.TRAVEL_PER_KM, quantity: km,
      ruleId: 'recall.mileage.v1',
      explanation: `Recall mileage: ${km} km home → recall work location → home × Motor Vehicle / Mileage Allowance (EBA 2020 cl 128.4; Schedule 4 / PR765587).`,
      formula: 'amount = round_half_up(travel_distance_km × travel_per_km[claim_date], 2)',
      facts: { travel_distance_km: km, travel_source: d.travel_source ?? null },
      paymentMethod: 'petty_cash',
    })
    if (m) drafts.push(m)
    else skip(ctx, 'recall_mileage', 'rate-unavailable', `travel_per_km on ${date}`)
  }

  // 4. Relieving Allowance — recall to a location other than the rostered station (85.8.10).
  const rostered = ctx?.profileSnapshot?.rostered_station_id ?? null
  if (d.recall_station_id == null || rostered == null) {
    skip(ctx, 'relieving_allowance', 'missing-station')
  } else if (Number(d.recall_station_id) !== Number(rostered)) {
    const r = allowanceDraft({
      ctx, claimDate: date, entitlementType: 'relieving_allowance', code: RATE_CODES.RELIEVING,
      ruleId: 'recall.relieving.v1',
      explanation: 'Relieving Allowance — recalled to a work location other than the rostered station, per shift (EBA 2020 cl 85.8.10; Schedule 4 / PR765587).',
      formula: 'amount = relieving_allowance[claim_date] (one per recall shift)',
      facts: { recall_station_id: d.recall_station_id, rostered_station_id: rostered },
      paymentMethod: 'payslip',
    })
    if (r) drafts.push(r)
    else skip(ctx, 'relieving_allowance', 'rate-unavailable', `relieving_allowance on ${date}`)
  }

  // 5. Recall meals (85.6.3).
  const meals = recallMealCount({ duty: d.recall_duty, startAt: d.recall_start_at, durationMs })
  if (meals.ambiguous) {
    skip(ctx, 'recall_meal', 'needs_operator_decision', meals.ambiguous)
  } else if (meals.count > 0) {
    const clause = d.recall_duty === 'day'
      ? (meals.count === 2 ? 'EBA 2020 cl 85.6.3(a): day duty commencing before 10:00, more than 2 h' : 'EBA 2020 cl 85.6.3(a): day duty commencing after 10:00, more than 3 h')
      : 'EBA 2020 cl 85.6.3(b): night duty commencing before 20:00, more than 2 h'
    drafts.push(...mealDrafts({
      ctx, claimDate: date, entitlementType: 'recall_meal', code: RATE_CODES.MEAL_ALLOWANCE,
      count: meals.count, ruleId: 'meal.recall.v1', clause,
      facts: { recall_duty: d.recall_duty, recall_start_at: d.recall_start_at, duration_hours: durationMs / MS_HOUR },
    }))
  }

  return drafts
}
