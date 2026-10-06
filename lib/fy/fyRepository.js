// ─── Financial-year data access (shared by both backends, WORK-256) ─────────
// Extracted verbatim from FinancialYearContext so the same queries run either
// in the browser against the Supabase `fat` client (FAT_BACKEND=supabase) or
// server-side against the Neon adapter (lib/server/fatClient.js) inside the
// caller's RLS-bound transaction (FAT_BACKEND=neon). On the Neon path `uid` is
// always the session-derived identity, never a browser-supplied value.

import { getFYDateRange, currentFYLabel } from '../calculations/engine.js'

/**
 * Load every FY for the user (newest first), bootstrapping the current FY when
 * none exists and ensuring exactly one is active.
 * @returns {Promise<{ rows: object[], active: object }>}
 */
export async function loadFinancialYears(client, uid) {
  const { data: fyRows, error: fetchError } = await client
    .from('financial_years')
    .select('*')
    .eq('user_id', uid)
    .order('start_date', { ascending: false })
  if (fetchError) throw fetchError

  let rows = fyRows || []

  // Bootstrap: first-ever load seeds the current FY. Idempotent under races
  // (ignoreDuplicates on the (user_id, label) unique key).
  if (rows.length === 0) {
    const label = currentFYLabel()
    const { start, end } = getFYDateRange(label)
    const { error: bootstrapError } = await client
      .from('financial_years')
      .upsert(
        { user_id: uid, label, start_date: start, end_date: end, is_active: true },
        { onConflict: 'user_id,label', ignoreDuplicates: true },
      )
    if (bootstrapError) throw bootstrapError

    const { data: seeded, error: refetchError } = await client
      .from('financial_years')
      .select('*')
      .eq('user_id', uid)
      .order('start_date', { ascending: false })
    if (refetchError) throw refetchError
    rows = seeded || []
  }

  let active = rows.find((r) => r.is_active) || rows[0]
  if (!rows.some((r) => r.is_active)) {
    await client.from('financial_years').update({ is_active: true }).eq('id', active.id)
    active = { ...active, is_active: true }
    rows = rows.map((r) => (r.id === active.id ? active : r))
  }
  return { rows, active }
}

/** Make `fyId` the single active FY for the user. */
export async function switchActiveFinancialYear(client, uid, fyId) {
  const { error: offErr } = await client.from('financial_years').update({ is_active: false }).eq('user_id', uid)
  if (offErr) throw offErr
  const { error: onErr } = await client.from('financial_years').update({ is_active: true }).eq('id', fyId).eq('user_id', uid)
  if (onErr) throw onErr
}

/** Create a (non-active) FY row for `label` (e.g. '2027FY'). */
export async function createFinancialYear(client, uid, label) {
  const { start, end } = getFYDateRange(label)
  const { data, error } = await client
    .from('financial_years')
    .insert({ user_id: uid, label, start_date: start, end_date: end, is_active: false })
    .select()
    .single()
  if (error) throw error
  return data
}
