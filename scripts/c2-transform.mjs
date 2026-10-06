#!/usr/bin/env node
// ─── C2/C3 transform-copy tool CLI (WORK-190, WORK-191; cross-database WORK-255) ─
// Supabase prototype source (read-only) → Neon canonical target, one deterministic
// plan with a machine-readable parity report. Contract: docs/architecture/C2_TRANSFORM_CONTRACT.md.
//
//   source-extract-sql [--no-classifications]     read-only query for the legacy SUPABASE project
//   target-extract-sql --source S                 read-only query for the NEON target (source's scope)
//   synthetic-source --out F [--groups 0001,…] [--empty none] [--mutate sm-amount|empty-group-notes]
//                                                 synthetic source snapshot from the repository fixture
//   plan --source S --target T --env dev|prod --project P --target-name N --target-id ID
//        [--source-project REF] [--evidence real|synthetic] --out DIR
//                                                 report.json, plan.json, admission.json, verify.sql,
//                                                 rollback.sql, residue.sql, plan.sha256, and apply.sql
//                                                 only when every acceptance gate passes
//   admit --plan P --target T                     admission of a plan against a FRESH target snapshot
//   check --plan P --verify V                     compare a verify result with the plan
//
// Every SQL artefact runs on the Neon target only (never on Supabase), as one transaction.

import fs from 'node:fs'
import path from 'node:path'
import {
  sourceExtractSql, targetExtractSql, planCrossDb, admitCrossDb, syntheticCrossDbSource, mutateSyntheticSource,
  applySql, verifySql, rollbackSql, residueSql, checkVerify, canonicalJson, planSha256,
} from '../lib/fat/migration/c2/index.js'

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
/** Accept a raw snapshot, or the [{snapshot}] / {snapshot} row a SQL client returns. */
const snap = (f) => { const j = read(f); const x = Array.isArray(j) ? j[0] : j; return x.snapshot ?? x }

const o = args(process.argv.slice(2))
const cmd = o._[0]

if (cmd === 'source-extract-sql') {
  process.stdout.write(sourceExtractSql({ memberClassifications: !o['no-classifications'] }))
} else if (cmd === 'target-extract-sql') {
  process.stdout.write(targetExtractSql(snap(need(o, 'source'))))
} else if (cmd === 'synthetic-source') {
  const fixture = read(new URL('../__tests__/fixtures/c2/synthetic-source.json', import.meta.url))
  const opts = {}
  if (o.groups && o.groups !== true) opts.groups = String(o.groups).split(',')
  if (o.empty === 'none') opts.empty = []
  let s = syntheticCrossDbSource(fixture, opts)
  if (o.mutate && o.mutate !== true) s = mutateSyntheticSource(s, o.mutate)
  write(path.dirname(need(o, 'out')), path.basename(o.out), canonicalJson(s) + '\n')
} else if (cmd === 'plan') {
  const out = need(o, 'out')
  const { plan, report } = planCrossDb(snap(need(o, 'source')), snap(need(o, 'target')), {
    environment: need(o, 'env'), evidenceClass: o.evidence || 'real', sourceProject: o['source-project'] || null,
    binding: { project: need(o, 'project'), target: need(o, 'target-name'), target_id: need(o, 'target-id') },
  })
  const admission = admitCrossDb(plan, snap(o.target))
  write(out, 'report.json', canonicalJson(report) + '\n')
  write(out, 'plan.json', canonicalJson(plan) + '\n')
  write(out, 'admission.json', JSON.stringify(admission, null, 2) + '\n')
  write(out, 'verify.sql', verifySql(plan))
  write(out, 'rollback.sql', rollbackSql(plan))
  write(out, 'residue.sql', residueSql(plan))
  if (report.outcome === 'pass') write(out, 'apply.sql', applySql(plan))
  write(out, 'plan.sha256', planSha256(plan) + '\n')
  const g = Object.fromEntries(Object.entries(report.gates).map(([k, v]) => [k, v.status]))
  console.log(JSON.stringify({
    batch_key: plan.batch_key, change_id: plan.change_id, outcome: report.outcome, gates: g, source_checksum: plan.source_checksum,
    groups: report.source.groups, events: report.source.events, migrated: report.source.events_migrated, refused: report.source.events_refused,
    empty_claim_groups: report.empty_claim_groups.count, planned: report.planned, prerequisites: report.source_target.prerequisites,
    admission: admission.verdict, apply_sql: report.outcome === 'pass', plan_sha256: planSha256(plan),
  }, null, 2))
  if (report.outcome !== 'pass') process.exitCode = 1
} else if (cmd === 'admit') {
  const a = admitCrossDb(read(need(o, 'plan')), snap(need(o, 'target')))
  console.log(JSON.stringify(a, null, 2))
  if (a.verdict === 'refuse') process.exitCode = 1
} else if (cmd === 'check') {
  const r = checkVerify(read(need(o, 'plan')), (() => { const j = read(need(o, 'verify')); const v = Array.isArray(j) ? j[0] : j; return v.verify ?? v })())
  console.log(JSON.stringify(r, null, 2))
  if (!r.ok) process.exitCode = 1
} else {
  console.error('usage: c2-transform.mjs source-extract-sql | target-extract-sql | synthetic-source | plan | admit | check  (see header)')
  process.exit(2)
}
