-- Rollback of 20261006060500_fat_neon_rate_rule_seed.sql (WORK-254).
-- DESTRUCTIVE TO REFERENCE DATA: removes every fat.rates / fat.rate_versions row.
-- Refuses if any entitlement references a rate or rate version (snapshots are
-- static accounting records and must never lose their referent).
do $guard$
begin
  if exists (select 1 from fat.claim_entitlements where rate_id is not null or rate_version_id is not null) then
    raise exception 'rollback refused: entitlements reference fat.rates / fat.rate_versions';
  end if;
end;
$guard$;
alter table fat.rate_versions disable trigger rate_versions_append_only;
update fat.rates set active_version_id = null;
delete from fat.rate_versions;
delete from fat.rates;
alter table fat.rate_versions enable trigger rate_versions_append_only;
delete from fat_migrations.schema_migrations where version = '20261006060500';
