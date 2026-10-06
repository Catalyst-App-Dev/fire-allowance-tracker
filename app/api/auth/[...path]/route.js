// Neon Managed Better Auth proxy (WORK-256). Forwards /api/auth/* to the Neon
// Auth server and manages the signed HTTP-only session cookies on this origin.
// Neon backend only: on the Supabase backend this route does not exist.
import { NextResponse } from 'next/server'
import { isNeonBackend } from '@/lib/backend'

export const dynamic = 'force-dynamic'

async function handle(req, ctx) {
  if (!isNeonBackend()) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  const { neonAuth } = await import('@/lib/server/auth')
  const handlers = neonAuth().handler()
  return handlers[req.method](req, ctx)
}

export const GET = handle
export const POST = handle
