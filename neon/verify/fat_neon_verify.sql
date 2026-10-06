-- FAT Neon schema + synthetic-fixture verification (WORK-254, N1)
-- Run on the FAT Neon `dev` target after migrations 1–6 and the synthetic
-- fixture. Every test executes inside its own sub-transaction that is ALWAYS
-- rolled back, so the suite leaves no rows, roles grants or settings behind.
-- `app` tests run as fat_app (SET LOCAL ROLE, after a rolled-back
-- `GRANT fat_app TO current_user WITH INHERIT FALSE, SET TRUE`) with
-- fat.app_user_id set as the F3 server will set it.
-- Output: one row per test (name, ok, observed). Usage: neon/README.md.
create temp table fat_verify_results (seq int, name text, ok boolean, observed text) on commit drop;

do $verify$
declare
  A constant text := '5eed0000-0000-4000-8000-00000000000a';
  B constant text := '5eed0000-0000-4000-8000-00000000000b';
  C constant text := '5eed0000-0000-4000-8000-00000000000c';
  specs jsonb := $specs$[
  {"name":"rls: member A sees exactly own 6 claims","role":"app","user":"A","sql":["select count(*)::text from fat.operational_claims"],"value":"6"},
  {"name":"rls: member B sees none of A's claims","role":"app","user":"B","sql":["select count(*)::text from fat.operational_claims"],"value":"0"},
  {"name":"rls: no app identity set → no rows","role":"app","user":null,"sql":["select (select count(*) from fat.operational_claims) + (select count(*) from fat.profiles) + (select count(*) from fat.claim_entitlements)"],"value":"0"},
  {"name":"rls: details visible only through own claim","role":"app","user":"B","sql":["select (select count(*) from fat.retain_details)+(select count(*) from fat.recall_details)+(select count(*) from fat.standby_details)+(select count(*) from fat.muster_dismiss_details)+(select count(*) from fat.spoilt_meal_details)+(select count(*) from fat.delayed_meal_details)"],"value":"0"},
  {"name":"rls: A cannot insert a claim owned by B","role":"app","user":"A","sql":["insert into fat.operational_claims (owner_id, claim_type, claim_date) values ('5eed0000-0000-4000-8000-00000000000b','RC','2025-09-01')"],"state":"42501"},
  {"name":"rls: A cannot update B's profile (0 rows)","role":"app","user":"A","sql":["with u as (update fat.profiles set first_name='x' where id='5eed0000-0000-4000-8000-00000000000b' returning 1) select count(*)::text from u"],"value":"0"},
  {"name":"rls: A sees only own app identity","role":"app","user":"A","sql":["select count(*)::text from fat.app_identities"],"value":"1"},
  {"name":"priv: reference data readable by fat_app","role":"app","user":"A","sql":["select (select count(*) from fat.stations) || '/' || (select count(*) from fat.rates) || '/' || (select count(*) from fat.rate_versions)"],"value":"3/14/32"},
  {"name":"priv: fat_app cannot write reference data","role":"app","user":"A","sql":["insert into fat.stations (id, name) values (9999, 'x')"],"state":"42501"},
  {"name":"priv: fat_app cannot write rates","role":"app","user":"A","sql":["update fat.rates set display_name='x'"],"state":"42501"},
  {"name":"priv: fat_app cannot read migration batches","role":"app","user":"A","sql":["select count(*)::text from fat.migration_batches"],"state":"42501"},
  {"name":"priv: fat_app cannot read identity links","role":"app","user":"A","sql":["select count(*)::text from fat.identity_links"],"state":"42501"},
  {"name":"priv: fat_app cannot TRUNCATE","role":"app","user":"A","sql":["truncate fat.operational_claims cascade"],"state":"42501"},
  {"name":"priv: fat_app cannot provision identities","role":"app","user":"A","sql":["select fat.ensure_app_identity(gen_random_uuid(), 'x@example.invalid', 'native')::text"],"state":"42501"},
  {"name":"WORK-167: claim sequence advances for own id","role":"app","user":"A","sql":["select fat.increment_claim_sequence('5eed0000-0000-4000-8000-00000000000a','5eed0000-0000-4000-8000-0000000000a1','RT')::text"],"value":"2"},
  {"name":"WORK-167: claim sequence refuses another member","role":"app","user":"A","sql":["select fat.increment_claim_sequence('5eed0000-0000-4000-8000-00000000000b','5eed0000-0000-4000-8000-0000000000b1','RT')::text"],"state":"42501"},
  {"name":"WORK-167: claim sequence refuses an unset identity","role":"app","user":null,"sql":["select fat.increment_claim_sequence('5eed0000-0000-4000-8000-00000000000a','5eed0000-0000-4000-8000-0000000000a1','RT')::text"],"state":"42501"},
  {"name":"C1 guard: API caller cannot set provenance","role":"app","user":"A","sql":["insert into fat.operational_claims (owner_id, claim_type, claim_date, migration_batch_id) values ('5eed0000-0000-4000-8000-00000000000a','RC','2025-09-01','5eed0000-0000-4000-8000-0000000ba001')"],"state":"42501"},
  {"name":"C1 guard: API caller cannot mint prototype_migration payment","role":"app","user":"A","sql":["insert into fat.payment_records (owner_id, stream, record_date, gross_amount, source) values ('5eed0000-0000-4000-8000-00000000000a','payslip','2025-09-01',1,'prototype_migration')"],"state":"42501"},
  {"name":"C1 guard: provenance immutable for the migration path too","role":"owner","user":null,"sql":["update fat.operational_claims set prototype_row_id = gen_random_uuid() where id = '5eed0000-0000-4000-8000-0000000c0007'"],"state":"42501"},
  {"name":"C1: claim_number is set-once","role":"owner","user":null,"sql":["update fat.operational_claims set claim_number = 2 where id = '5eed0000-0000-4000-8000-0000000c0001'"],"state":"42501"},
  {"name":"C1: claim number unique per owner/FY/type","role":"owner","user":null,"sql":["insert into fat.operational_claims (owner_id, claim_type, claim_date, claim_number, financial_year_id) values ('5eed0000-0000-4000-8000-00000000000a','RT','2025-09-01',1,'5eed0000-0000-4000-8000-0000000000a1')"],"state":"23505"},
  {"name":"C1: claim FY must belong to the claim owner","role":"owner","user":null,"sql":["insert into fat.operational_claims (owner_id, claim_type, claim_date, claim_number, financial_year_id) values ('5eed0000-0000-4000-8000-00000000000a','RC','2025-09-01',7,'5eed0000-0000-4000-8000-0000000000b1')"],"state":"23503"},
  {"name":"C1: financial year must run 1 July – 30 June","role":"owner","user":null,"sql":["insert into fat.financial_years (user_id, label, start_date, end_date) values ('5eed0000-0000-4000-8000-00000000000a','bad','2025-01-01','2025-12-31')"],"state":"23514"},
  {"name":"C1: entitlement owner must equal claim owner","role":"owner","user":null,"sql":["insert into fat.claim_entitlements (claim_id, owner_id, entitlement_type, unit, rule_id, rule_version, rate_snapshot) values ('5eed0000-0000-4000-8000-0000000c0001','5eed0000-0000-4000-8000-00000000000b','x','hours','r','v','{}')"],"state":"23503"},
  {"name":"C1: prototype claim identity is idempotent","role":"owner","user":null,"sql":["insert into fat.operational_claims (owner_id, claim_type, claim_date, migration_batch_id, prototype_source, prototype_row_id) values ('5eed0000-0000-4000-8000-00000000000c','RC','2026-02-02','5eed0000-0000-4000-8000-0000000ba001','recalls','5eed0000-0000-4000-8000-0000000a9101')"],"state":"23505"},
  {"name":"C1: prototype entitlement component is idempotent","role":"owner","user":null,"sql":["insert into fat.claim_entitlements (claim_id, owner_id, entitlement_type, unit, rule_id, rule_version, rate_snapshot, migration_batch_id, prototype_source, prototype_row_id, prototype_component) values ('5eed0000-0000-4000-8000-0000000c0007','5eed0000-0000-4000-8000-00000000000c','x','dollars','r','v','{}','5eed0000-0000-4000-8000-0000000ba001','recalls','5eed0000-0000-4000-8000-0000000a9101','travel_amount')"],"state":"23505"},
  {"name":"C1: source row consumed exactly once","role":"owner","user":null,"sql":["insert into fat.migration_source_rows (batch_id, owner_id, source_table, source_row_id, source_checksum, disposition, target_claim_id) values ('5eed0000-0000-4000-8000-0000000ba001','5eed0000-0000-4000-8000-00000000000c','recalls','5eed0000-0000-4000-8000-0000000a9101','x','claim','5eed0000-0000-4000-8000-0000000c0007')"],"state":"23505"},
  {"name":"C1: excluded source row needs code + snapshot","role":"owner","user":null,"sql":["insert into fat.migration_source_rows (batch_id, owner_id, source_table, source_row_id, source_checksum, disposition) values ('5eed0000-0000-4000-8000-0000000ba001','5eed0000-0000-4000-8000-00000000000c','recalls',gen_random_uuid(),'x','excluded')"],"state":"23514"},
  {"name":"C3: migration_source_key is idempotent","role":"owner","user":null,"sql":["insert into fat.payment_records (owner_id, stream, record_date, gross_amount, source, migration_batch_id, migration_source_key) values ('5eed0000-0000-4000-8000-00000000000c','payslip','2026-02-20',1,'prototype_migration','5eed0000-0000-4000-8000-0000000ba001','c3:dev:synthetic:recalls:5eed0000-0000-4000-8000-0000000a9101')"],"state":"23505"},
  {"name":"C3: prototype_migration requires a batch","role":"owner","user":null,"sql":["insert into fat.payment_records (owner_id, stream, record_date, gross_amount, source) values ('5eed0000-0000-4000-8000-00000000000c','payslip','2026-02-20',1,'prototype_migration')"],"state":"23514"},
  {"name":"C3: create_payment_record refuses prototype_migration","role":"owner","user":null,"sql":["select (fat.create_payment_record('5eed0000-0000-4000-8000-00000000000a','payslip','2025-09-01',1,'prototype_migration')).id::text"],"state":"23514"},
  {"name":"C3: migrated payment allocated and entitlement paid","role":"owner","user":null,"sql":["select payment_status from fat.claim_entitlements where id = '5eed0000-0000-4000-8000-0000000e0007'"],"value":"paid"},
  {"name":"WORK-172: rate_versions append-only (update)","role":"owner","user":null,"sql":["update fat.rate_versions set value = value + 1 where version_label = 'eba2020'"],"state":"42501"},
  {"name":"WORK-172: rate_versions append-only (delete)","role":"owner","user":null,"sql":["delete from fat.rate_versions where version_label = 'eba2020'"],"state":"42501"},
  {"name":"WORK-172: withdrawal is final","role":"owner","user":null,"sql":["update fat.rate_versions set withdrawn_at = null, withdrawn_reason = null where withdrawn_at is not null"],"state":"42501"},
  {"name":"WORK-172: one live version per rate/classification/date","role":"owner","user":null,"sql":["insert into fat.rate_versions (rate_id, version_label, value, effective_from, classification, source_kind, source_ref) select rate_id, 'dup', value, effective_from, classification, source_kind, 'dup' from fat.rate_versions where classification = 'lff'"],"state":"23505"},
  {"name":"WORK-172: classification domain is closed","role":"owner","user":null,"sql":["insert into fat.member_classifications (owner_id, classification, effective_from, source_ref) values ('5eed0000-0000-4000-8000-00000000000b','captain','2021-01-01','x')"],"state":"23514"},
  {"name":"WORK-172: LFF 4 h double-time estimate = 404.08 from stored versions","role":"owner","user":null,"sql":["select round(round(bp.value * f.value / d.value, 2) * m.value * 4, 2)::text from fat.rate_versions bp join fat.rates rb on rb.id=bp.rate_id and rb.code='enterprise_base_pay_weekly' and bp.classification='lff', fat.rate_versions f join fat.rates rf on rf.id=f.rate_id and rf.code='overtime_rate_factor', fat.rate_versions d join fat.rates rd on rd.id=d.rate_id and rd.code='overtime_hourly_divisor', fat.rate_versions m join fat.rates rm on rm.id=m.rate_id and rm.code='double_time_multiplier'"],"value":"404.08"},
  {"name":"WORK-172: mileage resolves to 1.50 from 2023-06-17, workbook 1.20 withdrawn","role":"owner","user":null,"sql":["select string_agg(value::text || case when withdrawn_at is null then '' else 'W' end, ',' order by effective_from) from fat.rate_versions rv join fat.rates r on r.id = rv.rate_id where r.code = 'travel_per_km'"],"value":"1.37,1.50,1.2000W"},
  {"name":"WORK-172: snapshot fields immutable","role":"owner","user":null,"sql":["update fat.claim_entitlements set generated_hours = 5 where id = '5eed0000-0000-4000-8000-0000000e0001'"],"state":"42501"},
  {"name":"WORK-172: override needs a reason","role":"owner","user":null,"sql":["update fat.claim_entitlements set edited_hours = 9, edited_note = null where id = '5eed0000-0000-4000-8000-0000000e0001'"],"state":"23514"},
  {"name":"WORK-172: fixture override audited","role":"owner","user":null,"sql":["select count(*)::text || ':' || bool_and(manual_override)::text from fat.entitlement_overrides o join fat.claim_entitlements e on e.id = o.entitlement_id where o.entitlement_id = '5eed0000-0000-4000-8000-0000000e0003' and o.field = 'edited_hours' and o.new_value = 4.25"],"value":"1:true"},
  {"name":"identity seam: override actor is the app identity","role":"app","user":"A","sql":["update fat.claim_entitlements set edited_hours = 4.5, edited_note = 'test' where id = '5eed0000-0000-4000-8000-0000000e0001'","select actor_id::text from fat.entitlement_overrides where entitlement_id = '5eed0000-0000-4000-8000-0000000e0001' order by created_at desc limit 1"],"value":"5eed0000-0000-4000-8000-00000000000a"},
  {"name":"identity seam: Neon Auth subject resolves to preserved legacy id","role":"owner","user":null,"sql":["select fat.resolve_app_identity('neon_auth','synthetic-neon-auth-user-c')::text"],"value":"5eed0000-0000-4000-8000-00000000000c"},
  {"name":"identity seam: legacy uid preserved as FAT owner id","role":"owner","user":null,"sql":["select (legacy_subject = id and origin = 'legacy_supabase')::text from fat.app_identities where id = '5eed0000-0000-4000-8000-00000000000c'"],"value":"true"},
  {"name":"identity seam: disabled identity no longer resolves","role":"owner","user":null,"sql":["update fat.app_identities set status = 'disabled' where id = '5eed0000-0000-4000-8000-00000000000c'","select coalesce(fat.resolve_app_identity('neon_auth','synthetic-neon-auth-user-c')::text, 'null')"],"value":"null"},
  {"name":"identity seam: one subject per provider","role":"owner","user":null,"sql":["insert into fat.identity_links (app_identity_id, provider, provider_subject, linked_by) values ('5eed0000-0000-4000-8000-00000000000b','neon_auth','synthetic-neon-auth-user-a','operator')"],"state":"23505"},
  {"name":"identity seam: legacy identity must keep its uid","role":"owner","user":null,"sql":["insert into fat.app_identities (id, email, origin, legacy_subject) values (gen_random_uuid(), 'x@example.invalid', 'legacy_supabase', gen_random_uuid())"],"state":"23514"},
  {"name":"identity seam: every profile has an app identity with the same id","role":"owner","user":null,"sql":["select count(*)::text from fat.profiles p left join fat.app_identities i on i.id = p.id where i.id is null"],"value":"0"},
  {"name":"identity seam: owner FK cascade from app identity","role":"owner","user":null,"sql":["delete from fat.app_identities where id = '5eed0000-0000-4000-8000-00000000000a'","select ((select count(*) from fat.operational_claims where owner_id = '5eed0000-0000-4000-8000-00000000000a') + (select count(*) from fat.financial_years where user_id = '5eed0000-0000-4000-8000-00000000000a'))::text"],"value":"0"},
  {"name":"payments: petty-cash allocation settled → claimed","role":"owner","user":null,"sql":["select payment_status from fat.claim_entitlements where id = '5eed0000-0000-4000-8000-0000000e0002'"],"value":"claimed"},
  {"name":"payments: over-allocation refused","role":"owner","user":null,"sql":["select fat.link_entitlement_payment('5eed0000-0000-4000-8000-0000000e0002','5eed0000-0000-4000-8000-0000000f0001',1.00,'discrepancy_note','5eed0000-0000-4000-8000-00000000000a')::text"],"state":"23514"},
  {"name":"payments: stream mismatch refused","role":"owner","user":null,"sql":["select fat.link_entitlement_payment('5eed0000-0000-4000-8000-0000000e0001','5eed0000-0000-4000-8000-0000000f0001',0,'manual','5eed0000-0000-4000-8000-00000000000a')::text"],"state":"P0001"},
  {"name":"payments: retract re-opens status and audits","role":"owner","user":null,"sql":["select fat.retract_payment('5eed0000-0000-4000-8000-0000000f0001','5eed0000-0000-4000-8000-00000000000a','test')::text","select e.payment_status || ':' || (select action from fat.reconciliation_audit a where a.entitlement_id = e.id order by created_at desc, action desc limit 1) from fat.claim_entitlements e where e.id = '5eed0000-0000-4000-8000-0000000e0002'"],"value":"outstanding:unlink_payment"},
  {"name":"payslip: confirm links line, entitlement paid","role":"app","user":"A","sql":["select fat.confirm_payslip_import_line('5eed0000-0000-4000-8000-0000000d0101','5eed0000-0000-4000-8000-00000000000a','5eed0000-0000-4000-8000-0000000e0001','manual')::text","select payment_status from fat.claim_entitlements where id = '5eed0000-0000-4000-8000-0000000e0001'"],"value":"paid"},
  {"name":"payslip: duplicate confirm refused","role":"app","user":"A","sql":["select fat.confirm_payslip_import_line('5eed0000-0000-4000-8000-0000000d0101','5eed0000-0000-4000-8000-00000000000a',null,null)::text","insert into fat.payslip_import_lines (import_id, owner_id, line_index, parsed_reference, parsed_description, parsed_amount, parsed_date) values ('5eed0000-0000-4000-8000-0000000d0001','5eed0000-0000-4000-8000-00000000000a',1,'SYN-PS-1','Maint Stn N/N',404.08,'2025-08-28') returning id::text"],"chain":"select fat.confirm_payslip_import_line(%L::uuid,'5eed0000-0000-4000-8000-00000000000a',null,null)::text","state":"23505"},
  {"name":"WORK-173: generator detail columns present","role":"owner","user":null,"sql":["select count(*)::text from information_schema.columns where table_schema = 'fat' and (table_name, column_name) in (('recall_details','recall_duty'),('recall_details','recall_travel_minutes'),('recall_details','recall_travel_sunday_or_ph'),('retain_details','retain_shift'),('retain_details','night_shift_interrupted'),('retain_details','retain_travel_home_minutes'),('delayed_meal_details','duty_start_at'),('delayed_meal_details','duty_end_at'),('standby_details','home_to_rostered_km'),('standby_details','home_to_target_km'),('muster_dismiss_details','home_to_rostered_km'),('muster_dismiss_details','home_to_target_km'))"],"value":"12"},
  {"name":"WORK-173: every claim type carries its detail row","role":"owner","user":null,"sql":["select string_agg(c.claim_type, ',' order by c.claim_type) from fat.operational_claims c where c.owner_id = '5eed0000-0000-4000-8000-00000000000a' and (exists (select 1 from fat.retain_details d where d.claim_id = c.id) or exists (select 1 from fat.recall_details d where d.claim_id = c.id) or exists (select 1 from fat.standby_details d where d.claim_id = c.id) or exists (select 1 from fat.muster_dismiss_details d where d.claim_id = c.id) or exists (select 1 from fat.spoilt_meal_details d where d.claim_id = c.id) or exists (select 1 from fat.delayed_meal_details d where d.claim_id = c.id))"],"value":"DM,MD,RC,RT,SB,SM"},
  {"name":"portability: no Supabase auth/storage/realtime dependency","role":"owner","user":null,"sql":["select ((select count(*) from pg_namespace where nspname in ('auth','storage','realtime','supabase_migrations','extensions','graphql')) + (select count(*) from pg_proc where pronamespace = 'fat'::regnamespace and prosrc ~* '\\m(auth|storage)\\.') + (select count(*) from pg_constraint where connamespace = 'fat'::regnamespace and contype = 'f' and confrelid::regclass::text !~ '^fat\\.') + (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')))::text"],"value":"0"},
  {"name":"synthetic only: every identity is reserved synthetic","role":"owner","user":null,"sql":["select (count(*) filter (where email !~ '@example\\.invalid$' or id::text !~ '^5eed'))::text from fat.app_identities"],"value":"0"},
  {"name":"synthetic only: no non-synthetic station","role":"owner","user":null,"sql":["select count(*)::text from fat.stations where id not between 9001 and 9003"],"value":"0"}
  ]$specs$;
  s jsonb;
  i int := 0;
  v_out text;
  v_state text;
  v_ok boolean;
  stmt text;
  n int;
begin
  for s in select * from jsonb_array_elements(specs) loop
    i := i + 1;
    v_out := null; v_state := null;
    begin
      execute format('grant fat_app to %I with inherit false, set true', current_user);
      perform set_config('fat.app_user_id',
        case s->>'user' when 'A' then A when 'B' then B when 'C' then C else '' end, true);
      if s->>'role' = 'app' then
        execute 'set local role fat_app';
      end if;
      n := jsonb_array_length(s->'sql');
      for k in 0 .. n - 1 loop
        stmt := s->'sql'->>k;
        if stmt ~* '^\s*(select|with)' or stmt ~* '\mreturning\M' then
          execute stmt into v_out;
        else
          execute stmt;
        end if;
      end loop;
      if s ? 'chain' then
        execute format(s->>'chain', v_out) into v_out;
      end if;
      v_state := '00000';
      raise exception using errcode = 'P0001', message = 'FATV_ROLLBACK';
    exception when others then
      if sqlerrm <> 'FATV_ROLLBACK' then
        v_state := sqlstate;
        v_out := left(sqlerrm, 160);
      end if;
    end;
    if s ? 'state' then
      v_ok := v_state = s->>'state';
    else
      v_ok := v_state = '00000' and v_out is not distinct from s->>'value';
    end if;
    insert into fat_verify_results values (i, s->>'name', v_ok, v_state || ' ' || coalesce(v_out, 'null'));
  end loop;
end;
$verify$;

select seq, ok, name, observed from fat_verify_results order by seq;
