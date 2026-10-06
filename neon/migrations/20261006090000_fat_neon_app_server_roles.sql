-- FAT Neon backend — application server login roles (WORK-256, N2)
-- Owner: fat. Rollback: neon/rollbacks/20261006090000_fat_neon_app_server_roles.rollback.sql
--
-- The FAT server (Next.js route handlers, lib/server/) is the only database client:
-- browsers never hold a PostgreSQL credential. Two LOGIN roles, both NOINHERIT and
-- NOBYPASSRLS, so a connection holds NO table privilege until the server explicitly
-- switches role inside a transaction:
--
--   fat_app_server            SET LOCAL ROLE fat_app + set_config('fat.app_user_id', …)
--                             for every member request (RLS owner policies apply).
--   fat_identity_provisioner  SET LOCAL ROLE fat_service, used only by
--                             lib/server/identity.js to resolve / provision the app
--                             identity behind a verified Neon Auth session. Never CRUD.
--
-- Created by SQL (not the Neon API) so neither role is a member of neon_superuser.
-- No password is set here: credentials are issued out of band and never enter the
-- repository (security.secrets-and-access). Until one is set, neither role can log in.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'fat_app_server') then
    create role fat_app_server login noinherit nobypassrls nocreatedb nocreaterole noreplication;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'fat_identity_provisioner') then
    create role fat_identity_provisioner login noinherit nobypassrls nocreatedb nocreaterole noreplication;
  end if;
end;
$roles$;

grant fat_app to fat_app_server with inherit false, set true;
grant fat_service to fat_identity_provisioner with inherit false, set true;

comment on role fat_app_server is
  'WORK-256: FAT application server login. NOINHERIT member of fat_app; every request runs SET LOCAL ROLE fat_app with fat.app_user_id set from the verified Neon Auth session.';
comment on role fat_identity_provisioner is
  'WORK-256: FAT identity provisioning login. NOINHERIT member of fat_service; used only to resolve/provision fat.app_identities + fat.identity_links for a verified Neon Auth session.';

-- Postconditions.
do $assert$
declare r record;
begin
  for r in select rolname, rolcanlogin, rolinherit, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb
             from pg_roles where rolname in ('fat_app_server', 'fat_identity_provisioner') loop
    if not r.rolcanlogin or r.rolinherit or r.rolbypassrls or r.rolsuper or r.rolcreaterole or r.rolcreatedb then
      raise exception 'WORK-256 postcondition: role % has an unexpected attribute', r.rolname;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('fat_app_server', 'fat_identity_provisioner')) <> 2 then
    raise exception 'WORK-256 postcondition: login roles missing';
  end if;
  if not pg_has_role('fat_app_server', 'fat_app', 'SET') or pg_has_role('fat_app_server', 'fat_app', 'USAGE') then
    raise exception 'WORK-256 postcondition: fat_app_server must SET (not inherit) fat_app';
  end if;
  if pg_has_role('fat_app_server', 'fat_service', 'SET') then
    raise exception 'WORK-256 postcondition: fat_app_server must not reach fat_service';
  end if;
  if not pg_has_role('fat_identity_provisioner', 'fat_service', 'SET') or pg_has_role('fat_identity_provisioner', 'fat_service', 'USAGE') then
    raise exception 'WORK-256 postcondition: fat_identity_provisioner must SET (not inherit) fat_service';
  end if;
  if pg_has_role('fat_identity_provisioner', 'fat_app', 'SET') then
    raise exception 'WORK-256 postcondition: fat_identity_provisioner must not reach fat_app';
  end if;
  if exists (select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
              where u.rolname in ('fat_app_server', 'fat_identity_provisioner') and g.rolname not in ('fat_app', 'fat_service')) then
    raise exception 'WORK-256 postcondition: login roles hold an unexpected membership';
  end if;
end;
$assert$;
