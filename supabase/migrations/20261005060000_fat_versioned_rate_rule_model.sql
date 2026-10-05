-- ─── Versioned rate/rule model + audited per-claim override (WORK-172, G11) ──
-- Owner: fat. Rollback: supabase/rollbacks/20261005060000_fat_versioned_rate_rule_model.rollback.sql
--
-- Root cause (WORK-172 design record, Linear comments e3f01997 / 8516344a /
-- c0f76c81 / 4f129331):
--   * Retain $ used a code constant RETAIN_OVERTIME_HOURLY_RATE = 101.0225 —
--     one member's payslip figure (404.09 / 4) applied to every user, rank and
--     date. FRV overtime is classification-dependent.
--   * fat.retain.retain_rate_used numeric(8,2) truncated it to 101.02, so the
--     row could not reproduce its own amount (4 × 101.02 ≠ 404.09).
--   * fat.rate_versions had no classification context, no provenance, a
--     4-dp value column and no dollars_per_hour / multiplier units; nothing
--     enforced append-only; claim_entitlements overrides had no audit trail.
--
-- Model (portable PostgreSQL core — see docs/architecture/RATE_RULE_MODEL.md):
--   overtime single-time hourly base
--     = round_half_up(enterprise_base_pay_weekly[classification] × overtime_rate_factor
--                      ÷ overtime_hourly_divisor, 2)
--   line amount = round_half_up(hours × base × multiplier, 2)
--   Evidence classes: enterprise Base Pay = FWC order (PR765587 Annexure A);
--   90.93 % factor and ×2 = industrial instrument (FRV EBA 2020);
--   ÷36 = payroll-reconciled operator decision D-172-1 (NOT stated in the EBA).
--   Accepted reconciliation tolerance: 4 h retain = $404.08 vs payslip $404.09.
--
-- Data safety: no stored historical amount is rewritten. Column changes are
-- widenings (numeric(12,4) → numeric, numeric(8,2) → numeric). The one
-- non-authoritative workbook version (travel_per_km $1.20) is WITHDRAWN, not
-- deleted — it remains as history and any snapshot referencing it is intact.
--
-- Supabase-specific seams (replace at the GOV-481 Neon cutover): RLS policies,
-- auth.uid() inside fat.current_actor(), and role grants to
-- authenticated/service_role. Everything else is portable PostgreSQL.
--
-- Scope boundary: fat schema only. Not touched: user_rates (retired as primary
-- in app code; table + data kept until the C7/Neon cutover), prototype claim
-- tables other than the retain_rate_used widening, any other app's objects.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0. Closed classification set (FRV EBA 2020 Division A ranks, as listed in
--    PR765587 Annexure A). A domain keeps both users of it identical.
create domain fat.frv_classification as text
  check (value in (
    'recruit','ff1','ff2','ff3','qff','sff','lff','slff','so','sso',
    'cmdr_commencement','cmdr_12m','cmdr_24m','fscc','sfscc'
  ));
comment on domain fat.frv_classification is
  'WORK-172: FRV Division A classification (rank) codes keyed by rate_versions and member_classifications.';

-- 1. fat.rates — units and semantic description.
alter table fat.rates drop constraint rates_unit_check;
alter table fat.rates add constraint rates_unit_check check (unit in (
  'dollars','dollars_per_km','hours','dollars_per_hour','dollars_per_week','multiplier'
));
alter table fat.rates add column description text;

-- 2. fat.rate_versions — full precision, classification context, provenance,
--    withdrawal (instead of deletion).
alter table fat.rate_versions alter column value type numeric;
alter table fat.rate_versions
  add column classification   fat.frv_classification,
  add column source_kind      text,
  add column source_ref       text,
  add column withdrawn_at     timestamptz,
  add column withdrawn_reason text;

-- Provenance backfill for the five canonical-04 rows (metadata only; values
-- unchanged).
update fat.rate_versions rv
set source_kind = 'workbook',
    source_ref  = 'FRV Allowances workbook via defaultRates.js / canonical 04 seed. Personal workbook value, NOT industrial-entitlement authority (operator decision, WORK-172 PROMPT #10). Meal-entitlement mapping to industrial codes: WORK-173.'
from fat.rates r
where r.id = rv.rate_id and r.code in ('small_meal','large_meal','travel_per_km')
  and rv.version_label = 'initial-2025-06';

update fat.rate_versions rv
set source_kind = 'industrial_instrument',
    source_ref  = 'FRV EBA 2020 Div A cl 85.8.4(b) (Standby & Dismiss 0.5 h overtime allowance) / cl 85.8.1 (Muster & Dismiss 1.0 h); rule confirmed by WORK-170.'
from fat.rates r
where r.id = rv.rate_id and r.code in ('standby_hours','md_hours')
  and rv.version_label = 'initial-2025-06';

alter table fat.rate_versions alter column source_kind set not null;
alter table fat.rate_versions alter column source_ref  set not null;
alter table fat.rate_versions add constraint rate_versions_source_kind_check
  check (source_kind in ('industrial_instrument','fwc_order','payroll_reconciled','workbook'));
alter table fat.rate_versions add constraint rate_versions_withdrawn_pair_check
  check ((withdrawn_at is null) = (withdrawn_reason is null));

-- Effective-date uniqueness now includes classification and ignores withdrawn
-- history: one live version per (rate, classification, effective_from).
alter table fat.rate_versions drop constraint rate_versions_rate_id_effective_from_key;
create unique index rate_versions_effective_key
  on fat.rate_versions (rate_id, coalesce(classification::text, ''), effective_from)
  where withdrawn_at is null;

comment on column fat.rate_versions.classification is
  'NULL = applies to every classification. Lookup prefers an exact classification match, else NULL.';
comment on column fat.rate_versions.source_kind is
  'industrial_instrument (EBA) | fwc_order (e.g. PR765587) | payroll_reconciled (operator-accepted payroll behaviour) | workbook (non-authoritative).';
comment on column fat.rate_versions.withdrawn_at is
  'Set once to retire a version from lookup without deleting it. Snapshots that referenced it are unaffected.';

-- 3. Withdraw the workbook km rate ($1.20 is a tax/workbook figure, not the
--    industrial Motor Vehicle / Mileage Allowance).
update fat.rate_versions rv
set withdrawn_at = now(),
    withdrawn_reason = 'Workbook/tax value, not industrial entitlement authority. Superseded by PR765587 Div A Motor Vehicle / Mileage Allowance history (WORK-172).'
from fat.rates r
where r.id = rv.rate_id and r.code = 'travel_per_km' and rv.version_label = 'initial-2025-06';

-- 4. Seed new rate/rule identities and their authoritative versions.
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

-- 5. Append-only enforcement on rate_versions. Only a one-way withdrawal is
--    permitted; values, dates, classification and provenance are immutable.
create function fat.rate_versions_append_only()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'fat.rate_versions is append-only: withdraw a version instead of deleting it'
      using errcode = '42501';
  end if;
  if new.rate_id        is distinct from old.rate_id
     or new.version_label  is distinct from old.version_label
     or new.value          is distinct from old.value
     or new.effective_from is distinct from old.effective_from
     or new.classification is distinct from old.classification
     or new.source_kind    is distinct from old.source_kind
     or new.source_ref     is distinct from old.source_ref
     or new.created_at     is distinct from old.created_at
     or new.created_by     is distinct from old.created_by then
    raise exception 'fat.rate_versions is append-only: insert a new version instead of updating one'
      using errcode = '42501';
  end if;
  if old.withdrawn_at is not null
     and (new.withdrawn_at is distinct from old.withdrawn_at
          or new.withdrawn_reason is distinct from old.withdrawn_reason) then
    raise exception 'fat.rate_versions: a withdrawal is final'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke all on function fat.rate_versions_append_only() from public, anon, authenticated;

create trigger rate_versions_append_only
  before update or delete on fat.rate_versions
  for each row execute function fat.rate_versions_append_only();

-- 6. Prototype retain snapshot column: widen so the applied rate is stored
--    exactly (temporary compatibility; retires with the prototype tables).
alter table fat.retain alter column retain_rate_used type numeric;

-- 7. Member classification history (effective-dated; supports promotion).
create table fat.member_classifications (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references fat.profiles(id) on delete cascade,
  classification  fat.frv_classification not null,
  effective_from  date not null,
  source_ref      text not null check (length(btrim(source_ref)) > 0),
  created_at      timestamptz not null default now(),
  unique (owner_id, effective_from)
);
comment on table fat.member_classifications is
  'WORK-172: a member''s FRV classification history. The row with the latest effective_from <= claim date applies. No row → overtime $ estimates fail closed.';
alter table fat.member_classifications enable row level security;
create policy users_read_own   on fat.member_classifications for select using (auth.uid() = owner_id);
create policy users_insert_own on fat.member_classifications for insert with check (auth.uid() = owner_id);
create policy users_delete_own on fat.member_classifications for delete using (auth.uid() = owner_id);
grant select, insert, delete on fat.member_classifications to authenticated;
grant select, insert, update, delete on fat.member_classifications to service_role;

-- 8. Audited per-claim override on canonical entitlements.
create function fat.current_actor()
returns uuid
language sql
stable
set search_path = ''
as $function$ select auth.uid() $function$;
comment on function fat.current_actor() is
  'WORK-172 identity seam: the acting user for audit rows. Supabase: auth.uid(). Replace with the server-session identity at the Neon cutover (GOV-481).';
revoke all on function fat.current_actor() from public, anon;
grant execute on function fat.current_actor() to authenticated, service_role;

alter table fat.claim_entitlements add column edited_source text;
comment on column fat.claim_entitlements.edited_source is
  'Provenance of a manual override (e.g. payslip ref). Copied into fat.entitlement_overrides.';

create table fat.entitlement_overrides (
  id               uuid primary key default gen_random_uuid(),
  entitlement_id   uuid not null references fat.claim_entitlements(id) on delete cascade,
  owner_id         uuid not null references fat.profiles(id) on delete cascade,
  field            text not null check (field in ('edited_hours','edited_amount')),
  generated_value  numeric,
  previous_value   numeric,
  new_value        numeric,
  reason           text not null check (length(btrim(reason)) > 0),
  source_ref       text,
  actor_id         uuid,
  created_at       timestamptz not null default now()
);
create index idx_entitlement_overrides_entitlement on fat.entitlement_overrides (entitlement_id, created_at);
comment on table fat.entitlement_overrides is
  'WORK-172: append-only audit of manual overrides to fat.claim_entitlements (who/what/why/source/when). Written only by the claim_entitlements_override_audit trigger. Overrides never touch fat.rates/rate_versions.';
alter table fat.entitlement_overrides enable row level security;
create policy users_read_own on fat.entitlement_overrides for select using (auth.uid() = owner_id);
grant select on fat.entitlement_overrides to authenticated;
grant select on fat.entitlement_overrides to service_role;

create function fat.claim_entitlements_override_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  -- Generation fields are a static accounting record: never rewritten.
  if new.generated_amount   is distinct from old.generated_amount
     or new.generated_hours is distinct from old.generated_hours
     or new.rule_id         is distinct from old.rule_id
     or new.rule_version    is distinct from old.rule_version
     or new.rate_id         is distinct from old.rate_id
     or new.rate_version_id is distinct from old.rate_version_id
     or new.rate_snapshot   is distinct from old.rate_snapshot
     or new.generated_at    is distinct from old.generated_at then
    raise exception 'claim_entitlements: generated values and rate/rule snapshot are immutable; use edited_hours / edited_amount with a reason'
      using errcode = '42501';
  end if;

  if new.edited_hours is distinct from old.edited_hours
     or new.edited_amount is distinct from old.edited_amount then
    if new.edited_note is null or length(btrim(new.edited_note)) = 0 then
      raise exception 'claim_entitlements: a manual override requires a reason in edited_note'
        using errcode = '23514';
    end if;
    if new.edited_hours is distinct from old.edited_hours then
      insert into fat.entitlement_overrides
        (entitlement_id, owner_id, field, generated_value, previous_value, new_value, reason, source_ref, actor_id)
      values
        (new.id, new.owner_id, 'edited_hours', new.generated_hours, old.edited_hours, new.edited_hours,
         new.edited_note, new.edited_source, fat.current_actor());
    end if;
    if new.edited_amount is distinct from old.edited_amount then
      insert into fat.entitlement_overrides
        (entitlement_id, owner_id, field, generated_value, previous_value, new_value, reason, source_ref, actor_id)
      values
        (new.id, new.owner_id, 'edited_amount', new.generated_amount, old.edited_amount, new.edited_amount,
         new.edited_note, new.edited_source, fat.current_actor());
    end if;
  end if;

  new.manual_override := (new.edited_hours is not null or new.edited_amount is not null);
  return new;
end;
$function$;
revoke all on function fat.claim_entitlements_override_audit() from public, anon, authenticated;

create trigger claim_entitlements_override_audit
  before update on fat.claim_entitlements
  for each row execute function fat.claim_entitlements_override_audit();

-- 9. Privileges: rate reference data is read-only to end users.
revoke insert, update, delete, truncate, references, trigger on fat.rates         from authenticated;
revoke insert, update, delete, truncate, references, trigger on fat.rate_versions from authenticated;
revoke all on fat.member_classifications, fat.entitlement_overrides from anon;

-- 10. Postconditions. Any failure raises and rolls the whole migration back.
do $assert$
declare
  n int;
  lff numeric;
begin
  -- Seeds present and exact.
  select rv.value into lff from fat.rate_versions rv join fat.rates r on r.id = rv.rate_id
   where r.code = 'enterprise_base_pay_weekly' and rv.classification = 'lff' and rv.withdrawn_at is null;
  if lff is distinct from 1999.60 then raise exception 'WORK-172 postcondition: LFF base pay % <> 1999.60', lff; end if;

  select count(*) into n from fat.rate_versions where source_kind is null or source_ref is null;
  if n > 0 then raise exception 'WORK-172 postcondition: % rate_versions without provenance', n; end if;

  -- Reference reconciliation: LFF 4 h double time = 404.08 (accepted ±0.01 vs payslip 404.09).
  if round(round(1999.60 * 0.9093 / 36, 2) * 2 * 4, 2) <> 404.08 then
    raise exception 'WORK-172 postcondition: reconciliation arithmetic changed';
  end if;

  -- Only one live travel_per_km version per effective date, workbook value withdrawn.
  select count(*) into n from fat.rate_versions rv join fat.rates r on r.id = rv.rate_id
   where r.code = 'travel_per_km' and rv.withdrawn_at is null and rv.value = 1.20;
  if n <> 0 then raise exception 'WORK-172 postcondition: workbook km version still live'; end if;

  -- authenticated cannot write rate reference data; anon has nothing on new tables.
  if has_table_privilege('authenticated', 'fat.rates', 'INSERT')
     or has_table_privilege('authenticated', 'fat.rate_versions', 'UPDATE')
     or has_table_privilege('authenticated', 'fat.entitlement_overrides', 'INSERT')
     or has_table_privilege('anon', 'fat.member_classifications', 'SELECT')
     or has_table_privilege('anon', 'fat.entitlement_overrides', 'SELECT') then
    raise exception 'WORK-172 postcondition: unexpected table privilege';
  end if;

  -- No PUBLIC/anon EXECUTE on the new functions.
  if has_function_privilege('anon', 'fat.current_actor()', 'EXECUTE')
     or has_function_privilege('anon', 'fat.claim_entitlements_override_audit()', 'EXECUTE')
     or has_function_privilege('authenticated', 'fat.claim_entitlements_override_audit()', 'EXECUTE')
     or has_function_privilege('anon', 'fat.rate_versions_append_only()', 'EXECUTE') then
    raise exception 'WORK-172 postcondition: unexpected function EXECUTE';
  end if;

  -- fat default ACLs still grant nothing to PUBLIC/anon (WORK-166 invariant).
  select count(*) into n
  from pg_default_acl d, lateral aclexplode(d.defaclacl) a
  where d.defaclnamespace = 'fat'::regnamespace
    and (a.grantee = 0 or a.grantee = 'anon'::regrole::oid);
  if n > 0 then raise exception 'WORK-172 postcondition: fat default ACL grants PUBLIC/anon'; end if;

  -- RLS on the new tables.
  if not (select relrowsecurity from pg_class where oid = 'fat.member_classifications'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'fat.entitlement_overrides'::regclass) then
    raise exception 'WORK-172 postcondition: RLS not enabled';
  end if;
end;
$assert$;
