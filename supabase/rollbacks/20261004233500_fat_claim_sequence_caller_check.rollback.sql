-- ─── ROLLBACK: Bind claim-sequence advancement to the caller (WORK-167) ──────
-- Reverses supabase/migrations/20261004233500_fat_claim_sequence_caller_check.sql.
--
-- DATA: destroys NO data. It only redefines one function.
--
-- SECURITY WARNING: this restores the pre-WORK-167 definition, which is
-- SECURITY DEFINER with no caller check — any signed-in user can again advance
-- another user's claim sequence via /rest/v1/rpc/increment_claim_sequence. Run
-- it only to recover broken claim creation, with the same approval the forward
-- migration needed in that project.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function fat.increment_claim_sequence(
  p_user_id          uuid,
  p_financial_year_id uuid,
  p_claim_type       text
)
returns integer
language plpgsql
security definer
set search_path = fat, pg_temp
as $function$
declare
  v_seq integer;
begin
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

comment on function fat.increment_claim_sequence(uuid, uuid, text) is null;

revoke all on function fat.increment_claim_sequence(uuid, uuid, text) from public, anon;
grant execute on function fat.increment_claim_sequence(uuid, uuid, text) to authenticated, service_role;
