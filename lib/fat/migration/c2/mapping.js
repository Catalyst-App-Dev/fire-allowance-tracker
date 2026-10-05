// ─── C2 transform — prototype → canonical field map (WORK-190) ──────────────
// Pure. Every canonical value is either copied from a recorded prototype fact,
// derived deterministically from recorded facts (documented in
// docs/architecture/C2_TRANSFORM_CONTRACT.md § 4), or NULL. Nothing is guessed:
// a NULL generator input makes the dependent canonical entitlement fail closed
// and is reported as a missing input.

import {
  CANONICAL_TYPE, DETAIL_TABLE, DETAIL_COLUMNS, ID_NAMESPACE, PRESERVED_RULE_ID, TOOL, RETAIN_ROSTERED_FINISH,
} from './constants.js'
import { uuidv5, num, parseClock, melbourneInterval, melbourneInstant } from './util.js'

export const claimId = (table, rowId) => uuidv5(`claim:${table}:${rowId}`, ID_NAMESPACE)
export const entitlementId = (table, rowId, component) => uuidv5(`entitlement:${table}:${rowId}:${component}`, ID_NAMESPACE)
export const ledgerId = (table, rowId) => uuidv5(`ledger:${table}:${rowId}`, ID_NAMESPACE)

const ci = (row) => (row && row.calculation_inputs && typeof row.calculation_inputs === 'object' ? row.calculation_inputs : {})
const firstDefined = (...xs) => xs.find((x) => x !== undefined && x !== null && x !== '') ?? null

/** A station id that exists in fat.stations, else null (never a dangling FK). */
function station(id, stations) {
  const n = num(id)
  return n != null && stations.has(n) ? n : null
}

const DUTY = { Day: 'day', Night: 'night' }

/** Build the canonical claim row for a resolved event. */
export function buildClaim(ev, ref) {
  const p = ev.parent
  const type = CANONICAL_TYPE[ev.appType]
  const rosteredRaw = ev.parentTable === 'retain' || ev.parentTable === 'spoilt_meals' ? p.station_id : p.rostered_stn_id
  const stationId = station(rosteredRaw, ref.stations)
  const notes = [ev.group?.notes, p.notes].filter((x) => typeof x === 'string' && x.trim() !== '')
  const uniqueNotes = [...new Set(notes)]
  return {
    id: claimId(ev.parentTable, p.id),
    owner_id: p.user_id,
    claim_type: type,
    claim_date: p.date,
    station_id_snapshot: stationId,
    station_name_snapshot: stationId != null ? ref.stations.get(stationId) ?? null : null,
    source_calculation_mode: (type === 'SB' || type === 'MD') && p.matrix_version_id ? 'frv_matrix' : null,
    status: 'submitted',
    generated_at: firstDefined(p.created_at, ev.group?.created_at) ?? `${p.date}T00:00:00.000Z`,
    notes: uniqueNotes.length ? uniqueNotes.join('\n\n') : null,
    claim_number: ev.claimNumber,
    financial_year_id: ev.financialYearId,
    prototype_claim_group_id: ev.group?.id ?? null,
    prototype_source: ev.parentTable,
    prototype_row_id: p.id,
  }
}

/**
 * Build the 1:1 detail row. Returns { table, row, derivations, notes } —
 * derivations name every value that is derived rather than copied.
 */
export function buildDetail(ev, claim, ref) {
  const p = ev.parent
  const c = ci(p)
  const table = DETAIL_TABLE[claim.claim_type]
  const row = Object.fromEntries(DETAIL_COLUMNS[table].map((k) => [k, null]))
  row.claim_id = claim.id
  const derivations = []
  const notes = []

  if (claim.claim_type === 'RC') {
    const arrival = parseClock(firstDefined(p.arrived, c.arrivalTime))
    const bookedOff = parseClock(c.bookedOffTime)
    const iv = melbourneInterval(p.date, arrival, bookedOff)
    row.recall_station_id = station(p.recall_stn_id, ref.stations)
    row.recall_start_at = iv.start
    row.recall_end_at = iv.end
    row.recall_duty = DUTY[firstDefined(c.shift, p.shift)] ?? null
    if (iv.start) derivations.push('recall_start_at = claim date + arrival time (Australia/Melbourne)')
    if (iv.end) derivations.push('recall_end_at = claim date + booked-off time, next day when earlier than arrival (Australia/Melbourne)')
    notes.push(...iv.notes)
  } else if (claim.claim_type === 'RT') {
    const shift = firstDefined(p.shift, c.shift)
    const finish = RETAIN_ROSTERED_FINISH[shift]
    const bookedOff = parseClock(firstDefined(p.booked_off_time, c.bookedOffTime))
    const iv = melbourneInterval(p.date, finish ?? null, bookedOff)
    row.retain_start_at = iv.start
    row.retain_end_at = iv.end
    row.retain_shift = DUTY[shift] ?? null
    if (iv.start) derivations.push('retain_start_at = claim date + prototype rostered finish (Day 18:00 / Night 08:00), the basis of the stored hours (Australia/Melbourne)')
    if (iv.end) derivations.push('retain_end_at = claim date + booked-off time, next day when earlier than the rostered finish (Australia/Melbourne)')
    notes.push(...iv.notes)
  } else if (claim.claim_type === 'SB' || claim.claim_type === 'MD') {
    const arrived = parseClock(firstDefined(p.arrived_time, p.arrived, c.arrivedTime))
    const at = arrived == null ? {} : melbourneInstant(p.date, arrived)
    if (at.ambiguous) notes.push(`arrival: ${at.ambiguous}`)
    const matrixVersion = p.matrix_version_id != null ? String(p.matrix_version_id) : null
    if (claim.claim_type === 'SB') {
      row.standby_station_id = station(p.standby_stn_id, ref.stations)
      row.standby_start_at = at.iso ?? null
    } else {
      row.md_station_id = station(p.standby_stn_id, ref.stations)
      row.md_event_at = at.iso ?? null
      // Raw source distances only — the reversed WORK-170 payable-km formula is never computed.
      row.home_to_rostered_km = num(c.homeToRosteredKm)
      row.home_to_target_km = num(c.homeToMdKm)
    }
    row.matrix_hours = num(p.matrix_hours)
    row.matrix_version = matrixVersion
    if (at.iso) derivations.push(`${claim.claim_type === 'SB' ? 'standby_start_at' : 'md_event_at'} = claim date + arrival time (Australia/Melbourne)`)
  } else if (claim.claim_type === 'SM') {
    const interrupted = parseClock(p.meal_interrupted)
    const at = interrupted == null ? {} : melbourneInstant(p.date, interrupted)
    if (at.ambiguous) notes.push(`meal_interrupted: ${at.ambiguous}`)
    row.meal_interrupted_at = at.iso ?? null
    row.emergency_call_ref = firstDefined(p.call_number, c.firecallNumber)
    if (at.iso) derivations.push('meal_interrupted_at = claim date + recorded meal-interrupted time (Australia/Melbourne)')
  }
  // DM: the prototype records no delay fact (cause, notice, break window, duty) — all NULL.
  return { table, row, derivations, notes }
}

/** Value of a stored component on a prototype row. */
export function componentValue(row, component) {
  if (component === 'meal_amount') return num(firstDefined(row.meal_amount, row.total_amount))
  return num(row[component])
}

/** A preserved-historical-value entitlement for one stored component. */
export function buildEntitlement({ claim, table, row, rule, autoChild }) {
  const value = componentValue(row, rule.component)
  const c = ci(row)
  const historical = rule.historical ? num(row[rule.historical]) : null
  return {
    id: entitlementId(table, row.id, rule.component),
    claim_id: claim.id,
    owner_id: claim.owner_id,
    entitlement_type: rule.type,
    unit: rule.unit,
    generated_amount: rule.unit === 'dollars' ? value : null,
    generated_hours: rule.unit === 'hours' ? value : null,
    rule_id: PRESERVED_RULE_ID,
    rule_version: `${TOOL.name}@${TOOL.version}`,
    rule_explanation: `Historical prototype value preserved verbatim from fat.${table}.${rule.component} (row ${row.id}${autoChild ? `, auto-child ${autoChild}` : ''}) by the C2 transform (WORK-190). Not regenerated; canonical rules are compared in the C2 parity report only.`,
    formula_explanation: `preserved = fat.${table}.${rule.component}`,
    rate_id: null,
    rate_version_id: null,
    rate_snapshot: {
      kind: 'prototype_preserved',
      tool: `${TOOL.name}@${TOOL.version}`,
      source_table: table,
      source_row_id: row.id,
      source_column: rule.component,
      auto_child: autoChild ?? null,
      stored_value: value,
      historical_amount: rule.historical ? { column: rule.historical, value: historical, note: 'historical dollars of an hours-first entitlement; never derived from hours' } : null,
      prototype_rates_snapshot: row.rates_snapshot ?? null,
      retain_rate: c.retainRate ?? null,
      retain_rate_used: row.retain_rate_used ?? null,
    },
    payment_method: rule.method,
    payment_status: null,
    generated_at: firstDefined(row.created_at) ?? `${row.date}T00:00:00.000Z`,
    prototype_source: table,
    prototype_row_id: row.id,
    prototype_component: rule.component,
  }
}

/** Manual adjustment (prototype adjusted_amount) → audited override on the entitlement. */
export function buildAdjustment(entitlement, table, row) {
  return {
    id: entitlement.id,
    edited_amount: num(row.adjusted_amount),
    edited_note: `Prototype manual adjustment (fat.${table}.adjusted_amount) preserved by the C2 transform (WORK-190).`,
    edited_source: `prototype:${table}:${row.id}.adjusted_amount`,
  }
}
