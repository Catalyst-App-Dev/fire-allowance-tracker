// ─── C3 historical payment state → canonical payment records (WORK-191) ─────
// Pure. Maps the prototype's per-row payment toggles (payment_status,
// payment_date, payslip_pay_nbr) onto the canonical payment model C1 made
// representable: one prototype_migration payment_records row + one manual
// entitlement_payment_links allocation per PAID entitlement; nothing for an
// unpaid one. The entitlement's payment_status is then whatever the canonical
// recompute derives (fat._reconc_recompute) — the prototype toggle is evidence,
// never the stored truth.
//
// Contract: docs/architecture/C3_PAYMENT_STATE_CONTRACT.md. Nothing is guessed:
// evidence that cannot be mapped deterministically is a genuine gate-6 failure.

import { ID_NAMESPACE, TOOL, PAYMENT_STATUS, PAYMENT_FAILURES, PAYMENT_STRUCTURAL } from './constants.js'
import { uuidv5, num, round2, sameMoney, melbourneDate } from './util.js'

export const paymentSourceKey = (table, rowId, component) => `c3:${table}:${rowId}:${component}`
export const paymentRecordId = (key) => uuidv5(`payment_record:${key}`, ID_NAMESPACE)
export const linkNote = (key) => `prototype_migration ${key} (C3, WORK-191)`

const norm = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim().toLowerCase())
const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim())

/**
 * Classify one prototype row's payment evidence.
 * → { state: 'paid' | 'unpaid', ... } or { fail: <PAYMENT_FAILURES code> }.
 */
export function sourcePaymentState(row) {
  const ps = norm(row.payment_status)
  const legacy = norm(row.status)
  const date = text(row.payment_date)
  const evidence = { payment_status: row.payment_status ?? null, payment_date: date, legacy_status: row.status ?? null, payslip_pay_nbr: text(row.payslip_pay_nbr) }
  if (ps === 'paid') return date ? { state: 'paid', ...evidence } : { fail: 'C3_PAID_WITHOUT_DATE', ...evidence }
  if (ps === 'pending') return date ? { fail: 'C3_PENDING_WITH_DATE', ...evidence } : { state: 'unpaid', ...evidence }
  if (ps === null) {
    if (date) return { fail: 'C3_UNPAID_WITH_DATE', ...evidence }
    if (legacy === null || legacy === 'pending') return { state: 'unpaid', ...evidence }
    return { fail: 'C3_LEGACY_STATUS_CONFLICT', ...evidence }
  }
  return { fail: 'C3_UNKNOWN_PAYMENT_STATUS', ...evidence }
}

/** Historical payable amount the allocation must equal (effective dollars, or stored historical dollars for hours). */
function allocationOf(ent, adjusted) {
  if (ent.unit === 'dollars') {
    const v = adjusted ?? num(ent.generated_amount)
    return { amount: v, basis: adjusted != null ? 'edited_amount (C2-preserved prototype adjusted_amount)' : 'generated_amount (preserved prototype value)' }
  }
  if (ent.unit === 'hours') {
    const v = num(ent.rate_snapshot?.historical_amount?.value)
    return { amount: v, basis: `stored historical dollars ${ent.rate_snapshot?.historical_amount?.column ?? '?'} of an hours-first entitlement (never derived from hours)` }
  }
  return { amount: null, basis: `unit ${ent.unit} has no payment allocation basis` }
}

/**
 * Plan C3 for the migrated events.
 * @param {object[]} events     migrated C2 events (parent, children, components, exclusions)
 * @param {object[]} entitlements  planned C2 entitlements (mutated: payment_status = derived final status)
 * @param {Map}      adjustedById  entitlement id → edited_amount
 * @param {Map}      claimById
 * @returns {{ records, links, gate, report }}
 */
export function planPayments({ events, entitlements, adjustedById, claimById }) {
  const entByRow = new Map()
  for (const e of entitlements) {
    const k = `${e.prototype_source}:${e.prototype_row_id}`
    if (!entByRow.has(k)) entByRow.set(k, [])
    entByRow.get(k).push(e)
  }
  const records = []
  const links = []
  const items = []
  const failures = []
  const structural = []
  let unpaidRowsWithPayNumber = 0

  for (const ev of events) {
    const rows = [{ table: ev.parentTable, row: ev.parent }, ...ev.children.map((c) => ({ table: c.table, row: c.row }))]
    for (const { table, row } of rows) {
      const ents = entByRow.get(`${table}:${row.id}`) || []
      const st = sourcePaymentState(row)
      if (!ents.length) {
        // No payable entitlement on this row: container/marker parent or approved exclusion.
        const excluded = ev.exclusions.some((x) => x.row === row)
        const code = excluded ? 'EXCLUDED_ARTIFACT_NOT_PAYABLE' : 'CONTAINER_ROW_NOT_PAYABLE'
        structural.push({ event: ev.key, source: `${table}:${row.id}`, code, source_state: st.state ?? null, source_anomaly: st.fail ?? null, payment_status: st.payment_status, payment_date: st.payment_date })
        continue
      }
      if (st.state === 'unpaid' && st.payslip_pay_nbr) unpaidRowsWithPayNumber += 1
      const inference = ents.length > 1 ? 'row_level: one prototype toggle covers every component of this row' : null
      for (const e of [...ents].sort((a, b) => (a.id < b.id ? -1 : 1))) {
        const claim = claimById.get(e.claim_id)
        const key = paymentSourceKey(table, row.id, e.prototype_component)
        const route = PAYMENT_STATUS[e.payment_method]
        const alloc = allocationOf(e, adjustedById.get(e.id) ?? null)
        const item = {
          event: ev.key, entitlement_id: e.id, entitlement_type: e.entitlement_type, unit: e.unit,
          source: `${table}:${row.id}`, component: e.prototype_component, owner_id: e.owner_id,
          claim_type: claim?.claim_type ?? null, financial_year_id: claim?.financial_year_id ?? null,
          payment_status: st.payment_status, payment_date: st.payment_date, legacy_status: st.legacy_status,
          payslip_pay_nbr: st.payslip_pay_nbr, source_state: st.state ?? 'invalid',
          source_amount: alloc.amount, allocation_basis: alloc.basis, inference,
          canonical_status: null, payment_record_id: null, migration_source_key: null, allocated_amount: 0,
        }
        let fail = st.fail ?? null
        if (!fail && st.state === 'paid' && !route) fail = 'C3_UNROUTED_ENTITLEMENT'
        if (!fail && st.state === 'paid' && (alloc.amount == null || alloc.amount < 0)) fail = 'C3_ALLOCATION_UNESTABLISHED'
        if (fail) {
          failures.push({ event: ev.key, entitlement_id: e.id, source: `${table}:${row.id}`, component: e.prototype_component, code: fail, reason: PAYMENT_FAILURES[fail], evidence: { payment_status: st.payment_status, payment_date: st.payment_date, legacy_status: st.legacy_status } })
          item.source_state = 'invalid'
          item.failure = fail
          e.payment_status = route ? route.open : null
          item.canonical_status = e.payment_status
          items.push(item)
          continue
        }
        if (st.state === 'unpaid') {
          e.payment_status = route ? route.open : null
          item.canonical_status = e.payment_status
          items.push(item)
          continue
        }
        const amount = round2(alloc.amount)
        const id = paymentRecordId(key)
        records.push({
          id, owner_id: e.owner_id, stream: e.payment_method, record_date: melbourneDate(st.payment_date),
          reference: st.payslip_pay_nbr, gross_amount: amount, source: 'prototype_migration', migration_source_key: key,
          raw_payload: {
            kind: 'prototype_payment_state', tool: `${TOOL.name}@${TOOL.version}`, issue: 'WORK-191',
            source_table: table, source_row_id: row.id, source_component: e.prototype_component, entitlement_id: e.id,
            payment_status: st.payment_status, payment_date: st.payment_date, legacy_status: st.legacy_status,
            payslip_pay_nbr: st.payslip_pay_nbr,
            record_date_basis: 'Australia/Melbourne calendar date of the prototype payment_date instant',
            amount_basis: alloc.basis, inference,
            note: 'Historical prototype payment toggle mapped by C3. Not a payslip line, bank settlement or payroll identifier.',
          },
        })
        links.push({ entitlement_id: e.id, payment_record_id: id, allocated_amount: amount, link_kind: 'manual', note: linkNote(key), actor_id: e.owner_id })
        e.payment_status = route.settled
        Object.assign(item, { canonical_status: route.settled, payment_record_id: id, migration_source_key: key, allocated_amount: amount })
        items.push(item)
      }
    }
  }

  records.sort((a, b) => (a.id < b.id ? -1 : 1))
  links.sort((a, b) => (a.entitlement_id + a.payment_record_id < b.entitlement_id + b.payment_record_id ? -1 : 1))
  items.sort((a, b) => (a.entitlement_id < b.entitlement_id ? -1 : 1))
  failures.sort((a, b) => (a.entitlement_id < b.entitlement_id ? -1 : 1))
  structural.sort((a, b) => (a.source < b.source ? -1 : 1))

  const gate = evaluateGate6({ entitlements, items, records, links, failures, structural, unpaidRowsWithPayNumber })
  return { records, links, gate, items, failures, structural }
}

function evaluateGate6({ entitlements, items, records, links, failures, structural, unpaidRowsWithPayNumber }) {
  const sum = (xs, f) => round2(xs.reduce((t, x) => t + (f(x) ?? 0), 0))
  const paid = items.filter((i) => i.source_state === 'paid')
  const unpaid = items.filter((i) => i.source_state === 'unpaid')
  const linkByEnt = new Map()
  for (const l of links) linkByEnt.set(l.entitlement_id, [...(linkByEnt.get(l.entitlement_id) || []), l])
  const recordById = new Map(records.map((r) => [r.id, r]))

  // Unmatched: a paid entitlement without exactly one planned link, or an unpaid / invalid one with any.
  const unmatched = items.filter((i) => {
    const n = (linkByEnt.get(i.entitlement_id) || []).length
    return i.source_state === 'paid' ? n !== 1 : n !== 0
  }).length
  const over = paid.filter((i) => sum(linkByEnt.get(i.entitlement_id) || [], (l) => l.allocated_amount) > round2(i.source_amount ?? 0)).length
  const under = paid.filter((i) => sum(linkByEnt.get(i.entitlement_id) || [], (l) => l.allocated_amount) < round2(i.source_amount ?? 0)).length
  const recordAllocMismatch = records.filter((r) => !sameMoney(r.gross_amount, sum(links.filter((l) => l.payment_record_id === r.id), (l) => l.allocated_amount))).length
  const keys = records.map((r) => r.migration_source_key)
  const dupKeys = keys.length - new Set(keys).size
  const dupIds = records.length - new Set(records.map((r) => r.id)).size
  const missingDate = records.filter((r) => !r.record_date).length
  const entById = new Map(entitlements.map((e) => [e.id, e]))
  const statusMismatch = items.filter((i) => {
    const e = entById.get(i.entitlement_id)
    const route = PAYMENT_STATUS[e?.payment_method]
    if (!route) return i.source_state === 'paid'
    return e.payment_status !== (i.source_state === 'paid' ? route.settled : route.open)
  }).length
  const crossOwner = links.filter((l) => recordById.get(l.payment_record_id)?.owner_id !== entById.get(l.entitlement_id)?.owner_id).length
  const streamMismatch = links.filter((l) => recordById.get(l.payment_record_id)?.stream !== entById.get(l.entitlement_id)?.payment_method).length
  const byKey = (xs, amt) => {
    const m = {}
    for (const i of xs) {
      const k = `${i.owner_id}|${i.claim_type}|${i.financial_year_id ?? 'none'}`
      m[k] = m[k] || { count: 0, amount: 0 }
      m[k].count += 1
      m[k].amount = round2(m[k].amount + (amt(i) ?? 0))
    }
    return Object.fromEntries(Object.entries(m).sort())
  }
  const statusCounts = {}
  for (const i of items) statusCounts[i.canonical_status ?? 'null'] = (statusCounts[i.canonical_status ?? 'null'] ?? 0) + 1

  const genuine = failures.length + unmatched + over + under + recordAllocMismatch + dupKeys + dupIds + missingDate + statusMismatch + crossOwner + streamMismatch
  const sourcePaidAmount = sum(paid, (i) => i.source_amount)
  const allocated = sum(links, (l) => l.allocated_amount)
  const pass = genuine === 0 && records.length === paid.length && links.length === paid.length && sameMoney(sourcePaidAmount, allocated)
  return {
    name: 'Historical payment state reconciled to canonical payment records/links/audit; no prototype toggle is truth',
    status: pass ? 'pass' : 'fail',
    evidence: {
      basis: 'prototype payment_status/payment_date per row (Paid ⇔ Paid + payment_date) → one prototype_migration payment record + one manual link per paid entitlement; unpaid → no record, canonical open status; status derived as fat._reconc_recompute does',
      source_payable_entitlements: items.length,
      source_paid: { count: paid.length, amount: sourcePaidAmount, by_owner_type_fy: byKey(paid, (i) => i.source_amount) },
      source_unpaid: { count: unpaid.length, amount: sum(unpaid, (i) => i.source_amount), by_owner_type_fy: byKey(unpaid, (i) => i.source_amount) },
      source_invalid: { count: items.length - paid.length - unpaid.length },
      canonical: {
        payment_records: records.length,
        payment_links: links.length,
        allocated_amount: allocated,
        allocated_by_owner_type_fy: byKey(paid, (i) => (linkByEnt.get(i.entitlement_id) || []).reduce((t, l) => t + l.allocated_amount, 0)),
        entitlement_status: Object.fromEntries(Object.entries(statusCounts).sort()),
      },
      unmatched_source_payment_state: unmatched,
      over_allocated: over,
      under_allocated: under,
      record_allocation_mismatches: recordAllocMismatch,
      duplicate_migration_payment_identities: dupKeys + dupIds,
      records_without_date: missingDate,
      status_mismatches: statusMismatch,
      cross_owner_or_stream_links: crossOwner + streamMismatch,
      contradictory_or_insufficient_source_states: failures.length,
      genuine_failures: genuine,
      intended_structural_differences: {
        count: structural.length,
        with_paid_or_anomalous_state: structural.filter((s) => s.source_state === 'paid' || s.source_anomaly).length,
        codes: PAYMENT_STRUCTURAL,
      },
      inference_boundaries: {
        row_level_shared_toggle: items.filter((i) => i.inference).length,
        unpaid_rows_with_payslip_pay_nbr: unpaidRowsWithPayNumber,
        claim_group_parent_status: 'ignored: cached projection, never payment evidence',
      },
      db: 're-proved by apply (link_entitlement_payment + recompute + audit postconditions) and the verify query',
    },
  }
}
