'use client'

// ─── Backend-agnostic client auth/session (WORK-256) ─────────────────────────
// Pages and contexts use these functions instead of calling supabase.auth.*
// directly, so the same UI runs on either backend (lib/backend.js):
//
//   supabase → Supabase Auth, unchanged (client-side session, as before).
//   neon     → Neon Managed Better Auth through the same-origin /api/auth proxy
//              (signed HTTP-only cookies). The FAT server verifies the session on
//              every request; `session.user.id` here is the FAT app identity the
//              server resolved (fat.app_identities.id), returned by `session.get`.
//
// Neon sessions are not Supabase sessions: switching FAT_BACKEND means members
// sign in again on the other backend.

import { supabase } from '@/lib/supabaseClient'
import { isNeonBackend } from '@/lib/backend'
import { callFat, FatApiError, AUTH_EXPIRED_EVENT } from '@/lib/data/fatApi'

const AUTH_CHANGED_EVENT = 'fat:auth-changed'

let neonClientPromise = null
function neonAuthClient() {
  if (!neonClientPromise) {
    neonClientPromise = import('@neondatabase/auth/next').then((m) => m.createAuthClient())
  }
  return neonClientPromise
}

function emitAuthChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(AUTH_CHANGED_EVENT))
}

function authError(error, fallback) {
  if (!error) return null
  const message = error.message || error.statusText || fallback
  return new Error(message)
}

/**
 * Current session, or null. Shape: { user: { id, email }, access_token? }.
 * On Neon, user.id is the FAT app identity resolved by the server.
 */
export async function getCurrentSession() {
  if (!isNeonBackend()) {
    const { data } = await supabase.auth.getSession()
    return data?.session ?? null
  }
  try {
    const s = await callFat('session.get')
    return s?.user ? s : null
  } catch (e) {
    if (e instanceof FatApiError && (e.status === 401 || e.status === 403)) return null
    throw e
  }
}

/** Subscribe to sign-in / sign-out / expiry. Returns an unsubscribe function. */
export function onAuthStateChange(callback) {
  if (!isNeonBackend()) {
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => callback(sess ?? null))
    return () => sub.subscription.unsubscribe()
  }
  const refresh = () => { getCurrentSession().then(callback).catch(() => callback(null)) }
  const expired = () => callback(null)
  window.addEventListener(AUTH_CHANGED_EVENT, refresh)
  window.addEventListener(AUTH_EXPIRED_EVENT, expired)
  return () => {
    window.removeEventListener(AUTH_CHANGED_EVENT, refresh)
    window.removeEventListener(AUTH_EXPIRED_EVENT, expired)
  }
}

export async function signInWithPassword(email, password) {
  if (!isNeonBackend()) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) throw error
    return
  }
  const client = await neonAuthClient()
  const { error } = await client.signIn.email({ email, password })
  if (error) throw authError(error, 'Sign-in failed.')
  emitAuthChanged()
}

/**
 * @returns {Promise<{ needsConfirmation: boolean }>}
 */
export async function signUpWithPassword(email, password) {
  if (!isNeonBackend()) {
    const { data, error } = await supabase.auth.signUp({ email, password, options: { redirectTo: window.location.origin } })
    if (error) throw error
    return { needsConfirmation: !data?.session }
  }
  const client = await neonAuthClient()
  const name = email.split('@')[0] || 'FAT member'
  const { data, error } = await client.signUp.email({ email, password, name })
  if (error) throw authError(error, 'Sign-up failed.')
  emitAuthChanged()
  return { needsConfirmation: !data?.token && !data?.session }
}

export async function signOut() {
  if (!isNeonBackend()) {
    await supabase.auth.signOut()
    return
  }
  const client = await neonAuthClient()
  await client.signOut()
  emitAuthChanged()
}

export async function requestPasswordReset(email, redirectTo) {
  if (!isNeonBackend()) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo })
    if (error) throw error
    return
  }
  // Neon Auth (shared e-mail provider). Synthetic DEV addresses are not
  // deliverable, so on Neon DEV this succeeds without an e-mail arriving.
  const client = await neonAuthClient()
  const { error } = await client.requestPasswordReset({ email, redirectTo })
  if (error) throw authError(error, 'Could not request a reset link.')
}

/**
 * Complete a password reset. Supabase uses the recovery session established
 * from the link; Neon Auth uses the `token` query parameter on the link.
 */
export async function completePasswordReset({ password, token }) {
  if (!isNeonBackend()) {
    const { error } = await supabase.auth.updateUser({ password })
    if (error) throw error
    return
  }
  if (!token) throw new Error('This reset link is invalid or has expired. Please request a new one.')
  const client = await neonAuthClient()
  const { error } = await client.resetPassword({ newPassword: password, token })
  if (error) throw authError(error, 'Failed to update password.')
}
