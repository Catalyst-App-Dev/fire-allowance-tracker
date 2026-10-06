// ─── Neon Auth session → FAT app identity (WORK-256) ─────────────────────────
// Server-only. Resolves (and on first sign-in provisions) the FAT app identity
// behind a verified Neon Auth session, inside a fat_service transaction — the
// ONLY use of the provisioning credential. Policy: lib/server/identityPolicy.js.

import 'server-only'
import { withServiceTx } from './db.js'
import { AUTH_PROVIDER, IdentityError, decideProvisioning, sessionSubject } from './identityPolicy.js'

// Short in-process cache so each request does not open a provisioning
// connection. 60 s bound: a disabled identity stops resolving within a minute.
const CACHE_TTL_MS = 60_000
const cache = new Map()

async function resolveLinked(query, subject) {
  const rows = await query('select fat.resolve_app_identity($1, $2) as id', [AUTH_PROVIDER, subject])
  return rows[0]?.id ?? null
}

/**
 * @param {{id:string,email:string,emailVerified?:boolean}} user — Neon Auth session user
 * @returns {Promise<string>} fat.app_identities.id
 */
export async function resolveAppIdentity(user) {
  const s = sessionSubject(user)
  const hit = cache.get(s.subject)
  if (hit && hit.expires > Date.now()) return hit.id

  const id = await withServiceTx(async ({ query }) => {
    const linked = await resolveLinked(query, s.subject)
    if (linked) return linked

    // First sign-in: the browser fires several requests at once, each of which
    // may arrive here. Serialise provisioning per e-mail address (which covers
    // every subject claiming it) for the rest of this transaction, then
    // re-check: the first request
    // provisions, every concurrent one resolves the link it created.
    await query("select pg_advisory_xact_lock(hashtextextended('fat.identity:' || $1, 0))", [s.email])
    const raced = await resolveLinked(query, s.subject)
    if (raced) return raced

    // A link may exist to a disabled identity: never re-link, never resolve.
    const dead = await query(
      `select i.status from fat.identity_links l join fat.app_identities i on i.id = l.app_identity_id
        where l.provider = $1 and l.provider_subject = $2`, [AUTH_PROVIDER, s.subject])
    if (dead.length) throw new IdentityError('this identity is disabled', 'IDENTITY_DISABLED', 403)

    const existingRows = await query('select id, status from fat.app_identities where lower(email) = $1', [s.email])
    const decision = decideProvisioning(s, existingRows[0] ?? null, { syntheticOnly: true })

    let identityId = decision.identityId
    if (decision.action === 'create') {
      identityId = (await query("select fat.ensure_app_identity(null, $1, 'native') as id", [s.email]))[0].id
    }
    await query(
      `insert into fat.identity_links (app_identity_id, provider, provider_subject, verified_email, linked_by)
       values ($1, $2, $3, $4, $5)
       on conflict (provider, provider_subject) do nothing`,
      [identityId, AUTH_PROVIDER, s.subject, s.emailVerified ? s.email : null, decision.linkedBy])
    // Re-resolve: a concurrent first request may have won the link.
    const resolved = await resolveLinked(query, s.subject)
    if (!resolved) throw new IdentityError('identity link could not be established', 'LINK_FAILED', 500)
    return resolved
  })

  cache.set(s.subject, { id, expires: Date.now() + CACHE_TTL_MS })
  return id
}
