// WORK-256 — Neon Auth session → FAT app identity provisioning policy (pure).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideProvisioning, sessionSubject, IdentityError, normaliseEmail } from '../lib/server/identityPolicy.js'

test('session subject requires an id and an e-mail; e-mail is normalised', () => {
  assert.deepEqual(sessionSubject({ id: ' u1 ', email: ' A@Example.Invalid ', emailVerified: true }), { subject: 'u1', email: 'a@example.invalid', emailVerified: true })
  assert.throws(() => sessionSubject({ email: 'a@example.invalid' }), (e) => e instanceof IdentityError && e.code === 'NO_SUBJECT')
  assert.throws(() => sessionSubject({ id: 'u1' }), (e) => e.code === 'NO_EMAIL')
  assert.equal(normaliseEmail(null), '')
})

test('DEV Neon path provisions synthetic (reserved-domain) identities only', () => {
  const s = (email, v = false) => ({ subject: 's', email, emailVerified: v })
  assert.equal(decideProvisioning(s('x@example.invalid'), null).action, 'create')
  assert.equal(decideProvisioning(s('x@foo.test'), null).action, 'create')
  assert.equal(decideProvisioning(s('x@example.com'), null).action, 'create')
  assert.throws(() => decideProvisioning(s('person@gmail.com'), null), (e) => e.code === 'NOT_SYNTHETIC' && e.status === 403)
  assert.throws(() => decideProvisioning(s('x@frv.vic.gov.au', true), null), (e) => e.code === 'NOT_SYNTHETIC')
})

test('an unverified sign-up never takes over an existing identity', () => {
  const existing = { id: 'legacy-1', status: 'active' }
  assert.throws(() => decideProvisioning({ subject: 's', email: 'm@example.invalid', emailVerified: false }, existing), (e) => e.code === 'EMAIL_UNVERIFIED')
  assert.deepEqual(decideProvisioning({ subject: 's', email: 'm@example.invalid', emailVerified: true }, existing), { action: 'link-existing', identityId: 'legacy-1', linkedBy: 'verified_email' })
})

test('a disabled identity is never linked', () => {
  assert.throws(() => decideProvisioning({ subject: 's', email: 'm@example.invalid', emailVerified: true }, { id: 'x', status: 'disabled' }), (e) => e.code === 'IDENTITY_DISABLED')
})

test('a fresh native identity records how it was linked', () => {
  assert.equal(decideProvisioning({ subject: 's', email: 'n@example.invalid', emailVerified: false }, null).linkedBy, 'synthetic')
  assert.equal(decideProvisioning({ subject: 's', email: 'n@example.invalid', emailVerified: true }, null).linkedBy, 'verified_email')
})
