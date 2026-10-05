// ─── Claim-Type Detail Tables (canonical) ────────────────────────────────────
// One row per parent operational_claim, joined 1:1 on `claim_id`. Detail
// tables hold ONLY type-specific input fields — never recomputed outputs
// (those live on claim_entitlements).
//
// Forward-only: new claim types add new detail tables. Existing detail
// tables MUST NOT be widened to model unrelated claim types.
//
// See DATABASE_ARCHITECTURE_v1.0.md § 2. Operational Claims (Detail Tables).

/**
 * @typedef {Object} RecallDetails
 * @property {string}        claim_id
 * @property {number|null}   recall_station_id
 * @property {string|null}   recall_start_at
 * @property {string|null}   recall_end_at
 * @property {number|null}   travel_distance_km    // actual home → recall work location → home km (EBA cl 128.4); Google Maps or manual
 * @property {'google_maps'|'manual'|null} travel_source
 * @property {boolean|null}  meal_break_taken
 * @property {'day'|'night'|null} recall_duty      // WORK-173: day or night duty (EBA cl 85.6.3) — explicit, never inferred
 * @property {number|null}   recall_travel_minutes // WORK-173: actual home → recall work location → home travelling time (cl 128.4)
 * @property {boolean|null}  recall_travel_sunday_or_ph // WORK-173: travel on a Sunday / public holiday → time and one half (cl 128.4)
 */

/**
 * @typedef {Object} RetainDetails
 * @property {string}        claim_id
 * @property {string|null}   retain_start_at       // conclusion of the rostered shift
 * @property {string|null}   retain_end_at         // release from duty
 * @property {boolean|null}  meal_break_taken
 * @property {'day'|'night'|null} retain_shift     // WORK-173: the retained shift
 * @property {boolean|null}  night_shift_interrupted // WORK-173: night shift interrupted by a fire call / incident / fire duty (cl 85.8.9)
 * @property {number|null}   retain_travel_home_minutes // WORK-173: reasonable travelling time to residence (cl 85.8.9)
 */

/**
 * @typedef {Object} StandbyDetails
 * @property {string}        claim_id
 * @property {number|null}   standby_station_id
 * @property {string|null}   standby_start_at
 * @property {string|null}   standby_end_at
 * @property {number|null}   matrix_distance_km    // FRV Matrix only
 * @property {number|null}   matrix_hours          // FRV Matrix Index sheet decimal hours
 * @property {string|null}   matrix_version
 */

/**
 * @typedef {Object} MusterDismissDetails
 * @property {string}        claim_id
 * @property {number|null}   md_station_id
 * @property {string|null}   md_event_at
 * @property {number|null}   matrix_distance_km
 * @property {number|null}   matrix_hours
 * @property {string|null}   matrix_version
 */

/**
 * @typedef {Object} DelayedMealDetails
 * @property {string}        claim_id
 * @property {string|null}   meal_window_start_at
 * @property {string|null}   meal_window_end_at
 * @property {string|null}   actual_meal_at        // NULL if no meal was taken
 * @property {boolean|null}  delay_notice_2h       // WORK-173: 2 hours' prior notice of the delay was given (cl 85.6.6)
 * @property {'other'|'fire_call'|'salvage'|'watching'|null} delay_cause // WORK-173: cl 85.6.6 vs 85.6.7
 * @property {string|null}   duty_start_at         // WORK-173: fire call / salvage / watching duty start (cl 85.6.7)
 * @property {string|null}   duty_end_at           // WORK-173: fire call / salvage / watching duty end (cl 85.6.7)
 */

/**
 * @typedef {Object} SpoiltMealDetails
 * @property {string}        claim_id
 * @property {string|null}   meal_provisioned_at
 * @property {string|null}   spoilt_reason         // free-text
 * @property {string|null}   meal_interrupted_at   // WORK-173: when the begun meal was interrupted (cl 85.7.1)
 * @property {boolean|null}  emergency_response    // WORK-173: interruption was a response to an emergency call (cl 85.7.1)
 * @property {string|null}   emergency_call_ref    // WORK-173: optional evidence; not an entitlement condition
 */

export const DETAIL_TABLE_BY_CLAIM_TYPE = {
  RC: 'recall_details',
  RT: 'retain_details',
  SB: 'standby_details',
  MD: 'muster_dismiss_details',
  DM: 'delayed_meal_details',
  SM: 'spoilt_meal_details',
}
