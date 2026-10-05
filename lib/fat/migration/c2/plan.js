// ─── C2 transform — deterministic planner (WORK-190) ────────────────────────
// planC2(snapshot, { environment, evidenceClass }) → { plan, report }
//
// Pure and deterministic: identical input → byte-identical plan and report
// (canonical JSON, sorted arrays, no clocks, no random ids). The plan holds the
// exact canonical rows to write; the report is the machine-readable parity
// report stored in fat.migration_batches.report.

import {
  TOOL, REPORT_SCHEMA, SNAPSHOT_SCHEMA, SOURCE_TABLES, CANONICAL_TYPE, DETAIL_TABLE, PARENT_COMPONENTS,
  EXCLUSIONS, INTENDED_DIFFERENCES, GENERATOR_PARITY_TYPES, ACCEPTANCE_GATES,
} from './constants.js'
import { normalise, sha256Json, num, round2, sameMoney } from './util.js'
import { discoverEvents } from './events.js'
import { buildClaim, buildDetail, buildEntitlement, buildAdjustment, componentValue, ledgerId } from './mapping.js'
import { generatorParity, assertKnownClasses } from './parity.js'

const byKey = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0)

function buildReference(snapshot) {
  const r = snapshot.reference || {}
  const classifications = new Map()
  for (const m of r.member_classifications || []) {
    if (!classifications.has(m.owner_id)) classifications.set(m.owner_id, [])
    classifications.get(m.owner_id).push({ classification: m.classification, effective_from: m.effective_from })
  }
  return {
    fys: new Map((r.financial_years || []).map((f) => [f.id, f])),
    stations: new Map((r.stations || []).map((s) => [Number(s.id), s.name ?? null])),
    profiles: new Set(r.profiles || []),
    rates: r.rates || [],
    rateVersions: r.rate_versions || [],
    classifications,
  }
}

function isJulyJune(fy) {
  if (!fy?.start_date || !fy?.end_date) return false
  const [y, m, d] = fy.start_date.split('-').map(Number)
  return m === 7 && d === 1 && fy.end_date === `${y + 1}-06-30`
}

/**
 * Resolve the stored components of one event into entitlement rules, applying
 * the consistency checks that keep every stored dollar attributable (gate 5).
 * Returns { components: [{table,row,rule,autoChild}], exclusions: [...], refuse? }.
 */
function resolveComponents(ev) {
  const p = ev.parent
  const components = []
  const exclusions = []
  const parentMoney = (col) => num(p[col]) ?? 0

  if (ev.appType === 'spoilt' || ev.appType === 'delayed_meal') {
    for (const rule of PARENT_COMPONENTS[ev.appType]) components.push({ table: ev.parentTable, row: p, rule, autoChild: null })
    if (componentValue(p, 'meal_amount') == null) return { refuse: ['missing_stored_amount', 'meal claim has no stored meal_amount / total_amount'] }
    if (p.total_amount != null && p.meal_amount != null && !sameMoney(num(p.total_amount), num(p.meal_amount))) {
      return { refuse: ['parent_child_total_mismatch', `meal_amount ${p.meal_amount} ≠ total_amount ${p.total_amount}`] }
    }
    return { components, exclusions, parentAdjustable: components[0] }
  }

  if (ev.children.length) {
    // Child-carried: every payout lives on an auto-child row.
    let childTotal = 0
    for (const ch of ev.children) {
      if (ch.rule.exclusion) {
        const amounts = [ch.row.travel_amount, ch.row.total_amount, ch.row.mealie_amount, ch.row.adjusted_amount].map(num).filter((x) => x != null)
        if (amounts.some((x) => x !== 0)) {
          return { refuse: ['recall_excess_travel_nonzero', `recall excess_travel child ${ch.row.id} carries a non-zero amount; no rule establishes it and it is not the approved $0 G12 artifact`] }
        }
        exclusions.push({ table: ch.table, row: ch.row, code: ch.rule.exclusion })
        continue
      }
      const v = componentValue(ch.row, ch.rule.component)
      if (v == null) return { refuse: ['missing_stored_amount', `child ${ch.table}:${ch.row.id} has no ${ch.rule.component}`] }
      if (ch.rule.unit === 'dollars') {
        if (ch.row.total_amount != null && !sameMoney(num(ch.row.total_amount), v)) {
          return { refuse: ['child_amount_inconsistent', `child ${ch.table}:${ch.row.id} total_amount ${ch.row.total_amount} ≠ ${ch.rule.component} ${v}`] }
        }
        childTotal += v
      } else {
        const hist = num(ch.row[ch.rule.historical]) ?? 0
        if ((num(ch.row.overnight_cash) ?? 0) !== 0) return { refuse: ['unmapped_stored_component', `child ${ch.row.id} carries overnight_cash`] }
        if (ch.row.total_amount != null && !sameMoney(num(ch.row.total_amount), hist)) {
          return { refuse: ['child_amount_inconsistent', `child ${ch.table}:${ch.row.id} total_amount ${ch.row.total_amount} ≠ ${ch.rule.historical} ${hist}`] }
        }
        childTotal += hist
      }
      components.push(ch)
    }
    if (p.adjusted_amount != null) {
      return { refuse: ['unattributable_parent_adjustment', 'a parent-level adjusted_amount cannot be attributed to one auto-child entitlement'] }
    }
    if (ev.appType === 'standby' || ev.appType === 'md') {
      if (['total_amount', 'travel_amount', 'night_mealie'].some((c) => parentMoney(c) !== 0)) {
        return { refuse: ['unattributable_parent_amount', 'the Standby / M&D parent marker carries a non-zero amount alongside auto-children'] }
      }
    } else {
      if ((num(p.overnight_cash) ?? 0) !== 0) return { refuse: ['unmapped_stored_component', 'retain parent carries overnight_cash that no auto-child carries'] }
      if (!sameMoney(parentMoney('total_amount'), round2(childTotal))) {
        return { refuse: ['parent_child_total_mismatch', `parent total_amount ${p.total_amount} ≠ auto-children ${round2(childTotal)}`] }
      }
    }
    return { components, exclusions, parentAdjustable: null }
  }

  // Parent-carried (legacy rows without auto-children).
  let carried = 0
  for (const rule of PARENT_COMPONENTS[ev.appType]) {
    const v = componentValue(p, rule.component)
    if (v == null || v === 0) continue
    components.push({ table: ev.parentTable, row: p, rule, autoChild: null })
    carried += rule.unit === 'dollars' ? v : (num(p[rule.historical]) ?? 0)
  }
  if ((num(p.overnight_cash) ?? 0) !== 0) return { refuse: ['unmapped_stored_component', 'retain parent carries overnight_cash'] }
  if (!sameMoney(parentMoney('total_amount'), round2(carried))) {
    return { refuse: ['unattributable_parent_amount', `parent total_amount ${p.total_amount} is not fully carried by mappable components (${round2(carried)})`] }
  }
  return { components, exclusions, parentAdjustable: components.length === 1 ? components[0] : null }
}

const sourceTypeOf = (ev) => ev.appType

/** Plan the C2 transform. */
export function planC2(snapshot, { environment, evidenceClass = 'real' } = {}) {
  if (!['dev', 'prod'].includes(environment)) throw new Error('planC2: environment must be dev or prod')
  if (snapshot?.schema !== SNAPSHOT_SCHEMA) throw new Error(`planC2: snapshot schema must be ${SNAPSHOT_SCHEMA}`)
  const source = {}
  for (const t of SOURCE_TABLES) source[t] = normalise(snapshot.source?.[t] || []).sort(byKey('id'))
  const reference = normalise(snapshot.reference || {})
  const target = normalise(snapshot.target || {})
  const ref = buildReference({ reference })

  const sourceChecksum = sha256Json(source)
  const inputFingerprint = sha256Json({ source, reference, target })
  const batchKey = `c2:${environment}:${TOOL.version}:${inputFingerprint.slice(0, 32)}`
  const rowChecksum = new Map()
  for (const t of SOURCE_TABLES) for (const r of source[t]) rowChecksum.set(`${t}:${r.id}`, sha256Json(r))
  const rowOf = new Map()
  for (const t of SOURCE_TABLES) for (const r of source[t]) rowOf.set(`${t}:${r.id}`, r)

  const { events, refused } = discoverEvents(source)

  // Resolve claim number + FY + owner; detect duplicates in the established scope.
  const resolved = []
  for (const ev of events) {
    const p = ev.parent
    const refuse = (code, reason) => refused.push({ key: ev.key, code, reason, rows: ev.rows, group_id: ev.group?.id ?? null, source_claim_type: sourceTypeOf(ev) })
    if (!ref.profiles.has(p.user_id)) { refuse('owner_missing', `owner ${p.user_id} has no fat.profiles row`); continue }
    const gn = num(ev.group?.claim_number); const pn = num(p.claim_number)
    if (gn != null && pn != null && gn !== pn) { refuse('claim_number_conflict', `group number ${gn} ≠ parent number ${pn}`); continue }
    const gf = ev.group?.financial_year_id ?? null; const pf = p.financial_year_id ?? null
    if (gf && pf && gf !== pf) { refuse('financial_year_conflict', `group FY ${gf} ≠ parent FY ${pf}`); continue }
    ev.claimNumber = gn ?? pn
    ev.financialYearId = gf ?? pf
    if (ev.claimNumber != null && ev.claimNumber <= 0) { refuse('claim_number_invalid', `claim number ${ev.claimNumber}`); continue }
    if (ev.claimNumber != null && !ev.financialYearId) { refuse('missing_financial_year', 'a claim number requires its financial year'); continue }
    if (ev.financialYearId) {
      const fy = ref.fys.get(ev.financialYearId)
      if (!fy || fy.user_id !== p.user_id) { refuse('financial_year_not_owned', `FY ${ev.financialYearId} does not exist for owner ${p.user_id}`); continue }
      if (!isJulyJune(fy)) { refuse('financial_year_not_july_june', `FY ${fy.label} is not 1 July → 30 June`); continue }
    }
    const comp = resolveComponents(ev)
    if (comp.refuse) { refuse(...comp.refuse); continue }
    ev.components = comp.components
    ev.exclusions = comp.exclusions
    ev.parentAdjustable = comp.parentAdjustable
    ev.canonicalType = CANONICAL_TYPE[ev.appType]
    resolved.push(ev)
  }
  const scope = new Map()
  for (const ev of resolved) {
    if (ev.claimNumber == null) continue
    const k = `${ev.parent.user_id}|${ev.financialYearId}|${ev.canonicalType}|${ev.claimNumber}`
    if (!scope.has(k)) scope.set(k, [])
    scope.get(k).push(ev)
  }
  const dup = new Set([...scope.values()].filter((l) => l.length > 1).flat())
  for (const ev of dup) {
    refused.push({ key: ev.key, code: 'duplicate_claim_number', reason: `claim number ${ev.claimNumber} is used by more than one ${ev.canonicalType} event for this owner and FY`, rows: ev.rows, group_id: ev.group?.id ?? null, source_claim_type: sourceTypeOf(ev) })
  }
  const migrated = resolved.filter((ev) => !dup.has(ev))

  // Build the plan.
  const claims = []
  const details = Object.fromEntries(Object.values(DETAIL_TABLE).map((t) => [t, []]))
  const entitlements = []
  const adjustments = []
  const ledger = []
  const eventReports = []
  const parityItems = []
  const exclusionsOut = []
  const missingTally = {}

  for (const ev of migrated) {
    const claim = buildClaim(ev, ref)
    const detail = buildDetail(ev, claim, ref)
    claims.push(claim)
    details[detail.table].push(detail.row)
    const evEnts = []
    for (const comp of ev.components) {
      const e = buildEntitlement({ claim, table: comp.table, row: comp.row, rule: comp.rule, autoChild: comp.autoChild })
      entitlements.push(e)
      evEnts.push(e)
      const adjustable = comp.row !== ev.parent || ev.parentAdjustable === comp
      if (comp.row.adjusted_amount != null && adjustable) adjustments.push(buildAdjustment(e, comp.table, comp.row))
    }
    const sourceType = sourceTypeOf(ev)
    const ledgerRow = (table, row, disposition, extra = {}) => ({
      id: ledgerId(table, row.id),
      owner_id: claim.owner_id,
      source_table: table,
      source_row_id: row.id,
      source_claim_group_id: ev.group?.id ?? null,
      source_claim_type: sourceType,
      source_checksum: rowChecksum.get(`${table}:${row.id}`),
      source_snapshot: row,
      disposition,
      target_claim_id: claim.id,
      exclusion_code: null,
      exclusion_reason: null,
      ...extra,
    })
    if (ev.group) ledger.push(ledgerRow('claim_groups', ev.group, 'claim'))
    ledger.push(ledgerRow(ev.parentTable, ev.parent, 'claim'))
    for (const ch of ev.children) {
      const ex = ev.exclusions.find((x) => x.row === ch.row)
      if (ex) {
        ledger.push(ledgerRow(ch.table, ch.row, 'excluded', { exclusion_code: ex.code, exclusion_reason: EXCLUSIONS[ex.code].reason }))
        exclusionsOut.push({ event: ev.key, source_table: ch.table, source_row_id: ch.row.id, exclusion_code: ex.code, stored_amount: num(ch.row.total_amount) })
      } else {
        ledger.push(ledgerRow(ch.table, ch.row, 'entitlement'))
      }
    }

    let items = []
    if (GENERATOR_PARITY_TYPES.includes(claim.claim_type)) {
      items = generatorParity(ev, claim, detail.row, ref)
      assertKnownClasses(items)
      for (const it of items) for (const f of it.missing_inputs || []) missingTally[`${claim.claim_type}.${f}`] = (missingTally[`${claim.claim_type}.${f}`] ?? 0) + 1
      parityItems.push(...items)
    }
    eventReports.push({
      event: ev.key,
      source: {
        claim_group_id: ev.group?.id ?? null,
        parent_table: ev.parentTable,
        parent_row_id: ev.parent.id,
        source_claim_type: sourceType,
        child_rows: ev.children.map((c) => `${c.table}:${c.row.id}`).sort(),
      },
      claim_id: claim.id,
      claim_type: claim.claim_type,
      owner_id: claim.owner_id,
      claim_number: claim.claim_number,
      financial_year_id: claim.financial_year_id,
      detail_table: detail.table,
      derivations: detail.derivations,
      detail_notes: detail.notes,
      entitlements: evEnts.map((e) => ({ id: e.id, type: e.entitlement_type, unit: e.unit, component: `${e.prototype_source}.${e.prototype_component}`, amount: e.generated_amount, hours: e.generated_hours })),
      excluded: ev.exclusions.map((x) => `${x.table}:${x.row.id}`),
    })
  }

  claims.sort(byKey('id'))
  for (const t of Object.keys(details)) details[t].sort(byKey('claim_id'))
  entitlements.sort(byKey('id'))
  adjustments.sort(byKey('id'))
  ledger.sort(byKey('id'))
  eventReports.sort(byKey('event'))
  parityItems.sort((a, b) => (a.event + a.entitlement_type < b.event + b.entitlement_type ? -1 : 1))
  exclusionsOut.sort(byKey('source_row_id'))
  refused.sort(byKey('key'))

  const gates = evaluateGates({ source, events: migrated, refused, claims, details, entitlements, adjustments, ledger, rowOf, ref })
  const acceptance = ACCEPTANCE_GATES.every((g) => gates[g].status === 'pass')

  const generatorByType = {}
  for (const t of GENERATOR_PARITY_TYPES) {
    const its = parityItems.filter((i) => i.claim_type === t)
    const count = (c) => its.filter((i) => i.classification === c).length
    generatorByType[t] = {
      events: new Set(its.map((i) => i.event)).size,
      exact_match: count('exact_match'),
      intended_difference: count('intended_difference'),
      genuine_failure: count('genuine_failure'),
      excluded_artifact: count('excluded_artifact'),
      unable_to_generate: count('unable_to_generate'),
    }
  }

  const report = {
    schema: REPORT_SCHEMA,
    tool: { ...TOOL },
    environment,
    evidence_class: evidenceClass,
    batch_key: batchKey,
    source_checksum: sourceChecksum,
    input_fingerprint: inputFingerprint,
    source: {
      rows: Object.fromEntries(SOURCE_TABLES.map((t) => [t, source[t].length])),
      events: migrated.length + refused.length,
      events_migrated: migrated.length,
      events_refused: refused.length,
      migrated_by_type: Object.fromEntries(Object.values(CANONICAL_TYPE).map((t) => [t, migrated.filter((e) => e.canonicalType === t).length])),
    },
    outcome: acceptance ? 'pass' : 'fail',
    acceptance: { required_gates: [...ACCEPTANCE_GATES], passed: acceptance },
    gates,
    planned: {
      claims: claims.length,
      details: Object.fromEntries(Object.entries(details).map(([t, r]) => [t, r.length])),
      entitlements: entitlements.length,
      adjustments: adjustments.length,
      ledger: {
        claim: ledger.filter((l) => l.disposition === 'claim').length,
        entitlement: ledger.filter((l) => l.disposition === 'entitlement').length,
        excluded: ledger.filter((l) => l.disposition === 'excluded').length,
      },
      payment_records: 0,
      payment_note: 'Historical payment state is not mapped by C2; C3 (WORK-191) owns it. Migrated entitlements carry payment_status NULL.',
    },
    events: eventReports,
    refused: refused.map((r) => ({ event: r.key, code: r.code, reason: r.reason, classification: 'genuine_failure', rows: r.rows.map((x) => `${x.table}:${x.id}`).sort() })),
    exclusions: exclusionsOut,
    generator_parity: {
      scope: [...GENERATOR_PARITY_TYPES],
      basis: 'canonical WORK-173 generators run in memory on the mapped facts vs the prototype stored behaviour; report-only, nothing persisted, no stored amount recalculated',
      by_type: generatorByType,
      missing_inputs: Object.fromEntries(Object.entries(missingTally).sort()),
      items: parityItems,
    },
    intended_difference_classes: INTENDED_DIFFERENCES,
    exclusion_codes: EXCLUSIONS,
    bridge_mirrors: bridgeMirrors(target, claims, details),
  }
  const plan = { batch_key: batchKey, environment, source_checksum: sourceChecksum, report, claims, details, entitlements, adjustments, ledger }
  return { plan, report }
}

/** Native (non-migrated) canonical claims and their deterministic candidate matches — reported, never touched. */
function bridgeMirrors(target, claims, details) {
  const natives = [...(target.native_claims || [])].sort(byKey('id'))
  const destOf = (c) => {
    const t = DETAIL_TABLE[c.claim_type]
    const d = (details[t] || []).find((x) => x.claim_id === c.id)
    return d ? (d.standby_station_id ?? d.md_station_id ?? null) : null
  }
  const matched = []
  for (const n of natives) {
    const hits = claims.filter((c) => c.owner_id === n.owner_id && c.claim_type === n.claim_type && c.claim_date === n.claim_date
      && (c.station_id_snapshot ?? null) === (num(n.station_id_snapshot) ?? null) && destOf(c) === (num(n.dest_station_id) ?? null))
    if (hits.length) matched.push({ native_claim_id: n.id, migrated_claim_ids: hits.map((h) => h.id).sort(), ambiguous: hits.length > 1 })
  }
  return {
    policy: 'native canonical claims are never adopted, modified or deleted by C2; candidate matches are listed for C5 (WORK-193) to retire at cutover',
    native_claims: natives.length,
    native_by_type: natives.reduce((o, n) => ({ ...o, [n.claim_type]: (o[n.claim_type] ?? 0) + 1 }), {}),
    matched,
    unmatched: natives.length - matched.length,
  }
}

function sumBy(rows, keyFn, valFn) {
  const m = {}
  for (const r of rows) { const k = keyFn(r); m[k] = round2((m[k] ?? 0) + (valFn(r) ?? 0)) }
  return Object.fromEntries(Object.entries(m).sort())
}

function evaluateGates({ events, refused, claims, details, entitlements, adjustments, ledger, rowOf, ref }) {
  const claimById = new Map(claims.map((c) => [c.id, c]))
  const gkey = (owner, type, fy) => `${owner}|${type}|${fy ?? 'none'}`

  // 1. Logical event count parity by owner, type and FY.
  const srcCounts = {}
  for (const ev of events) { const k = gkey(ev.parent.user_id, ev.canonicalType, ev.financialYearId); srcCounts[k] = (srcCounts[k] ?? 0) + 1 }
  const tgtCounts = {}
  for (const c of claims) { const k = gkey(c.owner_id, c.claim_type, c.financial_year_id); tgtCounts[k] = (tgtCounts[k] ?? 0) + 1 }
  const g1 = refused.length === 0 && JSON.stringify(Object.entries(srcCounts).sort()) === JSON.stringify(Object.entries(tgtCounts).sort())

  // 2. Exact claim-number preservation within the established scope.
  const numMismatch = events.filter((ev) => {
    const c = claims.find((x) => x.prototype_row_id === ev.parent.id)
    return !c || c.claim_number !== ev.claimNumber || c.financial_year_id !== ev.financialYearId
  }).length
  const scopeKeys = claims.filter((c) => c.claim_number != null).map((c) => `${c.owner_id}|${c.financial_year_id}|${c.claim_type}|${c.claim_number}`)
  const dupScope = scopeKeys.length - new Set(scopeKeys).size
  const numberRefusals = refused.filter((r) => ['duplicate_claim_number', 'claim_number_conflict', 'missing_financial_year', 'financial_year_conflict', 'financial_year_not_owned', 'financial_year_not_july_june', 'claim_number_invalid'].includes(r.code)).length
  const g2 = numMismatch === 0 && dupScope === 0 && numberRefusals === 0

  // 3. Each parent → exactly one claim + one detail row of the correct type.
  const detailCount = new Map()
  for (const [t, rows] of Object.entries(details)) for (const d of rows) detailCount.set(d.claim_id, [...(detailCount.get(d.claim_id) || []), t])
  const badDetail = claims.filter((c) => { const ts = detailCount.get(c.id) || []; return ts.length !== 1 || ts[0] !== DETAIL_TABLE[c.claim_type] }).length
  const structural = refused.filter((r) => !['duplicate_claim_number', 'claim_number_conflict', 'missing_financial_year', 'financial_year_conflict', 'financial_year_not_owned', 'financial_year_not_july_june', 'claim_number_invalid'].includes(r.code)).length
  const g3 = badDetail === 0 && structural === 0 && claims.length === events.length

  // 4. Each legitimate auto-child → exactly one entitlement, or a named approved exclusion.
  const childLedger = ledger.filter((l) => l.disposition !== 'claim')
  const entCountByRow = {}
  for (const e of entitlements) { const k = `${e.prototype_source}:${e.prototype_row_id}`; entCountByRow[k] = (entCountByRow[k] ?? 0) + 1 }
  const badChild = childLedger.filter((l) => {
    const n = entCountByRow[`${l.source_table}:${l.source_row_id}`] ?? 0
    return l.disposition === 'entitlement' ? n !== 1 : (n !== 0 || !EXCLUSIONS[l.exclusion_code])
  }).length
  const childRefusals = refused.filter((r) => ['unrecognised_child', 'recall_excess_travel_nonzero', 'orphan_child'].includes(r.code)).length
  const g4 = badChild === 0 && childRefusals === 0

  // 5. Amount / hour / unit reconciliation, by owner/FY/type and globally.
  const src = []
  for (const e of entitlements) {
    const row = rowOf.get(`${e.prototype_source}:${e.prototype_row_id}`)
    const c = claimById.get(e.claim_id)
    const histCol = e.rate_snapshot?.historical_amount?.column
    src.push({
      k: gkey(c.owner_id, c.claim_type, c.financial_year_id), unit: e.unit,
      source_value: componentValue(row, e.prototype_component), target_value: e.unit === 'dollars' ? e.generated_amount : e.generated_hours,
      source_hist: histCol ? num(row[histCol]) : null, target_hist: e.rate_snapshot?.historical_amount?.value ?? null,
    })
  }
  const recon = (unit) => {
    const rows = src.filter((s) => s.unit === unit)
    return {
      source_by_owner_type_fy: sumBy(rows, (s) => s.k, (s) => s.source_value),
      target_by_owner_type_fy: sumBy(rows, (s) => s.k, (s) => s.target_value),
      source_total: round2(rows.reduce((t, s) => t + (s.source_value ?? 0), 0)),
      target_total: round2(rows.reduce((t, s) => t + (s.target_value ?? 0), 0)),
    }
  }
  const dollars = recon('dollars')
  const hours = recon('hours')
  const hist = { source_total: round2(src.reduce((t, s) => t + (s.source_hist ?? 0), 0)), target_total: round2(src.reduce((t, s) => t + (s.target_hist ?? 0), 0)) }
  const adjSource = round2(entitlements.reduce((t, e) => {
    const row = rowOf.get(`${e.prototype_source}:${e.prototype_row_id}`)
    return t + (adjustments.find((a) => a.id === e.id) ? num(row.adjusted_amount) ?? 0 : 0)
  }, 0))
  const adjTarget = round2(adjustments.reduce((t, a) => t + (a.edited_amount ?? 0), 0))
  const excludedAmount = round2(ledger.filter((l) => l.disposition === 'excluded').reduce((t, l) => t + (num(l.source_snapshot.total_amount) ?? 0), 0))
  const amountRefusals = refused.filter((r) => ['parent_child_total_mismatch', 'child_amount_inconsistent', 'unattributable_parent_amount', 'unattributable_parent_adjustment', 'unmapped_stored_component', 'missing_stored_amount'].includes(r.code)).length
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const g5 = amountRefusals === 0
    && eq(dollars.source_by_owner_type_fy, dollars.target_by_owner_type_fy) && sameMoney(dollars.source_total, dollars.target_total)
    && eq(hours.source_by_owner_type_fy, hours.target_by_owner_type_fy) && sameMoney(hours.source_total, hours.target_total)
    && sameMoney(hist.source_total, hist.target_total) && sameMoney(adjSource, adjTarget)

  // 7. No orphans, no cross-owner rows (plan side; the DB re-proves it).
  const orphanEnts = entitlements.filter((e) => !claimById.has(e.claim_id)).length
  const crossOwnerEnts = entitlements.filter((e) => claimById.get(e.claim_id)?.owner_id !== e.owner_id).length
  const crossOwnerFy = claims.filter((c) => c.financial_year_id && ref.fys.get(c.financial_year_id)?.user_id !== c.owner_id).length
  const orphanLedger = ledger.filter((l) => !claimById.has(l.target_claim_id)).length
  const crossOwnerLedger = ledger.filter((l) => claimById.get(l.target_claim_id)?.owner_id !== l.owner_id).length
  const orphanDetails = Object.values(details).flat().filter((d) => !claimById.has(d.claim_id)).length
  const ownerRefusals = refused.filter((r) => ['cross_owner_group', 'owner_missing'].includes(r.code)).length
  const g7 = orphanEnts + crossOwnerEnts + crossOwnerFy + orphanLedger + crossOwnerLedger + orphanDetails + ownerRefusals === 0

  const st = (b) => (b ? 'pass' : 'fail')
  return {
    1: { name: 'Logical operational-event count parity by owner, type and FY', status: st(g1), evidence: { source: Object.fromEntries(Object.entries(srcCounts).sort()), canonical: Object.fromEntries(Object.entries(tgtCounts).sort()), refused_events: refused.length } },
    2: { name: 'Exact claim-number preservation and existing uniqueness scope', status: st(g2), evidence: { scope: '(owner_id, financial_year_id, claim_type, claim_number)', mismatches: numMismatch, duplicates_in_scope: dupScope, number_or_fy_refusals: numberRefusals, claims_without_number: claims.filter((c) => c.claim_number == null).length } },
    3: { name: 'Each prototype parent → exactly one canonical claim + one correct detail row', status: st(g3), evidence: { parents: events.length, claims: claims.length, wrong_or_missing_detail: badDetail, structural_refusals: structural } },
    4: { name: 'Each legitimate auto-child → exactly one entitlement, or a named approved exclusion', status: st(g4), evidence: { child_rows: childLedger.length, entitlement_dispositions: childLedger.filter((l) => l.disposition === 'entitlement').length, excluded: childLedger.filter((l) => l.disposition === 'excluded').length, violations: badChild, child_refusals: childRefusals } },
    5: { name: 'Amount / hour / unit reconciliation by owner/FY/type and globally', status: st(g5), evidence: { dollars, hours, historical_dollars_of_hours_entitlements: hist, adjustments: { source: adjSource, target_edited: adjTarget, count: adjustments.length }, approved_exclusions_amount: excludedAmount, amount_refusals: amountRefusals } },
    6: { name: 'Historical payment state reconciled to canonical payment records/links/audit', status: 'not_evaluated', owner: 'C3 — WORK-191', evidence: { note: 'C2 creates no payment record or link; migrated entitlements carry payment_status NULL' } },
    7: { name: 'No orphan details/entitlements/links; no cross-owner rows; ownership and RLS', status: st(g7), evidence: { orphan_entitlements: orphanEnts, cross_owner_entitlements: crossOwnerEnts, cross_owner_fy: crossOwnerFy, orphan_ledger: orphanLedger, cross_owner_ledger: crossOwnerLedger, orphan_details: orphanDetails, owner_refusals: ownerRefusals, db: 're-proved by apply postconditions and the verify query (FKs, RLS, API privileges, payment links)' } },
    8: { name: 'Frozen-source archive counts and checksums match', status: 'not_evaluated', owner: 'C4 — WORK-192 (write freeze + archive)', evidence: { note: 'C2 records the source checksum and a per-row checksum on every ledger row for C4 to compare' } },
    9: { name: 'Application smoke tests pass while the prototype source stays read-only', status: 'not_evaluated', owner: 'C5 — WORK-193' },
  }
}
