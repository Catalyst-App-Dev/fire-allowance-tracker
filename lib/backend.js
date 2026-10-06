// ─── FAT backend routing contract (WORK-256) ─────────────────────────────────
// One server env var, FAT_BACKEND, selects the data/auth backend for a
// deployment. next.config.mjs inlines it at build time as the NON-SECRET literal
// NEXT_PUBLIC_FAT_BACKEND so client and server agree:
//
//   neon      → Neon server data layer (lib/server/*, app/api/fat/*) + Neon
//               Managed Better Auth. The browser never holds a DB credential and
//               no Supabase client is constructed (lib/supabaseClient.js guards).
//               Payments / payslip storage are forced dark (WORK-257).
//   supabase  → the existing client-side Supabase path (default; Production).
//
// Anything other than the exact literal 'neon' (including unset) means
// 'supabase', so no existing environment changes behaviour by omission.
// Rollback for DEV/Preview: set FAT_BACKEND=supabase (or unset) and redeploy.

export const FAT_BACKEND = process.env.NEXT_PUBLIC_FAT_BACKEND === 'neon' ? 'neon' : 'supabase'

export function isNeonBackend() {
  return FAT_BACKEND === 'neon'
}
