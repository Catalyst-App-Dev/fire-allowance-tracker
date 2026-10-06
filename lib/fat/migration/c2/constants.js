// ─── C2 transform — contract constants (WORK-190) ───────────────────────────
// Authority: docs/architecture/C2_TRANSFORM_CONTRACT.md (design record on
// Linear WORK-190), C1_CUTOVER_CONTRACT.md, CANONICAL_ENTITLEMENT_RULES.md.

// 1.1.0 (WORK-191): C3 historical payment-state mapping joined the same batch; gate 6 is evaluated.
// 2.0.0 (WORK-255): cross-database topology — Supabase prototype source → Neon canonical target;
// EMPTY_CLAIM_GROUP; owner identity through the WORK-254 app-identity seam; gates R and I.
export const TOOL = Object.freeze({ name: 'fat-c2-transform', version: '2.0.0' })
export const REPORT_SCHEMA = 'fat.c2.parity-report/v3'
// The planner's combined input (source + reference + target, one object). Built from the two
// cross-database snapshots by crossdb.js; also the shape the pure planner tests use.
export const SNAPSHOT_SCHEMA = 'fat.c2.source-snapshot/v1'
// Cross-database snapshots (WORK-255).
export const SOURCE_SNAPSHOT_SCHEMA = 'fat.c2.source-snapshot/v2'
export const TARGET_SNAPSHOT_SCHEMA = 'fat.c2.target-snapshot/v1'

// Fixed namespace for UUIDv5 target ids (never change: ids are the idempotent identity).
export const ID_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1504c9'

export const SOURCE_TABLES = Object.freeze(['claim_groups', 'recalls', 'retain', 'standby', 'spoilt_meals'])
// Every Supabase table the cross-database source snapshot carries and its source_checksum covers
// (the C4 archive set: the five prototype tables + claim_sequences + financial_years).
export const SNAPSHOT_TABLES = Object.freeze([...SOURCE_TABLES, 'claim_sequences', 'financial_years'])
export const CLAIM_TABLES = Object.freeze(['recalls', 'retain', 'standby', 'spoilt_meals'])

// Prototype app claim type (claim_groups.claim_type / claim_sequences key) → canonical type.
export const CANONICAL_TYPE = Object.freeze({
  recalls: 'RC', retain: 'RT', standby: 'SB', md: 'MD', spoilt: 'SM', delayed_meal: 'DM',
})

// The prototype table holding each app type's parent row.
export const PARENT_TABLE = Object.freeze({
  recalls: 'recalls', retain: 'retain', standby: 'standby', md: 'standby', spoilt: 'spoilt_meals', delayed_meal: 'spoilt_meals',
})

export const DETAIL_TABLE = Object.freeze({
  RC: 'recall_details', RT: 'retain_details', SB: 'standby_details',
  MD: 'muster_dismiss_details', SM: 'spoilt_meal_details', DM: 'delayed_meal_details',
})

// Every column written per detail table (explicit NULLs keep the comparison exact).
export const DETAIL_COLUMNS = Object.freeze({
  recall_details: ['claim_id', 'recall_station_id', 'recall_start_at', 'recall_end_at', 'travel_distance_km',
    'travel_source', 'meal_break_taken', 'recall_duty', 'recall_travel_minutes', 'recall_travel_sunday_or_ph'],
  retain_details: ['claim_id', 'retain_start_at', 'retain_end_at', 'meal_break_taken', 'retain_shift',
    'night_shift_interrupted', 'retain_travel_home_minutes'],
  standby_details: ['claim_id', 'standby_station_id', 'standby_start_at', 'standby_end_at', 'matrix_distance_km',
    'matrix_hours', 'matrix_version', 'home_to_rostered_km', 'home_to_target_km'],
  muster_dismiss_details: ['claim_id', 'md_station_id', 'md_event_at', 'matrix_distance_km', 'matrix_hours',
    'matrix_version', 'home_to_rostered_km', 'home_to_target_km'],
  spoilt_meal_details: ['claim_id', 'meal_provisioned_at', 'spoilt_reason', 'meal_interrupted_at',
    'emergency_response', 'emergency_call_ref'],
  delayed_meal_details: ['claim_id', 'meal_window_start_at', 'meal_window_end_at', 'actual_meal_at',
    'delay_notice_2h', 'delay_cause', 'duty_start_at', 'duty_end_at'],
})

export const CLAIM_COLUMNS = Object.freeze(['id', 'owner_id', 'claim_type', 'claim_date', 'station_id_snapshot',
  'station_name_snapshot', 'source_calculation_mode', 'status', 'generated_at', 'notes', 'claim_number',
  'financial_year_id', 'prototype_claim_group_id', 'prototype_source', 'prototype_row_id'])

export const ENTITLEMENT_COLUMNS = Object.freeze(['id', 'claim_id', 'owner_id', 'entitlement_type', 'unit',
  'generated_amount', 'generated_hours', 'rule_id', 'rule_version', 'rule_explanation', 'formula_explanation',
  'rate_id', 'rate_version_id', 'rate_snapshot', 'payment_method', 'payment_status', 'generated_at',
  'prototype_source', 'prototype_row_id', 'prototype_component'])

export const LEDGER_COLUMNS = Object.freeze(['id', 'owner_id', 'source_table', 'source_row_id',
  'source_claim_group_id', 'source_claim_type', 'source_checksum', 'source_snapshot', 'disposition',
  'target_claim_id', 'exclusion_code', 'exclusion_reason'])

// Parent markers stored in calculation_inputs.autoChild on SB/MD parent rows.
export const PARENT_MARKERS = Object.freeze({ standby: 'standby_and_dismi', md: 'md_event' })

export const PRESERVED_RULE_ID = 'prototype.preserved.v1'

/**
 * Legitimate auto-children per app type, keyed "<table>:<autoChild>".
 * component = the stored column carried verbatim; method = the historical route.
 */
export const CHILD_RULES = Object.freeze({
  recalls: {
    'recalls:callback_ops': { component: 'travel_amount', type: 'recall_mileage', unit: 'dollars', method: 'payslip' },
    'recalls:excess_travel': { exclusion: 'G12_FAKE_RECALL_EXCESS_TRAVEL' },
    'spoilt_meals:petty_cash_meal': { component: 'meal_amount', type: 'recall_meal', unit: 'dollars', method: 'petty_cash' },
  },
  retain: {
    'retain:maint_stn_nn': { component: 'generated_hours', type: 'retain_overtime', unit: 'hours', method: 'payslip', historical: 'retain_amount' },
    'spoilt_meals:retain_meal': { component: 'meal_amount', type: 'retain_meal', unit: 'dollars', method: 'petty_cash' },
  },
  standby: {
    'standby:standby_excess_travel': { component: 'travel_amount', type: 'excess_travel_standby', unit: 'dollars', method: 'payslip' },
    'spoilt_meals:standby_small_meal': { component: 'meal_amount', type: 'small_meal', unit: 'dollars', method: 'petty_cash' },
  },
  md: {
    'standby:standby_excess_travel': { component: 'travel_amount', type: 'excess_travel_md', unit: 'dollars', method: 'payslip' },
  },
  spoilt: {},
  delayed_meal: {},
})

/**
 * Components carried by a parent row itself: always for SM/DM; for RC/RT/SB/MD
 * only on legacy rows that have no auto-children ("parent-carried" mode).
 */
export const PARENT_COMPONENTS = Object.freeze({
  recalls: [
    { component: 'travel_amount', type: 'recall_mileage', unit: 'dollars', method: 'payslip' },
    { component: 'mealie_amount', type: 'recall_meal', unit: 'dollars', method: 'petty_cash' },
  ],
  retain: [
    { component: 'generated_hours', type: 'retain_overtime', unit: 'hours', method: 'payslip', historical: 'retain_amount' },
  ],
  standby: [
    { component: 'travel_amount', type: 'excess_travel_standby', unit: 'dollars', method: 'payslip' },
    { component: 'night_mealie', type: 'small_meal', unit: 'dollars', method: 'petty_cash' },
  ],
  md: [
    { component: 'travel_amount', type: 'excess_travel_md', unit: 'dollars', method: 'payslip' },
  ],
  spoilt: [{ component: 'meal_amount', type: 'spoilt_meal', unit: 'dollars', method: 'petty_cash', always: true }],
  delayed_meal: [{ component: 'meal_amount', type: 'delayed_meal', unit: 'dollars', method: 'petty_cash', always: true }],
})

/** Approved exclusions (CUTOVER_PLAN "Approved legacy exclusion (G12)"). */
export const EXCLUSIONS = Object.freeze({
  G12_FAKE_RECALL_EXCESS_TRAVEL: {
    reason: 'Known fake $0 Recall Excess Travel auto-child (G12). Not a payable entitlement: no authoritative rule establishes recall excess travel (D9d); recall travel is recall_travel_time + recall_mileage under cl 128.4. Preserved here as provenance only.',
    refs: ['CUTOVER_PLAN.md "Approved legacy exclusion (G12)"', 'C1_CUTOVER_CONTRACT.md § 4', 'CANONICAL_ENTITLEMENT_RULES.md § 2', 'WORK-174'],
  },
  EMPTY_CLAIM_GROUP: {
    reason: 'Prototype claim_groups row with zero member rows in recalls / retain / standby / spoilt_meals: no logical event exists, so no canonical claim is created. Not dropped and not a failure: the group row is preserved here as provenance and stays untouched in the source.',
    refs: ['WORK-192 B1', 'WORK-255', 'C2_TRANSFORM_CONTRACT.md § 6'],
  },
})

/** Exclusion codes that dispose of a whole source group (no target claim) rather than one child row. */
export const GROUP_EXCLUSIONS = Object.freeze(['EMPTY_CLAIM_GROUP'])

/** Intended-difference classes: deliberate corrections by the authoritative rules. */
export const INTENDED_DIFFERENCES = Object.freeze({
  RT_NEAREST_QUARTER_128_1: {
    rule: 'FRV EBA 2020 cl 128.1: overtime is calculated to the NEAREST quarter hour. The prototype calcRetainHours rounds UP (ceiling) in 0.25 h steps.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 1.3, § 3', 'WORK-250'],
  },
  MEAL_RATE_SCHEDULE_4: {
    rule: 'Meal allowances are the versioned Schedule 4 / FWC PR765587 amounts (meal_allowance, spoilt_meal_allowance); the prototype priced meals with workbook small_meal / large_meal.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 0, § 9, § 11', 'FRV EBA 2020 cl 85.6.1 / 85.6.8 / 85.7.1'],
  },
  RC_MEAL_RULE_85_6_3: {
    rule: 'Recall meal count follows cl 85.6.3 (day: before 10:00 and > 2 h → 2; after 10:00 and > 3 h → 1; night: before 20:00 and > 2 h → 1). The prototype used workbook tiers (Large / Large + Small, 4 h minimum, notified-recall suppression).',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 2.1', 'FRV EBA 2020 cl 85.6.3, 128.7'],
  },
  RT_MEAL_RULE_85_6_4: {
    rule: 'Retain meal count follows cl 85.6.4 (1 on a cl 128.5 retention; a 2nd once over 2 h; one more at the end of each further 2 h). The prototype used workbook clock thresholds (Large at +1 h, Small every +2 h).',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 3', 'FRV EBA 2020 cl 85.6.4', 'WORK-250'],
  },
  RC_OVERTIME_128_2: {
    rule: 'Recall overtime (minimum 4 h at double time, nearest quarter hour) is a canonical hours-first entitlement; the prototype recorded no recall overtime (base recall pay was left to payroll).',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 2', 'FRV EBA 2020 cl 128.1, 128.2'],
  },
  RC_TRAVEL_TIME_128_4: {
    rule: 'Recall travelling time at ordinary rates (× 1.5 Sundays / public holidays) on every recall; the prototype had no recall travel-time entitlement.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 2', 'FRV EBA 2020 cl 128.4'],
  },
  RC_RELIEVING_85_8_10: {
    rule: 'Relieving Allowance, per recall shift, when recalled to a location other than the rostered station; the prototype had no Relieving Allowance.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 2, § 7', 'FRV EBA 2020 cl 85.8.10'],
  },
  RT_TRAVEL_HOME_85_8_9: {
    rule: 'Travel home after a retention following a night shift interrupted by a fire call, incident or fire duty (cl 85.8.9), at ordinary rate; the prototype had no such entitlement.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 3', 'FRV EBA 2020 cl 85.8.9'],
  },
  SM_SPOILT_ALLOWANCE_85_7_1: {
    rule: 'Spoilt Meal Allowance is the versioned spoilt_meal_allowance under cl 85.7.1; the prototype paid workbook small_meal.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 4', 'FRV EBA 2020 cl 85.7.1'],
  },
  DM_MEAL_ALLOWANCE_85_6_6: {
    rule: 'Delayed Meal is its own type paid at meal_allowance under cl 85.6.6 / 85.6.7, no longer collapsed onto workbook small_meal.',
    refs: ['CANONICAL_ENTITLEMENT_RULES.md § 5', 'FRV EBA 2020 cl 85.6.6, 85.6.7', 'D9b'],
  },
})

/** Facts each generator item needs, used to name the missing inputs when it cannot generate. */
export const REQUIRED_FACTS = Object.freeze({
  recall_overtime: ['recall_start_at', 'recall_end_at'],
  recall_travel_time: ['recall_travel_minutes', 'recall_travel_sunday_or_ph'],
  recall_mileage: ['travel_distance_km'],
  relieving_allowance: ['recall_station_id', 'rostered_station_id'],
  recall_meal: ['recall_duty', 'recall_start_at', 'recall_end_at'],
  retain_overtime: ['retain_start_at', 'retain_end_at'],
  retain_travel_home: ['retain_shift', 'night_shift_interrupted', 'retain_travel_home_minutes'],
  retain_meal: ['retain_start_at', 'retain_end_at'],
  spoilt_meal: ['meal_interrupted_at', 'emergency_response'],
  delayed_meal: ['delay_cause', 'meal_window_start_at', 'meal_window_end_at', 'actual_meal_at', 'delay_notice_2h', 'duty_start_at', 'duty_end_at'],
})

export const GENERATOR_PARITY_TYPES = Object.freeze(['RC', 'RT', 'SM', 'DM'])
export const ACCEPTANCE_GATES = Object.freeze(['1', '2', '3', '4', '5', '6', '7'])
// Cross-database acceptance adds R (target reference readiness) and I (owner identity preservation).
export const CROSS_DB_ACCEPTANCE_GATES = Object.freeze(['R', 'I', ...ACCEPTANCE_GATES])

/**
 * DEV must never receive a real identity (WORK-255 hard boundary): every e-mail of an identity
 * provisioned on a dev target must use a reserved test domain (RFC 2606 / RFC 6761).
 */
export const RESERVED_TEST_EMAIL = /@(?:[a-z0-9-]+\.)*(?:invalid|test|example|localhost|example\.(?:com|net|org))$/i

// Prototype rostered-shift finish (lib/calculations/engine.js RETAIN_HOUR_BOUNDARIES):
// the basis the stored retain hours were computed from.
export const RETAIN_ROSTERED_FINISH = Object.freeze({ Day: 18 * 60, Night: 8 * 60 })

// ─── C3 historical payment state (WORK-191) ─────────────────────────────────
// Authority: docs/architecture/C3_PAYMENT_STATE_CONTRACT.md, C1_CUTOVER_CONTRACT.md § 6.

export const PAYMENT_RECORD_COLUMNS = Object.freeze(['id', 'owner_id', 'stream', 'record_date', 'reference',
  'gross_amount', 'raw_payload', 'source', 'migration_source_key'])

/** Canonical initial (no eligible link) and terminal payment_status per route — fat._reconc_recompute. */
export const PAYMENT_STATUS = Object.freeze({
  payslip: { open: 'pending', settled: 'paid' },
  petty_cash: { open: 'outstanding', settled: 'claimed' },
})

/** Prototype payment evidence that cannot be mapped without guessing: each is a genuine gate-6 failure. */
export const PAYMENT_FAILURES = Object.freeze({
  C3_PAID_WITHOUT_DATE: 'payment_status Paid without payment_date: the prototype toggle always records the date, and payment_records.record_date cannot be invented',
  C3_PENDING_WITH_DATE: 'payment_status Pending carries a payment_date: the prototype toggle clears the date on Pending',
  C3_UNPAID_WITH_DATE: 'payment_status NULL carries a payment_date',
  C3_LEGACY_STATUS_CONFLICT: 'payment_status NULL with a legacy status other than Pending: the prototype readers disagree (calcParentStatus falls back to status, groupedView reads NULL as Pending)',
  C3_UNKNOWN_PAYMENT_STATUS: 'payment_status is not Paid, Pending or NULL',
  C3_UNROUTED_ENTITLEMENT: 'paid entitlement has no payment_method, so no payment stream can be established',
  C3_ALLOCATION_UNESTABLISHED: 'the historical payable amount of a paid entitlement is missing or negative',
})

/** Prototype payment state on rows that carry no payable entitlement: reported, never mapped. */
export const PAYMENT_STRUCTURAL = Object.freeze({
  CONTAINER_ROW_NOT_PAYABLE: 'operational container / parent-marker row of a child-carried event: its dollars live on the auto-children (prototype groupedView zeroes it), so its toggle is not payment evidence for any entitlement',
  EXCLUDED_ARTIFACT_NOT_PAYABLE: 'approved G12 exclusion: no canonical entitlement exists to carry payment state',
})
