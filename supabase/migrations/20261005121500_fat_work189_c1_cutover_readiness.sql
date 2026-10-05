-- ─── C1 canonical schema/contract readiness for cutover (WORK-189, G09/G10) ──
-- Owner: fat. Rollback: supabase/rollbacks/20261005121500_fat_work189_c1_cutover_readiness.rollback.sql
--
-- Plan authority: docs/architecture/CUTOVER_PLAN.md § C1 and its parity gate.
-- Design record: Linear WORK-189 "Investigation Record — C1 schema-gap and
-- design (2026-10-05, PROMPT #17)"; contract: docs/architecture/C1_CUTOVER_CONTRACT.md.
--
-- What this adds — REPRESENTATION ONLY. It moves no data, generates nothing and
-- maps no payment state (C2 = transform + parity report, WORK-190; C3 = payment
-- mapping, WORK-191). Every column added is nullable; no existing row changes.
--   1. fat.migration_batches        deterministic batch identity (batch_key).
--   2. fat.financial_years          July–June CHECK; UNIQUE (id, user_id).
--   3. fat.operational_claims       claim_number + financial_year_id (owner-bound
--                                   FK), batch tag, prototype lineage; claim-number
--                                   uniqueness in its established scope.
--   4. fat.claim_entitlements       batch tag + prototype lineage per component;
--                                   owner bound to the parent claim.
--   5. fat.payment_records          batch tag + idempotent migration_source_key;
--                                   source value 'prototype_migration'.
--   6. fat.migration_source_rows    exactly-once ledger of consumed prototype rows,
--                                   incl. named exclusions (fake $0 Recall Excess
--                                   Travel) preserved as provenance.
--   7. fat.guard_migration_provenance  API roles cannot write provenance; set-once.
--
-- Claim-number scope (evidence 2026-10-05): fat.claim_sequences is unique on
-- (user_id, financial_year_id, claim_type) with claim_type = the app claim type
-- recalls|retain|standby|md|spoilt|delayed_meal, which maps 1:1 onto canonical
-- RC|RT|SB|MD|SM|DM. Canonical scope is therefore
-- (owner_id, financial_year_id, claim_type, claim_number).
--
-- FY: fat.financial_years is kept as the canonical FY entity (PROJECTED_MODEL
-- "claim numbering; financial years"). The prototype assigns the ACTIVE FY at
-- save time, so FY is stored explicitly, never derived from claim_date. Every
-- existing row (DEV 2, PROD 2) is 1 Jul → 30 Jun and the app only writes that
-- shape (lib/fy getFYDateRange); the CHECK makes it mechanical.
--
-- Adopted, not duplicated: operational_claims.prototype_claim_group_id and
-- prototype_source (+ uq_operational_claims_prototype_group) were applied in
-- both projects by the abandoned dual-write branch (DEV ledger 20260602091409
-- canonical_04_dual_write_provenance; PROD fat_parity_20) with no repository
-- file and no app reader/writer; every value is NULL. They are adopted here with
-- IF NOT EXISTS (no-op where present) and re-documented as transform lineage.
-- The rest of that ledger drift stays with WORK-180 (G18).
--
-- Not touched: WORK-173 generator-input columns, WORK-172 rate/rule objects and
-- override audit (manual adjustments are already representable: insert, then
-- UPDATE edited_* + edited_note + edited_source → fat.entitlement_overrides),
-- fat.create_payment_record (users still cannot mint migrated records), prototype
-- claim tables, any other app's objects.
--
-- Supabase-specific seam (GOV-481 Neon): the guard compares current_user with
-- the API role names anon/authenticated (inert on Neon, where the server-side
-- session is the authority), plus the RLS deny policies. Everything else is
-- portable PostgreSQL.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Migration batches.
create table fat.migration_batches (
  id               uuid primary key default gen_random_uuid(),
  batch_key        text not null unique check (length(btrim(batch_key)) > 0),
  step             text not null check (step in ('C2','C3')),
  environment      text not null check (environment in ('dev','prod')),
  tool             text not null check (length(btrim(tool)) > 0),
  tool_version     text not null check (length(btrim(tool_version)) > 0),
  source_checksum  text,
  status           text not null default 'running'
                     check (status in ('running','completed','failed','rolled_back')),
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  report           jsonb,
  notes            text,
  check (status = 'running' or completed_at is not null)
);
comment on table fat.migration_batches is
  'WORK-189 (C1): one row per C2 transform / C3 payment-mapping run. batch_key is the deterministic, caller-chosen identity (e.g. step + environment + source checksum + tool version), so a rerun resolves to the same batch. report holds the machine-readable parity report written by C2/C3. Service-role only.';

-- 2. Financial years: July–June, and an owner-bound key for composite FKs.
alter table fat.financial_years
  add constraint financial_years_july_june check (
    extract(month from start_date) = 7
    and extract(day from start_date) = 1
    and end_date = (start_date + interval '1 year' - interval '1 day')::date),
  add constraint financial_years_id_user_id_key unique (id, user_id);
comment on constraint financial_years_july_june on fat.financial_years is
  'WORK-189 (C1): an FY is exactly 1 July → 30 June (D9f).';

-- 3. Operational claims.
alter table fat.operational_claims
  add column if not exists prototype_claim_group_id uuid,
  add column if not exists prototype_source         text;

alter table fat.operational_claims
  add column claim_number        integer,
  add column financial_year_id   uuid,
  add column migration_batch_id  uuid references fat.migration_batches(id),
  add column prototype_row_id    uuid,
  add constraint operational_claims_claim_number_positive
    check (claim_number is null or claim_number > 0),
  add constraint operational_claims_claim_number_needs_fy
    check (claim_number is null or financial_year_id is not null),
  add constraint operational_claims_prototype_source_check
    check (prototype_source is null or prototype_source in ('recalls','retain','standby','spoilt_meals')),
  add constraint operational_claims_prototype_row_pair
    check ((prototype_source is null) = (prototype_row_id is null)),
  add constraint operational_claims_prototype_needs_batch
    check (migration_batch_id is not null
           or (prototype_claim_group_id is null and prototype_row_id is null)),
  add constraint operational_claims_id_owner_key unique (id, owner_id),
  add constraint operational_claims_financial_year_owner_fkey
    foreign key (financial_year_id, owner_id) references fat.financial_years (id, user_id);

create unique index uq_operational_claims_claim_number
  on fat.operational_claims (owner_id, financial_year_id, claim_type, claim_number)
  where claim_number is not null;
create unique index uq_operational_claims_prototype_row
  on fat.operational_claims (prototype_source, prototype_row_id)
  where prototype_row_id is not null;
create unique index if not exists uq_operational_claims_prototype_group
  on fat.operational_claims (prototype_claim_group_id)
  where prototype_claim_group_id is not null;
create index idx_operational_claims_financial_year
  on fat.operational_claims (financial_year_id) where financial_year_id is not null;
create index idx_operational_claims_migration_batch
  on fat.operational_claims (migration_batch_id) where migration_batch_id is not null;

comment on column fat.operational_claims.claim_number is
  'WORK-189 (C1): user-visible claim number. Unique per (owner_id, financial_year_id, claim_type) — the fat.claim_sequences scope. Set-once.';
comment on column fat.operational_claims.financial_year_id is
  'WORK-189 (C1): the July–June FY workspace the claim belongs to (fat.financial_years, same owner). Stored, never derived from claim_date. Set-once.';
comment on column fat.operational_claims.migration_batch_id is
  'WORK-189 (C1): the C2 batch that created this row; NULL for natively created claims. Rollback before C6 deletes only batch-tagged rows.';
comment on column fat.operational_claims.prototype_claim_group_id is
  'WORK-189 (C1, adopted from the abandoned dual-write branch): the prototype fat.claim_groups.id this canonical claim was transformed from. Unique. Set-once; not writable by API roles.';
comment on column fat.operational_claims.prototype_source is
  'WORK-189 (C1, adopted): the prototype table holding the parent row (recalls | retain | standby | spoilt_meals). Set-once; not writable by API roles.';
comment on column fat.operational_claims.prototype_row_id is
  'WORK-189 (C1): the prototype parent row id. (prototype_source, prototype_row_id) is the batch-independent transform identity. Set-once; not writable by API roles.';

-- 4. Claim entitlements.
alter table fat.claim_entitlements
  add column migration_batch_id   uuid references fat.migration_batches(id),
  add column prototype_source     text,
  add column prototype_row_id     uuid,
  add column prototype_component  text,
  add constraint claim_entitlements_prototype_source_check
    check (prototype_source is null or prototype_source in ('recalls','retain','standby','spoilt_meals')),
  add constraint claim_entitlements_prototype_lineage_complete
    check ((prototype_source is null) = (prototype_row_id is null)
           and (prototype_row_id is null) = (prototype_component is null)),
  add constraint claim_entitlements_prototype_component_nonblank
    check (prototype_component is null or length(btrim(prototype_component)) > 0),
  add constraint claim_entitlements_prototype_needs_batch
    check (prototype_row_id is null or migration_batch_id is not null),
  add constraint claim_entitlements_claim_owner_fkey
    foreign key (claim_id, owner_id) references fat.operational_claims (id, owner_id) on delete cascade;

create unique index uq_claim_entitlements_prototype_component
  on fat.claim_entitlements (prototype_source, prototype_row_id, prototype_component)
  where prototype_row_id is not null;
create index idx_claim_entitlements_migration_batch
  on fat.claim_entitlements (migration_batch_id) where migration_batch_id is not null;

comment on column fat.claim_entitlements.prototype_component is
  'WORK-189 (C1): which stored amount of the prototype row this entitlement carries (e.g. total_amount, travel_amount, night_mealie, meal_amount). (prototype_source, prototype_row_id, prototype_component) is the batch-independent identity. Set-once; not writable by API roles.';
comment on column fat.claim_entitlements.migration_batch_id is
  'WORK-189 (C1): the C2 batch that created this entitlement; NULL for engine-generated entitlements.';

-- 5. Payment records.
alter table fat.payment_records
  add column migration_batch_id    uuid references fat.migration_batches(id),
  add column migration_source_key  text,
  drop constraint payment_records_source_check,
  add constraint payment_records_source_check
    check (source = any (array['manual','payslip_screenshot','payslip_pdf','petty_cash_export','prototype_migration'])),
  add constraint payment_records_migration_pair
    check ((migration_batch_id is null) = (migration_source_key is null)),
  add constraint payment_records_migration_source
    check ((coalesce(source, '') = 'prototype_migration') = (migration_batch_id is not null));

create unique index uq_payment_records_migration_source_key
  on fat.payment_records (migration_source_key) where migration_source_key is not null;
create index idx_payment_records_migration_batch
  on fat.payment_records (migration_batch_id) where migration_batch_id is not null;

comment on column fat.payment_records.migration_source_key is
  'WORK-189 (C1): deterministic key chosen by C3 for a payment record mapped from prototype payment state; unique, so reruns never duplicate. Set-once; not writable by API roles.';

-- 6. Source-row ledger.
create table fat.migration_source_rows (
  id                     uuid primary key default gen_random_uuid(),
  batch_id               uuid not null references fat.migration_batches(id) on delete cascade,
  owner_id               uuid not null references fat.profiles(id) on delete cascade,
  source_table           text not null
                           check (source_table in ('claim_groups','recalls','retain','standby','spoilt_meals')),
  source_row_id          uuid not null,
  source_claim_group_id  uuid,
  source_claim_type      text,
  source_checksum        text not null check (length(btrim(source_checksum)) > 0),
  source_snapshot        jsonb,
  disposition            text not null check (disposition in ('claim','entitlement','excluded')),
  target_claim_id        uuid,
  exclusion_code         text,
  exclusion_reason       text,
  created_at             timestamptz not null default now(),
  unique (source_table, source_row_id),
  check ((disposition = 'excluded') = (exclusion_code is not null)),
  check (disposition = 'excluded' or target_claim_id is not null),
  check (disposition <> 'excluded' or source_snapshot is not null),
  foreign key (target_claim_id, owner_id)
    references fat.operational_claims (id, owner_id) on delete cascade
);
create index idx_migration_source_rows_batch  on fat.migration_source_rows (batch_id);
create index idx_migration_source_rows_target on fat.migration_source_rows (target_claim_id)
  where target_claim_id is not null;
comment on table fat.migration_source_rows is
  'WORK-189 (C1): exactly-once ledger of every prototype row a C2 batch consumed. disposition claim = parent/group became target_claim_id; entitlement = its stored amounts became entitlements on target_claim_id; excluded = a named approved exclusion (exclusion_code, e.g. G12 fake $0 Recall Excess Travel) preserved with its source_snapshot and never a payable entitlement. source_checksum supports parity gate 8. Service-role only.';

-- 7. Provenance guard. Arguments name the guarded columns:
--      plain name  → provenance: API roles may never set or change it; set-once.
--      once:<name> → set-once for everyone (NULL → value allowed, value never changes).
create function fat.guard_migration_provenance()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  api   boolean := current_user in ('anon', 'authenticated');
  n     jsonb   := to_jsonb(new);
  o     jsonb   := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  arg   text;
  col   text;
  prov  boolean;
begin
  foreach arg in array tg_argv loop
    prov := arg not like 'once:%';
    col  := case when prov then arg else substr(arg, 6) end;
    if tg_op = 'INSERT' then
      if prov and api and n->>col is not null then
        raise exception '%.%: migration provenance is not writable by %', tg_table_name, col, current_user
          using errcode = '42501';
      end if;
    elsif (o->>col) is distinct from (n->>col) then
      if prov and api then
        raise exception '%.%: migration provenance is not writable by %', tg_table_name, col, current_user
          using errcode = '42501';
      end if;
      if o->>col is not null then
        raise exception '%.%: value is set-once and cannot change', tg_table_name, col
          using errcode = '42501';
      end if;
    end if;
  end loop;

  if tg_table_name = 'payment_records' and api
     and (n->>'source' = 'prototype_migration' or o->>'source' = 'prototype_migration')
     and (tg_op = 'INSERT' or (o->>'source') is distinct from (n->>'source')) then
    raise exception 'payment_records.source prototype_migration is reserved for the C3 migration'
      using errcode = '42501';
  end if;
  return new;
end;
$function$;
comment on function fat.guard_migration_provenance() is
  'WORK-189 (C1): blocks API roles (anon/authenticated) from writing migration provenance and makes provenance, claim_number and financial_year_id set-once. Supabase seam (GOV-481): replace the API-role test with server-session authority on Neon.';
revoke all on function fat.guard_migration_provenance() from public, anon, authenticated;

create trigger guard_migration_provenance
  before insert or update on fat.operational_claims
  for each row execute function fat.guard_migration_provenance(
    'migration_batch_id', 'prototype_claim_group_id', 'prototype_source', 'prototype_row_id',
    'once:claim_number', 'once:financial_year_id');
create trigger guard_migration_provenance
  before insert or update on fat.claim_entitlements
  for each row execute function fat.guard_migration_provenance(
    'migration_batch_id', 'prototype_source', 'prototype_row_id', 'prototype_component');
create trigger guard_migration_provenance
  before insert or update on fat.payment_records
  for each row execute function fat.guard_migration_provenance(
    'migration_batch_id', 'migration_source_key');

-- 8. Privileges: the new tables are service-role only; nothing widens.
alter table fat.migration_batches     enable row level security;
alter table fat.migration_source_rows enable row level security;
create policy no_api_access on fat.migration_batches
  for all to anon, authenticated using (false) with check (false);
create policy no_api_access on fat.migration_source_rows
  for all to anon, authenticated using (false) with check (false);
revoke all on fat.migration_batches, fat.migration_source_rows from public, anon, authenticated;
grant select, insert, update, delete on fat.migration_batches, fat.migration_source_rows to service_role;

-- 9. Postconditions. Any failure raises and rolls the whole migration back.
do $assert$
declare
  n int;
begin
  -- Nothing existing was tagged or rewritten by this migration.
  select count(*) into n from fat.operational_claims
   where claim_number is not null or financial_year_id is not null or migration_batch_id is not null
      or prototype_row_id is not null or prototype_claim_group_id is not null or prototype_source is not null;
  if n > 0 then raise exception 'WORK-189 postcondition: % operational_claims carry migration metadata', n; end if;
  select count(*) into n from fat.claim_entitlements where migration_batch_id is not null or prototype_row_id is not null;
  if n > 0 then raise exception 'WORK-189 postcondition: % claim_entitlements carry migration metadata', n; end if;

  -- WORK-173 generator inputs intact.
  select count(*) into n from pg_attribute
   where not attisdropped and (attrelid, attname) in (
     ('fat.recall_details'::regclass, 'recall_duty'), ('fat.recall_details'::regclass, 'recall_travel_minutes'),
     ('fat.recall_details'::regclass, 'recall_travel_sunday_or_ph'),
     ('fat.retain_details'::regclass, 'retain_shift'), ('fat.retain_details'::regclass, 'night_shift_interrupted'),
     ('fat.retain_details'::regclass, 'retain_travel_home_minutes'),
     ('fat.spoilt_meal_details'::regclass, 'meal_interrupted_at'), ('fat.spoilt_meal_details'::regclass, 'emergency_response'),
     ('fat.spoilt_meal_details'::regclass, 'emergency_call_ref'),
     ('fat.delayed_meal_details'::regclass, 'delay_notice_2h'), ('fat.delayed_meal_details'::regclass, 'delay_cause'),
     ('fat.delayed_meal_details'::regclass, 'duty_start_at'), ('fat.delayed_meal_details'::regclass, 'duty_end_at'));
  if n <> 13 then raise exception 'WORK-189 postcondition: WORK-173 columns % / 13', n; end if;

  -- Adopted lineage columns have the expected types.
  if (select atttypid from pg_attribute where attrelid = 'fat.operational_claims'::regclass
        and attname = 'prototype_claim_group_id' and not attisdropped) is distinct from 'uuid'::regtype
     or (select atttypid from pg_attribute where attrelid = 'fat.operational_claims'::regclass
        and attname = 'prototype_source' and not attisdropped) is distinct from 'text'::regtype then
    raise exception 'WORK-189 postcondition: adopted prototype lineage columns have unexpected types';
  end if;

  -- No API-role access to the new tables or function.
  if has_table_privilege('anon', 'fat.migration_batches', 'SELECT')
     or has_table_privilege('authenticated', 'fat.migration_batches', 'SELECT')
     or has_table_privilege('authenticated', 'fat.migration_batches', 'INSERT')
     or has_table_privilege('anon', 'fat.migration_source_rows', 'SELECT')
     or has_table_privilege('authenticated', 'fat.migration_source_rows', 'SELECT')
     or has_table_privilege('authenticated', 'fat.migration_source_rows', 'INSERT') then
    raise exception 'WORK-189 postcondition: unexpected table privilege on a migration table';
  end if;
  if has_function_privilege('anon', 'fat.guard_migration_provenance()', 'EXECUTE')
     or has_function_privilege('authenticated', 'fat.guard_migration_provenance()', 'EXECUTE') then
    raise exception 'WORK-189 postcondition: unexpected function EXECUTE';
  end if;

  -- fat default ACLs still grant nothing to PUBLIC/anon (WORK-166 invariant).
  select count(*) into n
  from pg_default_acl d, lateral aclexplode(d.defaclacl) a
  where d.defaclnamespace = 'fat'::regnamespace
    and (a.grantee = 0 or a.grantee = 'anon'::regrole::oid);
  if n > 0 then raise exception 'WORK-189 postcondition: fat default ACL grants PUBLIC/anon'; end if;

  -- RLS on the new tables and the tables this migration altered.
  select count(*) into n from pg_class
   where oid in ('fat.migration_batches'::regclass, 'fat.migration_source_rows'::regclass,
                 'fat.operational_claims'::regclass, 'fat.claim_entitlements'::regclass,
                 'fat.payment_records'::regclass, 'fat.financial_years'::regclass)
     and relrowsecurity;
  if n <> 6 then raise exception 'WORK-189 postcondition: RLS not enabled on % of 6 tables', 6 - n; end if;
end;
$assert$;
