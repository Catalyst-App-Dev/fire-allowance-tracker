-- FAT Neon DEV synthetic fixture (WORK-254, N1)
-- Target: the FAT Neon `dev` target ONLY (backend-preflight operation data-load,
-- change id `fat-dev-synthetic-20261006`). Never applied to `main`.
--
-- Every identity, station, claim and amount here is SYNTHETIC: UUIDs use the
-- reserved 5eed… prefix, e-mail addresses use the reserved .invalid TLD
-- (RFC 2606), station ids are 9001–9003 (no FRV station has those ids), and no
-- row was copied from Supabase DEV or PROD. Rate/rule reference data comes from
-- migration 6/6 (repository authority).
--
-- Exercises: the identity seam (native, synthetic and legacy-preserved origin,
-- provider links), classifications, stations and matrices, July–June financial
-- years, all six canonical claim types with their WORK-173 detail fields,
-- hours-first entitlements with frozen rate snapshots, an audited manual
-- override, payment routing / record / allocation / reconciliation audit, a
-- payslip import line, and C1/C3 provenance (batch, source-row ledger with an
-- excluded G12-style artifact, prototype-lineage claim and entitlement, and a
-- `prototype_migration` payment record with its idempotent source key).
-- Runs as the migration owner (outside RLS), like the Supabase service role.

-- 1. Identities (fat.ensure_app_identity replaces the auth.users trigger).
select fat.ensure_app_identity('5eed0000-0000-4000-8000-00000000000a', 'synthetic.member.a@example.invalid', 'synthetic');
select fat.ensure_app_identity('5eed0000-0000-4000-8000-00000000000b', 'synthetic.member.b@example.invalid', 'synthetic');
-- A legacy-preserved identity: a SYNTHETIC uid standing in for a Supabase
-- auth.users.id, proving the FAT owner id is kept unchanged (legacy_subject = id).
select fat.ensure_app_identity('5eed0000-0000-4000-8000-00000000000c', 'synthetic.legacy.c@example.invalid', 'legacy_supabase');

insert into fat.identity_links (app_identity_id, provider, provider_subject, verified_email, linked_by) values
  ('5eed0000-0000-4000-8000-00000000000a', 'neon_auth',     'synthetic-neon-auth-user-a',            'synthetic.member.a@example.invalid', 'synthetic'),
  ('5eed0000-0000-4000-8000-00000000000c', 'supabase_auth', '5eed0000-0000-4000-8000-00000000000c',  'synthetic.legacy.c@example.invalid', 'legacy_uid'),
  ('5eed0000-0000-4000-8000-00000000000c', 'neon_auth',     'synthetic-neon-auth-user-c',            'synthetic.legacy.c@example.invalid', 'verified_email');

update fat.profiles set first_name = 'Synthetic', last_name = 'Member A', display_name = 'Synthetic A'
 where id = '5eed0000-0000-4000-8000-00000000000a';

-- 2. Stations and matrices (synthetic ids 9001–9003).
insert into fat.stations (id, name, abbreviation, region, district, suburb, postcode) values
  (9001, 'Synthetic Station Alpha', 'SSA', 'Synthetic', 'S1', 'Example North', '0001'),
  (9002, 'Synthetic Station Bravo', 'SSB', 'Synthetic', 'S1', 'Example South', '0002'),
  (9003, 'Synthetic Station Charlie', 'SSC', 'Synthetic', 'S2', 'Example West', '0003');
insert into fat.station_aliases (alias, alias_norm, station_id, source) values
  ('Alpha', 'alpha', 9001, 'synthetic');
insert into fat.station_distance_matrix (from_station_id, to_station_id, matrix_version, distance_km) values
  (9001, 9002, 'synthetic-v1', 13.50), (9002, 9001, 'synthetic-v1', 13.50), (9001, 9003, 'synthetic-v1', 31.20);
insert into fat.station_time_matrix (from_station_id, to_station_id, matrix_version, hours) values
  (9001, 9002, 'synthetic-v1', 0.25), (9001, 9003, 'synthetic-v1', 0.50);
insert into fat.travel_matrix_versions (id, label, unit, is_active, notes, cell_count, station_count) values
  ('5eed0000-0000-4000-8000-0000000000f1', 'synthetic-index-hr', 'hours', true, 'WORK-254 synthetic fixture', 1, 2);
insert into fat.travel_matrix_cells (version_id, station_a_id, station_b_id, value) values
  ('5eed0000-0000-4000-8000-0000000000f1', 9001, 9002, 0.250);

update fat.profiles set rostered_station_id = 9001 where id = '5eed0000-0000-4000-8000-00000000000a';
insert into fat.profile_ext (user_id, station_id, rostered_station_label, platoon, home_dist_km)
values ('5eed0000-0000-4000-8000-00000000000a', 9001, 'Synthetic Station Alpha', 'A', 12.0);

-- 3. Classification history and July–June financial years.
insert into fat.member_classifications (owner_id, classification, effective_from, source_ref) values
  ('5eed0000-0000-4000-8000-00000000000a', 'lff', date '2021-01-01', 'synthetic fixture WORK-254');
insert into fat.financial_years (id, user_id, label, start_date, end_date, is_active) values
  ('5eed0000-0000-4000-8000-0000000000a1', '5eed0000-0000-4000-8000-00000000000a', '2025-26', date '2025-07-01', date '2026-06-30', true),
  ('5eed0000-0000-4000-8000-0000000000b1', '5eed0000-0000-4000-8000-00000000000b', '2025-26', date '2025-07-01', date '2026-06-30', true);
insert into fat.claim_sequences (user_id, financial_year_id, claim_type, next_seq) values
  ('5eed0000-0000-4000-8000-00000000000a', '5eed0000-0000-4000-8000-0000000000a1', 'RT', 2);

-- 4. Canonical claims for member A — one per claim type, with WORK-173 detail fields.
insert into fat.operational_claims (id, owner_id, claim_type, claim_date, station_id_snapshot, station_name_snapshot, source_calculation_mode, status, claim_number, financial_year_id) values
  ('5eed0000-0000-4000-8000-0000000c0001', '5eed0000-0000-4000-8000-00000000000a', 'RT', date '2025-08-12', 9001, 'Synthetic Station Alpha', 'manual',     'submitted', 1, '5eed0000-0000-4000-8000-0000000000a1'),
  ('5eed0000-0000-4000-8000-0000000c0002', '5eed0000-0000-4000-8000-00000000000a', 'RC', date '2025-09-03', 9002, 'Synthetic Station Bravo', 'google_maps','submitted', 1, '5eed0000-0000-4000-8000-0000000000a1'),
  ('5eed0000-0000-4000-8000-0000000c0003', '5eed0000-0000-4000-8000-00000000000a', 'SB', date '2025-10-21', 9003, 'Synthetic Station Charlie','frv_matrix','draft',     1, '5eed0000-0000-4000-8000-0000000000a1'),
  ('5eed0000-0000-4000-8000-0000000c0004', '5eed0000-0000-4000-8000-00000000000a', 'MD', date '2025-11-02', 9002, 'Synthetic Station Bravo', 'frv_matrix', 'draft',     1, '5eed0000-0000-4000-8000-0000000000a1'),
  ('5eed0000-0000-4000-8000-0000000c0005', '5eed0000-0000-4000-8000-00000000000a', 'SM', date '2025-12-14', 9001, 'Synthetic Station Alpha', 'manual',     'draft',     1, '5eed0000-0000-4000-8000-0000000000a1'),
  ('5eed0000-0000-4000-8000-0000000c0006', '5eed0000-0000-4000-8000-00000000000a', 'DM', date '2026-01-09', 9001, 'Synthetic Station Alpha', 'manual',     'draft',     1, '5eed0000-0000-4000-8000-0000000000a1');
insert into fat.retain_details (claim_id, retain_start_at, retain_end_at, meal_break_taken, retain_shift, night_shift_interrupted, retain_travel_home_minutes)
values ('5eed0000-0000-4000-8000-0000000c0001', '2025-08-12 18:00+10', '2025-08-12 19:15+10', false, 'day', false, 0);
insert into fat.recall_details (claim_id, recall_station_id, recall_start_at, recall_end_at, travel_distance_km, travel_source, meal_break_taken, recall_duty, recall_travel_minutes, recall_travel_sunday_or_ph)
values ('5eed0000-0000-4000-8000-0000000c0002', 9002, '2025-09-03 08:00+10', '2025-09-03 13:00+10', 24.60, 'google_maps', true, 'day', 35, false);
insert into fat.standby_details (claim_id, standby_station_id, standby_start_at, standby_end_at, matrix_distance_km, matrix_hours, matrix_version, home_to_rostered_km, home_to_target_km)
values ('5eed0000-0000-4000-8000-0000000c0003', 9003, '2025-10-21 08:00+11', '2025-10-21 18:00+11', 31.20, 0.50, 'synthetic-v1', 12.00, 40.00);
insert into fat.muster_dismiss_details (claim_id, md_station_id, md_event_at, matrix_distance_km, matrix_hours, matrix_version, home_to_rostered_km, home_to_target_km)
values ('5eed0000-0000-4000-8000-0000000c0004', 9002, '2025-11-02 07:30+11', 13.50, 0.25, 'synthetic-v1', 12.00, 20.00);
insert into fat.spoilt_meal_details (claim_id, meal_provisioned_at, spoilt_reason, meal_interrupted_at, emergency_response, emergency_call_ref)
values ('5eed0000-0000-4000-8000-0000000c0005', '2025-12-14 12:00+11', 'synthetic: call during meal', '2025-12-14 12:10+11', true, 'SYN-0001');
insert into fat.delayed_meal_details (claim_id, meal_window_start_at, meal_window_end_at, actual_meal_at, delay_notice_2h, delay_cause, duty_start_at, duty_end_at)
values ('5eed0000-0000-4000-8000-0000000c0006', '2026-01-09 12:00+11', '2026-01-09 13:00+11', '2026-01-09 15:30+11', false, 'fire_call', '2026-01-09 08:00+11', '2026-01-09 18:00+11');

-- 5. Hours-first entitlements with frozen rate/rule snapshots (WORK-172).
insert into fat.claim_entitlements (id, claim_id, owner_id, entitlement_type, unit, generated_hours, generated_amount, rule_id, rule_version, rule_explanation, rate_id, rate_version_id, rate_snapshot)
select '5eed0000-0000-4000-8000-0000000e0001', '5eed0000-0000-4000-8000-0000000c0001', '5eed0000-0000-4000-8000-00000000000a',
       'retain_overtime', 'hours', 4.00, 404.0800, 'overtime.enterprise_rate.v1', 'v1', 'synthetic: retained >= 60 min → 4 h minimum at double time (cl 128.5)',
       r.id, rv.id,
       jsonb_build_object('classification', 'lff', 'base_pay_weekly', rv.value, 'factor', 0.9093, 'divisor', 36, 'multiplier', 2,
                          'base_hourly', 50.51, 'is_estimate', true, 'estimate_convention', 'fat.overtime_estimate.cents_base.v1', 'synthetic', true)
  from fat.rates r join fat.rate_versions rv on rv.rate_id = r.id
 where r.code = 'enterprise_base_pay_weekly' and rv.classification = 'lff' and rv.withdrawn_at is null;
insert into fat.claim_entitlements (id, claim_id, owner_id, entitlement_type, unit, generated_amount, rule_id, rule_version, rate_id, rate_version_id, rate_snapshot)
select '5eed0000-0000-4000-8000-0000000e0002', '5eed0000-0000-4000-8000-0000000c0002', '5eed0000-0000-4000-8000-00000000000a',
       'recall_meal', 'dollars', rv.value, 'meal.recall.v1', 'v1', r.id, rv.id,
       jsonb_build_object('code', r.code, 'version_label', rv.version_label, 'value', rv.value, 'synthetic', true)
  from fat.rates r join fat.rate_versions rv on rv.rate_id = r.id
 where r.code = 'meal_allowance' and rv.version_label = 'pr765587-2023-06';
insert into fat.claim_entitlements (id, claim_id, owner_id, entitlement_type, unit, generated_hours, rule_id, rule_version, rate_snapshot)
values ('5eed0000-0000-4000-8000-0000000e0003', '5eed0000-0000-4000-8000-0000000c0003', '5eed0000-0000-4000-8000-00000000000a',
        'standby_overtime_allowance', 'hours', 0.50, 'standby.cl85_8_4b.v1', 'v1', '{"source":"synthetic","hours":0.5}');

-- An audited manual override (trigger writes fat.entitlement_overrides; generation fields stay immutable).
update fat.claim_entitlements
   set edited_hours = 4.25, edited_note = 'synthetic: payslip shows 4.25 h', edited_source = 'synthetic:payslip:SYN-1'
 where id = '5eed0000-0000-4000-8000-0000000e0003';

-- 6. Payment routing, record, allocation and reconciliation audit (Payments stay dark: data only).
select fat.route_entitlement('5eed0000-0000-4000-8000-0000000e0002', 'petty_cash', '5eed0000-0000-4000-8000-00000000000a', 'synthetic routing');
select fat.route_entitlement('5eed0000-0000-4000-8000-0000000e0001', 'payslip',    '5eed0000-0000-4000-8000-00000000000a', 'synthetic routing');
insert into fat.payment_records (id, owner_id, stream, record_date, reference, gross_amount, source)
values ('5eed0000-0000-4000-8000-0000000f0001', '5eed0000-0000-4000-8000-00000000000a', 'petty_cash', date '2025-09-30', 'SYN-PC-1', 20.53, 'manual');
select fat.link_entitlement_payment('5eed0000-0000-4000-8000-0000000e0002', '5eed0000-0000-4000-8000-0000000f0001', 20.53, 'manual',
                                    '5eed0000-0000-4000-8000-00000000000a', 'synthetic allocation', false, 0.01);

insert into fat.payslip_imports (id, owner_id, source, status, pay_date, parser_name, parser_version, line_count)
values ('5eed0000-0000-4000-8000-0000000d0001', '5eed0000-0000-4000-8000-00000000000a', 'manual_entry', 'parsed', date '2025-08-28', 'synthetic', '0', 1);
insert into fat.payslip_import_lines (id, import_id, owner_id, line_index, raw_text, parsed_reference, parsed_description, parsed_amount, parsed_date, candidate_entitlement_id)
values ('5eed0000-0000-4000-8000-0000000d0101', '5eed0000-0000-4000-8000-0000000d0001', '5eed0000-0000-4000-8000-00000000000a', 0,
        'SYN Maint Stn N/N 4.00', 'SYN-PS-1', 'Maint Stn N/N', 404.08, date '2025-08-28', '5eed0000-0000-4000-8000-0000000e0001');

-- 7. C1/C3 provenance: one synthetic C2 batch, a prototype-lineage claim and
--    entitlement, a source-row ledger (claim + excluded artifact) and a C3-style
--    prototype_migration payment record with its idempotent key.
insert into fat.migration_batches (id, batch_key, step, environment, tool, tool_version, source_checksum, status, completed_at, notes)
values ('5eed0000-0000-4000-8000-0000000ba001', 'c2:dev:synthetic:work-254', 'C2', 'dev', 'synthetic-fixture', '0.0.0',
        'synthetic', 'completed', now(), 'WORK-254 synthetic provenance fixture — not a real C2 run');
insert into fat.operational_claims (id, owner_id, claim_type, claim_date, status, claim_number, financial_year_id,
                                    migration_batch_id, prototype_claim_group_id, prototype_source, prototype_row_id)
values ('5eed0000-0000-4000-8000-0000000c0007', '5eed0000-0000-4000-8000-00000000000c', 'RC', date '2026-02-02', 'submitted', null, null,
        '5eed0000-0000-4000-8000-0000000ba001', '5eed0000-0000-4000-8000-0000000a9001', 'recalls', '5eed0000-0000-4000-8000-0000000a9101');
insert into fat.claim_entitlements (id, claim_id, owner_id, entitlement_type, unit, generated_amount, rule_id, rule_version, rate_snapshot,
                                    migration_batch_id, prototype_source, prototype_row_id, prototype_component)
values ('5eed0000-0000-4000-8000-0000000e0007', '5eed0000-0000-4000-8000-0000000c0007', '5eed0000-0000-4000-8000-00000000000c',
        'recall_travel', 'dollars', 36.90, 'prototype.stored_amount', 'c2', '{"provenance":"prototype","synthetic":true}',
        '5eed0000-0000-4000-8000-0000000ba001', 'recalls', '5eed0000-0000-4000-8000-0000000a9101', 'travel_amount');
insert into fat.migration_source_rows (batch_id, owner_id, source_table, source_row_id, source_claim_group_id, source_claim_type, source_checksum, disposition, target_claim_id) values
  ('5eed0000-0000-4000-8000-0000000ba001', '5eed0000-0000-4000-8000-00000000000c', 'claim_groups', '5eed0000-0000-4000-8000-0000000a9001', null, 'recalls', 'sha256:synthetic-group', 'claim', '5eed0000-0000-4000-8000-0000000c0007'),
  ('5eed0000-0000-4000-8000-0000000ba001', '5eed0000-0000-4000-8000-00000000000c', 'recalls', '5eed0000-0000-4000-8000-0000000a9101', '5eed0000-0000-4000-8000-0000000a9001', 'recalls', 'sha256:synthetic-row', 'entitlement', '5eed0000-0000-4000-8000-0000000c0007');
insert into fat.migration_source_rows (batch_id, owner_id, source_table, source_row_id, source_claim_group_id, source_claim_type, source_checksum, source_snapshot, disposition, exclusion_code, exclusion_reason)
values ('5eed0000-0000-4000-8000-0000000ba001', '5eed0000-0000-4000-8000-00000000000c', 'recalls', '5eed0000-0000-4000-8000-0000000a9102',
        '5eed0000-0000-4000-8000-0000000a9001', 'recalls', 'sha256:synthetic-artifact', '{"total_amount":0,"synthetic":true}',
        'excluded', 'G12_FAKE_ZERO_EXCESS_TRAVEL', 'synthetic $0 recall excess-travel artifact (G12)');
insert into fat.payment_records (id, owner_id, stream, record_date, reference, gross_amount, raw_payload, source, migration_batch_id, migration_source_key)
values ('5eed0000-0000-4000-8000-0000000f0007', '5eed0000-0000-4000-8000-00000000000c', 'payslip', date '2026-02-20', 'SYN-PAYNBR-7', 36.90,
        '{"synthetic":true}', 'prototype_migration', '5eed0000-0000-4000-8000-0000000ba001', 'c3:dev:synthetic:recalls:5eed0000-0000-4000-8000-0000000a9101');
select fat.route_entitlement('5eed0000-0000-4000-8000-0000000e0007', 'payslip', '5eed0000-0000-4000-8000-00000000000c', 'synthetic C3 route');
select fat.link_entitlement_payment('5eed0000-0000-4000-8000-0000000e0007', '5eed0000-0000-4000-8000-0000000f0007', 36.90, 'manual',
                                    '5eed0000-0000-4000-8000-00000000000c', 'synthetic C3 allocation', true, 0.01);
