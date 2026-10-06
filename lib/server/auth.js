// ─── Neon Managed Better Auth — server instance (WORK-256) ──────────────────
// Server-only. FAT verifies every Neon-path request server-side with
// auth.getSession() (signed, HTTP-only session cookies proxied through
// /api/auth/[...path]). There is NO Next.js middleware: route handlers check the
// session themselves (CLAUDE.md §7 "no middleware" is preserved).
//
// SDK note: @neondatabase/auth declares an optional peer `next >=16`; FAT runs
// Next 15.5. The Next adapter only uses next/headers cookies()/headers() and
// NextResponse, which are present (and async) in Next 15, so package.json pins
// the SDK's `next` to the app's own version via `overrides`. Proven by the
// WORK-256 local auth E2E (sign-up, sign-in, reload, sign-out, invalid session).

import 'server-only'
import { createNeonAuth } from '@neondatabase/auth/next/server'

let instance = null

export function neonAuth() {
  if (!instance) {
    const baseUrl = process.env.NEON_AUTH_BASE_URL
    const secret = process.env.NEON_AUTH_COOKIE_SECRET
    if (!baseUrl || !secret) throw new Error('server configuration missing: NEON_AUTH_BASE_URL / NEON_AUTH_COOKIE_SECRET')
    instance = createNeonAuth({ baseUrl, cookies: { secret }, logLevel: 'warn' })
  }
  return instance
}

/** The verified session user, or null (no / invalid / expired session). */
export async function getSessionUser() {
  const { data, error } = await neonAuth().getSession()
  if (error || !data?.user) return null
  return data.user
}
