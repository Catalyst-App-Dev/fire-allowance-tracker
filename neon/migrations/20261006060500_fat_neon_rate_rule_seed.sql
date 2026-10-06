-- FAT Neon backend — 6/6 rate/rule reference seed (WORK-254, N1)
-- Owner: fat. Rollback: neon/rollbacks/20261006060500_fat_neon_rate_rule_seed.rollback.sql
--
-- Global rate/rule REFERENCE data (no member data). Values and provenance are
-- the repository authority, copied verbatim:
--   * supabase/canonical/04_seed_rates.sql — the five canonical-04 rates, version
--     'initial-2025-06' (workbook / industrial provenance added by WORK-172);
--   * supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql §1–§4 and
--     20261005100000_fat_work173_generator_inputs.sql §2 —
--     WORK-172 rate identities, authoritative versions, and the WITHDRAWN workbook
--     travel_per_km $1.20 (inserted already-withdrawn: the append-only trigger
--     allows inserts; nothing is updated or deleted);
-- reproducing the Supabase DEV end state (docs/architecture/RATE_RULE_MODEL.md §4).

-- 1. Canonical-04 rate identities and their initial versions with provenance.
insert into fat.rates (code, display_name, unit) values
  ('travel_per_km', 'Kilometre Rate',                'dollars_per_km'),
  ('small_meal',    'Small Meal Allowance',          'dollars'),
  ('large_meal',    'Large Meal Allowance',          'dollars'),
  ('standby_hours', 'Standby & Dismiss (fixed hrs)', 'hours'),
  ('md_hours',      'Muster & Dismiss (fixed hrs)',  'hours');

insert into fat.rate_versions (rate_id, version_label, value, effective_from, source_kind, source_ref, withdrawn_at, withdrawn_reason)
select rt.id, 'initial-2025-06', x.value, date '2025-06-01', x.kind, x.ref,
       case when x.code = 'travel_per_km' then now() end,
       case when x.code = 'travel_per_km' then 'Workbook/tax value, not industrial entitlement authority. Superseded by PR765587 Div A Motor Vehicle / Mileage Allowance history (WORK-172).' end
from (values
  ('travel_per_km', 1.2000, 'workbook', 'FRV Allowances workbook via defaultRates.js / canonical 04 seed. Personal workbook value, NOT industrial-entitlement authority (operator decision, WORK-172 PROMPT #10). Meal-entitlement mapping to industrial codes: WORK-173.'),
  ('small_meal',   10.9000, 'workbook', 'FRV Allowances workbook via defaultRates.js / canonical 04 seed. Personal workbook value, NOT industrial-entitlement authority (operator decision, WORK-172 PROMPT #10). Meal-entitlement mapping to industrial codes: WORK-173.'),
  ('large_meal',   20.5500, 'workbook', 'FRV Allowances workbook via defaultRates.js / canonical 04 seed. Personal workbook value, NOT industrial-entitlement authority (operator decision, WORK-172 PROMPT #10). Meal-entitlement mapping to industrial codes: WORK-173.'),
  ('standby_hours', 0.5000, 'industrial_instrument', 'FRV EBA 2020 Div A cl 85.8.4(b) (Standby & Dismiss 0.5 h overtime allowance) / cl 85.8.1 (Muster & Dismiss 1.0 h); rule confirmed by WORK-170.'),
  ('md_hours',      1.0000, 'industrial_instrument', 'FRV EBA 2020 Div A cl 85.8.4(b) (Standby & Dismiss 0.5 h overtime allowance) / cl 85.8.1 (Muster & Dismiss 1.0 h); rule confirmed by WORK-170.')
) as x(code, value, kind, ref)
join fat.rates rt on rt.code = x.code;

update fat.rates rt
set active_version_id = rv.id
from fat.rate_versions rv
where rv.rate_id = rt.id
  and rv.version_label = 'initial-2025-06'
  and rt.code in ('small_meal','large_meal','standby_hours','md_hours');

-- 2. WORK-172 rate/rule identities, authoritative versions and active versions
--    (verbatim from 20261005060000 §4).
insert into fat.rates (code, display_name, unit, description) values
  ('enterprise_base_pay_weekly', 'Enterprise rate — weekly Base Pay', 'dollars_per_week',
   'Classification Base Pay only. Excludes every separately itemised allowance (EMR, Cert IV, Academy/RCRS/Instructor, Day Duty, meal, travel, mileage, retain, M&D, Excess Travel, reimbursements).'),
  ('overtime_rate_factor',       'Overtime rate factor (90.93 %)', 'multiplier',
   'Fraction of the enterprise rate used when calculating overtime.'),
  ('overtime_hourly_divisor',    'Overtime hourly divisor', 'hours',
   'Weekly → hourly divisor for the adjusted enterprise rate. Payroll-reconciled (D-172-1), not stated in the EBA.'),
  ('double_time_multiplier',     'Double time', 'multiplier',
   'Multiplier for overtime paid at double time (retain, recall, overtime-allowance hours).'),
  ('meal_allowance',             'Meal Allowance (Division A)', 'dollars',
   'Industrial meal allowance. Mapping of FAT meal entitlements to this code is WORK-173.'),
  ('spoilt_meal_allowance',      'Spoilt Meal Allowance (Division A)', 'dollars',
   'Industrial spoilt-meal allowance. Mapping of FAT meal entitlements to this code is WORK-173.');

update fat.rates set description = 'Motor Vehicle / Mileage Allowance (Division A), $ per km.'
where code = 'travel_per_km';

insert into fat.rate_versions (rate_id, version_label, value, effective_from, classification, source_kind, source_ref)
-- version_label is unique per rate, so classified versions carry the classification suffix.
select r.id, case when x.cls is null then x.label else x.label || '-' || x.cls end,
       x.value, x.eff, x.cls::fat.frv_classification, x.kind, x.ref
from (values
  -- Weekly enterprise Base Pay, Division A "Current Wage" (PR765587 Annexure A).
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1113.60, date '2021-01-01','recruit','fwc_order','PR765587 (FWC, 8 Sep 2023) Annexure A, Division A "Current Wage"; in force since the 2.5 % administrative variation wef 1 Jan 2021 ([2023] FWC 2020 [16]).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1552.62, date '2021-01-01','ff1',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1581.36, date '2021-01-01','ff2',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1613.61, date '2021-01-01','ff3',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1738.86, date '2021-01-01','qff',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1896.00, date '2021-01-01','sff',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 1999.60, date '2021-01-01','lff',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021). Matches the LFF payslip Base Pay line (Base Pay only; allowances excluded).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2121.41, date '2021-01-01','slff',   'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2260.73, date '2021-01-01','so',     'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2434.43, date '2021-01-01','sso',    'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2748.61, date '2021-01-01','cmdr_commencement','fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2850.62, date '2021-01-01','cmdr_12m','fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2952.47, date '2021-01-01','cmdr_24m','fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021); Commander after 24 months / L4.'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 2434.43, date '2021-01-01','fscc',   'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  ('enterprise_base_pay_weekly','pr765587-annexa-2021-01', 3025.62, date '2021-01-01','sfscc',  'fwc_order','PR765587 Annexure A, Division A "Current Wage" (wef 1 Jan 2021).'),
  -- Overtime rule parameters.
  ('overtime_rate_factor',   'eba2020',                  0.9093, date '2020-07-01', null, 'industrial_instrument','FRV Operational Employees Interim EA 2020, Part B wages: "In all cases when calculating overtime the rate to be used will be 90.93% of the enterprise rate." (inherited from MFB/UFU Operational Staff Agreement 2010 cl 96.2). EA operative from FRV commencement 1 Jul 2020.'),
  ('overtime_hourly_divisor','payroll-reconciled-d172-1', 36,    date '2020-07-01', null, 'payroll_reconciled',  'Operator decision D-172-1 (WORK-172, 2026-10-05): divide the adjusted weekly enterprise rate by 36. Payroll-reconciled to FRV payslips (LFF Maint Stn 4.00 h: model $404.08 vs payslip $404.09, accepted ±$0.01). NOT stated in the EBA and NOT derived from the 38/42-hour roster clause.'),
  ('double_time_multiplier', 'eba2020-cl128',            2,      date '2020-07-01', null, 'industrial_instrument','FRV EBA 2020 Part B cl 128.1 (overtime at double time), cl 128.2 (recall minimum 4 h at double time), cl 128.5 (retained 60 min or more: minimum 4 h at double time).'),
  -- Division A allowances (PR765587: payable from the first pay period after 16 Jun 2023).
  ('travel_per_km',          'pr765587-prior-2021-01',   1.37,  date '2021-01-01', null, 'fwc_order','PR765587 Division A "Motor Vehicle / Mileage Allowance" amount before the order (in force since the 1 Jan 2021 variation, [2023] FWC 2020 [16]).'),
  ('travel_per_km',          'pr765587-2023-06',         1.50,  date '2023-06-17', null, 'fwc_order','PR765587 Division A "Motor Vehicle / Mileage Allowance": payable from the first pay period after 16 Jun 2023. effective_from 17 Jun 2023 is the date-level lower bound of that pay period.'),
  ('meal_allowance',         'pr765587-prior-2021-01',  18.75,  date '2021-01-01', null, 'fwc_order','PR765587 Division A "Meal Allowance" amount before the order (in force since the 1 Jan 2021 variation).'),
  ('meal_allowance',         'pr765587-2023-06',        20.53,  date '2023-06-17', null, 'fwc_order','PR765587 Division A "Meal Allowance": payable from the first pay period after 16 Jun 2023.'),
  ('spoilt_meal_allowance',  'pr765587-prior-2021-01',  18.74,  date '2021-01-01', null, 'fwc_order','PR765587 Division A "Spoilt Meal Allowance" amount before the order (in force since the 1 Jan 2021 variation).'),
  ('spoilt_meal_allowance',  'pr765587-2023-06',        20.52,  date '2023-06-17', null, 'fwc_order','PR765587 Division A "Spoilt Meal Allowance": payable from the first pay period after 16 Jun 2023.')
) as x(code, label, value, eff, cls, kind, ref)
join fat.rates r on r.code = x.code;

-- active_version_id = latest live unclassified version (classification-keyed
-- rates have no single active version; lookup is by classification + date).
update fat.rates r
set active_version_id = (
  select rv.id from fat.rate_versions rv
  where rv.rate_id = r.id and rv.withdrawn_at is null and rv.classification is null
  order by rv.effective_from desc limit 1)
where r.code in ('travel_per_km','overtime_rate_factor','overtime_hourly_divisor',
                 'double_time_multiplier','meal_allowance','spoilt_meal_allowance');

-- 3. WORK-173 rate identities and versions (verbatim from
--    supabase/migrations/20261005100000_fat_work173_generator_inputs.sql §2).
insert into fat.rates (code, display_name, unit, description) values
  ('single_time_multiplier',   'Ordinary rate', 'multiplier',
   'Multiplier for time paid at ordinary rates (EBA 2020 cl 128.4 recall travelling time; cl 85.8.9 travel home; cl 85.8.1/85.8.4 Excess Travel).'),
  ('time_and_half_multiplier', 'Time and one half', 'multiplier',
   'Multiplier for recall travelling time on Sundays and public holidays (EBA 2020 cl 128.4).'),
  ('relieving_allowance',      'Relieving Allowance (Division A)', 'dollars',
   'Per shift, when recalled to a work location other than the rostered station (EBA 2020 cl 85.8.10; Schedule 4).');

insert into fat.rate_versions (rate_id, version_label, value, effective_from, classification, source_kind, source_ref)
select r.id, x.label, x.value, x.eff, null, x.kind, x.ref
from (values
  ('single_time_multiplier',   'eba2020-ordinary',     1,     date '2020-07-01', 'industrial_instrument',
   'FRV Operational Employees Interim EA 2020 Div A: "ordinary rates" — cl 128.4 (recall travelling time), cl 85.8.9 (travel home after night-shift retention), cl 85.8.1/85.8.4 (Excess Travel). EA operative from FRV commencement 1 Jul 2020.'),
  ('time_and_half_multiplier', 'eba2020-cl128.4',      1.5,   date '2020-07-01', 'industrial_instrument',
   'FRV EBA 2020 Div A cl 128.4: recall travelling time on Sundays and public holidays at time and one half.'),
  ('relieving_allowance',      'pr765587-2023-06',     35.11, date '2023-06-17', 'fwc_order',
   'PR765587 Division A "Relieving Allowance": payable from the first pay period after 16 Jun 2023 (effective_from 17 Jun 2023 = date-level lower bound). EBA 2020 Schedule 4 Part A originally $30.52 — not seeded because the 2021-01-01 variation value is not evidenced (WORK-173).')
) as x(code, label, value, eff, kind, ref)
join fat.rates r on r.code = x.code;

update fat.rates r
set active_version_id = (
  select rv.id from fat.rate_versions rv
  where rv.rate_id = r.id and rv.withdrawn_at is null and rv.classification is null
  order by rv.effective_from desc limit 1)
where r.code in ('single_time_multiplier','time_and_half_multiplier','relieving_allowance');

-- 4. Postconditions (WORK-172 §10 seed and arithmetic checks).
do $assert$
declare
  n int;
  lff numeric;
begin
  select rv.value into lff from fat.rate_versions rv join fat.rates r on r.id = rv.rate_id
   where r.code = 'enterprise_base_pay_weekly' and rv.classification = 'lff' and rv.withdrawn_at is null;
  if lff is distinct from 1999.60 then raise exception 'WORK-254 seed postcondition: LFF base pay % <> 1999.60', lff; end if;

  if round(round(1999.60 * 0.9093 / 36, 2) * 2 * 4, 2) <> 404.08 then
    raise exception 'WORK-254 seed postcondition: reconciliation arithmetic changed';
  end if;

  select count(*) into n from fat.rate_versions rv join fat.rates r on r.id = rv.rate_id
   where r.code = 'travel_per_km' and rv.withdrawn_at is null and rv.value = 1.20;
  if n <> 0 then raise exception 'WORK-254 seed postcondition: workbook km version still live'; end if;

  select count(*) into n from fat.rates;
  if n <> 14 then raise exception 'WORK-254 seed postcondition: % rates, expected 14', n; end if;
  select count(*) into n from fat.rate_versions;
  if n <> 32 then raise exception 'WORK-254 seed postcondition: % rate_versions, expected 32', n; end if;
end;
$assert$;
