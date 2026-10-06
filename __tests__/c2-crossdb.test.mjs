/**
 * WORK-255 — C2/C3 cross-database topology: Supabase prototype source (read-only) →
 * Neon canonical target. Split snapshots, deterministic planning, EMPTY_CLAIM_GROUP,
 * identity preservation through the WORK-254 seam, payment mapping, admission
 * (idempotent rerun / conflict / stale), rollback, target privilege model and the
 * batch-scoped verify that never reads a prototype table.
 *
 * Run with: node --test __tests__/c2-crossdb.test.mjs
 * The database side (apply, rerun, conflict raises, stale-plan guard, rollback, replay,
 * verify, RLS probe) is rehearsed on a local replica of the Neon schema and on Neon dev —
 * docs/evidence/WORK-255/.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

import {
  planCrossDb, admitCrossDb, targetScope, sourceExtractSql, targetExtractSql, syntheticCrossDbSource, mutateSyntheticSource, SYNTHETIC_N3,
  applySql, verifySql, rollbackSql, residueSql, checkVerify, verifyPayload, planSha256, canonicalJson, sha256Json,
} from '../lib/fat/migration/c2/index.js'
import { batchReport } from '../lib/fat/migration/c2/sql.js'
import { EXCLUSIONS } from '../lib/fat/migration/c2/constants.js'
import { targetFor, BINDING, MD5 } from './helpers/c2-cross.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/c2/synthetic-source.json', import.meta.url), 'utf8'))
const [A, B] = SYNTHETIC_N3.owners
const E = SYNTHETIC_N3.empty.map((e) => e.id)
const src = (opts) => syntheticCrossDbSource(fixture, opts)
const plan = (s, t = targetFor(s), opts = {}) => planCrossDb(s, t, { environment: 'dev', evidenceClass: 'synthetic', binding: BINDING, ...opts })
const clone = (x) => JSON.parse(JSON.stringify(x))
const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const PROTOTYPE_READ = /\b(from|join)\s+fat\.(claim_groups|recalls|retain|standby|spoilt_meals|user_rates)\b/
/** SQL code without its embedded data literals (data text may legitimately name prototype columns). */
const code = (sql) => sql.replace(/\$c2(plan|ver|ids)_[0-9a-f]{12}\$[\s\S]*?\$c2(plan|ver|ids)_[0-9a-f]{12}\$/g, '<literal>')

/** A target state holding exactly what an apply of `p` leaves behind. */
function appliedState(p) {
  return {
    identities: p.prerequisites.identities.map((i) => ({ id: i.id, email: i.email, origin: 'legacy_supabase', legacy_subject: i.id, status: 'active' })),
    profiles: p.prerequisites.identities.map((i) => i.id),
    financial_years: p.prerequisites.financial_years.map(({ is_active, ...f }) => f),
    claims_in_scope: p.claims.map((c) => ({ id: c.id, owner_id: c.owner_id, financial_year_id: c.financial_year_id, claim_type: c.claim_type, claim_number: c.claim_number, prototype_source: c.prototype_source, prototype_row_id: c.prototype_row_id, batch_key: p.batch_key })),
    ledger: p.ledger.map((l) => ({ source_table: l.source_table, source_row_id: l.source_row_id, batch_key: p.batch_key, source_checksum: l.source_checksum, disposition: l.disposition })),
    batches: [{ batch_key: p.batch_key, step: 'C2', status: 'completed', source_checksum: p.source_checksum }],
  }
}

// ── split topology ──────────────────────────────────────────────────────────

test('split topology: source from the Supabase snapshot, reference from the Neon snapshot; gates R and I join acceptance', () => {
  const s = src()
  const { plan: p, report } = plan(s)
  assert.equal(report.outcome, 'pass')
  assert.deepEqual(report.acceptance.required_gates, ['R', 'I', '1', '2', '3', '4', '5', '6', '7'])
  assert.equal(report.gates.R.status, 'pass')
  assert.equal(report.gates.I.status, 'pass')
  assert.match(report.topology, /supabase source → neon target/)
  assert.equal(report.source_target.source.provider, 'supabase')
  assert.deepEqual(report.source_target.target, { provider: 'neon', project: BINDING.project, target: 'dev', target_id: BINDING.target_id, schema: 'fat.c2.target-snapshot/v1' })
  assert.equal(p.topology, 'cross-database')
  assert.match(p.change_id, /^fat-c2-dev-[0-9a-f]{24}$/)
  assert.equal(p.target_reference_md5, MD5)
  // The source checksum covers all seven Supabase tables (C4 archive set), each with per-table counts and checksums.
  assert.deepEqual(Object.keys(report.gates['8'].evidence.table_checksums).sort(), ['claim_groups', 'claim_sequences', 'financial_years', 'recalls', 'retain', 'spoilt_meals', 'standby'])
  assert.equal(report.source.rows.claim_sequences, s.tables.claim_sequences.length)
})

test('the target snapshot must be read for this exact source scope', () => {
  const s = src()
  const other = targetFor(src({ groups: ['0001'] }))
  assert.throws(() => plan(s, other), /different source scope/)
})

test('extraction SQL: the Supabase query is read-only over the seven tables; the Neon query is read-only for the source scope', () => {
  const q = sourceExtractSql()
  assert.doesNotMatch(q, /\b(insert|update|delete|truncate|alter|create|grant|revoke|drop)\b/i)
  for (const t of ['claim_groups', 'recalls', 'retain', 'standby', 'spoilt_meals', 'claim_sequences', 'financial_years', 'profiles', 'stations', 'member_classifications']) assert.match(q, new RegExp(`fat\\.${t}\\b`))
  assert.doesNotMatch(sourceExtractSql({ memberClassifications: false }), /fat\.member_classifications/)
  const t = targetExtractSql(src())
  assert.doesNotMatch(t, /\b(insert|update|delete|truncate|alter|create|grant|revoke|drop)\b/i)
  assert.doesNotMatch(t, PROTOTYPE_READ)
  assert.match(t, /'reference_md5', md5\(/)
  assert.ok(t.includes(canonicalJson(targetScope(src()))))
})

// ── determinism ─────────────────────────────────────────────────────────────

test('deterministic: same snapshots → byte-identical plan, report, batch key, plan hash and SQL; row/key order irrelevant', () => {
  const a = plan(src())
  const b = plan(src())
  assert.equal(canonicalJson(a.plan), canonicalJson(b.plan))
  assert.equal(planSha256(a.plan), planSha256(b.plan))
  const shuffled = src()
  for (const t of Object.keys(shuffled.tables)) shuffled.tables[t] = shuffled.tables[t].reverse().map((r) => Object.fromEntries(Object.entries(r).reverse()))
  const c = plan(shuffled, targetFor(src()))
  assert.equal(c.plan.batch_key, a.plan.batch_key)
  assert.equal(canonicalJson(c.report), canonicalJson(a.report))
  assert.equal(applySql(c.plan), applySql(a.plan))
  assert.equal(verifySql(c.plan), verifySql(a.plan))
  assert.match(a.plan.batch_key, /^c2:dev:2\.0\.0:[0-9a-f]{32}$/)
})

test('target STATE never changes the plan (a rerun after apply plans the same batch); target REFERENCE does', () => {
  const s = src()
  const a = plan(s)
  const after = plan(s, targetFor(s, { state: appliedState(a.plan) }))
  assert.equal(canonicalJson(after.plan), canonicalJson(a.plan))
  const changedRate = targetFor(s, { versions: (targetFor(s).reference.rate_versions).map((v, i) => ({ ...v, withdrawn_at: null, value: i === 0 ? Number(v.value) + 1 : v.value })) })
  assert.notEqual(plan(s, changedRate).plan.batch_key, a.plan.batch_key)
})

test('canonical ids, ledger ids and payment ids come from source lineage only (independent of batch)', () => {
  const a = plan(src()).plan
  const b = plan(mutateSyntheticSource(src(), 'sm-amount')).plan
  assert.notEqual(a.batch_key, b.batch_key)
  assert.deepEqual(b.claims.map((c) => c.id), a.claims.map((c) => c.id))
  assert.deepEqual(b.entitlements.map((e) => e.id), a.entitlements.map((e) => e.id))
  assert.deepEqual(b.ledger.map((l) => l.id), a.ledger.map((l) => l.id))
  assert.deepEqual(b.payment_records.map((r) => r.id), a.payment_records.map((r) => r.id))
})

// ── EMPTY_CLAIM_GROUP ───────────────────────────────────────────────────────

test('EMPTY_CLAIM_GROUP — one empty group: no claim, one provenance-only exclusion, gate 1 passes truthfully', () => {
  const s = src({ groups: [], empty: [SYNTHETIC_N3.empty[1]] })
  const { plan: p, report } = plan(s)
  assert.equal(report.outcome, 'pass')
  assert.equal(p.claims.length, 0)
  assert.equal(p.ledger.length, 1)
  const l = p.ledger[0]
  assert.deepEqual([l.source_table, l.source_row_id, l.disposition, l.exclusion_code, l.target_claim_id, l.owner_id], ['claim_groups', E[1], 'excluded', 'EMPTY_CLAIM_GROUP', null, B.id])
  assert.equal(l.source_snapshot.id, E[1])
  assert.equal(l.exclusion_reason, EXCLUSIONS.EMPTY_CLAIM_GROUP.reason)
  assert.equal(l.source_checksum, sha256Json(l.source_snapshot))
  assert.equal(report.gates['1'].evidence.groups_excluded_empty, 1)
  assert.equal(report.gates['1'].evidence.groups_without_exactly_one_disposition, 0)
  assert.deepEqual(report.source.groups, { total: 1, claimed: 0, excluded_empty: 1, refused: 0 })
  assert.equal(report.empty_claim_groups.count, 1)
  assert.equal(report.refused.length, 0)
  // The owner still becomes a preserved identity (the ledger row is owner-bound); no FY is needed.
  assert.deepEqual(p.prerequisites.identities.map((i) => i.id), [B.id])
  assert.equal(p.prerequisites.financial_years.length, 0)
})

test('EMPTY_CLAIM_GROUP — multiple empty groups, and mixed with valid claims: every group has exactly one disposition', () => {
  const multi = plan(src({ groups: [] })).report
  assert.equal(multi.empty_claim_groups.count, 3)
  assert.equal(multi.outcome, 'pass')
  const { plan: p, report } = plan(src())
  assert.deepEqual(report.source.groups, { total: 6, claimed: 3, excluded_empty: 3, refused: 0 })
  assert.equal(p.claims.length, 3)
  assert.equal(p.ledger.filter((l) => l.exclusion_code === 'EMPTY_CLAIM_GROUP').length, 3)
  assert.equal(p.ledger.filter((l) => l.exclusion_code === 'G12_FAKE_RECALL_EXCESS_TRAVEL').length, 1)
  assert.ok(!p.claims.some((c) => E.includes(c.prototype_claim_group_id)))
  assert.deepEqual(report.planned.ledger, { claim: 6, entitlement: 4, excluded: 4 })
  assert.deepEqual(report.empty_claim_groups.groups.map((g) => g.group_id), E)
  assert.equal(report.gates['4'].status, 'pass')
  assert.equal(report.gates['7'].status, 'pass')
})

test('EMPTY_CLAIM_GROUP is not a loophole: a group with members but no parent is still refused; an empty group of an unknown owner is refused', () => {
  const s = src()
  s.tables.recalls = s.tables.recalls.filter((r) => r.calculation_inputs?.autoChild) // drop the RC parent, keep its children
  const r1 = plan(s).report
  assert.equal(r1.outcome, 'fail')
  assert.ok(r1.refused.some((x) => x.code === 'parent_count_0'))
  const s2 = src()
  s2.reference.profiles = s2.reference.profiles.filter((x) => x.id !== B.id)
  const r2 = plan(s2).report
  assert.equal(r2.outcome, 'fail')
  assert.equal(r2.refused.filter((x) => x.code === 'owner_missing').length, 2)
})

test('EMPTY_CLAIM_GROUP rerun is idempotent and a changed empty group conflicts (checksum change)', () => {
  const s = src()
  const a = plan(s).plan
  assert.equal(admitCrossDb(a, targetFor(s, { state: appliedState(a) })).verdict, 'already_applied')
  const c = mutateSyntheticSource(s, 'empty-group-notes')
  const pc = plan(c, targetFor(c, { state: appliedState(a) })).plan
  const changed = pc.ledger.find((l) => l.source_row_id === E[0])
  assert.notEqual(changed.source_checksum, a.ledger.find((l) => l.source_row_id === E[0]).source_checksum)
  const adm = admitCrossDb(pc, targetFor(c, { state: appliedState(a) }))
  assert.equal(adm.verdict, 'refuse')
  assert.ok(adm.conflicts.some((x) => x.code === 'source_row_held_by_other_batch' && x.source === `claim_groups:${E[0]}`))
  assert.match(applySql(pc), /C2 conflict: migration_source_rows % \(% %\) differs from the planned disposition/)
})

// ── identity ────────────────────────────────────────────────────────────────

test('identity: every owner keeps its Supabase UUID as a legacy_supabase FAT app identity; no password, no provider link', () => {
  const { plan: p, report } = plan(src())
  assert.deepEqual(p.prerequisites.identities, SYNTHETIC_N3.owners.map((o) => ({ id: o.id, email: o.email, origin: 'legacy_supabase' })))
  assert.ok(p.claims.every((c) => c.owner_id === A.id))
  const sql = applySql(p)
  assert.match(sql, /perform fat\.ensure_app_identity\(pi\.id, pi\.email, 'legacy_supabase'\)/)
  assert.match(sql, /ai\.origin <> 'legacy_supabase' or ai\.legacy_subject is distinct from pi\.id/)
  assert.doesNotMatch(code(sql), /identity_links|password/i)
  assert.equal(report.gates.I.evidence.owners, 2)
})

test('identity: a dev target refuses any non-reserved e-mail; a missing or duplicate e-mail fails gate I', () => {
  const real = src()
  real.reference.profiles[0].email = 'someone@gmail.com'
  const r = plan(real)
  assert.equal(r.report.gates.I.status, 'fail')
  assert.deepEqual(r.report.gates.I.evidence.non_reserved_email_on_dev, [A.id])
  assert.throws(() => applySql(r.plan), /apply refused/)
  assert.equal(plan(real, targetFor(real), { environment: 'prod' }).report.gates.I.status, 'pass')
  const none = src(); none.reference.profiles[1].email = null
  assert.deepEqual(plan(none).report.gates.I.evidence.owners_without_email, [B.id])
  const dup = src(); dup.reference.profiles[1].email = A.email.toUpperCase()
  assert.equal(plan(dup).report.gates.I.evidence.duplicate_emails, 1)
})

// ── reference ───────────────────────────────────────────────────────────────

test('gate R: a station missing on the target or named differently fails closed (governed reference load first)', () => {
  const s = src()
  const missing = plan(s, targetFor(s, { stations: [SYNTHETIC_N3.stations[0]] })).report
  assert.equal(missing.gates.R.status, 'fail')
  assert.equal(missing.gates.R.evidence.findings[0].code, 'reference_station_missing_on_target')
  const renamed = plan(s, targetFor(s, { stations: [SYNTHETIC_N3.stations[0], { id: 9002, name: 'Renamed' }] })).report
  assert.equal(renamed.gates.R.evidence.findings[0].code, 'reference_station_mismatch')
  assert.equal(renamed.outcome, 'fail')
})

// ── payments (WORK-191 contract unchanged) ──────────────────────────────────

test('payment state: paid → one deterministic record + link, unpaid stays open, totals reconcile; contradictions fail closed', () => {
  const { plan: p, report } = plan(src())
  const g6 = report.gates['6']
  assert.equal(g6.status, 'pass')
  assert.equal(p.payment_records.length, 4)
  assert.equal(p.payment_links.length, 4)
  assert.equal(g6.evidence.source_paid.amount, g6.evidence.canonical.allocated_amount)
  assert.ok(p.payment_records.every((r) => r.source === 'prototype_migration' && /^c3:[a-z_]+:[0-9a-f-]{36}:[a-z_]+$/.test(r.migration_source_key)))
  const open = p.entitlements.filter((e) => !p.payment_links.some((l) => l.entitlement_id === e.id))
  assert.ok(open.length > 0 && open.every((e) => ['pending', 'outstanding'].includes(e.payment_status)))
  const bad = src()
  bad.tables.spoilt_meals.find((r) => r.payment_status === 'Paid').payment_date = null
  const rb = plan(bad).report
  assert.equal(rb.gates['6'].status, 'fail')
  assert.ok(rb.payments.failures.some((f) => f.code === 'C3_PAID_WITHOUT_DATE'))
})

// ── admission: idempotent rerun, conflicts, stale ───────────────────────────

test('admission: apply on a clean target; already_applied after apply (rerun inserts nothing); partial presence refuses', () => {
  const s = src()
  const p = plan(s).plan
  assert.equal(admitCrossDb(p, targetFor(s)).verdict, 'apply')
  const done = admitCrossDb(p, targetFor(s, { state: appliedState(p) }))
  assert.equal(done.verdict, 'already_applied')
  assert.deepEqual(done.present, { batch: true, ledger: 14, identities: 2, financial_years: 1, claims: 3 })
  const half = appliedState(p); half.ledger = half.ledger.slice(0, 3); half.claims_in_scope = []; half.batches = []
  const partial = admitCrossDb(p, targetFor(s, { state: half }))
  assert.equal(partial.verdict, 'refuse')
})

test('admission: a changed source snapshot is refused (rows held by the applied batch); stale reference and identity / FY / number clashes refuse', () => {
  const s = src()
  const a = plan(s).plan
  const changed = mutateSyntheticSource(s, 'sm-amount')
  const b = plan(changed, targetFor(changed, { state: appliedState(a) })).plan
  const adm = admitCrossDb(b, targetFor(changed, { state: appliedState(a) }))
  assert.equal(adm.verdict, 'refuse')
  assert.ok(adm.conflicts.some((c) => c.code === 'source_row_held_by_other_batch'))
  assert.ok(adm.conflicts.some((c) => c.code === 'claim_held_by_other_batch'))
  assert.equal(admitCrossDb(a, targetFor(s, { md5: 'f'.repeat(32) })).conflicts[0].code, 'stale_target_reference')
  const synth = targetFor(s, { state: { identities: [{ id: A.id, email: A.email, origin: 'synthetic', legacy_subject: null, status: 'active' }] } })
  assert.ok(admitCrossDb(a, synth).conflicts.some((c) => c.code === 'identity_differs'))
  const emailTaken = targetFor(s, { state: { identities: [{ id: '5eed0000-0000-4000-8000-00000000000a', email: A.email, origin: 'synthetic', legacy_subject: null, status: 'active' }] } })
  assert.ok(admitCrossDb(a, emailTaken).conflicts.some((c) => c.code === 'identity_email_held_by_other_identity'))
  const fy = a.prerequisites.financial_years[0]
  const fyClash = targetFor(s, { state: { financial_years: [{ ...fy, id: '5eed0255-0000-4000-8000-0000000000ff' }] } })
  assert.ok(admitCrossDb(a, fyClash).conflicts.some((c) => c.code === 'financial_year_label_held_by_other_fy'))
  const rc = a.claims.find((c) => c.claim_type === 'RC')
  const taken = targetFor(s, { state: { claims_in_scope: [{ id: '5eed0255-0000-4000-8000-00000000c0de', owner_id: rc.owner_id, financial_year_id: rc.financial_year_id, claim_type: 'RC', claim_number: rc.claim_number, prototype_source: null, prototype_row_id: null, batch_key: null }] } })
  assert.ok(admitCrossDb(a, taken).conflicts.some((c) => c.code === 'claim_number_taken_on_target'))
})

// ── SQL: apply / verify / rollback / residue ────────────────────────────────

test('apply SQL: transport guard first, stale-reference guard, prerequisites, data-load ledger, then the batch; no prototype table', () => {
  const { plan: p } = plan(src())
  const sql = applySql(p)
  const i = (x) => { const n = sql.indexOf(x); assert.ok(n >= 0, x); return n }
  assert.ok(i(`if c2_plan_sha <> '${planSha256(p)}' then`) < i("C2 stale plan"))
  assert.ok(i('C2 stale plan') < i('perform fat.ensure_app_identity'))
  assert.ok(i('perform fat.ensure_app_identity') < i('insert into fat.financial_years'))
  assert.ok(i('insert into fat.financial_years') < i("insert into fat_migrations.data_loads (change_id, kind, checksum) values (c2_plan->>'change_id', 'migration_batch'"))
  assert.ok(i('fat_migrations.data_loads') < i('insert into fat.migration_batches'))
  assert.match(sql, /if md5\(\(jsonb_build_object\(/)
  assert.match(sql, /EMPTY_CLAIM_GROUP row\(s\) carry or produced a claim/)
  assert.doesNotMatch(code(sql), PROTOTYPE_READ)
  assert.doesNotMatch(code(sql), /\b(anon|authenticated|service_role)\b/)
  // The stored batch report is the parity summary bound to report.json by its sha256.
  const r = batchReport(p.report)
  assert.equal(r.full_report_sha256, sha256Json(p.report))
  assert.equal(r.gates['1'].status, 'pass')
  assert.equal(typeof r.events, 'number')
})

test('verify SQL: embeds the source snapshot; the DB rebuild of its canonical text hashes to source_checksum; Neon privilege model; RLS probe', () => {
  const { plan: p } = plan(src())
  const v = verifySql(p)
  assert.doesNotMatch(v, PROTOTYPE_READ)
  assert.doesNotMatch(v, /has_table_privilege\('(anon|authenticated)'/)
  assert.match(v, /has_table_privilege\('fat_app'/)
  assert.match(v, /has_table_privilege\('fat_service'/)
  assert.match(v, /execute 'set local role fat_app'/)
  assert.match(v, /grant fat_app to %I with inherit false, set true/)
  // Re-derive the canonical source text exactly as the verify SQL does: tables sorted (C collation), rows in embedded order.
  const vp = verifyPayload(p)
  const text = '{' + vp.tables.map((t) => `"${t}":[${vp.rows.filter((r) => r.t === t).map((r) => r.canon).join(',')}]`).join(',') + '}'
  assert.equal(sha(text), p.source_checksum)
  for (const l of p.ledger) assert.equal(sha(vp.rows.find((r) => r.t === l.source_table && r.id === l.source_row_id).canon), l.source_checksum)
  assert.equal(vp.probe.owner, A.id)
  assert.equal(vp.probe.owner_claims, 3)
  assert.equal(vp.probe.other_owner, B.id)
})

test('checkVerify: a clean verify passes; every failing check is named', () => {
  const { plan: p } = plan(src())
  const zeroKeys = ['ledger_checksum_mismatches', 'source_rows_without_exactly_one_ledger_row', 'gate1_empty_group_violations', 'gate1_groups_without_exactly_one_disposition',
    'gate2_number_or_fy_mismatch', 'gate2_scope_duplicates', 'gate3_bad_detail', 'gate3_parents_without_claim', 'gate4_child_violations', 'gate5_missing_source_rows',
    'gate5_value_mismatches', 'gate5_adjustment_mismatches', 'gate6_source_invalid', 'gate6_paid_without_exactly_one_migration_link', 'gate6_unpaid_with_links',
    'gate6_allocation_mismatches', 'gate6_record_date_mismatches', 'gate6_status_mismatches', 'gate6_audit_mismatches', 'gate6_unlinked_migration_records',
    'gate6_duplicate_source_keys', 'gate7_cross_owner_entitlements', 'gate7_cross_owner_fy', 'gate7_ledger_orphan_or_cross_owner', 'gate7_orphan_details',
    'gate7_payment_links_cross_owner_or_stream', 'gateI_identity_violations', 'gateI_planned_identities_missing', 'gateI_planned_fys_missing']
  const clean = {
    ...Object.fromEntries(zeroKeys.map((k) => [k, 0])),
    batch: { status: 'completed', outcome: 'pass', full_report_sha256: sha256Json(p.report) },
    data_load: { change_id: p.change_id, kind: 'migration_batch' },
    source_snapshot: { embedded_sha256: p.source_checksum, plan_source_checksum: p.source_checksum, batch_source_checksum: p.source_checksum, canon_parse_mismatches: 0 },
    planned_vs_target: { claims_missing: 0, claims_unplanned: 0, entitlements_missing: 0, entitlements_unplanned: 0, ledger_missing: 0, ledger_unplanned: 0, payment_records_missing: 0, payment_records_unplanned: 0, duplicate_canonical_ids: 0, payment_links: 4, payment_links_planned: 4, adjustment_overrides: 1, adjustments_planned: 1 },
    ledger_by_disposition: { claim: 6, entitlement: 4, excluded: 4 }, ledger_by_disposition_planned: p.report.planned.ledger,
    gate1_empty_claim_groups: 3, gate1_empty_claim_groups_planned: 3,
    gate5_totals: { dollars_source: 1, dollars_target: 1, hours_source: 2, hours_target: 2 },
    gate6_totals: { source_paid_entitlements: 4, source_paid_amount: 5, migration_records: 4, links_on_lineage: 4, allocated_amount: 5 },
    gate7_security: { rls_disabled: 0, fat_app_privileges_on_protected_tables: 0, fat_app_can_write_identities: 0, fat_service_missing_migration_access: 0, roles_login_or_bypassrls: 0, public_executable_functions: 0, provenance_guards_missing: 0, no_api_access_policies_missing: 0, supabase_api_roles_present: 0 },
    rls_probe: { owner_sees_own_migrated_claims: 3, expected: 3, owner_sees_other_owners_entitlements: 0, other_owner_sees_owner_claims: 0, unset_identity_sees: 0, ledger_readable_by_fat_app: false },
  }
  assert.deepEqual(checkVerify(p, clean), { ok: true, failures: [] })
  const bad = checkVerify(p, { ...clean, gate5_value_mismatches: 2, gate7_security: { ...clean.gate7_security, rls_disabled: 1 }, rls_probe: { ...clean.rls_probe, unset_identity_sees: 3 }, source_snapshot: { ...clean.source_snapshot, embedded_sha256: 'x' } })
  assert.deepEqual(bad.failures, ['gate5_value_mismatches = 2', 'gate7_security.rls_disabled = 1', 'embedded source snapshot does not hash to the batch source_checksum', 'rls: an unset identity sees migrated claims'])
})

test('rollback and residue: only the batch, identities and FYs kept as foundation, data-load replaced by <change>-rollback', () => {
  const { plan: p } = plan(src())
  const r = rollbackSql(p)
  assert.doesNotMatch(r, /delete from fat\.(app_identities|profiles|financial_years|stations|rates|rate_versions)\b/)
  for (const t of ['payment_records', 'claim_entitlements', 'operational_claims']) assert.match(r, new RegExp(`delete from fat\\.${t} where migration_batch_id = b`))
  assert.match(r, /delete from fat\.migration_source_rows where batch_id = b/)
  assert.match(r, new RegExp(`delete from fat_migrations\\.data_loads where change_id = '${p.change_id}'`))
  assert.match(r, new RegExp(`values \\('${p.change_id}-rollback', 'migration_batch', 'sha256:${planSha256(p)}'\\)`))
  const res = residueSql(p)
  assert.doesNotMatch(res, /\b(insert|update|delete)\b/i)
  for (const k of ['claims', 'entitlements', 'payment_records', 'payment_links', 'reconciliation_audit', 'ledger', 'data_load', 'identities_kept', 'financial_years_kept']) assert.match(res, new RegExp(`'${k}'`))
})

test('SQL artefacts refuse a non-cross-database plan or an unsafe change id', () => {
  const { plan: p } = plan(src())
  assert.throws(() => applySql({ ...p, topology: undefined }), /cross-database plan/)
  assert.throws(() => verifySql({ ...p, change_id: "x'; drop" }), /unsafe change id/)
  assert.throws(() => rollbackSql({ ...p, target_reference_md5: null }), /cross-database plan/)
})

test('no Supabase dependency in the target-side SQL; source-side SQL never writes', () => {
  const { plan: p } = plan(src())
  for (const s of [applySql(p), verifySql(p), rollbackSql(p), residueSql(p)]) {
    assert.doesNotMatch(code(s), /\bauth\.(uid|role|users|jwt)\b/)
    assert.doesNotMatch(code(s), /supabase_migrations|storage\./)
    assert.doesNotMatch(code(s), PROTOTYPE_READ)
  }
  assert.ok(clone(p).source_rows.length === Object.values(src().tables).flat().length)
})
