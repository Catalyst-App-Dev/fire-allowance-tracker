// ─── FAT server data layer — Neon connections and bound transactions ─────────
// WORK-256. Server-only. The browser never receives a PostgreSQL credential:
// FAT_DATABASE_URL / FAT_DATABASE_SERVICE_URL are server env vars read only here.
//
//   withMemberTx(appUserId, fn)  FAT_DATABASE_URL (login fat_app_server, NOINHERIT):
//                                BEGIN; SET LOCAL ROLE fat_app;
//                                set_config('fat.app_user_id', <id>, true); fn; COMMIT.
//                                RLS owner policies (fat.current_app_user_id()) apply.
//   withServiceTx(fn)            FAT_DATABASE_SERVICE_URL (login fat_identity_provisioner):
//                                SET LOCAL ROLE fat_service. Identity provisioning ONLY
//                                (lib/server/identity.js) — never member CRUD.
//
// `fn` receives { query(sql, params) → rows, fat } where `fat` is the
// PostgREST-shaped adapter (lib/server/fatClient.js) over the same transaction.
// The app identity is never taken from the browser: callers pass the id that
// lib/server/identity.js resolved from the verified Neon Auth session.

import 'server-only'
import { Pool, neonConfig, types } from '@neondatabase/serverless'
import { createFatClient } from './fatClient.js'

if (typeof WebSocket !== 'undefined') neonConfig.webSocketConstructor = WebSocket

// Match PostgREST JSON shapes the FAT client code already expects:
// numeric/int8 as numbers, date as 'YYYY-MM-DD', timestamps as ISO strings.
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)))   // numeric
types.setTypeParser(20, (v) => (v === null ? null : Number(v)))     // int8
types.setTypeParser(1082, (v) => v)                                  // date
types.setTypeParser(1114, (v) => (v === null ? null : new Date(`${v}Z`).toISOString()))  // timestamp
types.setTypeParser(1184, (v) => (v === null ? null : new Date(v).toISOString()))        // timestamptz

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class DataLayerError extends Error {
  constructor(message, code, status = 500) { super(message); this.code = code; this.status = status }
}

function env(name) {
  const v = process.env[name]
  if (!v) throw new DataLayerError(`server configuration missing: ${name}`, 'CONFIG', 500)
  return v
}

async function inTransaction(connectionString, setup, fn) {
  const pool = new Pool({ connectionString })
  const client = await pool.connect()
  const query = async (sql, params = []) => (await client.query(sql, params)).rows
  try {
    await client.query('begin')
    await setup(query)
    const result = await fn({ query, fat: createFatClient(query) })
    await client.query('commit')
    return result
  } catch (e) {
    try { await client.query('rollback') } catch { /* connection already failed */ }
    throw e
  } finally {
    client.release()
    await pool.end()
  }
}

/** Member transaction: RLS-scoped to exactly one resolved app identity. */
export function withMemberTx(appUserId, fn) {
  if (typeof appUserId !== 'string' || !UUID.test(appUserId)) {
    throw new DataLayerError('a resolved app identity is required', 'NO_IDENTITY', 401)
  }
  return inTransaction(env('FAT_DATABASE_URL'), async (q) => {
    await q('set local role fat_app')
    await q("select set_config('fat.app_user_id', $1, true)", [appUserId])
  }, fn)
}

/**
 * Transaction as fat_app with NO identity set — every owner policy denies.
 * Used only by tests/proofs of the "unset identity sees nothing" invariant.
 */
export function withUnboundMemberTx(fn) {
  return inTransaction(env('FAT_DATABASE_URL'), async (q) => { await q('set local role fat_app') }, fn)
}

/** Identity-provisioning transaction (fat_service). Only lib/server/identity.js calls this. */
export function withServiceTx(fn) {
  return inTransaction(env('FAT_DATABASE_SERVICE_URL'), async (q) => { await q('set local role fat_service') }, fn)
}
