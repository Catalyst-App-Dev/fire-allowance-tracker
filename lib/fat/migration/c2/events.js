// ─── C2 transform — logical event discovery and type resolution (WORK-190) ──
// Pure. Turns the five prototype tables into logical events (one claim each)
// or refusals. Types come only from source evidence that establishes them:
//   * grouped: claim_groups.claim_type, cross-checked with the parent's
//     standby_type / meal_type — a conflict is refused, never resolved by guess;
//   * ungrouped (legacy): the parent's own discriminator; NULL is not evidence.
// A child's meal_type is never read for type (RC/RT/SB meal children live in
// spoilt_meals; the SB night meal child is literally meal_type 'Spoilt').

import { CLAIM_TABLES, PARENT_TABLE, PARENT_MARKERS, CHILD_RULES } from './constants.js'

const autoChildOf = (row) => (row?.calculation_inputs && typeof row.calculation_inputs === 'object' ? row.calculation_inputs.autoChild ?? null : null)

/** Is `row` (in `table`) a parent row of an event of `appType`? */
function isParentRow(table, row, appType) {
  if (PARENT_TABLE[appType] !== table) return false
  const ac = autoChildOf(row)
  if (appType === 'standby' || appType === 'md') return ac == null || ac === PARENT_MARKERS.standby || ac === PARENT_MARKERS.md
  return ac == null
}

/** App type of an ungrouped parent row, from its own discriminator only. */
function ungroupedType(table, row) {
  const ac = autoChildOf(row)
  if (table === 'recalls') return ac == null ? { appType: 'recalls' } : { refuse: 'orphan_child' }
  if (table === 'retain') return ac == null ? { appType: 'retain' } : { refuse: 'orphan_child' }
  if (table === 'standby') {
    if (ac != null && ac !== PARENT_MARKERS.standby && ac !== PARENT_MARKERS.md) return { refuse: 'orphan_child' }
    if (row.standby_type === 'M&D') return { appType: 'md' }
    if (row.standby_type === 'Standby') return { appType: 'standby' }
    return { refuse: 'standby_type_unestablished' }
  }
  if (table === 'spoilt_meals') {
    if (ac != null) return { refuse: 'orphan_child' }
    if (row.meal_type === 'Delayed') return { appType: 'delayed_meal' }
    if (row.meal_type === 'Spoilt' || row.meal_type === 'Spoilt / Meal') return { appType: 'spoilt' }
    return { refuse: row.meal_type == null ? 'meal_type_unestablished' : 'meal_type_not_a_claim_type' }
  }
  return { refuse: 'unknown_table' }
}

/** Does the parent discriminator agree with the group's app type? */
function discriminatorConflict(appType, parent) {
  const ac = autoChildOf(parent)
  if (appType === 'md') {
    if (parent.standby_type !== 'M&D') return `group says md but standby_type is ${JSON.stringify(parent.standby_type)}`
    if (ac != null && ac !== PARENT_MARKERS.md) return `group says md but parent marker is ${ac}`
  }
  if (appType === 'standby') {
    if (parent.standby_type != null && parent.standby_type !== 'Standby') return `group says standby but standby_type is ${JSON.stringify(parent.standby_type)}`
    if (ac != null && ac !== PARENT_MARKERS.standby) return `group says standby but parent marker is ${ac}`
  }
  if (appType === 'spoilt' && parent.meal_type != null && parent.meal_type !== 'Spoilt' && parent.meal_type !== 'Spoilt / Meal') {
    return `group says spoilt but meal_type is ${JSON.stringify(parent.meal_type)}`
  }
  if (appType === 'delayed_meal' && parent.meal_type !== 'Delayed') {
    return `group says delayed_meal but meal_type is ${JSON.stringify(parent.meal_type)}`
  }
  return null
}

const ref = (table, row) => ({ table, id: row.id })

/**
 * @param {object} source  { claim_groups, recalls, retain, standby, spoilt_meals } (normalised rows)
 * @returns {{ events: object[], refused: object[], emptyGroups: object[] }}
 *   event:   { key, group, appType, parentTable, parent, children: [{table,row,autoChild}], rows }
 *   refused: { key, code, reason, rows: [{table,id}], group_id, source_claim_type }
 *   emptyGroups: claim_groups rows with ZERO member rows (EMPTY_CLAIM_GROUP, WORK-255) — no logical
 *            event, so no claim; disposed as a provenance-only exclusion, never refused or dropped.
 *            A group with members but no parent is still refused (parent_count_0).
 */
export function discoverEvents(source) {
  const groups = [...(source.claim_groups || [])].sort((a, b) => (a.id < b.id ? -1 : 1))
  const groupIds = new Set(groups.map((g) => g.id))
  const members = new Map(groups.map((g) => [g.id, []]))
  const ungrouped = []
  const refused = []

  for (const table of CLAIM_TABLES) {
    for (const row of [...(source[table] || [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      if (row.claim_group_id == null) ungrouped.push({ table, row })
      else if (!groupIds.has(row.claim_group_id)) {
        refused.push({ key: `row:${table}:${row.id}`, code: 'missing_group', reason: `claim_group_id ${row.claim_group_id} does not exist`, rows: [ref(table, row)], group_id: row.claim_group_id, source_claim_type: null })
      } else members.get(row.claim_group_id).push({ table, row })
    }
  }

  const events = []
  const emptyGroups = []
  for (const g of groups) {
    const m = members.get(g.id)
    if (m.length === 0) { emptyGroups.push(g); continue }
    const rows = [ref('claim_groups', g), ...m.map((x) => ref(x.table, x.row))]
    const refuse = (code, reason) => refused.push({ key: `group:${g.id}`, code, reason, rows, group_id: g.id, source_claim_type: g.claim_type })
    const appType = g.claim_type
    if (!PARENT_TABLE[appType]) { refuse('unknown_claim_type', `claim_groups.claim_type ${JSON.stringify(appType)} is not a prototype claim type`); continue }
    if (m.some((x) => x.row.user_id !== g.user_id)) { refuse('cross_owner_group', 'a member row belongs to a different owner than its group'); continue }
    const parents = m.filter((x) => isParentRow(x.table, x.row, appType))
    if (parents.length !== 1) { refuse(`parent_count_${parents.length}`, `expected exactly one ${PARENT_TABLE[appType]} parent row, found ${parents.length}`); continue }
    const parent = parents[0]
    const conflict = discriminatorConflict(appType, parent.row)
    if (conflict) { refuse('type_conflict', conflict); continue }
    const children = []
    let bad = null
    for (const x of m) {
      if (x === parent) continue
      const ac = autoChildOf(x.row)
      const rule = CHILD_RULES[appType][`${x.table}:${ac}`]
      if (!rule) { bad = `unrecognised child ${x.table}:${ac} (row ${x.row.id}) for ${appType}`; break }
      children.push({ table: x.table, row: x.row, autoChild: ac, rule })
    }
    if (bad) { refuse('unrecognised_child', bad); continue }
    events.push({ key: `group:${g.id}`, group: g, appType, parentTable: parent.table, parent: parent.row, children, rows })
  }

  for (const { table, row } of ungrouped) {
    const t = ungroupedType(table, row)
    const rows = [ref(table, row)]
    if (t.refuse) {
      refused.push({ key: `row:${table}:${row.id}`, code: t.refuse, reason: `ungrouped ${table} row: ${t.refuse.replace(/_/g, ' ')}`, rows, group_id: null, source_claim_type: null })
      continue
    }
    events.push({ key: `row:${table}:${row.id}`, group: null, appType: t.appType, parentTable: table, parent: row, children: [], rows })
  }

  events.sort((a, b) => (a.key < b.key ? -1 : 1))
  refused.sort((a, b) => (a.key < b.key ? -1 : 1))
  return { events, refused, emptyGroups }
}

export { autoChildOf }
