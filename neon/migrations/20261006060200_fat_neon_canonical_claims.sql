-- FAT Neon backend — 3/6 canonical claims, entitlements and C1 provenance (WORK-254, N1)
-- Owner: fat. Rollback: neon/rollbacks/20261006060200_fat_neon_canonical_claims.rollback.sql
--
-- Consolidated end state of: canonical 01/02/03 (operational claim model),
-- 20261005060000 (entitlement override audit, WORK-172), 20261005100000
-- (generator inputs, WORK-173) and 20261005121500 (C1 cutover readiness,
-- WORK-189 — docs/architecture/C1_CUTOVER_CONTRACT.md).
--
-- Every constraint, unique identity and index name is the Supabase DEV name, so
-- the two catalogs can be compared mechanically.
--
-- Neon adaptations in this file (NEON_BACKEND.md §4):
--   * fat.guard_migration_provenance identifies API callers by membership of
--     fat_app (USAGE) instead of current_user in ('anon','authenticated');
--     owner and fat_service sessions are the migration path, as service_role was.
--   * fat.claim_entitlements_override_audit is unchanged; its actor comes from
--     fat.current_actor() → fat.current_app_user_id().
-- Lineage to the prototype source is by (source_table, source_row_id) values
-- only: the prototype tables stay in legacy Supabase and are not FK targets.

-- 1. Migration batches (C1 §3). Service-only.
create table fat.migration_batches (
  id               uuid not null default gen_random_uuid(),
  batch_key        text not null,
  step             text not null,
  environment      text not null,
  tool             text not null,
  tool_version     text not null,
  source_checksum  text,
  status           text not null default 'running'::text,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  report           jsonb,
  notes            text,
  constraint migration_batches_pkey primary key (id),
  constraint migration_batches_batch_key_key unique (batch_key),
  constraint migration_batches_batch_key_check check (length(btrim(batch_key)) > 0),
  constraint migration_batches_check check ((status = 'running'::text) or (completed_at is not null)),
  constraint migration_batches_environment_check check (environment = any (array['dev'::text, 'prod'::text])),
  constraint migration_batches_status_check check (status = any (array['running'::text, 'completed'::text, 'failed'::text, 'rolled_back'::text])),
  constraint migration_batches_step_check check (step = any (array['C2'::text, 'C3'::text])),
  constraint migration_batches_tool_check check (length(btrim(tool)) > 0),
  constraint migration_batches_tool_version_check check (length(btrim(tool_version)) > 0)
);

-- 2. Operational claims (one row per event) and type-specific facts.
create table fat.operational_claims (
  id                        uuid not null default gen_random_uuid(),
  owner_id                  uuid not null,
  claim_type                text not null,
  claim_date                date not null,
  station_id_snapshot       integer,
  station_name_snapshot     text,
  source_calculation_mode   text,
  status                    text not null default 'draft'::text,
  generated_at              timestamptz not null default now(),
  notes                     text,
  parent_claim_id           uuid,
  copy_source_owner_id      uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  prototype_claim_group_id  uuid,
  prototype_source          text,
  claim_number              integer,
  financial_year_id         uuid,
  migration_batch_id        uuid,
  prototype_row_id          uuid,
  constraint operational_claims_pkey primary key (id),
  constraint operational_claims_id_owner_key unique (id, owner_id),
  constraint operational_claims_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint operational_claims_station_id_snapshot_fkey foreign key (station_id_snapshot) references fat.stations(id),
  constraint operational_claims_financial_year_owner_fkey foreign key (financial_year_id, owner_id) references fat.financial_years(id, user_id),
  constraint operational_claims_migration_batch_id_fkey foreign key (migration_batch_id) references fat.migration_batches(id),
  constraint operational_claims_claim_number_needs_fy check ((claim_number is null) or (financial_year_id is not null)),
  constraint operational_claims_claim_number_positive check ((claim_number is null) or (claim_number > 0)),
  constraint operational_claims_claim_type_check check (claim_type = any (array['RC'::text, 'RT'::text, 'SB'::text, 'MD'::text, 'DM'::text, 'SM'::text])),
  constraint operational_claims_prototype_needs_batch check ((migration_batch_id is not null) or ((prototype_claim_group_id is null) and (prototype_row_id is null))),
  constraint operational_claims_prototype_row_pair check ((prototype_source is null) = (prototype_row_id is null)),
  constraint operational_claims_prototype_source_check check ((prototype_source is null) or (prototype_source = any (array['recalls'::text, 'retain'::text, 'standby'::text, 'spoilt_meals'::text]))),
  constraint operational_claims_source_calculation_mode_check check (source_calculation_mode = any (array['frv_matrix'::text, 'google_maps'::text, 'manual'::text])),
  constraint operational_claims_status_check check (status = any (array['draft'::text, 'submitted'::text, 'archived'::text]))
);
create index idx_operational_claims_financial_year on fat.operational_claims using btree (financial_year_id) where (financial_year_id is not null);
create index idx_operational_claims_migration_batch on fat.operational_claims using btree (migration_batch_id) where (migration_batch_id is not null);
create index idx_operational_claims_owner_date on fat.operational_claims using btree (owner_id, claim_date);
create index idx_operational_claims_parent on fat.operational_claims using btree (parent_claim_id) where (parent_claim_id is not null);
create index idx_operational_claims_type_date on fat.operational_claims using btree (claim_type, claim_date);
create unique index uq_operational_claims_claim_number on fat.operational_claims using btree (owner_id, financial_year_id, claim_type, claim_number) where (claim_number is not null);
create unique index uq_operational_claims_prototype_group on fat.operational_claims using btree (prototype_claim_group_id) where (prototype_claim_group_id is not null);
create unique index uq_operational_claims_prototype_row on fat.operational_claims using btree (prototype_source, prototype_row_id) where (prototype_row_id is not null);
create trigger set_updated_at before update on fat.operational_claims
  for each row execute function fat.set_updated_at();

create table fat.recall_details (
  claim_id                     uuid not null,
  recall_station_id            integer,
  recall_start_at              timestamptz,
  recall_end_at                timestamptz,
  travel_distance_km           numeric(8,2),
  travel_source                text,
  meal_break_taken             boolean,
  recall_duty                  text,
  recall_travel_minutes        numeric,
  recall_travel_sunday_or_ph   boolean,
  constraint recall_details_pkey primary key (claim_id),
  constraint recall_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint recall_details_recall_station_id_fkey foreign key (recall_station_id) references fat.stations(id),
  constraint recall_details_recall_duty_check check (recall_duty = any (array['day'::text, 'night'::text])),
  constraint recall_details_recall_travel_minutes_check check (recall_travel_minutes >= (0)::numeric),
  constraint recall_details_travel_source_check check (travel_source = any (array['google_maps'::text, 'manual'::text]))
);

create table fat.retain_details (
  claim_id                    uuid not null,
  retain_start_at             timestamptz,
  retain_end_at               timestamptz,
  meal_break_taken            boolean,
  retain_shift                text,
  night_shift_interrupted     boolean,
  retain_travel_home_minutes  numeric,
  constraint retain_details_pkey primary key (claim_id),
  constraint retain_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint retain_details_retain_shift_check check (retain_shift = any (array['day'::text, 'night'::text])),
  constraint retain_details_retain_travel_home_minutes_check check (retain_travel_home_minutes >= (0)::numeric)
);

create table fat.standby_details (
  claim_id             uuid not null,
  standby_station_id   integer,
  standby_start_at     timestamptz,
  standby_end_at       timestamptz,
  matrix_distance_km   numeric(8,2),
  matrix_hours         numeric(6,2),
  matrix_version       text,
  home_to_rostered_km  numeric(8,2),
  home_to_target_km    numeric(8,2),
  constraint standby_details_pkey primary key (claim_id),
  constraint standby_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint standby_details_standby_station_id_fkey foreign key (standby_station_id) references fat.stations(id)
);

create table fat.muster_dismiss_details (
  claim_id             uuid not null,
  md_station_id        integer,
  md_event_at          timestamptz,
  matrix_distance_km   numeric(8,2),
  matrix_hours         numeric(6,2),
  matrix_version       text,
  home_to_rostered_km  numeric(8,2),
  home_to_target_km    numeric(8,2),
  constraint muster_dismiss_details_pkey primary key (claim_id),
  constraint muster_dismiss_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint muster_dismiss_details_md_station_id_fkey foreign key (md_station_id) references fat.stations(id)
);

create table fat.spoilt_meal_details (
  claim_id              uuid not null,
  meal_provisioned_at   timestamptz,
  spoilt_reason         text,
  meal_interrupted_at   timestamptz,
  emergency_response    boolean,
  emergency_call_ref    text,
  constraint spoilt_meal_details_pkey primary key (claim_id),
  constraint spoilt_meal_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade
);

create table fat.delayed_meal_details (
  claim_id              uuid not null,
  meal_window_start_at  timestamptz,
  meal_window_end_at    timestamptz,
  actual_meal_at        timestamptz,
  delay_notice_2h       boolean,
  delay_cause           text,
  duty_start_at         timestamptz,
  duty_end_at           timestamptz,
  constraint delayed_meal_details_pkey primary key (claim_id),
  constraint delayed_meal_details_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint delayed_meal_details_delay_cause_check check (delay_cause = any (array['other'::text, 'fire_call'::text, 'salvage'::text, 'watching'::text]))
);

-- 3. Generated entitlements (hours-first) with immutable rate/rule snapshots.
create table fat.claim_entitlements (
  id                   uuid not null default gen_random_uuid(),
  claim_id             uuid not null,
  owner_id             uuid not null,
  entitlement_type     text not null,
  unit                 text not null,
  generated_amount     numeric(12,4),
  generated_hours      numeric(8,2),
  edited_amount        numeric(12,4),
  edited_hours         numeric(8,2),
  edited_note          text,
  manual_override      boolean not null default false,
  rule_id              text not null,
  rule_version         text not null,
  rule_explanation     text,
  formula_explanation  text,
  rate_id              uuid,
  rate_version_id      uuid,
  rate_snapshot        jsonb not null,
  payment_method       text,
  payment_status       text,
  generated_at         timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  edited_source        text,
  migration_batch_id   uuid,
  prototype_source     text,
  prototype_row_id     uuid,
  prototype_component  text,
  constraint claim_entitlements_pkey primary key (id),
  constraint claim_entitlements_claim_id_fkey foreign key (claim_id) references fat.operational_claims(id) on delete cascade,
  constraint claim_entitlements_claim_owner_fkey foreign key (claim_id, owner_id) references fat.operational_claims(id, owner_id) on delete cascade,
  constraint claim_entitlements_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint claim_entitlements_rate_id_fkey foreign key (rate_id) references fat.rates(id),
  constraint claim_entitlements_rate_version_id_fkey foreign key (rate_version_id) references fat.rate_versions(id),
  constraint claim_entitlements_migration_batch_id_fkey foreign key (migration_batch_id) references fat.migration_batches(id),
  constraint claim_entitlements_payment_method_check check (payment_method = any (array['payslip'::text, 'petty_cash'::text])),
  constraint claim_entitlements_payment_status_check check ((payment_status is null) or (payment_status = any (array['pending'::text, 'paid'::text, 'outstanding'::text, 'claimed'::text]))),
  constraint claim_entitlements_prototype_component_nonblank check ((prototype_component is null) or (length(btrim(prototype_component)) > 0)),
  constraint claim_entitlements_prototype_lineage_complete check (((prototype_source is null) = (prototype_row_id is null)) and ((prototype_row_id is null) = (prototype_component is null))),
  constraint claim_entitlements_prototype_needs_batch check ((prototype_row_id is null) or (migration_batch_id is not null)),
  constraint claim_entitlements_prototype_source_check check ((prototype_source is null) or (prototype_source = any (array['recalls'::text, 'retain'::text, 'standby'::text, 'spoilt_meals'::text]))),
  constraint claim_entitlements_unit_check check (unit = any (array['dollars'::text, 'hours'::text, 'km'::text]))
);
create index idx_claim_entitlements_claim on fat.claim_entitlements using btree (claim_id);
create index idx_claim_entitlements_migration_batch on fat.claim_entitlements using btree (migration_batch_id) where (migration_batch_id is not null);
create index idx_claim_entitlements_owner_paystatus on fat.claim_entitlements using btree (owner_id, payment_status);
create index idx_claim_entitlements_type_generated on fat.claim_entitlements using btree (entitlement_type, generated_at);
create unique index uq_claim_entitlements_prototype_component on fat.claim_entitlements using btree (prototype_source, prototype_row_id, prototype_component) where (prototype_row_id is not null);
create trigger set_updated_at before update on fat.claim_entitlements
  for each row execute function fat.set_updated_at();
comment on column fat.claim_entitlements.edited_source is
  'Provenance of a manual override (e.g. payslip ref). Copied into fat.entitlement_overrides.';

create table fat.entitlement_overrides (
  id               uuid not null default gen_random_uuid(),
  entitlement_id   uuid not null,
  owner_id         uuid not null,
  field            text not null,
  generated_value  numeric,
  previous_value   numeric,
  new_value        numeric,
  reason           text not null,
  source_ref       text,
  actor_id         uuid,
  created_at       timestamptz not null default now(),
  constraint entitlement_overrides_pkey primary key (id),
  constraint entitlement_overrides_entitlement_id_fkey foreign key (entitlement_id) references fat.claim_entitlements(id) on delete cascade,
  constraint entitlement_overrides_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint entitlement_overrides_field_check check (field = any (array['edited_hours'::text, 'edited_amount'::text])),
  constraint entitlement_overrides_reason_check check (length(btrim(reason)) > 0)
);
create index idx_entitlement_overrides_entitlement on fat.entitlement_overrides using btree (entitlement_id, created_at);
comment on table fat.entitlement_overrides is
  'WORK-172: append-only audit of manual overrides to fat.claim_entitlements (who/what/why/source/when). Written only by the claim_entitlements_override_audit trigger. Overrides never touch fat.rates/rate_versions.';

-- fat.claim_entitlements_override_audit: verbatim from supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql
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
revoke all on function fat.claim_entitlements_override_audit() from public;
create trigger claim_entitlements_override_audit
  before update on fat.claim_entitlements
  for each row execute function fat.claim_entitlements_override_audit();

-- 4. Source-row ledger (C1 §4). Service-only.
create table fat.migration_source_rows (
  id                     uuid not null default gen_random_uuid(),
  batch_id               uuid not null,
  owner_id               uuid not null,
  source_table           text not null,
  source_row_id          uuid not null,
  source_claim_group_id  uuid,
  source_claim_type      text,
  source_checksum        text not null,
  source_snapshot        jsonb,
  disposition            text not null,
  target_claim_id        uuid,
  exclusion_code         text,
  exclusion_reason       text,
  created_at             timestamptz not null default now(),
  constraint migration_source_rows_pkey primary key (id),
  constraint migration_source_rows_source_table_source_row_id_key unique (source_table, source_row_id),
  constraint migration_source_rows_batch_id_fkey foreign key (batch_id) references fat.migration_batches(id) on delete cascade,
  constraint migration_source_rows_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint migration_source_rows_target_claim_id_owner_id_fkey foreign key (target_claim_id, owner_id) references fat.operational_claims(id, owner_id) on delete cascade,
  constraint migration_source_rows_check check ((disposition = 'excluded'::text) = (exclusion_code is not null)),
  constraint migration_source_rows_check1 check ((disposition = 'excluded'::text) or (target_claim_id is not null)),
  constraint migration_source_rows_check2 check ((disposition <> 'excluded'::text) or (source_snapshot is not null)),
  constraint migration_source_rows_disposition_check check (disposition = any (array['claim'::text, 'entitlement'::text, 'excluded'::text])),
  constraint migration_source_rows_source_checksum_check check (length(btrim(source_checksum)) > 0),
  constraint migration_source_rows_source_table_check check (source_table = any (array['claim_groups'::text, 'recalls'::text, 'retain'::text, 'standby'::text, 'spoilt_meals'::text]))
);
create index idx_migration_source_rows_batch on fat.migration_source_rows using btree (batch_id);
create index idx_migration_source_rows_target on fat.migration_source_rows using btree (target_claim_id) where (target_claim_id is not null);

-- 5. Provenance guard (C1 §7), adapted: API callers are fat_app members.
-- fat.guard_migration_provenance: adapted from supabase/migrations/20261005121500_fat_work189_c1_cutover_readiness.sql
create function fat.guard_migration_provenance()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  api   boolean := pg_has_role(current_user, 'fat_app', 'USAGE');  -- Neon: fat_app members are API callers (Supabase: anon/authenticated)
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
revoke all on function fat.guard_migration_provenance() from public;
create trigger guard_migration_provenance
  before insert or update on fat.operational_claims
  for each row execute function fat.guard_migration_provenance('migration_batch_id', 'prototype_claim_group_id', 'prototype_source', 'prototype_row_id', 'once:claim_number', 'once:financial_year_id');
create trigger guard_migration_provenance
  before insert or update on fat.claim_entitlements
  for each row execute function fat.guard_migration_provenance('migration_batch_id', 'prototype_source', 'prototype_row_id', 'prototype_component');
-- (payment_records' guard trigger is created with the table in 4/6.)
