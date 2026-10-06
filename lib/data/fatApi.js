// ─── Browser → FAT server domain operations (WORK-256, Neon backend) ────────
// The browser holds no database credential. On FAT_BACKEND=neon every data
// operation is a named domain operation executed server-side by
// app/api/fat/[op]/route.js under the caller's verified Neon Auth session
// (HTTP-only cookie, same origin). The server derives the acting identity from
// the session; nothing here can choose whose rows are read or written.

export class FatApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status }
}

export const AUTH_EXPIRED_EVENT = 'fat:auth-expired'

/**
 * @param {string} op     e.g. 'fy.load', 'claims.create'
 * @param {object} [input]
 * @returns {Promise<any>}
 */
export async function callFat(op, input = {}) {
  let res
  try {
    res = await fetch(`/api/fat/${encodeURIComponent(op)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(input ?? {}),
    })
  } catch (e) {
    throw new FatApiError('Network error — check your connection.', 'NETWORK', 0)
  }
  let body = null
  try { body = await res.json() } catch { /* empty / non-JSON */ }
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
    }
    throw new FatApiError(body?.message || `Request failed (${res.status})`, body?.error || 'HTTP_' + res.status, res.status)
  }
  return body
}
