// FAT domain operations (WORK-256, Neon backend only).
// POST /api/fat/<op> with a JSON body. <op> must be one of the registered domain
// operations (lib/server/ops/index.js); anything else is 404. Each operation
// runs in one transaction bound to the caller's verified identity (RLS).
import { memberRoute, readJson, RequestError } from '@/lib/server/route'
import { OPERATIONS } from '@/lib/server/ops'

export const dynamic = 'force-dynamic'

export const POST = memberRoute(async ({ req, params, db, appUserId, user }) => {
  const op = OPERATIONS[params?.op]
  if (!op) throw new RequestError('unknown operation', 'NOT_FOUND', 404)
  const input = await readJson(req)
  return op({ db, appUserId, user, input: input ?? {} })
})
