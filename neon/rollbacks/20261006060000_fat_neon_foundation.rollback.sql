-- Rollback of 20261006060000_fat_neon_foundation.sql (WORK-254).
-- DESTROYS DATA: drops schema fat (app identities, identity links) and the
-- fat_migrations ledger. Requires 2/6–6/6 rolled back first. The group roles
-- fat_app / fat_service are dropped only when nothing else depends on them.
drop schema if exists fat cascade;
drop schema if exists fat_migrations cascade;
alter default privileges grant execute on functions to public;
do $roles$
begin
  if exists (select 1 from pg_roles where rolname = 'fat_app') then drop role fat_app; end if;
  if exists (select 1 from pg_roles where rolname = 'fat_service') then drop role fat_service; end if;
end;
$roles$;
