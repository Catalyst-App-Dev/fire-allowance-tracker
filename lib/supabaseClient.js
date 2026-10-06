import { createClient } from '@supabase/supabase-js'
import { isNeonBackend } from './backend.js'

// ─── Neon backend guard (WORK-256) ───────────────────────────────────────────
// On FAT_BACKEND=neon no Supabase client is constructed: the exports become
// guards that throw on first use, so any remaining Supabase DB / Auth / Storage
// call on the Neon runtime fails loudly instead of silently reaching Supabase.
function neonGuard(name) {
  const fail = () => {
    throw new Error(`[supabase] ${name} is not available on the Neon backend (FAT_BACKEND=neon). Use the FAT server data layer.`)
  }
  return new Proxy({}, { get: (_t, prop) => (prop === 'then' ? undefined : fail()) })
}

function createSupabase() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('[supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars.')
  }

  // Default `supabase` client is used ONLY for auth (`supabase.auth.*` →
  // `auth.users`, the single acceptable shared Supabase resource).
  // All FAT-owned tables/RPCs (including the FAT-authoritative `profiles` table)
  // live in the `fat` schema and are accessed via the `fat` helper below —
  // see docs/FAT_SCHEMA_ARCHITECTURE.md.
  //
  // Requires `fat` to be in Supabase project's "Exposed schemas"
  // (Dashboard → Project Settings → API → Exposed schemas).
  return createClient(supabaseUrl, supabaseAnonKey, {
    db: { schema: 'public' },
  })
}

export const supabase = isNeonBackend() ? neonGuard('supabase') : createSupabase()

// Schema-scoped client for FAT-owned tables. Use this for every FAT query:
//   fat.from('claim_groups').select(...)
//   fat.rpc('increment_claim_sequence', { ... })
export const fat = isNeonBackend() ? neonGuard('fat') : supabase.schema('fat')
