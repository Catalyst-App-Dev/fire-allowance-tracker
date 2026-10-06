// ─── FAT domain route wrapper (WORK-256) ─────────────────────────────────────
// Every app/api/fat/* handler is built with memberRoute():
//   1. Neon backend only — on the Supabase backend these routes do not exist (404).
//   2. Verify the Neon Auth session server-side (401 when absent/invalid/expired).
//   3. Resolve the FAT app identity behind it (lib/server/identity.js).
//   4. Run the handler in ONE transaction bound to SET LOCAL ROLE fat_app +
//      fat.app_user_id = that identity (lib/server/db.js) — RLS scopes every row.
// The handler never receives, and must never use, a user id from the request.

import 'server-only'
import { NextResponse } from 'next/server'
import { isNeonBackend } from '../backend.js'
import { getSessionUser } from './auth.js'
import { resolveAppIdentity } from './identity.js'
import { withMemberTx } from './db.js'

export class RequestError extends Error {
  constructor(message, code = 'BAD_REQUEST', status = 400) { super(message); this.code = code; this.status = status }
}

export function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function errorResponse(e) {
  const status = Number.isInteger(e?.status) ? e.status : 500
  const code = e?.code && typeof e.code === 'string' ? e.code : 'SERVER_ERROR'
  if (status >= 500) console.error('[fat-api]', code, e?.message)
  // Postgres permission / RLS violations surface as 403, never as data.
  if (code === '42501') return json({ error: 'FORBIDDEN', message: 'not permitted' }, 403)
  return json({ error: code, message: status >= 500 ? 'server error' : e.message }, status)
}

export async function readJson(req) {
  try { return await req.json() } catch { throw new RequestError('invalid JSON body') }
}

/**
 * @param {(ctx:{req:Request, params:object, db:{query:Function, fat:object}, appUserId:string, user:object}) => Promise<any>} handler
 */
export function memberRoute(handler) {
  return async (req, routeCtx) => {
    if (!isNeonBackend()) return json({ error: 'NOT_FOUND' }, 404)
    try {
      const user = await getSessionUser()
      if (!user) return json({ error: 'UNAUTHENTICATED', message: 'sign in required' }, 401)
      const appUserId = await resolveAppIdentity(user)
      const params = routeCtx?.params ? await routeCtx.params : {}
      const result = await withMemberTx(appUserId, (db) => handler({ req, params, db, appUserId, user }))
      if (result instanceof Response) return result
      return json(result ?? { ok: true })
    } catch (e) {
      return errorResponse(e)
    }
  }
}
