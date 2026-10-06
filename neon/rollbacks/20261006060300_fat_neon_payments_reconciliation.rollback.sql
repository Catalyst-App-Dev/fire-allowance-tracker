-- Rollback of 20261006060300_fat_neon_payments_reconciliation.sql (WORK-254).
-- DESTROYS DATA: drops payment records, allocation links, reconciliation audit
-- and payslip staging tables with every row in them. DEV/synthetic only; a
-- PROD rollback follows docs/architecture/NEON_BACKEND.md §7 instead.
drop function if exists fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean);
drop table if exists fat.payslip_import_lines;
drop table if exists fat.payslip_imports;
drop function if exists fat.payslip_line_fp_trigger();
drop function if exists fat.payslip_line_content_fp(text, text, numeric, date);
drop function if exists fat.retract_payment(uuid, uuid, text, numeric);
drop function if exists fat.route_entitlement(uuid, text, uuid, text);
drop function if exists fat.recompute_entitlement_status(uuid, uuid, text, text, numeric);
drop function if exists fat.unlink_entitlement_payment(uuid, uuid, text, numeric);
drop function if exists fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric);
drop function if exists fat.create_payment_record(uuid, text, date, numeric, text, text, jsonb);
drop function if exists fat._reconc_write_audit(uuid, uuid, text, text, text, text, boolean);
drop function if exists fat._reconc_recompute(uuid, numeric);
drop table if exists fat.reconciliation_audit;
drop table if exists fat.entitlement_payment_links;
drop table if exists fat.payment_records;
delete from fat_migrations.schema_migrations where version = '20261006060300';
