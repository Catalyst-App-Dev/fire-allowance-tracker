-- C2/C3 cross-database verify (WORK-255) — batch c2:dev:2.0.0:e11f4436c36aede72a7a0374befb31af. Runs on the Neon TARGET as ONE transaction.
-- Changes nothing that survives: temp tables drop on commit; the fat_app RLS probe is always rolled back.
-- Never reads a prototype table: the source rows are the embedded snapshot, whose checksum is re-derived here.
do $c2verify$
declare
  v jsonb := $c2ver_5a0fa81fc8e1${"batch_key":"c2:dev:2.0.0:e11f4436c36aede72a7a0374befb31af","change_id":"fat-c2-dev-e11f4436c36aede72a7a0374","planned":{"adjustments":0,"claim_ids":[],"empty_claim_groups":0,"entitlement_ids":[],"financial_years":[],"identities":[],"ledger_by_disposition":{"claim":0,"entitlement":0,"excluded":0},"ledger_ids":[],"payment_links":0,"payment_record_ids":[]},"probe":{"other_owner":null,"owner":null,"owner_claims":0},"rows":[],"source_checksum":"fbe961f128305438f78cdea28dc112822c3e800b66f295c0d630b98edaadf7ff","tables":["claim_groups","claim_sequences","financial_years","recalls","retain","spoilt_meals","standby"]}$c2ver_5a0fa81fc8e1$::jsonb;
  bt record; src_sha text; res jsonb; probe jsonb := '{}'::jsonb; vn int;
begin
create temp table c2v_src on commit drop as
select x.t, x.id::uuid as id, x.canon, x.canon::jsonb as j, o.ord
from jsonb_array_elements(v->'rows') with ordinality o(e, ord), lateral jsonb_to_record(o.e) x(t text, id text, canon text);
select id, status, source_checksum, report into bt from fat.migration_batches where batch_key = v->>'batch_key';
select encode(sha256(convert_to('{' || string_agg(format('"%s":[%s]', tb.t, coalesce(g.rows, '')), ',' order by tb.t collate "C") || '}', 'UTF8')), 'hex')
into src_sha
from jsonb_array_elements_text(v->'tables') tb(t)
left join (select t, string_agg(canon, ',' order by ord) as rows from c2v_src group by t) g using (t);
create temp table c2v_val on commit drop as
select e.*, case when e.unit = 'dollars' then e.generated_amount else e.generated_hours end as target_value,
case e.prototype_component when 'meal_amount' then coalesce((s.j->>'meal_amount')::numeric, (s.j->>'total_amount')::numeric)
else (s.j->>e.prototype_component)::numeric end as source_value,
(s.j->>'adjusted_amount')::numeric as source_adjusted, s.id is not null as has_source,
case
when lower(btrim(s.j->>'payment_status')) = 'paid' and nullif(btrim(s.j->>'payment_date'), '') is not null then 'paid'
when lower(btrim(s.j->>'payment_status')) = 'pending' and nullif(btrim(s.j->>'payment_date'), '') is null then 'unpaid'
when nullif(btrim(s.j->>'payment_status'), '') is null and nullif(btrim(s.j->>'payment_date'), '') is null
and coalesce(lower(btrim(s.j->>'status')), 'pending') in ('pending', '') then 'unpaid'
else 'invalid' end as pay_state,
(s.j->>'payment_date')::timestamptz as pay_date,
case when e.unit = 'dollars' then coalesce(e.edited_amount, e.generated_amount)
when e.unit = 'hours' then (e.rate_snapshot->'historical_amount'->>'value')::numeric end as payable_amount
from fat.claim_entitlements e left join c2v_src s on s.t = e.prototype_source and s.id = e.prototype_row_id
where e.migration_batch_id = bt.id;
create temp table c2v_lnk on commit drop as
select l.*, x.id as ent_id, x.pay_state, x.payable_amount, x.prototype_source, x.prototype_row_id, x.prototype_component, x.owner_id as ent_owner,
x.payment_method, x.pay_date, r.owner_id as rec_owner, r.stream, r.source as rec_source, r.migration_source_key, r.gross_amount, r.record_date,
r.migration_batch_id as rec_batch
from fat.entitlement_payment_links l join c2v_val x on x.id = l.entitlement_id join fat.payment_records r on r.id = l.payment_record_id;
res := jsonb_build_object(
'batch', (select jsonb_build_object('id', bt.id, 'status', bt.status, 'outcome', bt.report->>'outcome', 'tool_version', bt.report#>>'{tool,version}',
'full_report_sha256', bt.report->>'full_report_sha256') where bt.id is not null),
'data_load', (select jsonb_build_object('change_id', d.change_id, 'kind', d.kind, 'checksum', d.checksum) from fat_migrations.data_loads d where d.change_id = v->>'change_id'),
'source_snapshot', jsonb_build_object('embedded_sha256', src_sha, 'plan_source_checksum', v->>'source_checksum', 'batch_source_checksum', bt.source_checksum,
'rows', (select count(*) from c2v_src), 'canon_parse_mismatches', (select count(*) from c2v_src where canon::jsonb is distinct from j)),
'ledger_checksum_mismatches', (select count(*) from fat.migration_source_rows l left join c2v_src s on s.t = l.source_table and s.id = l.source_row_id
where l.batch_id = bt.id and (s.id is null or encode(sha256(convert_to(s.canon, 'UTF8')), 'hex') <> l.source_checksum)),
'source_rows_without_exactly_one_ledger_row', (select count(*) from c2v_src s where s.t in ('claim_groups', 'recalls', 'retain', 'standby', 'spoilt_meals')
and (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.source_table = s.t and l.source_row_id = s.id) <> 1),
'planned_vs_target', jsonb_build_object(
'claims_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'claim_ids'))::uuid) p(id) where not exists (select 1 from fat.operational_claims c where c.id = p.id and c.migration_batch_id = bt.id)),
'claims_unplanned', (select count(*) from fat.operational_claims c where c.migration_batch_id = bt.id and c.id not in (select (jsonb_array_elements_text(v->'planned'->'claim_ids'))::uuid)),
'entitlements_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'entitlement_ids'))::uuid) p(id) where not exists (select 1 from fat.claim_entitlements e where e.id = p.id and e.migration_batch_id = bt.id)),
'entitlements_unplanned', (select count(*) from fat.claim_entitlements e where e.migration_batch_id = bt.id and e.id not in (select (jsonb_array_elements_text(v->'planned'->'entitlement_ids'))::uuid)),
'ledger_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'ledger_ids'))::uuid) p(id) where not exists (select 1 from fat.migration_source_rows l where l.id = p.id and l.batch_id = bt.id)),
'ledger_unplanned', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.id not in (select (jsonb_array_elements_text(v->'planned'->'ledger_ids'))::uuid)),
'payment_records_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'payment_record_ids'))::uuid) p(id) where not exists (select 1 from fat.payment_records r where r.id = p.id and r.migration_batch_id = bt.id)),
'payment_records_unplanned', (select count(*) from fat.payment_records r where r.migration_batch_id = bt.id and r.id not in (select (jsonb_array_elements_text(v->'planned'->'payment_record_ids'))::uuid)),
'payment_links', (select count(*) from c2v_lnk), 'payment_links_planned', (v->'planned'->>'payment_links')::int,
'adjustment_overrides', (select count(*) from fat.entitlement_overrides o join c2v_val x on x.id = o.entitlement_id where o.field = 'edited_amount'),
'adjustments_planned', (v->'planned'->>'adjustments')::int,
'duplicate_canonical_ids', (select count(*) - count(distinct id) from (select id from fat.operational_claims where migration_batch_id = bt.id
union all select id from fat.claim_entitlements where migration_batch_id = bt.id) z)),
'ledger_by_disposition', coalesce((select jsonb_object_agg(disposition, n) from (select disposition, count(*) n from fat.migration_source_rows where batch_id = bt.id group by 1) x), '{}'::jsonb),
'ledger_by_disposition_planned', v->'planned'->'ledger_by_disposition',
'gate1_empty_claim_groups', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.exclusion_code in ('EMPTY_CLAIM_GROUP')),
'gate1_empty_claim_groups_planned', (v->'planned'->>'empty_claim_groups')::int,
'gate1_empty_group_violations', (select count(*) from fat.migration_source_rows l left join c2v_src s on s.t = 'claim_groups' and s.id = l.source_row_id
where l.batch_id = bt.id and l.exclusion_code in ('EMPTY_CLAIM_GROUP') and (l.source_table <> 'claim_groups' or l.target_claim_id is not null or l.source_snapshot is null
or exists (select 1 from c2v_src m where m.t in ('recalls', 'retain', 'standby', 'spoilt_meals') and m.j->>'claim_group_id' = l.source_row_id::text)
or exists (select 1 from fat.operational_claims c where c.prototype_claim_group_id = l.source_row_id))),
'gate1_groups_without_exactly_one_disposition', (select count(*) from c2v_src s where s.t = 'claim_groups'
and (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.source_table = 'claim_groups' and l.source_row_id = s.id) <> 1),
'gate2_number_or_fy_mismatch', (select count(*) from fat.operational_claims c join c2v_src s on s.t = c.prototype_source and s.id = c.prototype_row_id
left join c2v_src g on g.t = 'claim_groups' and g.id = c.prototype_claim_group_id
where c.migration_batch_id = bt.id and (c.claim_number is distinct from coalesce((g.j->>'claim_number')::int, (s.j->>'claim_number')::int)
or c.financial_year_id is distinct from coalesce((g.j->>'financial_year_id')::uuid, (s.j->>'financial_year_id')::uuid))),
'gate2_scope_duplicates', (select count(*) from (select 1 from fat.operational_claims where claim_number is not null group by owner_id, financial_year_id, claim_type, claim_number having count(*) > 1) x),
'gate3_bad_detail', (select count(*) from fat.operational_claims c where c.migration_batch_id = bt.id and (
(select count(*) from fat.recall_details d where d.claim_id = c.id) + (select count(*) from fat.retain_details d where d.claim_id = c.id) + (select count(*) from fat.standby_details d where d.claim_id = c.id) + (select count(*) from fat.muster_dismiss_details d where d.claim_id = c.id) + (select count(*) from fat.spoilt_meal_details d where d.claim_id = c.id) + (select count(*) from fat.delayed_meal_details d where d.claim_id = c.id) <> 1
or (case c.claim_type when 'RC' then (select count(*) from fat.recall_details d where d.claim_id = c.id) when 'RT' then (select count(*) from fat.retain_details d where d.claim_id = c.id) when 'SB' then (select count(*) from fat.standby_details d where d.claim_id = c.id) when 'MD' then (select count(*) from fat.muster_dismiss_details d where d.claim_id = c.id) when 'SM' then (select count(*) from fat.spoilt_meal_details d where d.claim_id = c.id) when 'DM' then (select count(*) from fat.delayed_meal_details d where d.claim_id = c.id) end) <> 1)),
'gate3_parents_without_claim', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.disposition = 'claim' and l.source_table <> 'claim_groups'
and not exists (select 1 from fat.operational_claims c where c.migration_batch_id = bt.id and c.prototype_source = l.source_table and c.prototype_row_id = l.source_row_id)),
'gate4_child_violations', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.disposition <> 'claim' and (
(l.disposition = 'entitlement' and (select count(*) from c2v_val e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 1)
or (l.disposition = 'excluded' and ((select count(*) from fat.claim_entitlements e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 0
or l.exclusion_code not in ('G12_FAKE_RECALL_EXCESS_TRAVEL', 'EMPTY_CLAIM_GROUP') or l.source_snapshot is null)))),
'gate5_missing_source_rows', (select count(*) from c2v_val where not has_source),
'gate5_value_mismatches', (select count(*) from c2v_val where has_source and target_value is distinct from source_value),
'gate5_adjustment_mismatches', (select count(*) from c2v_val where has_source and (edited_amount is distinct from (case when edited_source is not null then source_adjusted end))),
'gate5_totals', jsonb_build_object(
'dollars_target', (select coalesce(sum(target_value), 0) from c2v_val where unit = 'dollars'),
'dollars_source', (select coalesce(sum(source_value), 0) from c2v_val where unit = 'dollars'),
'hours_target', (select coalesce(sum(target_value), 0) from c2v_val where unit = 'hours'),
'hours_source', (select coalesce(sum(source_value), 0) from c2v_val where unit = 'hours')),
'gate6_source_states', coalesce((select jsonb_object_agg(pay_state, n) from (select pay_state, count(*) n from c2v_val where has_source group by 1) x), '{}'::jsonb),
'gate6_source_invalid', (select count(*) from c2v_val where has_source and pay_state = 'invalid'),
'gate6_paid_without_exactly_one_migration_link', (select count(*) from c2v_val x where x.pay_state = 'paid' and (
(select count(*) from c2v_lnk where c2v_lnk.ent_id = x.id) <> 1
or (select count(*) from c2v_lnk where c2v_lnk.ent_id = x.id and c2v_lnk.link_kind = 'manual' and c2v_lnk.rec_source = 'prototype_migration' and c2v_lnk.rec_batch = bt.id
and c2v_lnk.migration_source_key = 'c3:' || x.prototype_source || ':' || x.prototype_row_id || ':' || x.prototype_component) <> 1)),
'gate6_unpaid_with_links', (select count(*) from c2v_val x where x.pay_state <> 'paid' and exists (select 1 from c2v_lnk where c2v_lnk.ent_id = x.id)),
'gate6_allocation_mismatches', (select count(*) from c2v_lnk where pay_state = 'paid' and (allocated_amount is distinct from round(payable_amount, 2) or gross_amount is distinct from allocated_amount)),
'gate6_record_date_mismatches', (select count(*) from c2v_lnk where pay_state = 'paid' and record_date is distinct from (pay_date at time zone 'Australia/Melbourne')::date),
'gate6_status_mismatches', (select count(*) from c2v_val x where x.has_source and x.payment_status is distinct from (case
when x.pay_state = 'paid' then case x.payment_method when 'payslip' then 'paid' when 'petty_cash' then 'claimed' end
else case x.payment_method when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end end)),
'gate6_audit_mismatches', (select count(*) from c2v_lnk k where (select count(*) from fat.reconciliation_audit a
where a.entitlement_id = k.ent_id and a.action = 'link_payment' and a.reason = k.note and a.automated) <> 1),
'gate6_unlinked_migration_records', (select count(*) from fat.payment_records r where r.migration_batch_id = bt.id and not exists (select 1 from fat.entitlement_payment_links l where l.payment_record_id = r.id)),
'gate6_duplicate_source_keys', (select count(*) from (select 1 from fat.payment_records where migration_source_key is not null group by migration_source_key having count(*) > 1) x),
'gate6_totals', jsonb_build_object(
'source_paid_entitlements', (select count(*) from c2v_val where pay_state = 'paid'),
'source_paid_amount', (select coalesce(sum(round(payable_amount, 2)), 0) from c2v_val where pay_state = 'paid'),
'migration_records', (select count(*) from fat.payment_records where migration_batch_id = bt.id),
'links_on_lineage', (select count(*) from c2v_lnk),
'allocated_amount', (select coalesce(sum(allocated_amount), 0) from c2v_lnk)),
'gate7_cross_owner_entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where e.migration_batch_id = bt.id and e.owner_id <> c.owner_id),
'gate7_cross_owner_fy', (select count(*) from fat.operational_claims c join fat.financial_years f on f.id = c.financial_year_id where c.migration_batch_id = bt.id and f.user_id <> c.owner_id),
'gate7_ledger_orphan_or_cross_owner', (select count(*) from fat.migration_source_rows l left join fat.operational_claims c on c.id = l.target_claim_id
where l.batch_id = bt.id and l.target_claim_id is not null and (c.id is null or c.owner_id <> l.owner_id)),
'gate7_orphan_details', (select (select count(*) from fat.recall_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id)) + (select count(*) from fat.retain_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id)) + (select count(*) from fat.standby_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id)) + (select count(*) from fat.muster_dismiss_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id)) + (select count(*) from fat.spoilt_meal_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id)) + (select count(*) from fat.delayed_meal_details d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id))),
'gate7_payment_links_cross_owner_or_stream', (select count(*) from c2v_lnk where rec_owner <> ent_owner or stream is distinct from payment_method),
'gateI_identity_violations', (select count(*) from (select owner_id from fat.operational_claims where migration_batch_id = bt.id
union select owner_id from fat.migration_source_rows where batch_id = bt.id) o
where not exists (select 1 from fat.app_identities i join fat.profiles p on p.id = i.id
where i.id = o.owner_id and i.origin = 'legacy_supabase' and i.legacy_subject = i.id and i.status = 'active')),
'gateI_planned_identities_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'identities'))::uuid) p(id) where not exists (select 1 from fat.app_identities i where i.id = p.id and i.origin = 'legacy_supabase' and i.legacy_subject = p.id)),
'gateI_planned_fys_missing', (select count(*) from (select (jsonb_array_elements_text(v->'planned'->'financial_years'))::uuid) p(id) where not exists (select 1 from fat.financial_years f where f.id = p.id)),
'gate7_security', jsonb_build_object(
'rls_disabled', (select count(*) from pg_class where relnamespace = 'fat'::regnamespace and relkind = 'r' and not relrowsecurity),
'fat_app_privileges_on_protected_tables', (select count(*) from (values ('fat.migration_batches'), ('fat.migration_source_rows'), ('fat.identity_links')) t(tbl), (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
where has_table_privilege('fat_app', t.tbl, p.priv)),
'fat_app_can_write_identities', (select count(*) from (values ('INSERT'), ('UPDATE'), ('DELETE')) p(priv) where has_table_privilege('fat_app', 'fat.app_identities', p.priv))
+ case when has_function_privilege('fat_app', 'fat.ensure_app_identity(uuid, text, text)', 'EXECUTE') then 1 else 0 end,
'fat_service_missing_migration_access', (select count(*) from (values ('fat.migration_batches'), ('fat.migration_source_rows')) t(tbl), (values ('SELECT'), ('INSERT'), ('DELETE')) p(priv)
where not has_table_privilege('fat_service', t.tbl, p.priv)),
'roles_login_or_bypassrls', (select count(*) from pg_roles where rolname in ('fat_app', 'fat_service') and (rolcanlogin or rolbypassrls or rolsuper)),
'public_executable_functions', (select count(*) from pg_proc p where p.pronamespace = 'fat'::regnamespace
and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
'provenance_guards_missing', 3 - (select count(*) from pg_trigger where tgname = 'guard_migration_provenance' and not tgisinternal
and tgrelid in ('fat.operational_claims'::regclass, 'fat.claim_entitlements'::regclass, 'fat.payment_records'::regclass)),
'no_api_access_policies_missing', 3 - (select count(*) from pg_policies where schemaname = 'fat' and policyname = 'no_api_access'
and tablename in ('migration_batches', 'migration_source_rows', 'identity_links')),
'supabase_api_roles_present', (select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role'))),
'native', (select jsonb_build_object(
'claims', (select count(*) from fat.operational_claims c where c.prototype_row_id is null and c.migration_batch_id is null),
'entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null),
'fingerprint', md5(coalesce((select string_agg((to_jsonb(c) || jsonb_build_object('created_at', extract(epoch from c.created_at), 'updated_at', extract(epoch from c.updated_at), 'generated_at', extract(epoch from c.generated_at)))::text, '|' order by c.id) from fat.operational_claims c where c.prototype_row_id is null and c.migration_batch_id is null), '')
|| coalesce((select string_agg((to_jsonb(e) || jsonb_build_object('generated_at', extract(epoch from e.generated_at), 'updated_at', extract(epoch from e.updated_at)))::text, '|' order by e.id) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
|| coalesce((select string_agg((to_jsonb(d) || jsonb_build_object('standby_start_at', extract(epoch from d.standby_start_at), 'standby_end_at', extract(epoch from d.standby_end_at)))::text, '|' order by d.claim_id) from fat.standby_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
|| coalesce((select string_agg((to_jsonb(d) || jsonb_build_object('md_event_at', extract(epoch from d.md_event_at)))::text, '|' order by d.claim_id) from fat.muster_dismiss_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')))));
begin
execute format('grant fat_app to %I with inherit false, set true', current_user);
perform set_config('fat.app_user_id', coalesce(v#>>'{probe,owner}', ''), true);
execute 'set local role fat_app';
select count(*) into vn from fat.operational_claims where id in (select (jsonb_array_elements_text(v->'planned'->'claim_ids'))::uuid);
probe := jsonb_build_object('owner', v#>>'{probe,owner}', 'owner_sees_own_migrated_claims', vn, 'expected', (v#>>'{probe,owner_claims}')::int);
select count(*) into vn from fat.claim_entitlements where id in (select (jsonb_array_elements_text(v->'planned'->'entitlement_ids'))::uuid) and owner_id <> fat.current_app_user_id();
probe := probe || jsonb_build_object('owner_sees_other_owners_entitlements', vn);
perform set_config('fat.app_user_id', coalesce(v#>>'{probe,other_owner}', ''), true);
select count(*) into vn from fat.operational_claims where id in (select (jsonb_array_elements_text(v->'planned'->'claim_ids'))::uuid) and owner_id = (v#>>'{probe,owner}')::uuid;
probe := probe || jsonb_build_object('other_owner_sees_owner_claims', vn);
perform set_config('fat.app_user_id', '', true);
select count(*) into vn from fat.operational_claims where id in (select (jsonb_array_elements_text(v->'planned'->'claim_ids'))::uuid);
probe := probe || jsonb_build_object('unset_identity_sees', vn);
begin
perform count(*) from fat.migration_source_rows;
probe := probe || jsonb_build_object('ledger_readable_by_fat_app', true);
exception when insufficient_privilege then
probe := probe || jsonb_build_object('ledger_readable_by_fat_app', false);
end;
raise exception using errcode = 'P0001', message = 'C2V_ROLLBACK';
exception when others then
if sqlerrm <> 'C2V_ROLLBACK' then probe := probe || jsonb_build_object('error', sqlerrm); end if;
end;
res := res || jsonb_build_object('rls_probe', probe);
  perform set_config('fat_c2.verify_result', res::text, true);
end
$c2verify$;
select nullif(current_setting('fat_c2.verify_result', true), '')::jsonb as verify;
