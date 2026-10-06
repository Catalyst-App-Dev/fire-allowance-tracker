-- Rollback of 20261006060200_fat_neon_canonical_claims.sql (WORK-254).
-- DESTROYS DATA: drops canonical claims, details, entitlements, override audit
-- and C1 provenance tables with every row in them. Requires 4/6 rolled back first.
drop table if exists fat.migration_source_rows;
drop table if exists fat.entitlement_overrides;
drop table if exists fat.claim_entitlements;
drop function if exists fat.claim_entitlements_override_audit();
drop table if exists fat.delayed_meal_details;
drop table if exists fat.spoilt_meal_details;
drop table if exists fat.muster_dismiss_details;
drop table if exists fat.standby_details;
drop table if exists fat.retain_details;
drop table if exists fat.recall_details;
drop table if exists fat.operational_claims;
drop function if exists fat.guard_migration_provenance();
drop table if exists fat.migration_batches;
delete from fat_migrations.schema_migrations where version = '20261006060200';
