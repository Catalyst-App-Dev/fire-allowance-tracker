-- ─── WORK-173: generator input facts + rate seeds for Recall / Retain / Meals ─
-- Owner: fat. Rollback: supabase/rollbacks/20261005100000_fat_work173_generator_inputs.rollback.sql
--
-- Rule authority: Linear WORK-173 rule specification v0.2 (operator-approved,
-- ChatGPT PROMPT #15, 2026-10-05) and docs/architecture/CANONICAL_ENTITLEMENT_RULES.md.
-- Source: FRV EBA 2020 Division A cl 127, 128.1/128.2/128.4/128.5/128.7,
-- 85.6.3–85.6.8, 85.7.1, 85.8.9, 85.8.10; Schedule 4; FWC PR765587.
--
-- What this adds (all ADDITIVE and NULLABLE; nothing is rewritten):
--   1. Claim-fact columns the canonical generators need (generator inputs are
--      WORK-173's scope; WORK-189/C1 explicitly excludes generators and must
--      carry these columns through the cutover).
--   2. Rate identities + versions: single_time_multiplier (1),
--      time_and_half_multiplier (1.5), relieving_allowance ($35.11 from
--      2023-06-17). The 2020 Schedule 4 Relieving $30.52 is deliberately NOT
--      seeded: the 2021-01-01 variation value is not evidenced, so a $30.52
--      version would misstate 2021-01-01..2023-06-16. Lookups before
--      2023-06-17 fail closed (no Relieving row). FAT holds no claims before
--      2026-05-29.
--
-- RLS / grants: column additions inherit the existing table policies; the new
-- rate rows inherit the WORK-172 read-only reference-data privileges and the
-- append-only trigger on fat.rate_versions.
-- Portable PostgreSQL (GOV-481 Neon): yes — no Supabase-specific seams added.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Generator input facts.
alter table fat.recall_details
  add column recall_duty                text    check (recall_duty in ('day','night')),
  add column recall_travel_minutes      numeric check (recall_travel_minutes >= 0),
  add column recall_travel_sunday_or_ph boolean;
comment on column fat.recall_details.recall_duty is
  'WORK-173: recall for day or night duty (EBA 2020 cl 85.6.3). Explicit fact, never inferred from the clock.';
comment on column fat.recall_details.recall_travel_minutes is
  'WORK-173: travelling time for the actual home → recall work location → home trip (EBA 2020 cl 128.4).';
comment on column fat.recall_details.recall_travel_sunday_or_ph is
  'WORK-173: travel on a Sunday or public holiday → time and one half (EBA 2020 cl 128.4).';
comment on column fat.recall_details.travel_distance_km is
  'Actual home → recall work location → home distance in km (EBA 2020 cl 128.4 mileage). WORK-173.';

alter table fat.retain_details
  add column retain_shift               text    check (retain_shift in ('day','night')),
  add column night_shift_interrupted    boolean,
  add column retain_travel_home_minutes numeric check (retain_travel_home_minutes >= 0);
comment on column fat.retain_details.retain_start_at is
  'Conclusion of the rostered shift (EBA 2020 cl 128.5 retention starts here). WORK-173.';
comment on column fat.retain_details.retain_end_at is
  'Release from duty. WORK-173.';
comment on column fat.retain_details.night_shift_interrupted is
  'WORK-173: the night shift was interrupted by a fire call, incident or fire duty (EBA 2020 cl 85.8.9).';
comment on column fat.retain_details.retain_travel_home_minutes is
  'WORK-173: reasonable travelling time to residence after the retention (EBA 2020 cl 85.8.9).';

alter table fat.spoilt_meal_details
  add column meal_interrupted_at timestamptz,
  add column emergency_response  boolean,
  add column emergency_call_ref  text;
comment on column fat.spoilt_meal_details.emergency_response is
  'WORK-173: the begun meal was interrupted because of response to an emergency call (EBA 2020 cl 85.7.1).';
comment on column fat.spoilt_meal_details.emergency_call_ref is
  'WORK-173: optional evidence; not an entitlement condition.';

alter table fat.delayed_meal_details
  add column delay_notice_2h boolean,
  add column delay_cause     text check (delay_cause in ('other','fire_call','salvage','watching')),
  add column duty_start_at   timestamptz,
  add column duty_end_at     timestamptz;
comment on column fat.delayed_meal_details.delay_cause is
  'WORK-173: other → EBA 2020 cl 85.6.6; fire_call/salvage/watching → cl 85.6.7 (3 h or more including the normal meal break).';
comment on column fat.delayed_meal_details.meal_window_start_at is
  'The member''s normal meal break start as recorded on the claim (EBA 2020 cl 127.2). WORK-173.';

-- 2. Rate identities and versions.
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
