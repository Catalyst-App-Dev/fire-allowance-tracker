-- FAT Neon backend — 2/6 reference, member and rate/rule tables (WORK-254, N1)
-- Owner: fat. Rollback: neon/rollbacks/20261006060100_fat_neon_reference_and_identity_data.rollback.sql
--
-- Consolidated end state of: supabase/fat-schema.sql + fat-schema-travel.sql
-- (reference, member and per-user tables), canonical 01/05/06 (station
-- matrices), 19_user_feature_flags, migrations 20261004233500 (caller-bound
-- claim sequence, WORK-167) and 20261005060000 (versioned rate/rule model,
-- WORK-172), and 20261005121500 (July–June FY, owner-bound FY key, WORK-189).
--
-- Neon adaptations in this file (NEON_BACKEND.md §4):
--   * every former `references auth.users(id)` now references fat.app_identities(id)
--     with the same ON DELETE action — owner UUIDs are unchanged;
--   * fat.increment_claim_sequence checks fat.current_app_user_id() instead of auth.uid();
--   * fat.handle_new_user (an auth.users trigger) is replaced by the server-called
--     fat.ensure_app_identity();
--   * fat.user_rates is deliberately not created (retired as a rate source by WORK-172;
--     it stays in legacy Supabase until retirement).

-- 1. Stations and station reference matrices (shared, read-only to fat_app).
create table fat.stations (
  id             integer not null,
  name           text not null,
  abbreviation   text,
  region         text,
  is_active      boolean not null default true,
  created_at     timestamptz default now(),
  updated_at     timestamptz default now(),
  district       text,
  street_address text,
  suburb         text,
  postcode       text,
  lat            numeric(9,6),
  lng            numeric(9,6),
  constraint stations_pkey primary key (id)
);
create trigger set_updated_at before update on fat.stations
  for each row execute function fat.set_updated_at();

create table fat.station_aliases (
  id          uuid not null default gen_random_uuid(),
  alias       text not null,
  alias_norm  text not null,
  station_id  integer not null,
  source      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint station_aliases_pkey primary key (id),
  constraint station_aliases_alias_norm_key unique (alias_norm),
  constraint station_aliases_station_id_fkey foreign key (station_id) references fat.stations(id) on delete cascade
);
create index idx_station_aliases_station on fat.station_aliases using btree (station_id);
create trigger set_updated_at before update on fat.station_aliases
  for each row execute function fat.set_updated_at();

create table fat.station_distance_matrix (
  from_station_id  integer not null,
  to_station_id    integer not null,
  matrix_version   text not null,
  distance_km      numeric(8,2) not null,
  constraint station_distance_matrix_pkey primary key (from_station_id, to_station_id, matrix_version),
  constraint station_distance_matrix_from_station_id_fkey foreign key (from_station_id) references fat.stations(id) on delete cascade,
  constraint station_distance_matrix_to_station_id_fkey foreign key (to_station_id) references fat.stations(id) on delete cascade,
  constraint station_distance_matrix_distance_km_check check (distance_km >= (0)::numeric)
);

create table fat.station_time_matrix (
  from_station_id  integer not null,
  to_station_id    integer not null,
  matrix_version   text not null,
  hours            numeric(6,2) not null,
  constraint station_time_matrix_pkey primary key (from_station_id, to_station_id, matrix_version),
  constraint station_time_matrix_from_station_id_fkey foreign key (from_station_id) references fat.stations(id) on delete cascade,
  constraint station_time_matrix_to_station_id_fkey foreign key (to_station_id) references fat.stations(id) on delete cascade,
  constraint station_time_matrix_hours_check check (hours >= (0)::numeric)
);

create table fat.travel_matrix_versions (
  id               uuid not null default gen_random_uuid(),
  label            text not null,
  source_filename  text,
  unit             text not null default 'hours'::text,
  is_active        boolean not null default false,
  imported_at      timestamptz not null default now(),
  imported_by      uuid,
  notes            text,
  cell_count       integer not null default 0,
  station_count    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint travel_matrix_versions_pkey primary key (id),
  constraint travel_matrix_versions_label_key unique (label),
  constraint travel_matrix_versions_imported_by_fkey foreign key (imported_by) references fat.app_identities(id) on delete set null,
  constraint travel_matrix_versions_unit_check check (unit = any (array['hours'::text, 'minutes'::text, 'km'::text]))
);
create index idx_travel_matrix_versions_active on fat.travel_matrix_versions using btree (is_active) where is_active;
create trigger set_updated_at before update on fat.travel_matrix_versions
  for each row execute function fat.set_updated_at();

create table fat.travel_matrix_cells (
  id            uuid not null default gen_random_uuid(),
  version_id    uuid not null,
  station_a_id  integer not null,
  station_b_id  integer not null,
  value         numeric(8,3) not null,
  created_at    timestamptz not null default now(),
  constraint travel_matrix_cells_pkey primary key (id),
  constraint travel_matrix_cells_version_id_station_a_id_station_b_id_key unique (version_id, station_a_id, station_b_id),
  constraint travel_matrix_cells_version_id_fkey foreign key (version_id) references fat.travel_matrix_versions(id) on delete cascade,
  constraint travel_matrix_cells_check check (station_a_id <= station_b_id),
  constraint travel_matrix_cells_value_check check (value >= (0)::numeric)
);
create index idx_travel_matrix_cells_lookup on fat.travel_matrix_cells using btree (version_id, station_a_id, station_b_id);

-- fat.travel_matrix_lookup: verbatim from supabase/fat-schema-travel.sql
create or replace function fat.travel_matrix_lookup(
  p_origin_id integer,
  p_dest_id   integer
) returns table (
  value           numeric(8,3),
  unit            text,
  version_id      uuid,
  version_label   text
)
language sql
stable
security invoker
set search_path = fat, pg_temp
as $$
  select c.value, v.unit, v.id as version_id, v.label as version_label
    from fat.travel_matrix_versions v
    join fat.travel_matrix_cells    c on c.version_id = v.id
   where v.is_active
     and c.station_a_id = least   (p_origin_id, p_dest_id)
     and c.station_b_id = greatest(p_origin_id, p_dest_id)
   limit 1;
$$;
revoke all on function fat.travel_matrix_lookup(integer, integer) from public;

-- 2. Member identity profile and per-member operational data.
create table fat.profiles (
  id                   uuid not null,
  email                text not null,
  first_name           text not null default ''::text,
  last_name            text not null default ''::text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  display_name         text,
  rostered_station_id  integer,
  home_location_label  text,
  home_lat             numeric(9,6),
  home_lng             numeric(9,6),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references fat.app_identities(id) on delete cascade,
  constraint profiles_rostered_station_id_fkey foreign key (rostered_station_id) references fat.stations(id) on delete set null
);
create trigger set_updated_at before update on fat.profiles
  for each row execute function fat.set_updated_at();

create table fat.profile_ext (
  user_id                 uuid not null,
  station_id              integer,
  rostered_station_label  text,
  platoon                 text,
  pay_number              text,
  home_address            text,
  home_dist_km            numeric(6,1) default 0,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  constraint profile_ext_pkey primary key (user_id),
  constraint profile_ext_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade,
  constraint profile_ext_station_id_fkey foreign key (station_id) references fat.stations(id) on delete set null
);
create trigger set_updated_at before update on fat.profile_ext
  for each row execute function fat.set_updated_at();

create table fat.home_address (
  id               uuid not null default gen_random_uuid(),
  user_id          uuid not null,
  address_text     text not null,
  address_hash     text not null,
  lat              numeric(10,7),
  lng              numeric(10,7),
  geocoded_at      timestamptz,
  geocode_status   text not null default 'pending'::text,
  address_version  integer not null default 1,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint home_address_pkey primary key (id),
  constraint home_address_user_id_key unique (user_id),
  constraint home_address_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade
);
create trigger set_updated_at before update on fat.home_address
  for each row execute function fat.set_updated_at();

create table fat.station_distances (
  id                     uuid not null default gen_random_uuid(),
  user_id                uuid not null,
  station_id             integer not null,
  home_address_hash      text not null,
  home_address_version   integer not null default 1,
  estimated_distance_km  numeric(8,2),
  confirmed_distance_km  numeric(8,2),
  confirmation_source    text,
  confirmed_at           timestamptz,
  station_lat            numeric(10,7),
  station_lng            numeric(10,7),
  station_geocoded_at    timestamptz,
  is_stale               boolean not null default false,
  stale_reason           text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint station_distances_pkey primary key (id),
  constraint station_distances_user_id_station_id_key unique (user_id, station_id),
  constraint station_distances_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade
);
create index idx_station_distances_user_stale on fat.station_distances using btree (user_id, is_stale);
create index idx_station_distances_user_station on fat.station_distances using btree (user_id, station_id);
create trigger set_updated_at before update on fat.station_distances
  for each row execute function fat.set_updated_at();

create table fat.user_feature_flags (
  user_id       uuid not null,
  feature_name  text not null,
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint user_feature_flags_pkey primary key (user_id, feature_name),
  constraint user_feature_flags_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade,
  constraint user_feature_flags_updated_by_fkey foreign key (updated_by) references fat.app_identities(id) on delete set null
);
create trigger set_updated_at before update on fat.user_feature_flags
  for each row execute function fat.set_updated_at();

-- 3. Financial years (July–June, per member) and claim numbering.
create table fat.financial_years (
  id          uuid not null default gen_random_uuid(),
  user_id     uuid not null,
  label       text not null,
  start_date  date not null,
  end_date    date not null,
  is_active   boolean not null default false,
  created_at  timestamptz default now(),
  constraint financial_years_pkey primary key (id),
  constraint financial_years_id_user_id_key unique (id, user_id),
  constraint financial_years_user_id_label_key unique (user_id, label),
  constraint financial_years_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade,
  constraint financial_years_july_june check (extract(month from start_date) = (7)::numeric and extract(day from start_date) = (1)::numeric and end_date = ((start_date + '1 year'::interval) - '1 day'::interval)::date)
);

create table fat.claim_sequences (
  id                 uuid not null default gen_random_uuid(),
  user_id            uuid not null,
  financial_year_id  uuid not null,
  claim_type         text not null,
  next_seq           integer not null default 1,
  constraint claim_sequences_pkey primary key (id),
  constraint claim_sequences_user_id_financial_year_id_claim_type_key unique (user_id, financial_year_id, claim_type),
  constraint claim_sequences_user_id_fkey foreign key (user_id) references fat.app_identities(id) on delete cascade,
  constraint claim_sequences_financial_year_id_fkey foreign key (financial_year_id) references fat.financial_years(id) on delete cascade
);

-- Caller-bound, SECURITY INVOKER (WORK-167 invariant), identity via the seam.
create function fat.increment_claim_sequence(
  p_user_id           uuid,
  p_financial_year_id uuid,
  p_claim_type        text
) returns integer
language plpgsql
set search_path = ''
as $function$
declare
  v_seq integer;
begin
  if fat.current_app_user_id() is null or p_user_id is distinct from fat.current_app_user_id() then
    raise exception 'increment_claim_sequence: caller may only advance their own claim sequence'
      using errcode = '42501';
  end if;

  insert into fat.claim_sequences (user_id, financial_year_id, claim_type, next_seq)
  values (p_user_id, p_financial_year_id, p_claim_type, 2)
  on conflict (user_id, financial_year_id, claim_type)
  do update set next_seq = fat.claim_sequences.next_seq + 1
  returning next_seq - 1 into v_seq;

  if v_seq is null then
    v_seq := 1;
  end if;
  return v_seq;
end;
$function$;
comment on function fat.increment_claim_sequence(uuid, uuid, text) is
  'WORK-167 caller-bound claim numbering. Neon: the caller is fat.current_app_user_id() (Supabase: auth.uid()).';
revoke all on function fat.increment_claim_sequence(uuid, uuid, text) from public;

-- 4. Identity provisioning (replaces the Supabase auth.users trigger
--    fat.handle_new_user). Called server-side by fat_service only.
create function fat.ensure_app_identity(
  p_id      uuid,
  p_email   text,
  p_origin  text default 'native'
) returns uuid
language plpgsql
set search_path = ''
as $function$
declare
  v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  if p_origin = 'legacy_supabase' and p_id is null then
    raise exception 'ensure_app_identity: a legacy_supabase identity must preserve its legacy uid'
      using errcode = '22023';
  end if;
  insert into fat.app_identities (id, email, origin, legacy_subject)
  values (v_id, p_email, p_origin, case when p_origin = 'legacy_supabase' then v_id end)
  on conflict (id) do nothing;
  insert into fat.profiles (id, email)
  values (v_id, p_email)
  on conflict (id) do nothing;
  return v_id;
end;
$function$;
comment on function fat.ensure_app_identity(uuid, text, text) is
  'WORK-254: idempotently provisions a FAT app identity and its fat.profiles row (replaces the Supabase on_auth_user_created_fat trigger). legacy_supabase identities keep their Supabase uid as the FAT owner id.';
revoke all on function fat.ensure_app_identity(uuid, text, text) from public;

create function fat.resolve_app_identity(p_provider text, p_subject text)
returns uuid
language sql
stable
set search_path = ''
as $function$
  select l.app_identity_id
    from fat.identity_links l
    join fat.app_identities i on i.id = l.app_identity_id
   where l.provider = p_provider
     and l.provider_subject = p_subject
     and i.status = 'active'
$function$;
comment on function fat.resolve_app_identity(text, text) is
  'WORK-254: authenticated provider subject → active FAT app identity (NULL when unlinked or disabled). Used by the server before SET LOCAL fat.app_user_id.';
revoke all on function fat.resolve_app_identity(text, text) from public;

-- 5. Versioned rates and rules (WORK-172). Global reference data.
create table fat.rates (
  id                 uuid not null default gen_random_uuid(),
  code               text not null,
  display_name       text not null,
  unit               text not null,
  active_version_id  uuid,
  created_at         timestamptz not null default now(),
  description        text,
  constraint rates_pkey primary key (id),
  constraint rates_code_key unique (code),
  constraint rates_unit_check check (unit = any (array['dollars'::text, 'dollars_per_km'::text, 'hours'::text, 'dollars_per_hour'::text, 'dollars_per_week'::text, 'multiplier'::text]))
);

create table fat.rate_versions (
  id                uuid not null default gen_random_uuid(),
  rate_id           uuid not null,
  version_label     text not null,
  value             numeric not null,
  effective_from    date not null,
  created_at        timestamptz not null default now(),
  created_by        uuid,
  classification    fat.frv_classification,
  source_kind       text not null,
  source_ref        text not null,
  withdrawn_at      timestamptz,
  withdrawn_reason  text,
  constraint rate_versions_pkey primary key (id),
  constraint rate_versions_rate_id_version_label_key unique (rate_id, version_label),
  constraint rate_versions_rate_id_fkey foreign key (rate_id) references fat.rates(id) on delete cascade,
  constraint rate_versions_created_by_fkey foreign key (created_by) references fat.profiles(id) on delete set null,
  constraint rate_versions_source_kind_check check (source_kind = any (array['industrial_instrument'::text, 'fwc_order'::text, 'payroll_reconciled'::text, 'workbook'::text])),
  constraint rate_versions_withdrawn_pair_check check ((withdrawn_at is null) = (withdrawn_reason is null))
);
create index idx_rate_versions_rate_effective on fat.rate_versions using btree (rate_id, effective_from desc);
create unique index rate_versions_effective_key on fat.rate_versions using btree (rate_id, coalesce((classification)::text, ''::text), effective_from) where (withdrawn_at is null);
comment on column fat.rate_versions.classification is
  'NULL = applies to every classification. Lookup prefers an exact classification match, else NULL.';
comment on column fat.rate_versions.source_kind is
  'industrial_instrument (EBA) | fwc_order (e.g. PR765587) | payroll_reconciled (operator-accepted payroll behaviour) | workbook (non-authoritative).';
comment on column fat.rate_versions.withdrawn_at is
  'Set once to retire a version from lookup without deleting it. Snapshots that referenced it are unaffected.';

alter table fat.rates add constraint rates_active_version_id_fkey
  foreign key (active_version_id) references fat.rate_versions(id);

-- fat.rate_versions_append_only: verbatim from supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql
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
revoke all on function fat.rate_versions_append_only() from public;
create trigger rate_versions_append_only
  before update or delete on fat.rate_versions
  for each row execute function fat.rate_versions_append_only();

create table fat.member_classifications (
  id              uuid not null default gen_random_uuid(),
  owner_id        uuid not null,
  classification  fat.frv_classification not null,
  effective_from  date not null,
  source_ref      text not null,
  created_at      timestamptz not null default now(),
  constraint member_classifications_pkey primary key (id),
  constraint member_classifications_owner_id_effective_from_key unique (owner_id, effective_from),
  constraint member_classifications_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint member_classifications_source_ref_check check (length(btrim(source_ref)) > 0)
);
comment on table fat.member_classifications is
  'WORK-172: a member''s FRV classification history. The row with the latest effective_from <= claim date applies. No row → overtime $ estimates fail closed.';
