-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️  DATA-DESTROYING ROLLBACK — READ BEFORE RUNNING
--   * DROPS the WORK-173 claim-fact columns on recall_details, retain_details,
--     spoilt_meal_details and delayed_meal_details (their values are lost).
--   * DELETES the WORK-173 rate identities/versions (single_time_multiplier,
--     time_and_half_multiplier, relieving_allowance). This FAILS (FK) if any
--     claim_entitlements row references one of those versions — such rows are
--     historical records and must not be deleted to make a rollback pass;
--     withdraw the versions instead in that case.
-- ═══════════════════════════════════════════════════════════════════════════
-- Reverses supabase/migrations/20261005100000_fat_work173_generator_inputs.sql (WORK-173).

begin;

update fat.rates set active_version_id = null
where code in ('single_time_multiplier','time_and_half_multiplier','relieving_allowance');

alter table fat.rate_versions disable trigger rate_versions_append_only;
delete from fat.rate_versions rv using fat.rates r
where r.id = rv.rate_id and r.code in ('single_time_multiplier','time_and_half_multiplier','relieving_allowance');
alter table fat.rate_versions enable trigger rate_versions_append_only;

delete from fat.rates where code in ('single_time_multiplier','time_and_half_multiplier','relieving_allowance');

alter table fat.delayed_meal_details
  drop column if exists duty_end_at,
  drop column if exists duty_start_at,
  drop column if exists delay_cause,
  drop column if exists delay_notice_2h;
alter table fat.spoilt_meal_details
  drop column if exists emergency_call_ref,
  drop column if exists emergency_response,
  drop column if exists meal_interrupted_at;
alter table fat.retain_details
  drop column if exists retain_travel_home_minutes,
  drop column if exists night_shift_interrupted,
  drop column if exists retain_shift;
alter table fat.recall_details
  drop column if exists recall_travel_sunday_or_ph,
  drop column if exists recall_travel_minutes,
  drop column if exists recall_duty;

commit;
