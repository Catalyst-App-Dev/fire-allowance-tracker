// ─── Canonical claim model for the Neon DEV runtime (WORK-256) ───────────────
// Pure. Two directions, both deterministic and unit-tested
// (__tests__/neon-canonical-claims.test.mjs):
//
//   1. buildCanonicalDetail — a ClaimForm payload → the canonical
//      operational_claims fields + the 1:1 *_details row. Facts are derived
//      exactly as the C2 contract § 4 derives them from the same prototype
//      inputs (Australia/Melbourne wall clock, Day/Night duty, retain rostered
//      finish), plus the explicit canonical facts the WORK-173 rules need that
//      the prototype form never collected (RC travel minutes / Sunday-PH /
//      round-trip km; RT night-shift interruption / travel-home minutes; SM
//      emergency response; DM meal window, actual meal, 2 h notice, cause, duty
//      span). Nothing is guessed: an absent fact stays NULL and the dependent
//      entitlement fails closed in the generator.
//
//   2. projectClaims — canonical rows → the exact `claims` / `claimGroups`
//      contract the existing UI consumes (ClaimsContext groupedView): one group
//      per operational claim, one child per entitlement. Payment state is
//      displayed from the canonical entitlement; nothing is fabricated.

import { parseClock, melbourneInterval, melbourneInstant } from '../../fat/migration/c2/util.js'
import { RETAIN_ROSTERED_FINISH, DETAIL_TABLE as C2_DETAIL_TABLE, REQUIRED_FACTS } from '../../fat/migration/c2/constants.js'
import { buildClaimLabel } from '../../calculations/engine.js'
import { resolveOperationalPlatoon } from '../../platoon/resolveOperationalPlatoon.js'

export const APP_TO_CANONICAL = Object.freeze({ recalls: 'RC', retain: 'RT', standby: 'SB', md: 'MD', spoilt: 'SM', delayed_meal: 'DM' })
export const CANONICAL_TO_APP = Object.freeze(Object.fromEntries(Object.entries(APP_TO_CANONICAL).map(([a, c]) => [c, a])))
export const DETAIL_TABLE = C2_DETAIL_TABLE
export const DELAY_CAUSES = Object.freeze(['other', 'fire_call', 'salvage', 'watching'])

const DUTY = { Day: 'day', Night: 'night' }
const SHIFT_FROM_DUTY = { day: 'Day', night: 'Night' }

/** Entitlement display labels (canonical entitlement_type → UI label). */
export const ENTITLEMENT_LABELS = Object.freeze({
  recall_overtime: 'Recall overtime',
  recall_travel_time: 'Recall travel time',
  recall_mileage: 'Recall mileage',
  relieving_allowance: 'Relieving allowance',
  recall_meal: 'Meal allowance',
  retain_overtime: 'Retain overtime',
  retain_travel_home: 'Travel home',
  retain_meal: 'Meal allowance',
  standby_dismi: 'Standby & Dismiss',
  excess_travel_standby: 'Excess Travel',
  small_meal: 'Small Meal Allowance',
  muster_dismis: 'Muster & Dismiss',
  excess_travel_md: 'Excess Travel',
  spoilt_meal: 'Spoilt meal allowance',
  delayed_meal: 'Delayed meal allowance',
})

export const MEAL_ENTITLEMENTS = Object.freeze(['recall_meal', 'retain_meal', 'small_meal', 'spoilt_meal', 'delayed_meal'])

const intOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) ? n : null
}
const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const boolOrNull = (v) => (v === true || v === false ? v : null)

function instant(date, clock, notes, what) {
  const m = parseClock(clock)
  if (m == null) return null
  const at = melbourneInstant(date, m)
  if (at.ambiguous) { notes.push(`${what}: ${at.ambiguous}`); return null }
  return at.iso
}

function interval(date, startClock, endClock, notes, what) {
  const iv = melbourneInterval(date, parseClock(startClock), parseClock(endClock))
  for (const n of iv.notes) notes.push(`${what} ${n}`)
  return iv
}

/**
 * @param {object} p
 * @param {string} p.appType      recalls | retain | standby | md | spoilt | delayed_meal
 * @param {string} p.date         YYYY-MM-DD
 * @param {object} p.fields       ClaimForm submitFields (station ids resolved)
 * @param {object} [p.facts]      explicit canonical facts (see header)
 * @param {object} [p.routingMeta]
 * @param {(id:number)=>boolean} p.stationExists
 * @param {string|null} [p.activeMatrixVersion]  active hours matrix version (SB/MD fallback)
 * @returns {{ claimType:string, detailTable:string, detail:object, stationIdSnapshot:number|null, sourceCalculationMode:string|null, notes:string[] }}
 */
export function buildCanonicalDetail({ appType, date, fields = {}, facts = {}, routingMeta = null, stationExists, activeMatrixVersion = null }) {
  const claimType = APP_TO_CANONICAL[appType]
  if (!claimType) throw new Error(`unknown claim type: ${appType}`)
  const station = (id) => { const n = intOrNull(id); return n != null && stationExists(n) ? n : null }
  const notes = []
  let detail
  let sourceCalculationMode = null

  if (claimType === 'RC') {
    const iv = interval(date, fields.arrivalTime, fields.bookedOffTime, notes, 'recall')
    const km = numOrNull(facts.travelDistanceKm)
    detail = {
      recall_station_id: station(fields.recallStnId),
      recall_start_at: iv.start,
      recall_end_at: iv.end,
      recall_duty: DUTY[fields.shift] ?? null,
      travel_distance_km: km,
      travel_source: km != null ? 'manual' : null,
      meal_break_taken: null,
      recall_travel_minutes: numOrNull(facts.travelMinutes),
      recall_travel_sunday_or_ph: boolOrNull(facts.travelSundayOrPh),
    }
  } else if (claimType === 'RT') {
    const finish = RETAIN_ROSTERED_FINISH[fields.shift]
    const iv = melbourneInterval(date, finish ?? null, parseClock(fields.bookedOffTime))
    for (const n of iv.notes) notes.push(`retain ${n}`)
    detail = {
      retain_start_at: iv.start,
      retain_end_at: iv.end,
      meal_break_taken: null,
      retain_shift: DUTY[fields.shift] ?? null,
      night_shift_interrupted: boolOrNull(facts.nightShiftInterrupted),
      retain_travel_home_minutes: numOrNull(facts.travelHomeMinutes),
    }
  } else if (claimType === 'SB' || claimType === 'MD') {
    const standbyMeta = routingMeta?.standby ?? null
    const matrixVersion = standbyMeta?.matrixVersionId != null ? String(standbyMeta.matrixVersionId) : (activeMatrixVersion ?? null)
    const at = instant(date, fields.arrivedTime, notes, 'arrival')
    if (matrixVersion) sourceCalculationMode = 'frv_matrix'
    if (claimType === 'SB') {
      detail = {
        standby_station_id: station(fields.standbyStnId),
        standby_start_at: at,
        matrix_distance_km: null,
        matrix_hours: numOrNull(standbyMeta?.matrixHours),
        matrix_version: matrixVersion,
        home_to_rostered_km: null,
        home_to_target_km: null,
      }
    } else {
      detail = {
        md_station_id: station(fields.standbyStnId),
        md_event_at: at,
        matrix_distance_km: null,
        matrix_hours: numOrNull(standbyMeta?.matrixHours),
        matrix_version: matrixVersion,
        // Raw source distances only (C2 § 4) — the payable-km formula is not recomputed here.
        home_to_rostered_km: numOrNull(fields.mdHomeToRosteredKm),
        home_to_target_km: numOrNull(fields.mdHomeToMdKm),
      }
    }
  } else if (claimType === 'SM') {
    detail = {
      meal_provisioned_at: null,
      spoilt_reason: null,
      meal_interrupted_at: instant(date, fields.incidentTime, notes, 'meal interrupted'),
      emergency_response: boolOrNull(facts.emergencyResponse),
      emergency_call_ref: fields.firecallNumber ? String(fields.firecallNumber) : null,
    }
  } else {
    // DM: the prototype recorded no delay fact; every fact is an explicit input.
    const win = interval(date, facts.mealWindowStart, facts.mealWindowEnd, notes, 'meal window')
    const duty = interval(date, facts.dutyStart, facts.dutyEnd, notes, 'duty')
    detail = {
      meal_window_start_at: win.start,
      meal_window_end_at: win.end,
      actual_meal_at: instant(date, facts.actualMealTime, notes, 'actual meal'),
      delay_notice_2h: boolOrNull(facts.delayNotice2h),
      delay_cause: DELAY_CAUSES.includes(facts.delayCause) ? facts.delayCause : null,
      duty_start_at: duty.start,
      duty_end_at: duty.end,
    }
  }

  return {
    claimType,
    detailTable: DETAIL_TABLE[claimType],
    detail,
    stationIdSnapshot: station(fields.rosteredStnId),
    sourceCalculationMode,
    notes,
  }
}

/** The WORK-173 required facts that are absent from a detail row (for display). */
export function missingFacts(claimType, detail, rosteredStationId) {
  const types = {
    RC: ['recall_overtime', 'recall_travel_time', 'recall_mileage', 'relieving_allowance', 'recall_meal'],
    RT: ['retain_overtime', 'retain_meal'],
    SM: ['spoilt_meal'],
    DM: ['delayed_meal'],
  }[claimType] || []
  const facts = { ...(detail || {}), rostered_station_id: rosteredStationId ?? null }
  const out = new Set()
  for (const t of types) for (const f of REQUIRED_FACTS[t] || []) if (facts[f] === null || facts[f] === undefined) out.add(f)
  return [...out]
}

// ─── Projection: canonical → UI claim contract ───────────────────────────────

function addDaysIso(iso, days) {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : new Date(ms + days * 86400000).toISOString()
}

const PAYMENT_METHOD_LABEL = { payslip: 'Payslip', petty_cash: 'Petty Cash' }

/** Melbourne wall-clock "HH:MM" of a stored instant, or null. */
function clockOf(iso) {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Melbourne', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms))
}

function shiftOf(claimType, d) {
  if (!d) return null
  if (claimType === 'RC') return SHIFT_FROM_DUTY[d.recall_duty] ?? null
  if (claimType === 'RT') return SHIFT_FROM_DUTY[d.retain_shift] ?? null
  return null
}

/**
 * @param {object} p
 * @param {object[]} p.claims        fat.operational_claims rows
 * @param {Map<string,object>} p.details  claim_id → detail row
 * @param {object[]} p.entitlements  fat.claim_entitlements rows
 * @param {Set<string>} p.linkedEntitlementIds  entitlements with payment links
 * @param {Map<number,string>} p.stationNames
 * @returns {{ claims: object[], claimGroups: object[] }}
 */
export function projectClaims({ claims, details, entitlements, linkedEntitlementIds = new Set(), stationNames = new Map() }) {
  const byClaim = new Map()
  for (const e of entitlements) {
    if (!byClaim.has(e.claim_id)) byClaim.set(e.claim_id, [])
    byClaim.get(e.claim_id).push(e)
  }
  const label = (id) => (id != null ? stationNames.get(Number(id)) ?? null : null)

  const groups = []
  const rows = []
  for (const c of claims) {
    const appType = CANONICAL_TO_APP[c.claim_type]
    const d = details.get(c.id) || null
    const shift = shiftOf(c.claim_type, d)
    const platoon = shift ? resolveOperationalPlatoon(c.claim_date, shift) : null
    const rosteredLabel = c.station_name_snapshot ?? label(c.station_id_snapshot)
    const stationLabels = {
      rostered_stn_label: rosteredLabel,
      recall_stn_label: c.claim_type === 'RC' ? label(d?.recall_station_id) : null,
      standby_stn_label: c.claim_type === 'SB' ? label(d?.standby_station_id) : c.claim_type === 'MD' ? label(d?.md_station_id) : null,
    }
    const ents = (byClaim.get(c.id) || []).slice().sort((a, b) => (a.generated_at < b.generated_at ? -1 : a.generated_at > b.generated_at ? 1 : (a.entitlement_type < b.entitlement_type ? -1 : 1)))

    const children = ents.map((e) => {
      const dollars = e.unit === 'dollars'
      const generatedAmount = dollars ? Number(e.generated_amount) : null
      const effectiveAmount = dollars ? Number(e.edited_amount ?? e.generated_amount) : 0
      const hours = e.unit === 'hours' ? Number(e.edited_hours ?? e.generated_hours) : null
      const estimate = e.unit === 'hours' && e.rate_snapshot && e.rate_snapshot.estimate != null ? Number(e.rate_snapshot.estimate) : null
      const paid = e.payment_status === 'paid'
      return {
        id: e.id,
        claimType: appType,
        claim_group_id: c.id,
        claim_number: c.claim_number,
        date: c.claim_date,
        created_at: e.generated_at,
        status: paid ? 'Paid' : 'Pending',
        payment_status: paid ? 'Paid' : 'Pending',
        payment_date: null,
        payslip_pay_nbr: null,
        payment_method: PAYMENT_METHOD_LABEL[e.payment_method] ?? null,
        // Hours-first: hour entitlements carry NO dollar amount (CLAUDE.md §7 —
        // no implicit hours→dollars conversion); the snapshot estimate is shown
        // separately and labelled as an estimate.
        total_amount: dollars ? generatedAmount : 0,
        meal_amount: dollars && MEAL_ENTITLEMENTS.includes(e.entitlement_type) ? generatedAmount : null,
        adjusted_amount: dollars && e.edited_amount != null ? Number(e.edited_amount) : null,
        component_amount: effectiveAmount,
        shift,
        platoon,
        ...stationLabels,
        calculation_inputs: {
          autoChild: e.entitlement_type,
          shift,
          platoon,
          canonical: true,
        },
        canonical: {
          entitlementType: e.entitlement_type,
          label: ENTITLEMENT_LABELS[e.entitlement_type] ?? e.entitlement_type,
          unit: e.unit,
          generatedAmount,
          generatedHours: e.unit === 'hours' ? Number(e.generated_hours) : null,
          hours,
          estimate,
          editedAmount: e.edited_amount != null ? Number(e.edited_amount) : null,
          editedHours: e.edited_hours != null ? Number(e.edited_hours) : null,
          editedNote: e.edited_note ?? null,
          manualOverride: e.manual_override === true,
          ruleId: e.rule_id,
          ruleVersion: e.rule_version,
          ruleExplanation: e.rule_explanation ?? null,
          formulaExplanation: e.formula_explanation ?? null,
          paymentStatus: e.payment_status ?? null,
          paymentMethod: e.payment_method ?? null,
          paymentLinked: linkedEntitlementIds.has(e.id),
          // Dollar allowances: quantity × versioned rate (e.g. mileage km × $/km).
          quantity: dollars && e.rate_snapshot?.quantity != null ? Number(e.rate_snapshot.quantity) : null,
          rateValue: dollars && e.rate_snapshot?.value != null ? Number(e.rate_snapshot.value) : null,
        },
      }
    })

    rows.push(...children)
    groups.push({
      id: c.id,
      claim_type: appType,
      claim_number: c.claim_number,
      label: c.claim_number ? buildClaimLabel(appType, c.claim_number, c.claim_date) : `${appType} (${c.claim_date})`,
      incident_date: c.claim_date,
      incident_number: null,
      overdue_at: addDaysIso(c.created_at, 28),
      created_at: c.created_at,
      financial_year_id: c.financial_year_id,
      canonical: {
        claimType: c.claim_type,
        status: c.status,
        notes: c.notes ?? null,
        migrated: c.migration_batch_id != null,
        shift,
        platoon,
        times: d ? {
          start: clockOf(d.recall_start_at ?? d.retain_start_at ?? d.standby_start_at ?? d.md_event_at ?? d.meal_interrupted_at ?? d.meal_window_start_at),
          end: clockOf(d.recall_end_at ?? d.retain_end_at ?? d.meal_window_end_at),
        } : null,
        missingFacts: missingFacts(c.claim_type, d, c.station_id_snapshot),
        paymentLinked: ents.some((e) => linkedEntitlementIds.has(e.id)),
        ...stationLabels,
      },
    })
  }

  // Newest first, matching the prototype ordering (date desc).
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  groups.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  return { claims: rows, claimGroups: groups }
}
