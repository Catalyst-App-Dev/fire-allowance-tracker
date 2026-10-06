-- Rollback of 20261006060100_fat_neon_reference_and_identity_data.sql (WORK-254).
-- DESTROYS DATA: drops member, financial-year, claim-numbering, station,
-- matrix and rate tables with every row in them. Requires 3/6 rolled back first.
drop table if exists fat.member_classifications;
alter table if exists fat.rates drop constraint if exists rates_active_version_id_fkey;
drop table if exists fat.rate_versions;
drop function if exists fat.rate_versions_append_only();
drop table if exists fat.rates;
drop function if exists fat.resolve_app_identity(text, text);
drop function if exists fat.ensure_app_identity(uuid, text, text);
drop function if exists fat.increment_claim_sequence(uuid, uuid, text);
drop table if exists fat.claim_sequences;
drop table if exists fat.financial_years;
drop table if exists fat.user_feature_flags;
drop table if exists fat.station_distances;
drop table if exists fat.home_address;
drop table if exists fat.profile_ext;
drop table if exists fat.profiles;
drop function if exists fat.travel_matrix_lookup(integer, integer);
drop table if exists fat.travel_matrix_cells;
drop table if exists fat.travel_matrix_versions;
drop table if exists fat.station_time_matrix;
drop table if exists fat.station_distance_matrix;
drop table if exists fat.station_aliases;
drop table if exists fat.stations;
delete from fat_migrations.schema_migrations where version = '20261006060100';
