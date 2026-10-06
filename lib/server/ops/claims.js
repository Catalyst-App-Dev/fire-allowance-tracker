// ─── Canonical claim operations (WORK-256, Neon DEV runtime) ─────────────────
// The DEV application half of C5: normal FAT claim workflows on the canonical
// Neon schema (fat.operational_claims + *_details + fat.claim_entitlements).
// No prototype table exists on Neon and none is recreated.
//
//   claims.list      canonical rows → the UI's claims / claimGroups contract
//   claims.preview   the create pipeline as a dry run (nothing persisted)
//   claims.create    claim number + operational claim + detail + WORK-173
//                    generator entitlements, in ONE transaction
//   claims.override  audited entitlement override (edited_amount / edited_hours
//                    + reason → fat.entitlement_overrides via the audit trigger)
//   claims.delete    whole-claim delete (cascade); refused once any entitlement
//                    is linked to a payment record
//
// Every statement runs as fat_app with fat.app_user_id = the session identity,
// so RLS scopes every row; `appUserId` is also written explicitly as owner.

import { APP_TO_CANONICAL, DELAY_CAUSES, ENTITLEMENT_LABELS, buildCanonicalDetail, missingFacts, projectClaims } from '../../claims/canonical/model.js'
import { generateEntitlements } from '../../fat/engine/index.js'
import { buildEngineContext, resolveActiveMatrixVersion } from '../../fat/engine/context.js'
import { generateAndPersistEntitlements } from '../../fat/engine/persistEntitlements.js'
import { RequestError } from '../route.js'
import { uuid, date as dateArg, oneOf, str } from './validate.js'

const DETAIL_TABLES = ['recall_details', 'retain_details', 'standby_details', 'muster_dismiss_details', 'spoilt_meal_details', 'delayed_meal_details']
const APP_TYPES = Object.keys(APP_TO_CANONICAL)
const MAX_NUMBER_ATTEMPTS = 50

// ── Input shaping ────────────────────────────────────────────────────────────

const FIELD_KEYS = [
  'shift', 'arrivalTime', 'bookedOffTime', 'arrivedTime', 'incidentTime', 'firecallNumber', 'platoon', 'notified',
  'rosteredStn', 'recallStn', 'standbyStn', 'operationalStn',
  'rosteredStnId', 'recallStnId', 'standbyStnId', 'operationalStnId',
  'distHomeKm', 'distStnKm', 'distKm', 'mdHomeToRosteredKm', 'mdHomeToMdKm', 'mdPayableKm', 'standbyType', 'mealType',
]
const FACT_KEYS = [
  'travelMinutes', 'travelSundayOrPh', 'travelDistanceKm', 'nightShiftInterrupted', 'travelHomeMinutes',
  'emergencyResponse', 'mealWindowStart', 'mealWindowEnd', 'actualMealTime', 'delayNotice2h', 'delayCause', 'dutyStart', 'dutyEnd',
]

function pick(obj, keys) {
  const out = {}
  if (!obj || typeof obj !== 'object') return out
  for (const k of keys) {
    const v = obj[k]
    if (v === undefined) continue
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) throw new RequestError(`${k} has an invalid type`)
    if (typeof v === 'string' && v.length > 300) throw new RequestError(`${k} is too long`)
    out[k] = v
  }
  return out
}

function factsInput(raw) {
  const f = pick(raw, FACT_KEYS)
  for (const k of ['travelMinutes', 'travelHomeMinutes', 'travelDistanceKm']) {
    if (f[k] !== undefined && f[k] !== null && f[k] !== '' && !(Number(f[k]) >= 0)) throw new RequestError(`${k} must be ≥ 0`)
  }
  if (f.delayCause != null && f.delayCause !== '' && !DELAY_CAUSES.includes(f.delayCause)) throw new RequestError('delayCause is invalid')
  return f
}

function routingInput(raw) {
  const s = raw?.standby
  if (!s || typeof s !== 'object') return null
  return { standby: pick(s, ['matrixHours', 'matrixVersionId', 'googleKmOneway', 'googleKmReturn', 'source']) }
}

function claimInput(input) {
  const appType = oneOf(input.claimType, 'claimType', APP_TYPES)
  return {
    appType,
    claimType: APP_TO_CANONICAL[appType],
    date: dateArg(input.date, 'date'),
    fields: pick(input.fields, FIELD_KEYS),
    facts: factsInput(input.facts),
    routingMeta: routingInput(input.routingMeta),
  }
}

// ── Shared pipeline ──────────────────────────────────────────────────────────

async function stationSet(db, ids) {
  const wanted = [...new Set(ids.map((x) => Number(x)).filter((n) => Number.isInteger(n)))]
  if (!wanted.length) return new Map()
  const rows = await db.query('select id, name from fat.stations where id = any($1)', [wanted])
  return new Map(rows.map((r) => [Number(r.id), r.name]))
}

async function buildDraft(db, c) {
  const stations = await stationSet(db, [c.fields.rosteredStnId, c.fields.recallStnId, c.fields.standbyStnId])
  let activeMatrixVersion = null
  if ((c.claimType === 'SB' || c.claimType === 'MD') && c.routingMeta?.standby?.matrixVersionId == null) {
    try { activeMatrixVersion = await resolveActiveMatrixVersion(db.fat) } catch { activeMatrixVersion = null }
  }
  const built = buildCanonicalDetail({
    appType: c.appType, date: c.date, fields: c.fields, facts: c.facts, routingMeta: c.routingMeta,
    stationExists: (id) => stations.has(id), activeMatrixVersion,
  })
  return { ...built, stationName: built.stationIdSnapshot != null ? stations.get(built.stationIdSnapshot) ?? null : null }
}

/** Human-readable form context kept on the claim (canonical notes; display only). */
function contextNotes(appType, fields) {
  const parts = []
  if (fields.shift && (appType !== 'recalls' && appType !== 'retain')) parts.push(`Shift: ${fields.shift}`)
  if (fields.platoon) parts.push(`Platoon: ${fields.platoon}`)
  if (fields.operationalStn) parts.push(`Operational station: ${fields.operationalStn}`)
  if (fields.firecallNumber) parts.push(`Firecall: ${fields.firecallNumber}`)
  return parts.length ? parts.join(' · ') : null
}

/** CANONICAL_ENTITLEMENT_RULES § 5.1: one meal event is never claimed twice (fail closed). */
async function assertNoDuplicateMealEvent(db, appUserId, claimType, detail) {
  if (claimType === 'SM' && detail.meal_interrupted_at) {
    const rows = await db.query(
      `select 1 from fat.spoilt_meal_details d join fat.operational_claims c on c.id = d.claim_id
        where c.owner_id = $1 and d.meal_interrupted_at = $2::timestamptz
       union all
       select 1 from fat.delayed_meal_details d join fat.operational_claims c on c.id = d.claim_id
        where c.owner_id = $1 and $2::timestamptz between d.meal_window_start_at and d.meal_window_end_at
       limit 1`, [appUserId, detail.meal_interrupted_at])
    if (rows.length) throw new RequestError('this meal event is already claimed', 'DUPLICATE_MEAL_EVENT', 409)
  }
  if (claimType === 'DM' && detail.meal_window_start_at) {
    const rows = await db.query(
      `select 1 from fat.delayed_meal_details d join fat.operational_claims c on c.id = d.claim_id
        where c.owner_id = $1 and d.meal_window_start_at = $2::timestamptz
       union all
       select 1 from fat.spoilt_meal_details d join fat.operational_claims c on c.id = d.claim_id
        where c.owner_id = $1 and d.meal_interrupted_at between $2::timestamptz and coalesce($3::timestamptz, $2::timestamptz)
       limit 1`, [appUserId, detail.meal_window_start_at, detail.meal_window_end_at])
    if (rows.length) throw new RequestError('this meal break is already claimed', 'DUPLICATE_MEAL_EVENT', 409)
  }
}

/**
 * DEV claim numbering: fat.increment_claim_sequence (caller-bound) keyed by the
 * canonical type, skipping any number already held in the C1 uniqueness scope
 * (owner, FY, canonical type) — e.g. by migrated claims, whose numbers C2
 * preserves without advancing the sequence. Production sequence alignment is
 * WORK-193's (C5) responsibility.
 */
async function nextClaimNumber(db, appUserId, financialYearId, claimType) {
  for (let i = 0; i < MAX_NUMBER_ATTEMPTS; i++) {
    const { data: n, error } = await db.fat.rpc('increment_claim_sequence', {
      p_user_id: appUserId, p_financial_year_id: financialYearId, p_claim_type: claimType,
    })
    if (error) throw Object.assign(new Error(error.message), { code: error.code })
    const taken = await db.query(
      `select 1 from fat.operational_claims
        where owner_id = $1 and financial_year_id = $2 and claim_type = $3 and claim_number = $4`,
      [appUserId, financialYearId, claimType, n])
    if (!taken.length) return n
  }
  throw new RequestError('could not allocate a claim number', 'SEQUENCE_EXHAUSTED', 409)
}

function draftView(d) {
  return {
    entitlementType: d.entitlement_type,
    label: ENTITLEMENT_LABELS[d.entitlement_type] ?? d.entitlement_type,
    unit: d.unit,
    amount: d.generated_amount ?? null,
    hours: d.generated_hours ?? null,
    estimate: d.unit === 'hours' ? d.rate_snapshot?.estimate ?? null : null,
    paymentMethod: d.payment_method,
    ruleId: d.rule_id,
    formula: d.formula_explanation ?? null,
    explanation: d.rule_explanation ?? null,
  }
}

// ── Operations ───────────────────────────────────────────────────────────────

async function listClaims({ db, input }) {
  const fyId = input.financialYearId ? uuid(input.financialYearId, 'financialYearId') : null
  const claims = await db.query(
    `select * from fat.operational_claims
      where owner_id = fat.current_app_user_id() and ($1::uuid is null or financial_year_id = $1::uuid)
      order by claim_date desc, created_at desc`, [fyId])
  const ids = claims.map((c) => c.id)
  const details = new Map()
  let entitlements = []
  let linked = new Set()
  if (ids.length) {
    for (const t of DETAIL_TABLES) {
      for (const r of await db.query(`select * from fat.${t} where claim_id = any($1)`, [ids])) details.set(r.claim_id, r)
    }
    entitlements = await db.query('select * from fat.claim_entitlements where claim_id = any($1)', [ids])
    const entIds = entitlements.map((e) => e.id)
    if (entIds.length) {
      linked = new Set((await db.query('select distinct entitlement_id from fat.entitlement_payment_links where entitlement_id = any($1)', [entIds])).map((r) => r.entitlement_id))
    }
  }
  const stationIds = []
  for (const c of claims) stationIds.push(c.station_id_snapshot)
  for (const d of details.values()) stationIds.push(d.recall_station_id, d.standby_station_id, d.md_station_id)
  const stationNames = await stationSet(db, stationIds.filter((x) => x != null))
  return projectClaims({ claims, details, entitlements, linkedEntitlementIds: linked, stationNames })
}

async function previewClaim({ db, appUserId, input }) {
  const c = claimInput(input)
  const built = await buildDraft(db, c)
  const ctx = await buildEngineContext(db.fat, {
    ownerId: appUserId,
    claimDate: c.date,
    matrixVersion: built.detail.matrix_version ?? null,
    destStationId: built.detail.standby_station_id ?? built.detail.md_station_id ?? null,
  })
  const skipped = []
  const drafts = generateEntitlements({ claim_type: built.claimType, claim_date: c.date }, built.detail, { ...ctx, onSkip: (s) => skipped.push(s) })
  return {
    claimType: built.claimType,
    entitlements: drafts.map(draftView),
    skipped,
    missingFacts: missingFacts(built.claimType, built.detail, ctx.profileSnapshot?.rostered_station_id ?? null),
    notes: built.notes,
  }
}

async function createClaim({ db, appUserId, input }) {
  const c = claimInput(input)
  const financialYearId = uuid(input.financialYearId, 'financialYearId')
  const fy = await db.query('select id from fat.financial_years where id = $1 and user_id = $2', [financialYearId, appUserId])
  if (!fy.length) throw new RequestError('financial year not found', 'NOT_FOUND', 404)

  const built = await buildDraft(db, c)
  await assertNoDuplicateMealEvent(db, appUserId, built.claimType, built.detail)
  const claimNumber = await nextClaimNumber(db, appUserId, financialYearId, built.claimType)

  const [claim] = await db.query(
    `insert into fat.operational_claims
       (owner_id, claim_type, claim_date, station_id_snapshot, station_name_snapshot, source_calculation_mode,
        status, notes, claim_number, financial_year_id)
     values ($1, $2, $3, $4, $5, $6, 'submitted', $7, $8, $9)
     returning *`,
    [appUserId, built.claimType, c.date, built.stationIdSnapshot, built.stationName, built.sourceCalculationMode,
      contextNotes(c.appType, c.fields), claimNumber, financialYearId])

  const cols = Object.keys(built.detail)
  await db.query(
    `insert into fat.${built.detailTable} (claim_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
    [claim.id, ...cols.map((k) => built.detail[k])])

  const persist = await generateAndPersistEntitlements(db.fat, { claim, details: built.detail, ownerId: appUserId })
  return {
    claimId: claim.id,
    claimNumber,
    claimType: built.claimType,
    entitlements: (persist.inserted || []).map(draftView),
    notes: built.notes,
  }
}

async function overrideEntitlement({ db, input }) {
  const id = uuid(input.entitlementId, 'entitlementId')
  const reason = str(input.reason, 'reason', { nullable: false, max: 500 })
  if (!reason.trim()) throw new RequestError('a reason is required for a manual override')
  const rows = await db.query(
    `select e.id, e.unit,
            exists (select 1 from fat.entitlement_payment_links l where l.entitlement_id = e.id) as linked
       from fat.claim_entitlements e where e.id = $1`, [id])
  if (!rows.length) throw new RequestError('entitlement not found', 'NOT_FOUND', 404)
  const e = rows[0]
  if (e.linked) throw new RequestError('this entitlement is linked to a payment record and cannot be edited', 'PAYMENT_LINKED', 409)
  const raw = input.value
  const value = raw === null || raw === '' || raw === undefined ? null : Number(raw)
  if (value !== null && (!Number.isFinite(value) || value < 0)) throw new RequestError('value must be a non-negative number')
  const column = e.unit === 'hours' ? 'edited_hours' : e.unit === 'dollars' ? 'edited_amount' : null
  if (!column) throw new RequestError('this entitlement unit cannot be edited')
  await db.query(
    `update fat.claim_entitlements
        set ${column} = $2::numeric, edited_note = $3, edited_source = 'fat-app:override', manual_override = ($2::numeric is not null)
      where id = $1`, [id, value, reason.trim()])
  return { ok: true }
}

async function deleteClaim({ db, input }) {
  const id = uuid(input.claimId, 'claimId')
  const rows = await db.query(
    `select c.id,
            exists (select 1 from fat.entitlement_payment_links l join fat.claim_entitlements e on e.id = l.entitlement_id
                     where e.claim_id = c.id) as linked
       from fat.operational_claims c where c.id = $1 and c.owner_id = fat.current_app_user_id()`, [id])
  if (!rows.length) throw new RequestError('claim not found', 'NOT_FOUND', 404)
  if (rows[0].linked) throw new RequestError('this claim has payment records linked; retract them first', 'PAYMENT_LINKED', 409)
  const deleted = await db.query('delete from fat.operational_claims where id = $1 returning id', [id])
  if (!deleted.length) throw new RequestError('claim not found', 'NOT_FOUND', 404)
  return { ok: true }
}

export const CLAIM_OPERATIONS = {
  'claims.list': listClaims,
  'claims.preview': previewClaim,
  'claims.create': createClaim,
  'claims.override': overrideEntitlement,
  'claims.delete': deleteClaim,
}
