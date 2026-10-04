-- ─── Bind claim-sequence advancement to the caller (WORK-167, gap G05) ───────
-- Owner: fat. Rollback: supabase/rollbacks/20261004233500_fat_claim_sequence_caller_check.rollback.sql
--
-- Root cause (WORK-167 design record, evidence 2026-10-04, DEV + PROD):
--   fat.increment_claim_sequence(p_user_id, p_financial_year_id, p_claim_type)
--   is SECURITY DEFINER (owner postgres) and executable by `authenticated`.
--   It upserts fat.claim_sequences for the caller-SUPPLIED p_user_id with no
--   check that it is the caller. fat.claim_sequences already has RLS policy
--   users_manage_own (auth.uid() = user_id), but SECURITY DEFINER runs as the
--   owner and bypasses it. Proven on DEV (rolled back): user B advanced user
--   A's `retain` counter 12 → 13 via the RPC, while B's direct UPDATE of A's
--   row under RLS changed 0 rows. `fat` is PostgREST-exposed, so the same
--   call works at /rest/v1/rpc/increment_claim_sequence in PROD.
--
-- Fix (smallest root-cause change; same signature, so no app change):
--   1. SECURITY INVOKER — the table's existing RLS applies again; the function
--      no longer crosses a privilege boundary.
--   2. Explicit guard: reject when auth.uid() is null or differs from
--      p_user_id (ERRCODE 42501) — a clear early error, defence in depth.
--   3. search_path = '' with fully-qualified names.
--   Grants are unchanged (authenticated, service_role); PUBLIC/anon revoked.
--   Step 4 asserts the end state and aborts the whole migration otherwise.
--
-- The only caller (lib/claims/ClaimsContext.js getNextClaimNumber) always
-- passes the signed-in user's own id, so legitimate behaviour is unchanged.
-- No service_role caller exists; such a call would now be rejected.
--
-- Neon note: this is a Supabase interim control (auth.uid(), RLS-as-auth,
-- PostgREST RPC). The invariant — a claim number only ever advances for the
-- authenticated caller — must be carried into FAT's Neon migration (GOV-481)
-- with identity taken from the server-side session, not ported literally.
--
-- Scope boundary: only this function. NOT touched: public.fat_set_updated_at
-- (retires with WORK-168), public.rls_auto_enable (shared/platform owner),
-- fat.claim_sequences grants/policies, any other fat object.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1–3. Redefine as SECURITY INVOKER with an explicit caller check.
create or replace function fat.increment_claim_sequence(
  p_user_id          uuid,
  p_financial_year_id uuid,
  p_claim_type       text
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_seq integer;
begin
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'increment_claim_sequence: caller may only advance their own claim sequence'
      using errcode = '42501';
  end if;

  insert into fat.claim_sequences (user_id, financial_year_id, claim_type, next_seq)
  values (p_user_id, p_financial_year_id, p_claim_type, 2)
  on conflict (user_id, financial_year_id, claim_type)
  do update set next_seq = fat.claim_sequences.next_seq + 1
  returning next_seq - 1 into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;
  return v_seq;
end;
$function$;

comment on function fat.increment_claim_sequence(uuid, uuid, text) is
  'WORK-167: atomically returns the next claim number for the CALLER only (SECURITY INVOKER + auth.uid() check, RLS users_manage_own applies). See supabase/migrations/20261004233500_fat_claim_sequence_caller_check.sql.';

-- Grants: unchanged in effect; restated so a fresh apply is self-contained.
revoke all on function fat.increment_claim_sequence(uuid, uuid, text) from public, anon;
grant execute on function fat.increment_claim_sequence(uuid, uuid, text) to authenticated, service_role;

-- 4. Postconditions. Any failure raises and rolls the whole migration back.
do $assert$
declare
  f oid := 'fat.increment_claim_sequence(uuid,uuid,text)'::regprocedure;
begin
  if (select prosecdef from pg_proc where oid = f) then
    raise exception 'WORK-167 postcondition failed: increment_claim_sequence is still SECURITY DEFINER';
  end if;
  if has_function_privilege('anon', f, 'EXECUTE')
     or exists (select 1 from aclexplode((select coalesce(proacl, acldefault('f', proowner)) from pg_proc where oid = f)) a
                where a.grantee = 0 and a.privilege_type = 'EXECUTE') then
    raise exception 'WORK-167 postcondition failed: increment_claim_sequence is PUBLIC/anon-executable';
  end if;
  if not has_function_privilege('authenticated', f, 'EXECUTE') then
    raise exception 'WORK-167 postcondition failed: authenticated lost EXECUTE (claim creation would break)';
  end if;
  if (select prosrc not like '%p_user_id is distinct from auth.uid()%' from pg_proc where oid = f) then
    raise exception 'WORK-167 postcondition failed: caller guard missing';
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'fat' and tablename = 'claim_sequences'
      and qual = '(auth.uid() = user_id)' and with_check = '(auth.uid() = user_id)'
  ) or not (select relrowsecurity from pg_class where oid = 'fat.claim_sequences'::regclass) then
    raise exception 'WORK-167 postcondition failed: fat.claim_sequences RLS/users_manage_own not as expected';
  end if;
end
$assert$;
