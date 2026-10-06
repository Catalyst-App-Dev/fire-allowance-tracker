// ─── C2/C3 cross-database topology (WORK-255) ───────────────────────────────
// Supabase prototype source (legacy, authoritative, read-only) → Neon canonical
// target (dev). Contract: docs/architecture/C2_TRANSFORM_CONTRACT.md § 10.
//
//   sourceExtractSql()          read-only, runs on SUPABASE: the source snapshot
//                               (fat.c2.source-snapshot/v2) — seven tables + source reference
//   targetExtractSql(source)    read-only, runs on NEON: the target snapshot
//                               (fat.c2.target-snapshot/v1) for exactly the source's scope
//   planCrossDb(source, target, opts)
//                               one deterministic plan: the pure C2/C3 planner over the two
//                               snapshots + gates R (reference) and I (identity) + the
//                               prerequisites (app identities, FYs) the target needs
//   admitCrossDb(plan, target)  plan-time admission against the CURRENT target state:
//                               apply | already_applied | refuse (never part of the plan)
//
// What decides the plan: the source snapshot and the target *reference* (stations, rates,
// rate versions, in-scope native claims). Target *state* (identities, FYs, ledger, batches)
// never enters the fingerprint, so a rerun after apply yields the same plan; it is judged by
// admission, and re-proved in the database by apply.

import {
  SOURCE_SNAPSHOT_SCHEMA, TARGET_SNAPSHOT_SCHEMA, SNAPSHOT_SCHEMA, SNAPSHOT_TABLES, SOURCE_TABLES,
  CROSS_DB_ACCEPTANCE_GATES, RESERVED_TEST_EMAIL,
} from './constants.js'
import { planC2 } from './plan.js'
import { canonicalJson, normalise, num } from './util.js'

// Rate codes the WORK-173 generators read (lib/fat/engine/context.js); extracted only when there is source.
export const GENERATOR_RATE_CODES = Object.freeze(['enterprise_base_pay_weekly', 'overtime_rate_factor', 'overtime_hourly_divisor', 'double_time_multiplier',
  'single_time_multiplier', 'time_and_half_multiplier', 'travel_per_km', 'meal_allowance', 'spoilt_meal_allowance', 'relieving_allowance'])

const STATION_FIELDS = ['rostered_stn_id', 'recall_stn_id', 'station_id', 'standby_stn_id']
const byId = (a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)
const uniqSorted = (xs) => [...new Set(xs.filter((x) => x !== null && x !== undefined))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

function literal(text, prefix) {
  let tag = `$${prefix}$`
  for (let i = 0; text.includes(tag); i++) tag = `$${prefix}${i}$`
  return `${tag}${text}${tag}`
}

// ── Source (Supabase, read-only) ────────────────────────────────────────────

/**
 * The read-only SUPABASE source query. One row, column `snapshot`. Reference rows are limited
 * to what the prototype rows reference (their owners, FYs and stations). Pass
 * memberClassifications: false for a source that has no fat.member_classifications table
 * (Supabase PROD before WORK-172) — generator parity then reports the classification as missing.
 */
export function sourceExtractSql({ memberClassifications = true } = {}) {
  const live = SOURCE_TABLES.map((t) => `'${t}', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from fat.${t} t), '[]'::jsonb)`).join(',\n        ')
  const ids = (paths) => `(select distinct v #>> '{}' from src, lateral (${paths.map((p) => `select jsonb_path_query(src.s, '$.*[*].${p}')`).join(' union all ')}) q(v) where jsonb_typeof(v) <> 'null')`
  const mc = memberClassifications
    ? `coalesce((select jsonb_agg(jsonb_build_object('owner_id', owner_id, 'classification', classification, 'effective_from', effective_from) order by owner_id, effective_from, id)
          from fat.member_classifications where owner_id::text in ${ids(['user_id'])}), '[]'::jsonb)`
    : `'[]'::jsonb`
  return `-- C2/C3 cross-database SOURCE extraction (WORK-255). Runs on the legacy SUPABASE project. Read-only.
select (with src as (select jsonb_build_object(
        ${live}) as s)
  select jsonb_build_object(
    'schema', '${SOURCE_SNAPSHOT_SCHEMA}',
    'provider', 'supabase',
    'tables', (select s from src) || jsonb_build_object(
      'claim_sequences', coalesce((select jsonb_agg(to_jsonb(q) order by q.id) from fat.claim_sequences q where q.user_id::text in ${ids(['user_id'])}), '[]'::jsonb),
      'financial_years', coalesce((select jsonb_agg(to_jsonb(f) order by f.id) from fat.financial_years f
          where f.user_id::text in ${ids(['user_id'])} or f.id::text in ${ids(['financial_year_id'])}), '[]'::jsonb)),
    'reference', jsonb_build_object(
      'profiles', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email) order by p.id) from fat.profiles p where p.id::text in ${ids(['user_id'])}), '[]'::jsonb),
      'stations', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name) order by st.id) from fat.stations st where st.id::text in ${ids(STATION_FIELDS)}), '[]'::jsonb),
      'member_classifications', ${mc}))) as snapshot;
`
}

/** Validate and normalise a source snapshot (accepts the raw row a SQL client returns). */
export function readSourceSnapshot(x) {
  const s = x?.snapshot ?? x
  if (s?.schema !== SOURCE_SNAPSHOT_SCHEMA) throw new Error(`source snapshot schema must be ${SOURCE_SNAPSHOT_SCHEMA}`)
  for (const t of SNAPSHOT_TABLES) if (!Array.isArray(s.tables?.[t])) throw new Error(`source snapshot is missing table ${t}`)
  return s
}

/** What the target extraction must read for this source: owners, e-mails, FYs, stations and source rows. */
export function targetScope(source) {
  const s = readSourceSnapshot(source)
  const rows = SOURCE_TABLES.flatMap((t) => s.tables[t].map((r) => ({ t, id: String(r.id) }))).sort((a, b) => (a.t + a.id < b.t + b.id ? -1 : 1))
  const all = SOURCE_TABLES.flatMap((t) => s.tables[t])
  return {
    has_source: rows.length > 0,
    owners: uniqSorted(all.map((r) => r.user_id)),
    emails: uniqSorted((s.reference?.profiles || []).map((p) => (p.email ? String(p.email).toLowerCase() : null))),
    financial_years: uniqSorted([...all.map((r) => r.financial_year_id), ...s.tables.financial_years.map((f) => f.id)]),
    stations: uniqSorted(all.flatMap((r) => STATION_FIELDS.map((f) => num(r[f])))).map(Number).sort((a, b) => a - b),
    rows,
  }
}

// ── Target (Neon, read-only) ────────────────────────────────────────────────

/**
 * The target reference expression over a scope (a jsonb SQL expression). Shared by the target
 * extraction and by apply's stale-plan check, so both read exactly the same rows. TimeZone-free:
 * no timestamp is emitted (withdrawal is a boolean); numeric rate values are emitted as text, so a
 * snapshot copied through a JSON client keeps the database's exact rendering (snapshot_md5 check).
 */
export function targetReferenceExpr(scope) {
  const codes = GENERATOR_RATE_CODES.map((c) => `'${c}'`).join(', ')
  const has = `coalesce((${scope}->>'has_source')::boolean, false)`
  return `jsonb_build_object(
      'stations', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name) order by st.id) from fat.stations st
          where st.id in (select (jsonb_array_elements_text(${scope}->'stations'))::int)), '[]'::jsonb),
      'rates', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'unit', r.unit) order by r.id) from fat.rates r
          where ${has} and r.code in (${codes})), '[]'::jsonb),
      'rate_versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'rate_id', v.rate_id, 'version_label', v.version_label, 'value', v.value::text,
            'effective_from', v.effective_from, 'classification', v.classification, 'source_kind', v.source_kind, 'source_ref', v.source_ref,
            'withdrawn', v.withdrawn_at is not null) order by v.id)
          from fat.rate_versions v join fat.rates r on r.id = v.rate_id where ${has} and r.code in (${codes})), '[]'::jsonb),
      'native_claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'owner_id', c.owner_id, 'claim_type', c.claim_type, 'claim_date', c.claim_date,
            'station_id_snapshot', c.station_id_snapshot, 'dest_station_id', coalesce(sd.standby_station_id, md.md_station_id)) order by c.id)
          from fat.operational_claims c
          left join fat.standby_details sd on sd.claim_id = c.id
          left join fat.muster_dismiss_details md on md.claim_id = c.id
          where c.prototype_row_id is null and c.migration_batch_id is null
            and c.owner_id::text in (select jsonb_array_elements_text(${scope}->'owners'))), '[]'::jsonb))`
}

/** The read-only NEON target query for exactly this source's scope. One row, column `snapshot`. */
export function targetExtractSql(source) {
  const scope = canonicalJson(targetScope(source))
  const sc = `(select s from scope)`
  return `-- C2/C3 cross-database TARGET extraction (WORK-255). Runs on the Neon target. Read-only.
-- snapshot_md5 = md5 of the database's own rendering of the snapshot: a copied snapshot is exact iff
-- md5(<copy>::jsonb::text) equals it.
select x.s as snapshot, md5(x.s::text) as snapshot_md5 from (with scope as (select ${literal(scope, 'c2scope')}::jsonb as s),
  ref as (select ${targetReferenceExpr(sc)} as r)
  select jsonb_build_object(
    'schema', '${TARGET_SNAPSHOT_SCHEMA}',
    'provider', 'neon',
    'scope', ${sc},
    'reference', (select r from ref),
    'reference_md5', md5((select r from ref)::text),
    'state', jsonb_build_object(
      'identities', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'origin', i.origin, 'legacy_subject', i.legacy_subject, 'status', i.status) order by i.id)
          from fat.app_identities i where i.id::text in (select jsonb_array_elements_text(${sc}->'owners'))
             or lower(i.email) in (select jsonb_array_elements_text(${sc}->'emails'))), '[]'::jsonb),
      'profiles', coalesce((select jsonb_agg(p.id order by p.id) from fat.profiles p where p.id::text in (select jsonb_array_elements_text(${sc}->'owners'))), '[]'::jsonb),
      'financial_years', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'user_id', f.user_id, 'label', f.label, 'start_date', f.start_date, 'end_date', f.end_date) order by f.id)
          from fat.financial_years f where f.id::text in (select jsonb_array_elements_text(${sc}->'financial_years'))
             or f.user_id::text in (select jsonb_array_elements_text(${sc}->'owners'))), '[]'::jsonb),
      'claims_in_scope', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'owner_id', c.owner_id, 'financial_year_id', c.financial_year_id, 'claim_type', c.claim_type,
            'claim_number', c.claim_number, 'prototype_source', c.prototype_source, 'prototype_row_id', c.prototype_row_id, 'batch_key', b.batch_key) order by c.id)
          from fat.operational_claims c left join fat.migration_batches b on b.id = c.migration_batch_id
          where c.financial_year_id::text in (select jsonb_array_elements_text(${sc}->'financial_years'))
             or c.prototype_row_id::text in (select x->>'id' from jsonb_array_elements(${sc}->'rows') x)), '[]'::jsonb),
      'ledger', coalesce((select jsonb_agg(jsonb_build_object('source_table', l.source_table, 'source_row_id', l.source_row_id, 'batch_key', b.batch_key,
            'source_checksum', l.source_checksum, 'disposition', l.disposition) order by l.source_table, l.source_row_id)
          from fat.migration_source_rows l join fat.migration_batches b on b.id = l.batch_id
          where exists (select 1 from jsonb_array_elements(${sc}->'rows') x where x->>'t' = l.source_table and x->>'id' = l.source_row_id::text)), '[]'::jsonb),
      'batches', coalesce((select jsonb_agg(jsonb_build_object('batch_key', b.batch_key, 'step', b.step, 'status', b.status, 'source_checksum', b.source_checksum) order by b.batch_key)
          from fat.migration_batches b where b.step = 'C2'), '[]'::jsonb)))) x(s);
`
}

export function readTargetSnapshot(x) {
  const t = x?.snapshot ?? x
  if (t?.schema !== TARGET_SNAPSHOT_SCHEMA) throw new Error(`target snapshot schema must be ${TARGET_SNAPSHOT_SCHEMA}`)
  if (!t.reference || !t.state || !t.scope || !/^[0-9a-f]{32}$/.test(t.reference_md5 || '')) throw new Error('target snapshot needs scope, reference, reference_md5 and state')
  return t
}

// ── Plan ────────────────────────────────────────────────────────────────────

/** The planner's combined input from the two snapshots (source data from Supabase, reference from Neon). */
function combinedInput(s, t) {
  const tref = normalise(t.reference)
  const sorted = (xs, key = (x) => String(x.id)) => [...(xs || [])].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const mcKey = (m) => `${m.owner_id}|${m.effective_from}|${m.classification}`
  return {
    schema: SNAPSHOT_SCHEMA,
    source: Object.fromEntries(SNAPSHOT_TABLES.map((x) => [x, s.tables[x]])),
    reference: {
      financial_years: sorted(s.tables.financial_years).map((f) => ({ id: f.id, user_id: f.user_id, label: f.label, start_date: f.start_date, end_date: f.end_date })),
      stations: sorted(tref.stations),
      profiles: sorted(s.reference?.profiles).map((p) => p.id),
      rates: sorted(tref.rates),
      // value travels as text (exact through any JSON transport; see targetReferenceExpr) and is a number here.
      rate_versions: sorted(tref.rate_versions).map(({ withdrawn, ...v }) => ({ ...v, value: num(v.value), withdrawn_at: withdrawn ? 'withdrawn' : null })),
      member_classifications: sorted(s.reference?.member_classifications, mcKey),
    },
    target: { native_claims: sorted(tref.native_claims) },
    // Recorded so the fingerprint covers every input that can change the result.
    source_reference: { stations: sorted(s.reference?.stations), profiles: sorted(s.reference?.profiles) },
  }
}

/** Gate R: every station the source references exists on the target with the same name. */
function gateR(s, t, scope) {
  const src = new Map((s.reference?.stations || []).map((x) => [Number(x.id), x.name ?? null]))
  const tgt = new Map((t.reference.stations || []).map((x) => [Number(x.id), x.name ?? null]))
  const findings = []
  for (const id of scope.stations) {
    const a = src.has(id); const b = tgt.has(id)
    if (a && !b) findings.push({ station_id: id, code: 'reference_station_missing_on_target', source_name: src.get(id) })
    else if (!a && b) findings.push({ station_id: id, code: 'reference_station_not_in_source', target_name: tgt.get(id) })
    else if (a && b && src.get(id) !== tgt.get(id)) findings.push({ station_id: id, code: 'reference_station_mismatch', source_name: src.get(id), target_name: tgt.get(id) })
  }
  const unknown = scope.stations.filter((id) => !src.has(id) && !tgt.has(id))
  const ratesNeeded = scope.has_source
  const missingCodes = ratesNeeded ? GENERATOR_RATE_CODES.filter((c) => !(t.reference.rates || []).some((r) => r.code === c)) : []
  return {
    name: 'Target reference readiness: every station the source references exists on the target with the same name (rates/versions come from the target)',
    status: findings.length ? 'fail' : 'pass',
    evidence: {
      referenced_stations: scope.stations.length, matched: scope.stations.length - findings.length - unknown.length,
      unknown_in_both: unknown, findings,
      rates: (t.reference.rates || []).length, rate_versions: (t.reference.rate_versions || []).length,
      generator_rate_codes_missing_on_target: missingCodes,
      note: 'a station missing on the target needs a governed reference data-load first; an id unknown to both is mapped to NULL as in C2 1.x. Rates are report-only (generator parity).',
    },
  }
}

/** Owners the plan writes for, and the identities / FYs the target must hold first. */
function prerequisitesOf(plan, s) {
  const owners = uniqSorted([...plan.claims.map((c) => c.owner_id), ...plan.ledger.map((l) => l.owner_id)])
  const prof = new Map((s.reference?.profiles || []).map((p) => [p.id, p.email ?? null]))
  const identities = owners.map((id) => ({ id, email: prof.get(id) ?? null, origin: 'legacy_supabase' }))
  const fyIds = new Set(plan.claims.map((c) => c.financial_year_id).filter(Boolean))
  const financial_years = s.tables.financial_years.filter((f) => fyIds.has(f.id))
    .map((f) => ({ id: f.id, user_id: f.user_id, label: f.label, start_date: f.start_date, end_date: f.end_date, is_active: f.is_active ?? false }))
    .sort(byId)
  return { identities, financial_years }
}

/** Gate I: owner UUIDs preserved as FAT app identities; on dev, only reserved test e-mails. */
function gateI(prereq, environment) {
  const missingEmail = prereq.identities.filter((i) => !i.email || !String(i.email).trim()).map((i) => i.id)
  const realOnDev = environment === 'dev' ? prereq.identities.filter((i) => i.email && !RESERVED_TEST_EMAIL.test(String(i.email).trim())).map((i) => i.id) : []
  const lower = prereq.identities.filter((i) => i.email).map((i) => String(i.email).trim().toLowerCase())
  const dupEmail = lower.length - new Set(lower).size
  const ok = missingEmail.length + realOnDev.length + dupEmail === 0
  return {
    name: 'Owner identity preserved: every migrated owner is a legacy_supabase FAT app identity whose id IS the Supabase owner UUID (WORK-254 seam)',
    status: ok ? 'pass' : 'fail',
    evidence: {
      owners: prereq.identities.length, provisioning: "fat.ensure_app_identity(<owner uuid>, <email>, 'legacy_supabase') — legacy_subject = id; no password, no provider link",
      owners_without_email: missingEmail, non_reserved_email_on_dev: realOnDev, duplicate_emails: dupEmail,
      dev_rule: environment === 'dev' ? 'dev targets accept reserved test-domain e-mails only (RFC 2606 / 6761)' : null,
    },
  }
}

/**
 * Plan the cross-database transform.
 * opts: { environment: 'dev'|'prod', evidenceClass, binding: { project, target, target_id }, sourceProject }
 */
export function planCrossDb(sourceSnap, targetSnap, { environment, evidenceClass = 'real', binding = {}, sourceProject = null } = {}) {
  const s = readSourceSnapshot(sourceSnap)
  const t = readTargetSnapshot(targetSnap)
  const scope = targetScope(s)
  if (canonicalJson(scope) !== canonicalJson(t.scope)) throw new Error('target snapshot was read for a different source scope; re-run targetExtractSql for this source')
  const input = combinedInput(s, t)
  const R = gateR(s, t, scope)
  const opts = { environment, evidenceClass, topology: 'cross-database: supabase source → neon target' }
  // Two passes: identities depend on the planned owners; the second pass carries gates R and I.
  const first = planC2(input, { ...opts, extraGates: { R }, acceptanceGates: CROSS_DB_ACCEPTANCE_GATES.filter((g) => g !== 'I') })
  const prerequisites = prerequisitesOf(first.plan, s)
  const I = gateI(prerequisites, environment)
  const { plan, report } = planC2(input, { ...opts, extraGates: { R, I }, acceptanceGates: CROSS_DB_ACCEPTANCE_GATES })
  report.source_target = {
    source: { provider: 'supabase', project: sourceProject, schema: s.schema, read_only: true },
    target: { provider: 'neon', project: binding.project ?? null, target: binding.target ?? null, target_id: binding.target_id ?? null, schema: t.schema },
    prerequisites: { identities: prerequisites.identities.length, financial_years: prerequisites.financial_years.length, rollback: 'not batch-tagged: identities and FYs are owner foundation and persist after a batch rollback' },
    claim_sequences: { source_rows: s.tables.claim_sequences.length, disposition: 'snapshot + checksum only; Neon claim_sequences alignment is C5 (WORK-193)' },
  }
  plan.report = report
  plan.topology = 'cross-database'
  plan.change_id = `fat-c2-${environment}-${report.input_fingerprint.slice(0, 24)}`
  plan.prerequisites = prerequisites
  plan.target_scope = scope
  plan.target_reference = normalise(t.reference)
  // The stale-plan check in apply compares the database's own rendering of the same reference rows.
  plan.target_reference_md5 = t.reference_md5
  plan.source_rows = SNAPSHOT_TABLES.flatMap((tb) => [...input.source[tb]].map((r) => normalise(r)).sort(byId).map((r) => ({ t: tb, id: String(r.id), canon: canonicalJson(r) })))
  return { plan, report }
}

// ── Admission (current target state; never part of the plan) ────────────────

/**
 * Decide, from a fresh target snapshot, whether this plan may be applied now:
 *   apply            nothing of it exists yet and nothing conflicts
 *   already_applied  the batch and every planned row are present (a rerun verifies, inserts nothing)
 *   refuse           something conflicts (rows held by another batch, identity/FY/claim-number clash)
 */
export function admitCrossDb(plan, targetSnap) {
  const t = readTargetSnapshot(targetSnap)
  if (canonicalJson(t.scope) !== canonicalJson(plan.target_scope)) return { verdict: 'refuse', conflicts: [{ code: 'scope_mismatch', why: 'target snapshot was read for a different source scope' }] }
  const conflicts = []
  const present = { batch: false, ledger: 0, identities: 0, financial_years: 0, claims: 0 }
  const st = normalise(t.state)

  const batch = st.batches.find((b) => b.batch_key === plan.batch_key)
  if (batch) {
    if (batch.status !== 'completed' || batch.source_checksum !== plan.source_checksum) conflicts.push({ code: 'batch_definition_differs', batch_key: plan.batch_key })
    else present.batch = true
  }
  if (canonicalJson(normalise(t.reference)) !== canonicalJson(plan.target_reference) || t.reference_md5 !== plan.target_reference_md5) conflicts.push({ code: 'stale_target_reference', why: 'target reference rows changed since the plan was made; re-plan' })

  for (const l of plan.ledger) {
    const e = st.ledger.find((x) => x.source_table === l.source_table && x.source_row_id === l.source_row_id)
    if (!e) continue
    if (e.batch_key !== plan.batch_key) conflicts.push({ code: 'source_row_held_by_other_batch', source: `${l.source_table}:${l.source_row_id}`, batch_key: e.batch_key })
    else if (e.source_checksum !== l.source_checksum || e.disposition !== l.disposition) conflicts.push({ code: 'ledger_row_differs', source: `${l.source_table}:${l.source_row_id}` })
    else present.ledger += 1
  }
  for (const i of plan.prerequisites.identities) {
    const byIdRow = st.identities.find((x) => x.id === i.id)
    const byEmail = st.identities.find((x) => i.email && String(x.email).toLowerCase() === String(i.email).toLowerCase())
    if (byEmail && byEmail.id !== i.id) conflicts.push({ code: 'identity_email_held_by_other_identity', owner: i.id })
    if (!byIdRow) continue
    if (byIdRow.origin !== 'legacy_supabase' || byIdRow.legacy_subject !== i.id || byIdRow.status !== 'active' || String(byIdRow.email).toLowerCase() !== String(i.email).toLowerCase()) {
      conflicts.push({ code: 'identity_differs', owner: i.id, found: { origin: byIdRow.origin, status: byIdRow.status } })
    } else present.identities += 1
  }
  for (const f of plan.prerequisites.financial_years) {
    const e = st.financial_years.find((x) => x.id === f.id)
    const clash = st.financial_years.find((x) => x.id !== f.id && x.user_id === f.user_id && x.label === f.label)
    if (clash) conflicts.push({ code: 'financial_year_label_held_by_other_fy', financial_year_id: f.id })
    if (!e) continue
    if (e.user_id !== f.user_id || e.label !== f.label || e.start_date !== f.start_date || e.end_date !== f.end_date) conflicts.push({ code: 'financial_year_differs', financial_year_id: f.id })
    else present.financial_years += 1
  }
  const planned = new Map(plan.claims.map((c) => [c.id, c]))
  for (const c of st.claims_in_scope) {
    if (planned.has(c.id)) {
      if (c.batch_key !== plan.batch_key) conflicts.push({ code: 'claim_held_by_other_batch', claim_id: c.id, batch_key: c.batch_key })
      else present.claims += 1
      continue
    }
    const clash = plan.claims.find((p) => p.claim_number != null && p.owner_id === c.owner_id && p.financial_year_id === c.financial_year_id && p.claim_type === c.claim_type && p.claim_number === c.claim_number)
    if (clash) conflicts.push({ code: 'claim_number_taken_on_target', claim_id: c.id, planned_claim_id: clash.id })
    if (c.prototype_row_id && plan.claims.some((p) => p.prototype_source === c.prototype_source && p.prototype_row_id === c.prototype_row_id)) {
      conflicts.push({ code: 'prototype_row_held_by_other_claim', claim_id: c.id })
    }
  }
  const complete = present.batch && present.ledger === plan.ledger.length && present.claims === plan.claims.length
  const none = !present.batch && present.ledger === 0 && present.claims === 0
  const verdict = conflicts.length ? 'refuse' : complete ? 'already_applied' : none ? 'apply' : 'refuse'
  if (!conflicts.length && verdict === 'refuse') conflicts.push({ code: 'partially_present', why: 'some but not all of this batch exists on the target' })
  return { verdict, batch_key: plan.batch_key, change_id: plan.change_id, present, conflicts }
}
