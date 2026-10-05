// ─── C2 transform — WORK-173 generator parity (WORK-190) ────────────────────
// Report-only. For each migrated RC / RT / SM / DM event the canonical WORK-173
// generator is run in memory on the mapped facts and compared with the
// prototype's stored behaviour. Nothing here is persisted and no stored amount
// is recalculated. Hours-first: retain is classified on hours; dollars are
// shown (stored historical value vs canonical estimate) but never converted.
//
// Classifications: exact_match | intended_difference | genuine_failure |
// excluded_artifact | unable_to_generate.

import { resolveRateVersion, resolveOvertimeRate } from '../../rates/rateModel.js'
import { generateRecallEntitlements } from '../../engine/generators/recall.js'
import { generateRetainEntitlements } from '../../engine/generators/retain.js'
import { generateSpoiltMealEntitlements } from '../../engine/generators/spoiltMeal.js'
import { generateDelayedMealEntitlements } from '../../engine/generators/delayedMeal.js'
import { calcRetainHours } from '../../../calculations/engine.js'
import { REQUIRED_FACTS, INTENDED_DIFFERENCES } from './constants.js'
import { num, round2, sameMoney } from './util.js'

const GENERATORS = {
  RC: generateRecallEntitlements,
  RT: generateRetainEntitlements,
  SM: generateSpoiltMealEntitlements,
  DM: generateDelayedMealEntitlements,
}

/** Engine context over the extracted catalog — the claim-time rostered station, never today's profile. */
export function parityContext(ref, ownerId, rosteredStationId) {
  const catalog = { rates: ref.rates, versions: ref.rateVersions }
  const history = ref.classifications.get(ownerId) || []
  const skips = []
  return {
    skips,
    onSkip: (s) => skips.push(s),
    profileSnapshot: { id: ownerId, rostered_station_id: rosteredStationId ?? null, rostered_station_name: null },
    rateLookup: (code, date) => {
      const h = resolveRateVersion(catalog, code, date)
      return h ? { rate: h.rate, rateVersion: h.version, value: Number(h.value) } : null
    },
    overtimeLookup: (date, multiplierCode) => resolveOvertimeRate(catalog, { date, classificationHistory: history, multiplierCode }),
    matrixLookup: () => null,
  }
}

function missingFacts(type, facts) {
  return (REQUIRED_FACTS[type] || []).filter((k) => facts[k] === null || facts[k] === undefined)
}

function canonicalSide(drafts, type) {
  const rows = drafts.filter((d) => d.entitlement_type === type)
  return {
    rows: rows.length,
    hours: rows.length && rows[0].unit === 'hours' ? round2(rows.reduce((s, d) => s + (d.generated_hours ?? 0), 0)) : null,
    amount: rows.length && rows[0].unit === 'dollars' ? round2(rows.reduce((s, d) => s + (d.generated_amount ?? 0), 0)) : null,
    estimate: rows.length && rows.every((d) => d.unit === 'hours' && d.rate_snapshot?.estimate != null)
      ? round2(rows.reduce((s, d) => s + d.rate_snapshot.estimate, 0))
      : null,
  }
}

const skipFor = (ctx, type) => ctx.skips.filter((s) => s.entitlement_type === type)

function item(ev, type, cls, extra) {
  return {
    event: ev.key,
    claim_type: ev.canonicalType,
    entitlement_type: type,
    classification: cls,
    ...extra,
  }
}

/** Classify a meal comparison (count and per-meal amount) under a type-specific rule class. */
function mealItem(ev, type, proto, canon, ctx, facts, ruleClass) {
  const skips = skipFor(ctx, type)
  if (skips.length) {
    return item(ev, type, 'unable_to_generate', {
      prototype: proto, canonical: null,
      missing_inputs: missingFacts(type, facts),
      reasons: skips.map((s) => `${s.reason}${s.detail ? `: ${s.detail}` : ''}`),
    })
  }
  const canonical = { count: canon.rows, amount: canon.amount ?? 0 }
  if (proto.count === canonical.count && sameMoney(proto.amount, canonical.amount)) {
    return item(ev, type, 'exact_match', { prototype: proto, canonical })
  }
  const classes = []
  if (proto.count !== canonical.count) classes.push(ruleClass)
  const perProto = proto.count ? proto.amount / proto.count : null
  const perCanon = canonical.count ? canonical.amount / canonical.count : null
  if (perProto != null && perCanon != null && !sameMoney(perProto, perCanon)) classes.push('MEAL_RATE_SCHEDULE_4')
  if (proto.count === canonical.count && !classes.length) classes.push('MEAL_RATE_SCHEDULE_4')
  return item(ev, type, 'intended_difference', { prototype: proto, canonical, intended_classes: classes })
}

/** Items present only in the canonical model (prototype never stored them). */
function canonicalOnlyItem(ev, type, canon, ctx, facts, intendedClass) {
  const skips = skipFor(ctx, type)
  if (canon.rows > 0) {
    return item(ev, type, 'intended_difference', { prototype: null, canonical: canon, intended_classes: [intendedClass] })
  }
  if (skips.length) {
    return item(ev, type, 'unable_to_generate', {
      prototype: null, canonical: null, missing_inputs: missingFacts(type, facts),
      reasons: skips.map((s) => `${s.reason}${s.detail ? `: ${s.detail}` : ''}`), intended_class_if_generated: intendedClass,
    })
  }
  return item(ev, type, 'exact_match', { prototype: null, canonical: null, note: 'neither model produces this entitlement for these facts' })
}

const childOf = (ev, autoChild) => ev.children.filter((c) => c.autoChild === autoChild)
const sumValues = (rows, col) => round2(rows.reduce((s, r) => s + (num(r[col]) ?? 0), 0))

function recallItems(ev, drafts, ctx, facts) {
  const c = ev.parent.calculation_inputs || {}
  const out = []
  out.push(canonicalOnlyItem(ev, 'recall_overtime', canonicalSide(drafts, 'recall_overtime'), ctx, facts, 'RC_OVERTIME_128_2'))
  out.push(canonicalOnlyItem(ev, 'recall_travel_time', canonicalSide(drafts, 'recall_travel_time'), ctx, facts, 'RC_TRAVEL_TIME_128_4'))
  out.push(canonicalOnlyItem(ev, 'relieving_allowance', canonicalSide(drafts, 'relieving_allowance'), ctx, facts, 'RC_RELIEVING_85_8_10'))

  // Mileage: prototype Callback-Ops travel $ (route Home→Rostered→Recall→Rostered→Home at the prototype km rate).
  const cb = childOf(ev, 'callback_ops').map((x) => x.row)
  const protoMileage = { amount: ev.children.length ? sumValues(cb, 'travel_amount') : round2(num(ev.parent.travel_amount) ?? 0), km: num(ev.parent.total_km) }
  const mileage = canonicalSide(drafts, 'recall_mileage')
  if (mileage.rows === 0) {
    out.push(item(ev, 'recall_mileage', 'unable_to_generate', {
      prototype: protoMileage, canonical: null, missing_inputs: missingFacts('recall_mileage', facts),
      reasons: ['the prototype records one-way Home→Rostered and Rostered→Recall legs on a different route model, not the actual home → recall location → home distance cl 128.4 requires'],
    }))
  } else {
    out.push(sameMoney(protoMileage.amount, mileage.amount)
      ? item(ev, 'recall_mileage', 'exact_match', { prototype: protoMileage, canonical: mileage })
      : item(ev, 'recall_mileage', 'genuine_failure', { prototype: protoMileage, canonical: mileage, reason: 'mileage differs with no approved intended-difference class' }))
  }

  const meal = childOf(ev, 'petty_cash_meal').map((x) => x.row)
  const protoMeal = {
    count: (num(c.smallMealCount) ?? 0) + (num(c.largeMealCount) ?? 0),
    amount: ev.children.length ? sumValues(meal, 'meal_amount') : round2(num(ev.parent.mealie_amount) ?? 0),
    tier: c.mealTier ?? null,
  }
  out.push(mealItem(ev, 'recall_meal', protoMeal, canonicalSide(drafts, 'recall_meal'), ctx, facts, 'RC_MEAL_RULE_85_6_3'))

  for (const x of childOf(ev, 'excess_travel')) {
    out.push(item(ev, 'recall_excess_travel', 'excluded_artifact', {
      prototype: { source_row_id: x.row.id, amount: num(x.row.total_amount) }, canonical: null, exclusion_code: 'G12_FAKE_RECALL_EXCESS_TRAVEL',
    }))
  }
  return out
}

function retainItems(ev, drafts, ctx, facts) {
  const p = ev.parent
  const c = p.calculation_inputs || {}
  const out = []
  const maint = childOf(ev, 'maint_stn_nn').map((x) => x.row)
  const protoHours = ev.children.length ? sumValues(maint, 'generated_hours') : round2(num(p.generated_hours) ?? 0)
  const protoAmount = ev.children.length ? sumValues(maint, 'retain_amount') : round2(num(p.retain_amount) ?? 0)
  const canon = canonicalSide(drafts, 'retain_overtime')
  const skips = skipFor(ctx, 'retain_overtime')
  const proto = { hours: protoHours, stored_amount: protoAmount }
  const shift = p.shift ?? c.shift
  const bookedOff = p.booked_off_time ?? c.bookedOffTime
  // Decidable when a row was generated, the time rounds to zero, or both instants
  // are known (a zero-length retention generates nothing — 0 h).
  const decidable = canon.rows > 0 || skips.every((s) => s.reason === 'rounds-to-zero') || (facts.retain_start_at != null && facts.retain_end_at != null)
  if (!decidable) {
    out.push(item(ev, 'retain_overtime', 'unable_to_generate', {
      prototype: proto, canonical: null, missing_inputs: missingFacts('retain_overtime', facts),
      reasons: skips.map((s) => s.reason),
    }))
  } else {
    const canonical = { hours: canon.rows ? canon.hours : 0, estimate: canon.estimate, estimate_note: 'WORK-246 estimate; hours-first, not compared as dollars' }
    if (canonical.hours === protoHours) {
      out.push(item(ev, 'retain_overtime', 'exact_match', { prototype: proto, canonical }))
    } else {
      // The prototype's own rule, recomputed from its recorded facts.
      const recomputed = calcRetainHours({ shift, bookedOffTime: typeof bookedOff === 'string' && /^\d{4}$/.test(bookedOff) ? `${bookedOff.slice(0, 2)}:${bookedOff.slice(2)}` : bookedOff }).hours
      if (recomputed !== protoHours) {
        out.push(item(ev, 'retain_overtime', 'genuine_failure', { prototype: { ...proto, recomputed_hours: recomputed }, canonical, reason: 'stored prototype hours do not match the prototype rule for its own recorded facts' }))
      } else if (Math.abs(canonical.hours - protoHours) <= 0.25 && protoHours >= canonical.hours) {
        out.push(item(ev, 'retain_overtime', 'intended_difference', { prototype: proto, canonical, intended_classes: ['RT_NEAREST_QUARTER_128_1'] }))
      } else {
        out.push(item(ev, 'retain_overtime', 'genuine_failure', { prototype: proto, canonical, reason: 'hours differ by more than the ceiling-vs-nearest quarter-hour correction' }))
      }
    }
  }

  const meal = childOf(ev, 'retain_meal').map((x) => x.row)
  const mc = meal[0]?.calculation_inputs || c
  const protoMeal = {
    count: (num(mc.smallMealCount) ?? 0) + (num(mc.largeMealCount) ?? 0),
    amount: ev.children.length ? sumValues(meal, 'meal_amount') : 0,
    tier: mc.mealTier ?? null,
  }
  out.push(mealItem(ev, 'retain_meal', protoMeal, canonicalSide(drafts, 'retain_meal'), ctx, facts, 'RT_MEAL_RULE_85_6_4'))
  out.push(canonicalOnlyItem(ev, 'retain_travel_home', canonicalSide(drafts, 'retain_travel_home'), ctx, facts, 'RT_TRAVEL_HOME_85_8_9'))
  return out
}

function mealClaimItems(ev, drafts, ctx, facts, type, intendedClass) {
  const proto = { count: 1, amount: round2(num(ev.parent.meal_amount ?? ev.parent.total_amount) ?? 0), meal_type: ev.parent.meal_type ?? null }
  const canon = canonicalSide(drafts, type)
  const skips = skipFor(ctx, type)
  if (canon.rows === 0) {
    if (skips.length) {
      return [item(ev, type, 'unable_to_generate', {
        prototype: proto, canonical: null, missing_inputs: missingFacts(type, facts),
        reasons: skips.map((s) => `${s.reason}${s.detail ? `: ${s.detail}` : ''}`), intended_class_if_generated: intendedClass,
      })]
    }
    return [item(ev, type, 'genuine_failure', { prototype: proto, canonical: { count: 0, amount: 0 }, reason: 'the canonical rule denies an allowance the prototype stored' })]
  }
  const canonical = { count: canon.rows, amount: canon.amount }
  return sameMoney(proto.amount, canonical.amount)
    ? [item(ev, type, 'exact_match', { prototype: proto, canonical })]
    : [item(ev, type, 'intended_difference', { prototype: proto, canonical, intended_classes: [intendedClass] })]
}

/** Generator parity items for one mapped event (RC / RT / SM / DM only). */
export function generatorParity(ev, claim, detailRow, ref) {
  const gen = GENERATORS[claim.claim_type]
  if (!gen) return []
  const ctx = parityContext(ref, claim.owner_id, claim.station_id_snapshot)
  const drafts = gen(claim, detailRow, ctx)
  const facts = { ...detailRow, rostered_station_id: claim.station_id_snapshot }
  if (claim.claim_type === 'RC') return recallItems(ev, drafts, ctx, facts)
  if (claim.claim_type === 'RT') return retainItems(ev, drafts, ctx, facts)
  if (claim.claim_type === 'SM') return mealClaimItems(ev, drafts, ctx, facts, 'spoilt_meal', 'SM_SPOILT_ALLOWANCE_85_7_1')
  return mealClaimItems(ev, drafts, ctx, facts, 'delayed_meal', 'DM_MEAL_ALLOWANCE_85_6_6')
}

export function assertKnownClasses(items) {
  for (const it of items) {
    for (const c of it.intended_classes || []) if (!INTENDED_DIFFERENCES[c]) throw new Error(`unknown intended class ${c}`)
  }
}
