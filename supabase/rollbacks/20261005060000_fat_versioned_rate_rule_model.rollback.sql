-- ═══════════════════════════════════════════════════════════════════════════
-- ⚠️  DATA-DESTROYING ROLLBACK — READ BEFORE RUNNING
--   * DROPS fat.entitlement_overrides (the override audit trail) and
--     fat.member_classifications (members' classification history).
--   * DROPS fat.claim_entitlements.edited_source.
--   * DELETES the WORK-172 seeded rates/versions (enterprise base pay,
--     overtime rule, Division A allowance history).
--   * NARROWS fat.rate_versions.value back to numeric(12,4) and
--     fat.retain.retain_rate_used back to numeric(8,2) — values with more
--     decimal places are ROUNDED (this re-introduces the 101.02 truncation).
-- Export those tables first if their contents matter.
-- ═══════════════════════════════════════════════════════════════════════════
-- Reverses supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql (WORK-172).

-- 8. Override audit.
drop trigger if exists claim_entitlements_override_audit on fat.claim_entitlements;
drop function if exists fat.claim_entitlements_override_audit();
drop table if exists fat.entitlement_overrides;
alter table fat.claim_entitlements drop column if exists edited_source;
drop function if exists fat.current_actor();

-- 7. Classification history.
drop table if exists fat.member_classifications;

-- 6. Prototype retain column.
alter table fat.retain alter column retain_rate_used type numeric(8,2);

-- 5. Append-only trigger (must go before the seed rows can be deleted).
drop trigger if exists rate_versions_append_only on fat.rate_versions;
drop function if exists fat.rate_versions_append_only();

-- 4. Seeds: clear active pointers, delete seeded versions and rates.
update fat.rates set active_version_id = null
where code in ('enterprise_base_pay_weekly','overtime_rate_factor','overtime_hourly_divisor',
               'double_time_multiplier','meal_allowance','spoilt_meal_allowance','travel_per_km');
delete from fat.rate_versions rv using fat.rates r
where r.id = rv.rate_id and r.code = 'travel_per_km'
  and rv.version_label in ('pr765587-prior-2021-01','pr765587-2023-06');
delete from fat.rates
where code in ('enterprise_base_pay_weekly','overtime_rate_factor','overtime_hourly_divisor',
               'double_time_multiplier','meal_allowance','spoilt_meal_allowance');  -- versions cascade

-- 3. Restore the withdrawn workbook km version as live and active.
update fat.rate_versions rv set withdrawn_at = null, withdrawn_reason = null
from fat.rates r where r.id = rv.rate_id and r.code = 'travel_per_km' and rv.version_label = 'initial-2025-06';
update fat.rates r set active_version_id = rv.id
from fat.rate_versions rv
where rv.rate_id = r.id and r.code = 'travel_per_km' and rv.version_label = 'initial-2025-06';

-- 2. rate_versions columns and constraints.
drop index if exists fat.rate_versions_effective_key;
alter table fat.rate_versions add constraint rate_versions_rate_id_effective_from_key unique (rate_id, effective_from);
alter table fat.rate_versions drop constraint if exists rate_versions_withdrawn_pair_check;
alter table fat.rate_versions drop constraint if exists rate_versions_source_kind_check;
alter table fat.rate_versions
  drop column if exists withdrawn_reason,
  drop column if exists withdrawn_at,
  drop column if exists source_ref,
  drop column if exists source_kind,
  drop column if exists classification;
alter table fat.rate_versions alter column value type numeric(12,4);

-- 1. rates units and description.
alter table fat.rates drop column if exists description;
alter table fat.rates drop constraint rates_unit_check;
alter table fat.rates add constraint rates_unit_check check (unit in ('dollars','dollars_per_km','hours'));

-- 0. Domain.
drop domain if exists fat.frv_classification;

-- 9. Privileges as they were before WORK-172 (RLS still limits writes to service_role).
grant insert, update, delete, truncate, references, trigger on fat.rates         to authenticated;
grant insert, update, delete, truncate, references, trigger on fat.rate_versions to authenticated;
