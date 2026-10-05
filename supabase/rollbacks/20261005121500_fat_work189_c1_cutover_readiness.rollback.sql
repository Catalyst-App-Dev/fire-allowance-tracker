-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️  DATA-DESTROYING ROLLBACK — READ BEFORE RUNNING
--   * DROPS fat.migration_batches and fat.migration_source_rows (every batch
--     record, parity report and source-row ledger entry is lost).
--   * DROPS operational_claims.claim_number / financial_year_id /
--     migration_batch_id / prototype_row_id and claim_entitlements /
--     payment_records migration columns (their values are lost).
--   * REFUSES (raises) while any batch-tagged canonical row or any
--     'prototype_migration' payment record exists: remove a C2/C3 batch through
--     its own batch rollback first. Migrated history is never silently orphaned.
--   * Does NOT drop operational_claims.prototype_claim_group_id / prototype_source
--     or uq_operational_claims_prototype_group: they pre-date this migration
--     (abandoned dual-write branch, WORK-180/G18) and are only re-documented here.
-- ═══════════════════════════════════════════════════════════════════════════
-- Reverses supabase/migrations/20261005121500_fat_work189_c1_cutover_readiness.sql (WORK-189).

begin;

do $guard$
begin
  if exists (select 1 from fat.operational_claims where migration_batch_id is not null)
     or exists (select 1 from fat.claim_entitlements where migration_batch_id is not null)
     or exists (select 1 from fat.payment_records where migration_batch_id is not null or source = 'prototype_migration') then
    raise exception 'WORK-189 rollback refused: batch-tagged canonical rows exist; roll back the C2/C3 batch first';
  end if;
end;
$guard$;

drop trigger if exists guard_migration_provenance on fat.payment_records;
drop trigger if exists guard_migration_provenance on fat.claim_entitlements;
drop trigger if exists guard_migration_provenance on fat.operational_claims;
drop function if exists fat.guard_migration_provenance();

drop table if exists fat.migration_source_rows;

alter table fat.payment_records
  drop constraint if exists payment_records_migration_source,
  drop constraint if exists payment_records_migration_pair,
  drop constraint if exists payment_records_source_check,
  add constraint payment_records_source_check
    check (source = any (array['manual','payslip_screenshot','payslip_pdf','petty_cash_export'])),
  drop column if exists migration_source_key,
  drop column if exists migration_batch_id;

alter table fat.claim_entitlements
  drop constraint if exists claim_entitlements_claim_owner_fkey,
  drop column if exists prototype_component,
  drop column if exists prototype_row_id,
  drop column if exists prototype_source,
  drop column if exists migration_batch_id;

drop index if exists fat.uq_operational_claims_claim_number;
drop index if exists fat.uq_operational_claims_prototype_row;
drop index if exists fat.idx_operational_claims_financial_year;
drop index if exists fat.idx_operational_claims_migration_batch;
alter table fat.operational_claims
  drop constraint if exists operational_claims_financial_year_owner_fkey,
  drop constraint if exists operational_claims_id_owner_key,
  drop constraint if exists operational_claims_prototype_needs_batch,
  drop constraint if exists operational_claims_prototype_row_pair,
  drop constraint if exists operational_claims_prototype_source_check,
  drop constraint if exists operational_claims_claim_number_needs_fy,
  drop constraint if exists operational_claims_claim_number_positive,
  drop column if exists prototype_row_id,
  drop column if exists migration_batch_id,
  drop column if exists financial_year_id,
  drop column if exists claim_number;
comment on column fat.operational_claims.prototype_claim_group_id is
  'Dual-write provenance. The fat.claim_groups.id this canonical claim was generated alongside during the live Standby / M&D claim-create flow. Idempotency key for the dual-write — see lib/fat/persistence/standbyDualWrite.js. NULL for canonical rows created outside the prototype dual-write.';
comment on column fat.operational_claims.prototype_source is
  'Diagnostic tag of the prototype flow that produced this canonical row (standby | md). Informational only.';

alter table fat.financial_years
  drop constraint if exists financial_years_id_user_id_key,
  drop constraint if exists financial_years_july_june;

drop table if exists fat.migration_batches;

commit;
