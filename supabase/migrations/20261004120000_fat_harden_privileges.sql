-- ─── Harden fat privileges in both DBs (WORK-166, gaps G03 + G04) ────────────
-- Owner: fat. Rollback: supabase/rollbacks/20261004120000_fat_harden_privileges.rollback.sql
--
-- Root cause (WORK-166 design record, read-only evidence 2026-10-04):
--   * Canonical 21 (APP-93) and 22 (APP-103) were deliberately DEV-only and
--     were never applied to PROD (wgcqzamuspuqpedqasbc). PROD still carries
--     postgres default ACLs in `fat` granting anon/authenticated/service_role
--     ALL on future tables, sequences and functions, and has no
--     `fat_enforce_no_public_execute` event trigger.
--   * Canonical 21 only changed *future* objects, so every existing `fat`
--     table still grants anon every table privilege in BOTH DBs (34 in DEV,
--     36 in PROD). RLS is on everywhere and no policy admits a NULL
--     auth.uid(), so this is fail-open configuration rather than a live leak.
--   * fat.payslip_line_content_fp, fat.payslip_line_fp_trigger and
--     fat.set_updated_at predate canonical 22's trigger and are still
--     PUBLIC- and anon-executable in BOTH DBs.
--
-- Need analysis: the app never queries `fat` as anon — no pre-auth page
-- touches `fat` and both server routes require and forward the user's JWT —
-- so anon needs no privilege on any `fat` table, sequence or function.
-- `authenticated` and `service_role` grants are deliberately unchanged
-- (payslip_line_fp_trigger is SECURITY INVOKER and calls
-- payslip_line_content_fp as the caller, so authenticated keeps EXECUTE).
--
-- This one file is applied to DEV first and then, only with explicit operator
-- approval for this migration, to PROD. It is idempotent: in DEV, steps 1–2
-- are no-ops because canonical 21/22 are already applied there; in PROD they
-- bring `fat` to the DEV posture. Step 5 asserts the end state and aborts the
-- whole migration (nothing is left half-applied) if any control is missing.
--
-- Scope boundary (do not widen): only `fat` objects and the `fat_`-prefixed
-- database-level event trigger. NOT touched: public.* (incl.
-- public.rls_auto_enable / ensure_rls and public.fat_set_updated_at → WORK-167),
-- fire_allowance_tracker.* (WORK-144/145), fat.increment_claim_sequence
-- (WORK-167), anon USAGE on schema fat, authenticated table privileges, cab.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Canonical 21 posture: future fat objects start with no Data API access.
alter default privileges for role postgres in schema fat
  revoke all privileges on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema fat
  revoke all privileges on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema fat
  revoke all privileges on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema fat
  revoke execute on functions from public;

-- 2. Canonical 22 posture: strip PUBLIC execute from every new fat function.
--    Created only when absent, so DEV's APP-103 objects are left exactly as
--    they are. Objects this migration creates are commented `WORK-166:` so the
--    rollback removes only what this migration added.
do $do$
begin
  if to_regprocedure('fat._enforce_no_public_execute()') is null then
    execute $fn$
      create function fat._enforce_no_public_execute()
        returns event_trigger
        language plpgsql
        security definer
        set search_path = ''
      as $body$
      declare
        rec record;
      begin
        for rec in
          select object_identity
          from pg_event_trigger_ddl_commands()
          where object_type = 'function'
            and schema_name = 'fat'
        loop
          execute format('revoke execute on function %s from public', rec.object_identity);
        end loop;
      end;
      $body$
    $fn$;
    execute $c$
      comment on function fat._enforce_no_public_execute() is
        'WORK-166: event-trigger handler that strips PUBLIC execute from every newly created or replaced fat.* function (canonical 22 / APP-103 logic). See supabase/migrations/20261004120000_fat_harden_privileges.sql.'
    $c$;
  end if;

  if not exists (select 1 from pg_event_trigger where evtname = 'fat_enforce_no_public_execute') then
    execute $et$
      create event trigger fat_enforce_no_public_execute
        on ddl_command_end
        when tag in ('CREATE FUNCTION')
        execute function fat._enforce_no_public_execute()
    $et$;
    execute $c$
      comment on event trigger fat_enforce_no_public_execute is
        'WORK-166: fires on every CREATE FUNCTION in the database, no-ops for every schema except fat. See supabase/migrations/20261004120000_fat_harden_privileges.sql.'
    $c$;
  end if;
end
$do$;

-- 3. No anon privilege on any existing fat table or sequence.
revoke all privileges on all tables in schema fat from anon;
revoke all privileges on all sequences in schema fat from anon;

-- 4. Existing PUBLIC/anon-executable fat functions (named, not blanket, so
--    WORK-167's increment_claim_sequence is not touched here). The handler is
--    included because, when created in step 2, it predates its own trigger.
revoke execute on function fat.payslip_line_content_fp(text, text, numeric, date) from public, anon;
revoke execute on function fat.payslip_line_fp_trigger() from public, anon;
revoke execute on function fat.set_updated_at() from public, anon;
revoke execute on function fat._enforce_no_public_execute() from public, anon;

-- 5. Postconditions. Any failure raises and rolls the whole migration back.
--    Privilege functions are wrapped in CASE so they are only evaluated on the
--    relation kind they accept, whatever order the planner applies filters in.
do $assert$
declare
  bad text;
begin
  select string_agg(pg_get_userbyid(d.defaclrole) || ':' || d.defaclobjtype::text || ':' || d.defaclacl::text, '; ')
    into bad
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'fat'
    and exists (
      select 1 from aclexplode(d.defaclacl) a
      where a.grantee = 0
         or a.grantee = 'anon'::regrole::oid
    );
  if bad is not null then
    raise exception 'WORK-166 postcondition failed: fat default ACL still grants PUBLIC/anon: %', bad;
  end if;

  select string_agg(c.relname, ', ')
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'fat'
    and case when c.relkind in ('r', 'p', 'v', 'm', 'f')
             then has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
             else false end;
  if bad is not null then
    raise exception 'WORK-166 postcondition failed: anon still holds privileges on fat relations: %', bad;
  end if;

  select string_agg(c.relname, ', ')
    into bad
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'fat'
    and case when c.relkind = 'S'
             then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
             else false end;
  if bad is not null then
    raise exception 'WORK-166 postcondition failed: anon still holds privileges on fat sequences: %', bad;
  end if;

  select string_agg(p.oid::regprocedure::text, ', ')
    into bad
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'fat'
    and (
      has_function_privilege('anon', p.oid, 'EXECUTE')
      or exists (
        select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE'
      )
    );
  if bad is not null then
    raise exception 'WORK-166 postcondition failed: fat functions still PUBLIC/anon-executable: %', bad;
  end if;

  if not exists (
    select 1 from pg_event_trigger
    where evtname = 'fat_enforce_no_public_execute'
      and evtenabled <> 'D'
      and evtfoid = 'fat._enforce_no_public_execute()'::regprocedure
  ) then
    raise exception 'WORK-166 postcondition failed: event trigger fat_enforce_no_public_execute missing or disabled';
  end if;
end
$assert$;
