-- C2/C3 batch rollback (WORK-255) — removes ONLY rows tagged to batch c2:dev:2.0.0:c7dd894ad0445e4a573d746a4a65e5de on the Neon TARGET.
-- Payment records (links cascade) → entitlements (details-free; audit + overrides cascade) → claims (details and
-- targeted ledger rows cascade) → remaining ledger rows of the batch (EMPTY_CLAIM_GROUP / untargeted) → the batch.
-- Owner identities and FYs (prerequisites) are foundation and are NOT removed. The data-load row fat-c2-dev-c7dd894ad0445e4a573d746a
-- is replaced by fat-c2-dev-c7dd894ad0445e4a573d746a-rollback. Run as ONE transaction (DO block + result SELECT). Roll back the newest batch first.
do $c2rollback$
declare b uuid; n_claims int := 0; n_ents int := 0; n_ledger int := 0; n_pay int := 0; n_links int := 0; n_audit int := 0; n_over int := 0; n_dl int := 0;
begin
  select id into b from fat.migration_batches where batch_key = 'c2:dev:2.0.0:c7dd894ad0445e4a573d746a4a65e5de';
  if b is null then
    perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', 'c2:dev:2.0.0:c7dd894ad0445e4a573d746a4a65e5de', 'found', false)::text, true);
    return;
  end if;
  select count(*) into n_links from fat.entitlement_payment_links l join fat.claim_entitlements e on e.id = l.entitlement_id where e.migration_batch_id = b;
  select count(*) into n_audit from fat.reconciliation_audit a join fat.claim_entitlements e on e.id = a.entitlement_id where e.migration_batch_id = b;
  select count(*) into n_over from fat.entitlement_overrides o join fat.claim_entitlements e on e.id = o.entitlement_id where e.migration_batch_id = b;
  delete from fat.payment_records where migration_batch_id = b;
  get diagnostics n_pay = row_count;
  delete from fat.claim_entitlements where migration_batch_id = b;
  get diagnostics n_ents = row_count;
  delete from fat.operational_claims where migration_batch_id = b;
  get diagnostics n_claims = row_count;
  delete from fat.migration_source_rows where batch_id = b;
  get diagnostics n_ledger = row_count;
  delete from fat.migration_batches where id = b;
  delete from fat_migrations.data_loads where change_id = 'fat-c2-dev-c7dd894ad0445e4a573d746a';
  get diagnostics n_dl = row_count;
  insert into fat_migrations.data_loads (change_id, kind, checksum) values ('fat-c2-dev-c7dd894ad0445e4a573d746a-rollback', 'migration_batch', 'sha256:799e83aade84ebd36277e877fd19b607c47153953f7a5b438c17a7c46ae986ca')
  on conflict (change_id) do nothing;
  perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', 'c2:dev:2.0.0:c7dd894ad0445e4a573d746a4a65e5de', 'found', true,
    'payment_records_deleted', n_pay, 'links_cascaded', n_links, 'audit_cascaded', n_audit, 'overrides_cascaded', n_over,
    'entitlements_deleted_directly', n_ents, 'claims_deleted', n_claims, 'untargeted_ledger_deleted', n_ledger,
    'data_load_removed', n_dl, 'rollback_change', 'fat-c2-dev-c7dd894ad0445e4a573d746a-rollback')::text, true);
end
$c2rollback$;
select nullif(current_setting('fat_c2.rollback_result', true), '')::jsonb as rollback_result;
