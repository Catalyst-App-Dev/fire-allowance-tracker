#!/usr/bin/env node
// ─── C2 transform-copy tool CLI (WORK-190; C3 payment state WORK-191) ────────
// Deterministic prototype → canonical transform with a machine-readable parity
// report. Contract: docs/architecture/C2_TRANSFORM_CONTRACT.md.
//
//   extract-sql                                   print the read-only extraction query
//   plan --snapshot S --env dev|prod [--evidence real|synthetic] --out DIR
//                                                 write report.json, plan.json, apply.sql,
//                                                 verify.sql, rollback.sql (apply only when
//                                                 acceptance gates pass)
//   bind-fixture --fixture F --owner U --fy FY --stations A,B --out B
//                                                 bind a synthetic fixture's placeholders (source only)
//   fixture-snapshot-sql --source B               read-only query: fixture as source + DB reference/target
//   harness-sql --snapshot X --out DIR            synthetic rehearsal harness (plan A + changed-source plans B (amount)
//                                                 and C (payment state, WORK-191));
//                                                 transaction-scoped, ends in RAISE — nothing persists
//   check --report R --verify V                   compare a verify result with the report
//
// Every SQL artefact runs as the DB owner / service role and is portable PostgreSQL.

import fs from 'node:fs'
import path from 'node:path'
import {
  planC2, extractSql, applySql, verifySql, rollbackSql, syntheticHarnessSql, checkVerify,
  bindSource, fixtureSnapshotSql, mutateSourceForConflict, mutateSourceForPaymentChange, canonicalJson, planSha256, fixtureJson, sha256Json,
} from '../lib/fat/migration/c2/index.js'
import { SOURCE_TABLES } from '../lib/fat/migration/c2/constants.js'

function args(argv) {
  const o = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
    else o._.push(argv[i])
  }
  return o
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const need = (o, k) => { if (!o[k] || o[k] === true) { console.error(`missing --${k}`); process.exit(2) } return o[k] }
const write = (dir, name, text) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); return path.join(dir, name) }
/** Accept a raw snapshot, or the {snapshot} row a SQL client returns. */
const snap = (f) => { const j = read(f); const x = Array.isArray(j) ? j[0] : j; return x.snapshot ?? x }

const o = args(process.argv.slice(2))
const cmd = o._[0]

if (cmd === 'extract-sql') {
  process.stdout.write(extractSql())
} else if (cmd === 'plan') {
  const env = need(o, 'env')
  const out = need(o, 'out')
  const { plan, report } = planC2(snap(need(o, 'snapshot')), { environment: env, evidenceClass: o.evidence || 'real' })
  write(out, 'report.json', canonicalJson(report) + '\n')
  write(out, 'plan.json', canonicalJson(plan) + '\n')
  write(out, 'verify.sql', verifySql(plan.batch_key))
  write(out, 'rollback.sql', rollbackSql(plan.batch_key))
  if (report.outcome === 'pass') write(out, 'apply.sql', applySql(plan))
  write(out, 'plan.sha256', planSha256(plan) + '\n')
  const g = Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.status]))
  console.log(JSON.stringify({ batch_key: plan.batch_key, outcome: report.outcome, gates: g, events: report.source.events, migrated: report.source.events_migrated, refused: report.source.events_refused, generator_parity: report.generator_parity.by_type, apply_sql: report.outcome === 'pass', plan_sha256: planSha256(plan) }, null, 2))
  if (report.outcome !== 'pass') process.exitCode = 1
} else if (cmd === 'bind-fixture') {
  const source = bindSource(read(need(o, 'fixture')), { owner: need(o, 'owner'), fy: need(o, 'fy'), stations: String(need(o, 'stations')).split(',') })
  write(path.dirname(need(o, 'out')), path.basename(o.out), canonicalJson({ source }) + '\n')
} else if (cmd === 'fixture-snapshot-sql') {
  process.stdout.write(fixtureSnapshotSql(read(need(o, 'source')).source))
} else if (cmd === 'harness-sql') {
  const out = need(o, 'out')
  const x = snap(need(o, 'snapshot'))
  const a = planC2(x, { environment: 'dev', evidenceClass: 'synthetic' })
  const b = planC2(mutateSourceForConflict(x), { environment: 'dev', evidenceClass: 'synthetic' })
  const c = planC2(mutateSourceForPaymentChange(x), { environment: 'dev', evidenceClass: 'synthetic' })
  if (a.report.outcome !== 'pass' || b.report.outcome !== 'pass' || c.report.outcome !== 'pass') { console.error('synthetic plans must pass their gates'); process.exit(1) }
  const fixtureSource = Object.fromEntries(SOURCE_TABLES.map((t) => [t, x.source[t] || []]))
  write(out, 'report-A.json', canonicalJson(a.report) + '\n')
  write(out, 'plan-A.json', canonicalJson(a.plan) + '\n')
  write(out, 'report-B.json', canonicalJson(b.report) + '\n')
  write(out, 'report-C.json', canonicalJson(c.report) + '\n')
  write(out, 'harness.sql', syntheticHarnessSql({ fixtureSource, planA: a.plan, planB: b.plan, planC: c.plan }))
  const expect = {
    plan_a_sha256: planSha256(a.plan),
    claims: a.plan.claims.length, entitlements: a.plan.entitlements.length, ledger: a.plan.ledger.length,
    adjustments: a.plan.adjustments.length, payment_records: a.plan.payment_records.length, payment_links: a.plan.payment_links.length,
    paid_amount: a.report.gates['6'].evidence.source_paid.amount, details: Object.fromEntries(Object.entries(a.plan.details).map(([t, r]) => [t, r.length])),
  }
  write(out, 'expect.json', JSON.stringify(expect, null, 2) + '\n')
  console.log(JSON.stringify({ ...expect, batch_key_A: a.plan.batch_key, batch_key_B: b.plan.batch_key, outcome: a.report.outcome, harness_bytes: fs.statSync(path.join(out, 'harness.sql')).size }, null, 2))
} else if (cmd === 'check') {
  const r = checkVerify(read(need(o, 'report')), (() => { const j = read(need(o, 'verify')); const v = Array.isArray(j) ? j[0] : j; return v.verify ?? v })())
  console.log(JSON.stringify(r, null, 2))
  if (!r.ok) process.exitCode = 1
} else {
  console.error('usage: c2-transform.mjs extract-sql | plan | bind-fixture | fixture-extract-sql | harness-sql | check  (see header)')
  process.exit(2)
}
