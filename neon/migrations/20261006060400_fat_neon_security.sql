-- FAT Neon backend — 5/6 row-level security, privileges and invariants (WORK-254, N1)
-- Owner: fat. Rollback: neon/rollbacks/20261006060400_fat_neon_security.rollback.sql
--
-- Carries the FAT security model (PROJECTED_MODEL.md "Security architecture";
-- WORK-165/166/167 Tier-1 invariants; C1 §7) onto Neon roles:
--   Supabase `authenticated` → fat_app  ·  `service_role` → fat_service  ·  `anon` → (none)
--   auth.uid()               → fat.current_app_user_id()
--   auth.role() = 'authenticated' / 'service_role' policies → policies TO fat_app / fat_service
-- Strict per-user isolation is unchanged: every member row is visible and
-- writable only when its owner equals the transaction's app identity.
-- Privileges are least-privilege and never wider than Supabase DEV: TRUNCATE,
-- REFERENCES and TRIGGER are not granted to fat_app (TRUNCATE would bypass
-- RLS); reference tables are SELECT-only for fat_app (DEV relied on RLS alone).
-- fat_service has no BYPASSRLS: it reaches rows through explicit policies.

-- 1. RLS on every fat table.
do $rls$
declare t record;
begin
  for t in select c.oid::regclass as rel from pg_class c
            where c.relnamespace = 'fat'::regnamespace and c.relkind = 'r' loop
    execute format('alter table %s enable row level security', t.rel);
  end loop;
end;
$rls$;

-- 2. fat_service: explicit full-access policy on every fat table (the
--    server-side administration / migration path; replaces service_role).
do $svc$
declare t record;
begin
  for t in select c.oid::regclass as rel from pg_class c
            where c.relnamespace = 'fat'::regnamespace and c.relkind = 'r' loop
    execute format('create policy fat_service_manage on %s for all to fat_service using (true) with check (true)', t.rel);
  end loop;
end;
$svc$;

-- 3. fat_app: owner-scoped policies (Supabase users_manage_own, auth.uid() → seam).
create policy users_manage_own on fat.financial_years   for all to fat_app using (fat.current_app_user_id() = user_id)  with check (fat.current_app_user_id() = user_id);
create policy users_manage_own on fat.claim_sequences   for all to fat_app using (fat.current_app_user_id() = user_id)  with check (fat.current_app_user_id() = user_id);
create policy users_manage_own on fat.profiles          for all to fat_app using (fat.current_app_user_id() = id)       with check (fat.current_app_user_id() = id);
create policy users_manage_own on fat.profile_ext       for all to fat_app using (fat.current_app_user_id() = user_id)  with check (fat.current_app_user_id() = user_id);
create policy users_manage_own on fat.home_address      for all to fat_app using (fat.current_app_user_id() = user_id)  with check (fat.current_app_user_id() = user_id);
create policy users_manage_own on fat.station_distances for all to fat_app using (fat.current_app_user_id() = user_id)  with check (fat.current_app_user_id() = user_id);
create policy users_manage_own on fat.operational_claims   for all to fat_app using (fat.current_app_user_id() = owner_id) with check (fat.current_app_user_id() = owner_id);
create policy users_manage_own on fat.claim_entitlements   for all to fat_app using (fat.current_app_user_id() = owner_id) with check (fat.current_app_user_id() = owner_id);
create policy users_manage_own on fat.payment_records      for all to fat_app using (fat.current_app_user_id() = owner_id) with check (fat.current_app_user_id() = owner_id);
create policy users_manage_own on fat.payslip_imports      for all to fat_app using (fat.current_app_user_id() = owner_id) with check (fat.current_app_user_id() = owner_id);
create policy users_manage_own on fat.payslip_import_lines for all to fat_app using (fat.current_app_user_id() = owner_id) with check (fat.current_app_user_id() = owner_id);
create policy users_manage_own on fat.reconciliation_audit for all to fat_app using (fat.current_app_user_id() = actor_id) with check (fat.current_app_user_id() = actor_id);

create policy users_manage_own on fat.recall_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = recall_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = recall_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.retain_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = retain_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = retain_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.standby_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = standby_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = standby_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.muster_dismiss_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = muster_dismiss_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = muster_dismiss_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.spoilt_meal_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = spoilt_meal_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = spoilt_meal_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.delayed_meal_details for all to fat_app
  using (exists (select 1 from fat.operational_claims c where c.id = delayed_meal_details.claim_id and c.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.operational_claims c where c.id = delayed_meal_details.claim_id and c.owner_id = fat.current_app_user_id()));
create policy users_manage_own on fat.entitlement_payment_links for all to fat_app
  using (exists (select 1 from fat.claim_entitlements e where e.id = entitlement_payment_links.entitlement_id and e.owner_id = fat.current_app_user_id()))
  with check (exists (select 1 from fat.claim_entitlements e where e.id = entitlement_payment_links.entitlement_id and e.owner_id = fat.current_app_user_id()));

create policy users_read_own   on fat.entitlement_overrides  for select to fat_app using (fat.current_app_user_id() = owner_id);
create policy users_read_own   on fat.member_classifications for select to fat_app using (fat.current_app_user_id() = owner_id);
create policy users_insert_own on fat.member_classifications for insert to fat_app with check (fat.current_app_user_id() = owner_id);
create policy users_delete_own on fat.member_classifications for delete to fat_app using (fat.current_app_user_id() = owner_id);
create policy owner_read       on fat.user_feature_flags     for select to fat_app using (fat.current_app_user_id() = user_id);
create policy identity_self_read on fat.app_identities      for select to fat_app using (fat.current_app_user_id() = id);

-- Reference data: readable by fat_app (Supabase authenticated_read).
create policy authenticated_read on fat.stations                for select to fat_app using (true);
create policy authenticated_read on fat.station_aliases         for select to fat_app using (true);
create policy authenticated_read on fat.station_distance_matrix for select to fat_app using (true);
create policy authenticated_read on fat.station_time_matrix     for select to fat_app using (true);
create policy authenticated_read on fat.travel_matrix_versions  for select to fat_app using (true);
create policy authenticated_read on fat.travel_matrix_cells     for select to fat_app using (true);
create policy authenticated_read on fat.rates                   for select to fat_app using (true);
create policy authenticated_read on fat.rate_versions           for select to fat_app using (true);

-- Migration provenance and identity links: never reachable by fat_app (C1 §7 no_api_access).
create policy no_api_access on fat.migration_batches     for all to fat_app using (false) with check (false);
create policy no_api_access on fat.migration_source_rows for all to fat_app using (false) with check (false);
create policy no_api_access on fat.identity_links        for all to fat_app using (false) with check (false);

-- 4. Table privileges.
grant select, insert, update, delete on
  fat.financial_years, fat.claim_sequences, fat.profiles, fat.profile_ext, fat.home_address,
  fat.station_distances, fat.operational_claims, fat.recall_details, fat.retain_details,
  fat.standby_details, fat.muster_dismiss_details, fat.spoilt_meal_details, fat.delayed_meal_details,
  fat.claim_entitlements, fat.payment_records, fat.entitlement_payment_links, fat.reconciliation_audit,
  fat.payslip_imports, fat.payslip_import_lines
  to fat_app;
grant select, insert, delete on fat.member_classifications to fat_app;
grant select on
  fat.entitlement_overrides, fat.user_feature_flags, fat.app_identities,
  fat.stations, fat.station_aliases, fat.station_distance_matrix, fat.station_time_matrix,
  fat.travel_matrix_versions, fat.travel_matrix_cells, fat.rates, fat.rate_versions
  to fat_app;

do $svcgrant$
declare t record;
begin
  for t in select c.oid::regclass as rel, c.relname from pg_class c
            where c.relnamespace = 'fat'::regnamespace and c.relkind = 'r' loop
    if t.relname = 'entitlement_overrides' then
      execute format('grant select on %s to fat_service', t.rel);   -- trigger-written audit only
    else
      execute format('grant select, insert, update, delete on %s to fat_service', t.rel);
    end if;
  end loop;
end;
$svcgrant$;

-- 5. Function EXECUTE (nothing to PUBLIC; Supabase DEV parity minus trigger-only functions).
grant execute on function
  fat.current_app_user_id(), fat.current_actor(),
  fat.increment_claim_sequence(uuid, uuid, text),
  fat.travel_matrix_lookup(integer, integer),
  fat._reconc_recompute(uuid, numeric),
  fat._reconc_write_audit(uuid, uuid, text, text, text, text, boolean),
  fat.create_payment_record(uuid, text, date, numeric, text, text, jsonb),
  fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric),
  fat.unlink_entitlement_payment(uuid, uuid, text, numeric),
  fat.recompute_entitlement_status(uuid, uuid, text, text, numeric),
  fat.route_entitlement(uuid, text, uuid, text),
  fat.retract_payment(uuid, uuid, text, numeric),
  fat.payslip_line_content_fp(text, text, numeric, date),
  fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean)
  to fat_app, fat_service;
grant execute on function
  fat.ensure_app_identity(uuid, text, text),
  fat.resolve_app_identity(text, text)
  to fat_service;

-- 6. Postconditions. Any failure raises and rolls the whole migration back.
do $assert$
declare
  n int;
  bad text;
begin
  select string_agg(relname, ', ') into bad from pg_class
   where relnamespace = 'fat'::regnamespace and relkind = 'r' and not relrowsecurity;
  if bad is not null then raise exception 'WORK-254 postcondition: RLS disabled on %', bad; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p
   where p.pronamespace = 'fat'::regnamespace
     and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  where a.grantee = 0 and a.privilege_type = 'EXECUTE');
  if bad is not null then raise exception 'WORK-254 postcondition: PUBLIC can execute %', bad; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p
   where p.pronamespace = 'fat'::regnamespace and p.prosrc ~* '\mauth\.(uid|role|users|jwt)\M';
  if bad is not null then raise exception 'WORK-254 postcondition: Supabase auth reference in %', bad; end if;

  select string_agg(conrelid::regclass::text, ', ') into bad from pg_constraint
   where contype = 'f' and connamespace = 'fat'::regnamespace
     and confrelid::regclass::text !~ '^fat\.';
  if bad is not null then raise exception 'WORK-254 postcondition: FK outside fat on %', bad; end if;

  select string_agg(p.proname, ', ') into bad from pg_proc p
   where p.pronamespace = 'fat'::regnamespace and p.prosecdef
     and p.proname <> 'claim_entitlements_override_audit';
  if bad is not null then raise exception 'WORK-254 postcondition: unexpected SECURITY DEFINER %', bad; end if;

  if has_function_privilege('fat_app', 'fat.claim_entitlements_override_audit()', 'EXECUTE')
     or has_function_privilege('fat_app', 'fat.ensure_app_identity(uuid, text, text)', 'EXECUTE')
     or has_table_privilege('fat_app', 'fat.rates', 'INSERT')
     or has_table_privilege('fat_app', 'fat.rate_versions', 'UPDATE')
     or has_table_privilege('fat_app', 'fat.entitlement_overrides', 'INSERT')
     or has_table_privilege('fat_app', 'fat.migration_batches', 'SELECT')
     or has_table_privilege('fat_app', 'fat.migration_source_rows', 'SELECT')
     or has_table_privilege('fat_app', 'fat.identity_links', 'SELECT')
     or has_table_privilege('fat_app', 'fat.operational_claims', 'TRUNCATE')
     or has_table_privilege('fat_service', 'fat.entitlement_overrides', 'INSERT') then
    raise exception 'WORK-254 postcondition: unexpected privilege';
  end if;

  select count(*) into n from pg_roles
   where rolname in ('fat_app', 'fat_service') and (rolcanlogin or rolbypassrls or rolsuper);
  if n > 0 then raise exception 'WORK-254 postcondition: fat_app/fat_service must be NOLOGIN without BYPASSRLS'; end if;

  select count(*) into n from pg_extension where extname <> 'plpgsql';
  if n > 0 then raise exception 'WORK-254 postcondition: unexpected extension'; end if;
end;
$assert$;
