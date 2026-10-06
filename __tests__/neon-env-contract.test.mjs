// WORK-256 — environment-variable contract for the Neon runtime (static).
// FAT convention: every application-specific variable carries the FAT_ prefix;
// the environment (Preview / Production) is the Vercel scope, never part of the key.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SERVER_SECRETS = ['FAT_DATABASE_URL', 'FAT_DATABASE_SERVICE_URL', 'FAT_NEON_AUTH_BASE_URL', 'FAT_NEON_AUTH_COOKIE_SECRET']

function files(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((n) => {
    const p = join(dir, n)
    return statSync(join(ROOT, p)).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : []
  })
}

function envReads(src) {
  return [...src.matchAll(/process\.env\.([A-Z0-9_]+)|\benv\('([A-Z0-9_]+)'\)/g)].map((m) => m[1] || m[2])
}

test('the server data layer reads exactly the four FAT_-prefixed secrets', () => {
  const reads = new Set(files('lib/server').flatMap((f) => envReads(readFileSync(join(ROOT, f), 'utf8'))))
  assert.deepEqual([...reads].sort(), [...SERVER_SECRETS].sort())
})

test('no unprefixed legacy names remain in the Neon runtime or its operator docs', () => {
  const legacy = /(?<![A-Z_])(DATABASE_URL|DATABASE_SERVICE_URL|NEON_AUTH_BASE_URL|NEON_AUTH_COOKIE_SECRET)\b/
  for (const f of [...files('lib/server'), 'app/api/auth/[...path]/route.js', 'next.config.mjs', '.env.example', 'docs/architecture/NEON_APP_RUNTIME.md']) {
    assert.doesNotMatch(readFileSync(join(ROOT, f), 'utf8'), legacy, f)
  }
})

test('only FAT_BACKEND is exposed to the browser, as a non-secret literal', () => {
  const cfg = readFileSync(join(ROOT, 'next.config.mjs'), 'utf8')
  assert.deepEqual(envReads(cfg), ['FAT_BACKEND'])
  for (const name of SERVER_SECRETS) {
    assert.doesNotMatch(cfg, new RegExp(name), `${name} must never be inlined into the client bundle`)
  }
})
