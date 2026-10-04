-- ─── ROLLBACK: Harden fat privileges (WORK-166) ──────────────────────────────
-- Reverses supabase/migrations/20261004120000_fat_harden_privileges.sql.
--
-- DATA: this rollback destroys NO data. It only re-grants privileges and,
-- where this migration created them, drops the event trigger and its handler.
--
-- SECURITY WARNING: running this re-opens the fail-open posture the
-- migration closed (anon table privileges on every fat table, PUBLIC/anon
-- execute on three functions, and — in a DB where WORK-166 created them —
-- broad default ACLs and no no-PUBLIC-execute trigger). Run it only to
-- recover a broken authenticated app flow, and only with the same approval
-- the forward migration needed in that project.
--
-- It is self-detecting, so the same file is correct in DEV and PROD:
--   * Part A restores the grants every project held before the migration.
--   * Part B runs only where the event trigger is commented `WORK-166:`, i.e.
--     where this migration created it (PROD). In DEV the trigger, handler and
--     default ACL state predate WORK-166 (APP-93/APP-103) and are left alone.
-- ─────────────────────────────────────────────────────────────────────────────

-- Part A (every project): pre-migration table/sequence/function grants.
grant all privileges on all tables in schema fat to anon;
grant all privileges on all sequences in schema fat to anon;
grant execute on function fat.payslip_line_content_fp(text, text, numeric, date) to public, anon;
grant execute on function fat.payslip_line_fp_trigger() to public, anon;
grant execute on function fat.set_updated_at() to public, anon;

-- Part B (only where WORK-166 created the trigger): remove it and its handler,
-- and restore the pre-migration postgres default ACLs in fat.
do $do$
begin
  if exists (
    select 1 from pg_event_trigger
    where evtname = 'fat_enforce_no_public_execute'
      and obj_description(oid, 'pg_event_trigger') like 'WORK-166:%'
  ) then
    execute 'drop event trigger fat_enforce_no_public_execute';
    execute 'drop function fat._enforce_no_public_execute()';
    execute 'alter default privileges for role postgres in schema fat grant all privileges on tables to anon, authenticated, service_role';
    execute 'alter default privileges for role postgres in schema fat grant all privileges on sequences to anon, authenticated, service_role';
    execute 'alter default privileges for role postgres in schema fat grant all privileges on functions to anon, authenticated, service_role';
    raise notice 'WORK-166 rollback: removed WORK-166 event trigger + handler and restored default ACLs';
  else
    raise notice 'WORK-166 rollback: event trigger not created by WORK-166; trigger, handler and default ACLs left unchanged';
  end if;
end
$do$;
