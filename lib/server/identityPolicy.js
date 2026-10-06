// ─── Neon Auth session → FAT app identity: provisioning policy (WORK-256) ────
// Pure decision logic, unit-tested in __tests__/neon-identity-policy.test.mjs.
// lib/server/identity.js executes the decision inside a fat_service transaction.
//
// The FAT app identity (fat.app_identities.id) is the owner UUID of every FAT
// row (WORK-254 identity seam). A Neon Auth user is linked to it through
// fat.identity_links (provider 'neon_auth', provider_subject = Neon Auth user id).
//
//   1. A linked, active subject resolves to its identity (fat.resolve_app_identity).
//   2. An unlinked subject on the DEV Neon path is provisioned only for a reserved
//      synthetic e-mail domain (no real users on Neon DEV; GOV-481 / WORK-256).
//   3. If an identity already holds that e-mail (e.g. a preserved legacy_supabase
//      identity), the subject is linked to it ONLY when Neon Auth reports the
//      e-mail verified (linked_by 'verified_email'). Otherwise the request is
//      refused: an unverified sign-up must never take over an existing identity.
//   4. Otherwise a fresh native identity is created (fat.ensure_app_identity) and
//      linked (linked_by 'synthetic' on DEV). E-mail verification is not required
//      for a fresh identity: the link keys on the auth subject, not the address.
//   5. A disabled identity never resolves and is never re-linked.

import { RESERVED_TEST_EMAIL } from '../fat/migration/c2/constants.js'

export const AUTH_PROVIDER = 'neon_auth'

export class IdentityError extends Error {
  constructor(message, code, status = 403) { super(message); this.code = code; this.status = status }
}

export function normaliseEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : ''
}

/** Validate the verified session user shape the server relies on. */
export function sessionSubject(user) {
  const subject = typeof user?.id === 'string' ? user.id.trim() : ''
  const email = normaliseEmail(user?.email)
  if (!subject) throw new IdentityError('session has no subject', 'NO_SUBJECT', 401)
  if (!email || !email.includes('@')) throw new IdentityError('session has no e-mail', 'NO_EMAIL', 401)
  return { subject, email, emailVerified: user?.emailVerified === true }
}

/**
 * Decide what to do for an unlinked subject.
 * @param {{subject:string,email:string,emailVerified:boolean}} s
 * @param {{id:string,status:string}|null} existing — identity already holding s.email
 * @param {{syntheticOnly:boolean}} opts
 * @returns {{action:'link-existing', identityId:string, linkedBy:'verified_email'} | {action:'create', linkedBy:'synthetic'|'verified_email'}}
 */
export function decideProvisioning(s, existing, { syntheticOnly = true } = {}) {
  if (syntheticOnly && !RESERVED_TEST_EMAIL.test(s.email)) {
    throw new IdentityError('the Neon DEV backend accepts synthetic test identities only (reserved test e-mail domains)', 'NOT_SYNTHETIC', 403)
  }
  if (existing) {
    if (existing.status !== 'active') throw new IdentityError('this identity is disabled', 'IDENTITY_DISABLED', 403)
    if (!s.emailVerified) {
      throw new IdentityError('an identity already uses this e-mail; verify the e-mail address before it can be linked', 'EMAIL_UNVERIFIED', 403)
    }
    return { action: 'link-existing', identityId: existing.id, linkedBy: 'verified_email' }
  }
  return { action: 'create', linkedBy: s.emailVerified ? 'verified_email' : 'synthetic' }
}
