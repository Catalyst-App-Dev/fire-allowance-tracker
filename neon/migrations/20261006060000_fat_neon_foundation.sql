-- FAT Neon backend — 1/6 foundation (WORK-254, N1)
-- Owner: fat. Target: the FAT-owned Neon project declared in .catalyst/app.yml
-- `backend:` (catalyst/backend@1). Rollback: neon/rollbacks/20261006060000_fat_neon_foundation.rollback.sql
--
-- This is NOT a replay of supabase/migrations. It is a consolidated, portable
-- PostgreSQL definition of FAT's canonical target (docs/architecture/NEON_BACKEND.md),
-- equal to the verified Supabase DEV end state except for the documented
-- Supabase → Neon adaptations (adaptation matrix in NEON_BACKEND.md §4).
--
-- This file creates:
--   * fat_migrations.schema_migrations — the Neon applied-state ledger read by
--     backend-preflight verify-applied (replaces supabase_migrations.schema_migrations);
--   * schema fat;
--   * NOLOGIN group roles fat_app (replaces Supabase `authenticated`) and
--     fat_service (replaces `service_role`); there is no `anon` equivalent;
--   * the application identity seam (fat.app_identities, fat.identity_links,
--     fat.current_app_user_id(), fat.current_actor()) that replaces auth.users,
--     auth.uid() and the auth.users trigger;
--   * shared helpers (fat.set_updated_at, domain fat.frv_classification).
--
-- No extension is required: gen_random_uuid() and md5() are core PostgreSQL.

-- 0. Applied-state ledger (one row per migration, written by the apply step in
--    the same transaction as the migration body).
create schema fat_migrations;
revoke all on schema fat_migrations from public;
create table fat_migrations.schema_migrations (
  version     text primary key check (version ~ '^[0-9]{14}$'),
  name        text not null check (length(btrim(name)) > 0),
  checksum    text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  applied_at  timestamptz not null default now(),
  applied_by  text not null default current_user
);
comment on table fat_migrations.schema_migrations is
  'WORK-254: FAT Neon applied-migration ledger. Each row is written in the same transaction as its migration (neon/README.md). verify-applied reads this table on the target it checks.';

-- Data loads (seed, synthetic fixtures, later C2/C3 batches) are recorded
-- separately so schema history stays identical across targets.
create table fat_migrations.data_loads (
  change_id   text primary key check (change_id ~ '^[a-z0-9][a-z0-9._-]{2,80}$'),
  kind        text not null check (kind in ('synthetic','reference','migration_batch')),
  checksum    text not null check (checksum ~ '^sha256:[0-9a-f]{64}$'),
  applied_at  timestamptz not null default now(),
  applied_by  text not null default current_user
);
comment on table fat_migrations.data_loads is
  'WORK-254: FAT Neon data-load ledger (synthetic DEV fixtures; later reference loads and C2/C3 batches). verify-applied reads it for data-load operations.';

-- 1. Schema. Nothing is granted to PUBLIC.
create schema fat;
revoke all on schema fat from public;
comment on schema fat is
  'Fire Allowance Tracker canonical schema (Neon). Owned by the fire-allowance-tracker repository; see docs/architecture/NEON_BACKEND.md.';

-- 2. Group roles. Login roles for the application server are created later
--    (F3) and granted membership; nothing here can log in.
do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'fat_app') then
    create role fat_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fat_service') then
    create role fat_service nologin;
  end if;
end;
$roles$;
comment on role fat_app is
  'WORK-254: FAT end-user data access (replaces Supabase authenticated). Every row is scoped by RLS to fat.current_app_user_id().';
comment on role fat_service is
  'WORK-254: FAT server-side administration and migration (replaces Supabase service_role). Explicit RLS policies, no BYPASSRLS.';
grant usage on schema fat to fat_app, fat_service;

-- 3. No PUBLIC EXECUTE on functions this owner creates (replaces the Supabase
--    fat_enforce_no_public_execute event trigger, WORK-166 canonical 22).
--    Global default privileges for the migrating role; each function below also
--    revokes PUBLIC explicitly and the security migration asserts the result.
alter default privileges revoke execute on functions from public;

-- 4. Shared helpers.
create domain fat.frv_classification as text
  check (value in (
    'recruit','ff1','ff2','ff3','qff','sff','lff','slff','so','sso',
    'cmdr_commencement','cmdr_12m','cmdr_24m','fscc','sfscc'
  ));
comment on domain fat.frv_classification is
  'WORK-172: FRV Division A classification (rank) codes keyed by rate_versions and member_classifications.';

-- fat.set_updated_at: verbatim from supabase/fat-schema.sql
create or replace function fat.set_updated_at()
returns trigger
language plpgsql
set search_path = fat, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
revoke all on function fat.set_updated_at() from public;

-- 5. Application identity seam (replaces auth.users as the owner of FAT rows).
--    fat.app_identities.id IS the FAT owner UUID. For a member migrated from
--    legacy Supabase it equals their auth.users.id, so every owner_id/user_id
--    stays byte-identical across the cutover; legacy_subject records that
--    preservation explicitly. A later authentication provider (Neon Auth) is
--    linked through fat.identity_links, never by rewriting owner ids.
create table fat.app_identities (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  origin          text not null,
  legacy_subject  uuid,
  status          text not null default 'active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint app_identities_email_check check (length(btrim(email)) > 0),
  constraint app_identities_origin_check check (origin in ('legacy_supabase','native','synthetic')),
  constraint app_identities_status_check check (status in ('active','disabled')),
  constraint app_identities_legacy_subject_key unique (legacy_subject),
  constraint app_identities_legacy_preserves_id check (legacy_subject is null or legacy_subject = id),
  constraint app_identities_legacy_origin check ((origin = 'legacy_supabase') = (legacy_subject is not null))
);
create unique index uq_app_identities_email on fat.app_identities (lower(email));
create trigger set_updated_at before update on fat.app_identities
  for each row execute function fat.set_updated_at();
comment on table fat.app_identities is
  'WORK-254: FAT application identity. id is the stable FAT owner UUID referenced by every FAT row (legacy Supabase auth.users.id preserved unchanged for migrated members). Holds no credential.';

create table fat.identity_links (
  id                uuid primary key default gen_random_uuid(),
  app_identity_id   uuid not null references fat.app_identities(id) on delete cascade,
  provider          text not null,
  provider_subject  text not null,
  verified_email    text,
  linked_by         text not null,
  linked_at         timestamptz not null default now(),
  constraint identity_links_provider_check check (provider in ('neon_auth','supabase_auth')),
  constraint identity_links_subject_check check (length(btrim(provider_subject)) > 0),
  constraint identity_links_linked_by_check check (linked_by in ('verified_email','legacy_uid','synthetic','operator')),
  constraint identity_links_provider_subject_key unique (provider, provider_subject),
  constraint identity_links_identity_provider_key unique (app_identity_id, provider)
);
create index idx_identity_links_identity on fat.identity_links (app_identity_id);
comment on table fat.identity_links is
  'WORK-254: maps an authentication provider subject (Neon Auth user id; legacy Supabase uid) to the preserved FAT app identity. One subject per provider, one link per provider per identity.';

-- The acting FAT identity for this transaction. The application server (F3)
-- verifies the authenticated session, resolves fat.identity_links, and sets
-- `fat.app_user_id` with SET LOCAL before any statement; clients never hold
-- database credentials. Replaces Supabase auth.uid().
create function fat.current_app_user_id()
returns uuid
language sql
stable
set search_path = ''
as $function$ select nullif(current_setting('fat.app_user_id', true), '')::uuid $function$;
comment on function fat.current_app_user_id() is
  'WORK-254 identity seam: the FAT app identity of the current transaction (SET LOCAL fat.app_user_id by the server). Replaces Supabase auth.uid(). NULL when unset → every owner policy denies.';
revoke all on function fat.current_app_user_id() from public;

create function fat.current_actor()
returns uuid
language sql
stable
set search_path = ''
as $function$ select fat.current_app_user_id() $function$;
comment on function fat.current_actor() is
  'WORK-172 identity seam: the acting user for audit rows. Neon: fat.current_app_user_id() (Supabase used auth.uid()).';
revoke all on function fat.current_actor() from public;
