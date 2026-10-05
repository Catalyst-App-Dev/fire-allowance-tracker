// ─── Spoilt Meal (SM) Entitlement Generator ──────────────────────────────────
// Pure function. Rule authority: WORK-173 rule spec v0.2 (operator-approved,
// PROMPT #15) § 4. Source: FRV EBA 2020 Division A cl 85.7.1 — a meal
// interrupted because of response to an emergency call → Spoilt Meal
// Allowance (Schedule 4 / PR765587, versioned spoilt_meal_allowance).
//
// Semantic modelling (not EBA wording): a meal that HAS BEGUN and is
// interrupted by an emergency response is Spoilt; a break that has not begun
// and is instead delayed is Delayed (delayedMeal.js). No condition beyond the
// clause is imposed: emergency_call_ref and meal_provisioned_at are optional
// evidence; there is no clock window.

import { allowanceDraft, skip } from './shared.js'
import { RATE_CODES } from '../../rates/rateModel.js'

/** @typedef {import('../types.js').EntitlementDraft}  EntitlementDraft */
/** @typedef {import('../types.js').EngineContext}     EngineContext */
/** @typedef {import('../types.js').SpoiltMealDetails} SpoiltMealDetails */
/** @typedef {import('../types.js').OperationalClaim}  OperationalClaim */

/**
 * @param {OperationalClaim}  claim
 * @param {SpoiltMealDetails} details
 * @param {EngineContext}     ctx
 * @returns {EntitlementDraft[]}
 */
export function generateSpoiltMealEntitlements(claim, details, ctx) {
  const d = details || {}
  if (typeof d.emergency_response !== 'boolean' || !d.meal_interrupted_at) {
    skip(ctx, 'spoilt_meal', 'missing-interruption-facts')
    return []
  }
  if (d.emergency_response !== true) return [] // non-emergency interruption: no 85.7.1 entitlement

  const draft = allowanceDraft({
    ctx, claimDate: claim?.claim_date, entitlementType: 'spoilt_meal', code: RATE_CODES.SPOILT_MEAL,
    ruleId: 'meal.spoilt.v1',
    explanation: 'Meal interrupted because of response to an emergency call — Spoilt Meal Allowance (EBA 2020 cl 85.7.1; Schedule 4 / PR765587).',
    formula: 'amount = spoilt_meal_allowance[claim_date]',
    facts: {
      meal_interrupted_at: d.meal_interrupted_at,
      emergency_response: true,
      emergency_call_ref: d.emergency_call_ref ?? null,
      meal_provisioned_at: d.meal_provisioned_at ?? null,
    },
    paymentMethod: 'petty_cash',
  })
  if (!draft) {
    skip(ctx, 'spoilt_meal', 'rate-unavailable', `spoilt_meal_allowance on ${claim?.claim_date}`)
    return []
  }
  return [draft]
}
