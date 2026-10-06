#!/usr/bin/env node
// ─── FAT Neon DEV — database-level RLS / identity proof (WORK-256) ───────────
// Uses the app server's own credential and data-layer functions
// (lib/server/db.js) against Neon `dev`. Synthetic identities only.
//
//   node --conditions=react-server scripts/neon-dev-rls-proof.mjs <identityA> <identityB>
//   (DATABASE_URL = fat_app_server, DATABASE_SERVICE_URL = fat_identity_provisioner)
//
// Proves: unset identity sees no owner-scoped row; A sees only A, B only B;
// A cannot update/delete/insert B's rows; fat_app cannot read identity links or
// provision identities; the provisioning role cannot act as a member.

import { withMemberTx, withUnboundMemberTx } from '../lib/server/db.js'
import { Pool } from '@neondatabase/serverless'

const [idA, idB] = process.argv.slice(2)
if (!idA || !idB) { console.error('usage: neon-dev-rls-proof.mjs <identityA> <identityB>'); process.exit(2) }

const OWNER_TABLES = {
  operational_claims: 'owner_id', claim_entitlements: 'owner_id', financial_years: 'user_id', profiles: 'id',
  profile_ext: 'user_id', member_classifications: 'owner_id', claim_sequences: 'user_id', home_address: 'user_id',
  payment_records: 'owner_id', entitlement_overrides: 'owner_id',
}
const checks = []
const check = (name, ok, detail = null) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.error('✗', name, detail ?? '') }

async function expectDenied(fn) {
  try { await fn(); return { denied: false } } catch (e) { return { denied: true, code: e.code ?? null, message: e.message } }
}

async function counts(query) {
  const out = {}
  for (const [t, col] of Object.entries(OWNER_TABLES)) {
    const rows = await query(`select count(*)::int as n, count(*) filter (where ${col} = fat.current_app_user_id())::int as own from fat.${t}`)
    out[t] = rows[0]
  }
  return out
}

// 1. Unset identity (fat_app, no fat.app_user_id): nothing visible.
const unset = await withUnboundMemberTx(({ query }) => counts(query))
check('unset identity sees no owner-scoped row (all tables)', Object.values(unset).every((c) => c.n === 0), unset)

// 2. A sees only A; B only B.
const seenA = await withMemberTx(idA, ({ query }) => counts(query))
const seenB = await withMemberTx(idB, ({ query }) => counts(query))
check('A sees only A rows', Object.values(seenA).every((c) => c.n === c.own), seenA)
check('B sees only B rows', Object.values(seenB).every((c) => c.n === c.own), seenB)
check('A has claims to protect (non-vacuous)', seenA.operational_claims.n > 0 && seenA.claim_entitlements.n > 0, seenA.operational_claims)
check('B has claims to protect (non-vacuous)', seenB.operational_claims.n > 0, seenB.operational_claims)

// 3. Cross-owner writes (every statement rolled back by throwing).
class Rollback extends Error {}
async function inRolledBack(id, fn) {
  try { await withMemberTx(id, async (db) => { await fn(db); throw new Rollback() }) } catch (e) { if (!(e instanceof Rollback)) throw e }
}
await inRolledBack(idA, async ({ query }) => {
  const up = await query('update fat.operational_claims set notes = $2 where owner_id = $1 returning id', [idB, 'attack'])
  check('A cannot update B claims (0 rows)', up.length === 0, up.length)
  const del = await query('delete from fat.claim_entitlements where owner_id = $1 returning id', [idB])
  check('A cannot delete B entitlements (0 rows)', del.length === 0, del.length)
  const fyB = await query('select id from fat.financial_years where user_id = $1', [idB])
  check('A cannot read B financial years', fyB.length === 0, fyB.length)
})
const ins = await expectDenied(() => withMemberTx(idA, ({ query }) => query(
  "insert into fat.operational_claims (owner_id, claim_type, claim_date, status) values ($1, 'SM', '2026-09-01', 'submitted')", [idB])))
check('A cannot insert a claim owned by B (RLS 42501)', ins.denied && ins.code === '42501', ins)
const seq = await expectDenied(() => withMemberTx(idA, ({ query }) => query(
  "select fat.increment_claim_sequence($1, gen_random_uuid(), 'RC')", [idB])))
check('A cannot advance B claim sequence (42501)', seq.denied && seq.code === '42501', seq)

// 4. Identity seam is not reachable by members.
const links = await expectDenied(() => withMemberTx(idA, ({ query }) => query('select count(*)::int as n from fat.identity_links')))
check('fat_app has no access to identity links (42501)', links.denied && links.code === '42501', links)
await inRolledBack(idA, async ({ query }) => {
  const ids = await query('select id from fat.app_identities')
  check('fat_app sees only its own app identity', ids.length === 1 && ids[0].id === idA, ids)
})
const prov = await expectDenied(() => withMemberTx(idA, ({ query }) => query("select fat.ensure_app_identity(null, 'x@example.invalid', 'native')")))
check('fat_app cannot provision identities (42501)', prov.denied && prov.code === '42501', prov)
const res = await expectDenied(() => withMemberTx(idA, ({ query }) => query("select fat.resolve_app_identity('neon_auth', 'anything')")))
check('fat_app cannot resolve identities (42501)', res.denied && res.code === '42501', res)

// 5. Login roles hold nothing without SET ROLE, and cannot cross roles.
for (const [name, url, other] of [['fat_app_server', process.env.DATABASE_URL, 'fat_service'], ['fat_identity_provisioner', process.env.DATABASE_SERVICE_URL, 'fat_app']]) {
  const pool = new Pool({ connectionString: url })
  const c = await pool.connect()
  try {
    const raw = await expectDenied(() => c.query('select count(*) from fat.operational_claims'))
    check(`${name}: no table access without SET ROLE`, raw.denied && raw.code === '42501', raw)
    await c.query('begin')
    const cross = await expectDenied(() => c.query(`set local role ${other}`))
    check(`${name}: cannot SET ROLE ${other}`, cross.denied, cross)
    await c.query('rollback').catch(() => {})
    const attrs = (await c.query('select rolbypassrls, rolsuper from pg_roles where rolname = current_user')).rows[0]
    check(`${name}: NOBYPASSRLS, not superuser`, attrs.rolbypassrls === false && attrs.rolsuper === false, attrs)
  } finally { c.release(); await pool.end() }
}

const failed = checks.filter((c) => !c.ok)
process.stdout.write(JSON.stringify({ schema: 'fat.work256.neon-dev-rls-proof/v1', at: new Date().toISOString(), identityA: idA, identityB: idB, passed: checks.length - failed.length, failed: failed.length, checks }, null, 2) + '\n')
process.exit(failed.length ? 1 : 0)
