// ─── C2 transform — SQL emitter (WORK-190) ──────────────────────────────────
// Portable PostgreSQL (no Supabase API, no extensions beyond core): runs from
// psql, the Supabase SQL editor / MCP, or a Neon console (GOV-481).
//
//   extractSql()            read-only: one row, column `snapshot` (jsonb)
//   applySql(plan)          atomic DO block: insert-if-absent, then PROVE every
//                           planned row equals the stored row; any difference
//                           raises and rolls the whole run back. Returns
//                           `apply_result` (inserted vs verified-existing counts).
//   verifySql(batchKey)     read-only: gates re-proved from the database itself
//   rollbackSql(batchKey)   rehearsal reset: removes only rows tagged to the batch
//   syntheticHarnessSql()   DEV rehearsal of transaction-scoped synthetic fixtures;
//                           ends in RAISE so nothing it wrote can persist.
//
// Data enters SQL only as one dollar-quoted JSON literal per plan (no per-value
// escaping); the tag is derived from the content and asserted absent from it.

import { CLAIM_COLUMNS, DETAIL_COLUMNS, ENTITLEMENT_COLUMNS, LEDGER_COLUMNS, DETAIL_TABLE, SOURCE_TABLES, EXCLUSIONS } from './constants.js'
import { canonicalJson, sha256 } from './util.js'

const BATCH_KEY = /^[a-z0-9:._-]{1,200}$/

function literal(json, prefix) {
  const tag = `$${prefix}_${sha256(json).slice(0, 12)}$`
  if (json.includes(tag)) throw new Error('dollar-quote tag collision')
  return `${tag}${json}${tag}`
}

const quoteKey = (k) => {
  if (!BATCH_KEY.test(k)) throw new Error(`unsafe batch key ${k}`)
  return `'${k}'`
}

/** Plan → the JSON the SQL consumes (adjustments merged onto their entitlements). */
export function planPayload(plan) {
  const adj = new Map(plan.adjustments.map((a) => [a.id, a]))
  return {
    batch: { batch_key: plan.batch_key, environment: plan.environment, source_checksum: plan.source_checksum, report: plan.report },
    claims: plan.claims,
    details: plan.details,
    entitlements: plan.entitlements.map((e) => ({
      ...e, edited_hours: null,
      edited_amount: adj.get(e.id)?.edited_amount ?? null,
      edited_note: adj.get(e.id)?.edited_note ?? null,
      edited_source: adj.get(e.id)?.edited_source ?? null,
    })),
    ledger: plan.ledger,
  }
}

// ── Extraction ──────────────────────────────────────────────────────────────

// Rate codes the WORK-173 generators read (lib/fat/engine/context.js), extracted only when there is source.
const GENERATOR_RATE_CODES = ['enterprise_base_pay_weekly', 'overtime_rate_factor', 'overtime_hourly_divisor', 'double_time_multiplier',
  'single_time_multiplier', 'time_and_half_multiplier', 'travel_per_km', 'meal_allowance', 'spoilt_meal_allowance', 'relieving_allowance']

/**
 * The snapshot expression. Reference rows are limited to what the source
 * references (its owners, FYs and stations; generator rate codes only when
 * there is any source), so the batch fingerprint changes only when an input
 * that can change the result changes. `sourceJson` (a JSON literal) replaces
 * the live tables for the synthetic rehearsal.
 */
function extractExpr(sourceJson = null) {
  const live = SOURCE_TABLES.map((t) => `'${t}', coalesce((select jsonb_agg(to_jsonb(t) order by t.id) from fat.${t} t), '[]'::jsonb)`).join(',\n        ')
  const srcSelect = sourceJson ? `select ${literal(sourceJson, 'c2src')}::jsonb as s` : `select jsonb_build_object(\n        ${live}) as s`
  const ids = (paths) => `(select distinct v #>> '{}' from src, lateral (${paths.map((p) => `select jsonb_path_query(src.s, '$.*[*].${p}')`).join(' union all ')}) q(v) where jsonb_typeof(v) <> 'null')`
  return `(with src as (${srcSelect}),
    has_source as (select exists (select 1 from src, jsonb_path_query(src.s, '$.*[*]')) as yes)
  select jsonb_build_object(
    'schema', 'fat.c2.source-snapshot/v1',
    'source', (select s from src),
    'reference', jsonb_build_object(
      'financial_years', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'user_id', user_id, 'label', label, 'start_date', start_date, 'end_date', end_date) order by id)
          from fat.financial_years where id::text in ${ids(['financial_year_id'])}), '[]'::jsonb),
      'stations', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by id)
          from fat.stations where id::text in ${ids(['rostered_stn_id', 'recall_stn_id', 'station_id', 'standby_stn_id'])}), '[]'::jsonb),
      'profiles', coalesce((select jsonb_agg(id order by id) from fat.profiles where id::text in ${ids(['user_id'])}), '[]'::jsonb),
      'rates', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'unit', unit) order by id) from fat.rates
          where (select yes from has_source) and code in (${GENERATOR_RATE_CODES.map((c) => `'${c}'`).join(', ')})), '[]'::jsonb),
      'rate_versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'rate_id', v.rate_id, 'version_label', v.version_label, 'value', v.value, 'effective_from', v.effective_from,
            'classification', v.classification, 'source_kind', v.source_kind, 'source_ref', v.source_ref, 'withdrawn_at', v.withdrawn_at) order by v.id)
          from fat.rate_versions v join fat.rates r on r.id = v.rate_id
          where (select yes from has_source) and r.code in (${GENERATOR_RATE_CODES.map((c) => `'${c}'`).join(', ')})), '[]'::jsonb),
      'member_classifications', coalesce((select jsonb_agg(jsonb_build_object('owner_id', owner_id, 'classification', classification, 'effective_from', effective_from) order by owner_id, effective_from, id)
          from fat.member_classifications where owner_id::text in ${ids(['user_id'])}), '[]'::jsonb)),
    'target', jsonb_build_object(
      'native_claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'owner_id', c.owner_id, 'claim_type', c.claim_type, 'claim_date', c.claim_date, 'station_id_snapshot', c.station_id_snapshot,
          'dest_station_id', coalesce(sd.standby_station_id, md.md_station_id)) order by c.id)
        from fat.operational_claims c
        left join fat.standby_details sd on sd.claim_id = c.id
        left join fat.muster_dismiss_details md on md.claim_id = c.id
        where c.prototype_row_id is null and c.migration_batch_id is null), '[]'::jsonb))))`
}

/** Synthetic rehearsal input: the fixture is the source; reference/target come from the database. */
export function fixtureSnapshotSql(fixtureSource) {
  return `-- C2 synthetic snapshot (WORK-190). Read-only: the fixture JSON is the source; reference and target are read from the database.\nselect ${extractExpr(canonicalJson(fixtureSource))} as snapshot;\n`
}

export function extractSql() {
  return `-- C2 source extraction (WORK-190). Read-only. Run as the DB owner / service role.\nselect ${extractExpr()} as snapshot;\n`
}

// ── Apply ───────────────────────────────────────────────────────────────────

const cols = (list, alias) => list.map((c) => `${alias}.${c}`).join(', ')
const tuple = (list, alias) => `(${cols(list, alias)})`

/**
 * PL/pgSQL statements applying the plan held in variable `c2_plan` and leaving
 * counters in `c2_result`. Caller declares `c2_plan jsonb; c2_result jsonb;`.
 */
export function applyBlock(label = 'c2_apply') {
  const claimCmp = [...CLAIM_COLUMNS.filter((c) => c !== 'id'), 'parent_claim_id', 'copy_source_owner_id']
  const entCmp = [...ENTITLEMENT_COLUMNS.filter((c) => c !== 'id'), 'edited_amount', 'edited_hours', 'edited_note', 'edited_source']
  const ledCmp = LEDGER_COLUMNS.filter((c) => c !== 'id')
  const detailLoops = Object.values(DETAIL_TABLE).map((t) => `
    for r_${t} in select * from jsonb_populate_recordset(null::fat.${t}, c2_plan->'details'->'${t}') loop
      insert into fat.${t} (${DETAIL_COLUMNS[t].join(', ')}) values (${cols(DETAIL_COLUMNS[t], `r_${t}`)}) on conflict do nothing;
      get diagnostics n = row_count; ins_details := ins_details + n; tot_details := tot_details + 1;
      select * into e_${t} from fat.${t} where claim_id = r_${t}.claim_id;
      if not found or e_${t} is distinct from r_${t} then
        raise exception 'C2 conflict: fat.${t} row for claim % differs from the planned canonical row', r_${t}.claim_id using errcode = 'P0001';
      end if;
    end loop;`).join('')
  const detailDecl = Object.values(DETAIL_TABLE).map((t) => `r_${t} fat.${t}; e_${t} fat.${t};`).join(' ')
  return `
  <<${label}>>
  declare
    b uuid; n int; nb int := 0;
    ins_claims int := 0; ins_details int := 0; ins_ents int := 0; ins_adj int := 0; ins_ledger int := 0;
    tot_claims int := 0; tot_details int := 0; tot_ents int := 0; tot_ledger int := 0;
    rc fat.operational_claims; ec fat.operational_claims;
    re fat.claim_entitlements; ee fat.claim_entitlements;
    rl fat.migration_source_rows; el fat.migration_source_rows;
    ${detailDecl}
    k text := c2_plan#>>'{batch,batch_key}';
  begin
    -- Batch envelope: same key ⇒ same definition and byte-equal report, else conflict.
    insert into fat.migration_batches (batch_key, step, environment, tool, tool_version, source_checksum, status, completed_at, report, notes)
    values (k, 'C2', c2_plan#>>'{batch,environment}', c2_plan#>>'{batch,report,tool,name}', c2_plan#>>'{batch,report,tool,version}',
            c2_plan#>>'{batch,source_checksum}', 'completed', now(), c2_plan#>'{batch,report}',
            'C2 transform-copy (WORK-190); evidence_class=' || (c2_plan#>>'{batch,report,evidence_class}'))
    on conflict (batch_key) do nothing;
    get diagnostics nb = row_count;
    select id into b from fat.migration_batches
     where batch_key = k and step = 'C2' and environment = c2_plan#>>'{batch,environment}'
       and tool = c2_plan#>>'{batch,report,tool,name}' and tool_version = c2_plan#>>'{batch,report,tool,version}'
       and source_checksum = c2_plan#>>'{batch,source_checksum}' and status = 'completed' and report = c2_plan#>'{batch,report}';
    if b is null then
      raise exception 'C2 conflict: batch % exists with a different definition, status or report', k using errcode = 'P0001';
    end if;

    for rc in select * from jsonb_populate_recordset(null::fat.operational_claims, c2_plan->'claims') loop
      rc.migration_batch_id := b;
      insert into fat.operational_claims (${CLAIM_COLUMNS.join(', ')}, migration_batch_id)
      values (${cols(CLAIM_COLUMNS, 'rc')}, rc.migration_batch_id) on conflict do nothing;
      get diagnostics n = row_count; ins_claims := ins_claims + n; tot_claims := tot_claims + 1;
      select * into ec from fat.operational_claims where id = rc.id;
      if not found or ${tuple(claimCmp, 'ec')} is distinct from ${tuple(claimCmp, 'rc')} then
        raise exception 'C2 conflict: operational_claims % differs from the planned canonical row (or its lineage is held by another row)', rc.id using errcode = 'P0001';
      end if;
    end loop;
${detailLoops}

    for re in select * from jsonb_populate_recordset(null::fat.claim_entitlements, c2_plan->'entitlements') loop
      insert into fat.claim_entitlements (${ENTITLEMENT_COLUMNS.join(', ')}, manual_override, migration_batch_id)
      values (${cols(ENTITLEMENT_COLUMNS, 're')}, false, b) on conflict do nothing;
      get diagnostics n = row_count; ins_ents := ins_ents + n; tot_ents := tot_ents + 1;
      if n = 1 and re.edited_amount is not null then
        -- Manual adjustment through the audited override path (WORK-172 trigger writes fat.entitlement_overrides).
        update fat.claim_entitlements set edited_amount = re.edited_amount, edited_note = re.edited_note, edited_source = re.edited_source
         where id = re.id;
        ins_adj := ins_adj + 1;
      end if;
      select * into ee from fat.claim_entitlements where id = re.id;
      if not found or ${tuple(entCmp, 'ee')} is distinct from ${tuple(entCmp, 're')} then
        raise exception 'C2 conflict: claim_entitlements % differs from the planned preserved entitlement', re.id using errcode = 'P0001';
      end if;
    end loop;

    for rl in select * from jsonb_populate_recordset(null::fat.migration_source_rows, c2_plan->'ledger') loop
      insert into fat.migration_source_rows (${LEDGER_COLUMNS.join(', ')}, batch_id)
      values (${cols(LEDGER_COLUMNS, 'rl')}, b) on conflict do nothing;
      get diagnostics n = row_count; ins_ledger := ins_ledger + n; tot_ledger := tot_ledger + 1;
      select * into el from fat.migration_source_rows where id = rl.id;
      if not found or ${tuple(ledCmp, 'el')} is distinct from ${tuple(ledCmp, 'rl')} then
        raise exception 'C2 conflict: migration_source_rows % (% %) differs from the planned disposition', rl.id, rl.source_table, rl.source_row_id using errcode = 'P0001';
      end if;
    end loop;

    -- Postconditions: nothing tagged to this batch outside the plan.
    select count(*) into n from fat.operational_claims
     where migration_batch_id = b and id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'claims') x);
    if n > 0 then raise exception 'C2 postcondition: % claim(s) tagged to batch % are not in the plan', n, k using errcode = 'P0001'; end if;
    select count(*) into n from fat.claim_entitlements
     where migration_batch_id = b and id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'entitlements') x);
    if n > 0 then raise exception 'C2 postcondition: % entitlement(s) tagged to batch % are not in the plan', n, k using errcode = 'P0001'; end if;
    select count(*) into n from fat.migration_source_rows
     where batch_id = b and id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'ledger') x);
    if n > 0 then raise exception 'C2 postcondition: % ledger row(s) of batch % are not in the plan', n, k using errcode = 'P0001'; end if;

    -- Gate 3: exactly one detail row, in the correct table, per planned claim.
    select count(*) into n from jsonb_array_elements(c2_plan->'claims') x, lateral (select
        (select count(*) from fat.recall_details where claim_id = (x->>'id')::uuid) rc,
        (select count(*) from fat.retain_details where claim_id = (x->>'id')::uuid) rt,
        (select count(*) from fat.standby_details where claim_id = (x->>'id')::uuid) sb,
        (select count(*) from fat.muster_dismiss_details where claim_id = (x->>'id')::uuid) md,
        (select count(*) from fat.spoilt_meal_details where claim_id = (x->>'id')::uuid) sm,
        (select count(*) from fat.delayed_meal_details where claim_id = (x->>'id')::uuid) dm) d
     where d.rc + d.rt + d.sb + d.md + d.sm + d.dm <> 1
        or (case x->>'claim_type' when 'RC' then d.rc when 'RT' then d.rt when 'SB' then d.sb when 'MD' then d.md when 'SM' then d.sm else d.dm end) <> 1;
    if n > 0 then raise exception 'C2 postcondition (gate 3): % claim(s) without exactly one correct detail row', n using errcode = 'P0001'; end if;

    -- Gate 4: per consumed child row, exactly the planned entitlements (none for an exclusion).
    select count(*) into n from jsonb_array_elements(c2_plan->'ledger') x
     where x->>'disposition' <> 'claim'
       and (select count(*) from fat.claim_entitlements e where e.prototype_source = x->>'source_table' and e.prototype_row_id = (x->>'source_row_id')::uuid)
           <> (select count(*) from jsonb_array_elements(c2_plan->'entitlements') y where y->>'prototype_source' = x->>'source_table' and y->>'prototype_row_id' = x->>'source_row_id');
    if n > 0 then raise exception 'C2 postcondition (gate 4): % child row(s) do not map to exactly their planned entitlements', n using errcode = 'P0001'; end if;
    select count(*) into n from jsonb_array_elements(c2_plan->'ledger') x
     where x->>'disposition' = 'excluded' and x->>'exclusion_code' not in (${Object.keys(EXCLUSIONS).map((c) => `'${c}'`).join(', ')});
    if n > 0 then raise exception 'C2 postcondition (gate 4): unapproved exclusion code' using errcode = 'P0001'; end if;

    -- Manual adjustments carry exactly one audited override row.
    select count(*) into n from jsonb_array_elements(c2_plan->'entitlements') x
     where x->>'edited_source' is not null
       and (select count(*) from fat.entitlement_overrides o where o.entitlement_id = (x->>'id')::uuid and o.field = 'edited_amount' and o.source_ref = x->>'edited_source') <> 1;
    if n > 0 then raise exception 'C2 postcondition: % adjustment(s) without exactly one audited override', n using errcode = 'P0001'; end if;

    c2_result := jsonb_build_object(
      'batch_key', k, 'batch_id', b, 'batch_inserted', nb,
      'claims', jsonb_build_object('planned', tot_claims, 'inserted', ins_claims, 'verified_existing', tot_claims - ins_claims),
      'details', jsonb_build_object('planned', tot_details, 'inserted', ins_details, 'verified_existing', tot_details - ins_details),
      'entitlements', jsonb_build_object('planned', tot_ents, 'inserted', ins_ents, 'verified_existing', tot_ents - ins_ents, 'adjustments_applied', ins_adj),
      'ledger', jsonb_build_object('planned', tot_ledger, 'inserted', ins_ledger, 'verified_existing', tot_ledger - ins_ledger));
  end ${label};`
}

/** SHA-256 of the exact plan text embedded in apply SQL (and returned by it as plan_sha256). */
export const planSha256 = (plan) => sha256(canonicalJson(planPayload(plan)))

export function applySql(plan) {
  if (plan.report.outcome !== 'pass') {
    throw new Error(`C2 apply refused: acceptance gates fail (${Object.entries(plan.report.gates).filter(([, g]) => g.status === 'fail').map(([k]) => k).join(', ')}). Fix the source or the tool; nothing is written.`)
  }
  const json = canonicalJson(planPayload(plan))
  return `-- C2 transform-copy apply (WORK-190) — batch ${plan.batch_key}
-- Generated by scripts/c2-transform.mjs. Atomic; safe to re-run: an identical
-- rerun inserts nothing and proves equivalence; any difference raises.
-- Run as the DB owner / service role, e.g. psql --single-transaction -f apply.sql
do $c2apply$
declare
  c2_plan_text text := ${literal(json, 'c2plan')};
  c2_plan jsonb := c2_plan_text::jsonb;
  c2_result jsonb;
begin
${applyBlock()}
  -- plan_sha256 proves the SQL that ran carried exactly the reviewed plan (compare with plan.sha256).
  c2_result := c2_result || jsonb_build_object('plan_sha256', encode(sha256(convert_to(c2_plan_text, 'UTF8')), 'hex'));
  perform set_config('fat_c2.apply_result', c2_result::text, false);
end
$c2apply$;
select current_setting('fat_c2.apply_result')::jsonb as apply_result;
`
}

// ── Verify (read-only) ──────────────────────────────────────────────────────

function verifyExpr(batchKey) {
  const k = quoteKey(batchKey)
  const srcUnion = ['recalls', 'retain', 'standby', 'spoilt_meals'].map((t) => `select '${t}'::text t, s.id, to_jsonb(s) j from fat.${t} s`).join(' union all ')
  const detailTables = Object.values(DETAIL_TABLE)
  return `(with
  b as (select id, status, report from fat.migration_batches where batch_key = ${k}),
  lin as (select c.* from fat.operational_claims c where c.prototype_row_id is not null),
  ents as (select e.* from fat.claim_entitlements e where e.prototype_row_id is not null),
  src as (${srcUnion}),
  val as (select e.*, case when e.unit = 'dollars' then e.generated_amount else e.generated_hours end as target_value,
             case e.prototype_component when 'meal_amount' then coalesce((s.j->>'meal_amount')::numeric, (s.j->>'total_amount')::numeric)
                  else (s.j->>e.prototype_component)::numeric end as source_value,
             (s.j->>'adjusted_amount')::numeric as source_adjusted, s.id is not null as has_source
          from ents e left join src s on s.t = e.prototype_source and s.id = e.prototype_row_id)
  select jsonb_build_object(
    'batch', (select jsonb_build_object('id', id, 'status', status, 'outcome', report->>'outcome', 'report_sha256', encode(sha256(convert_to(report::text, 'UTF8')), 'hex')) from b),
    'lineage_claims', (select count(*) from lin),
    'lineage_claims_by_type', coalesce((select jsonb_object_agg(claim_type, n) from (select claim_type, count(*) n from lin group by 1) x), '{}'::jsonb),
    'lineage_entitlements', (select count(*) from ents),
    'ledger_by_disposition', coalesce((select jsonb_object_agg(disposition, n) from (select disposition, count(*) n from fat.migration_source_rows group by 1) x), '{}'::jsonb),
    'gate2_number_or_fy_mismatch', (select count(*) from lin c join src s on s.t = c.prototype_source and s.id = c.prototype_row_id
        left join fat.claim_groups g on g.id = c.prototype_claim_group_id
        where c.claim_number is distinct from coalesce(g.claim_number, (s.j->>'claim_number')::int)
           or c.financial_year_id is distinct from coalesce(g.financial_year_id, (s.j->>'financial_year_id')::uuid)),
    'gate2_scope_duplicates', (select count(*) from (select 1 from fat.operational_claims where claim_number is not null group by owner_id, financial_year_id, claim_type, claim_number having count(*) > 1) x),
    'gate3_bad_detail', (select count(*) from lin c where
        ${detailTables.map((t) => `(select count(*) from fat.${t} d where d.claim_id = c.id)`).join(' + ')} <> 1
        or (case c.claim_type ${Object.entries(DETAIL_TABLE).map(([ct, t]) => `when '${ct}' then (select count(*) from fat.${t} d where d.claim_id = c.id)`).join(' ')} end) <> 1),
    'gate3_parents_without_claim', (select count(*) from fat.migration_source_rows l where l.disposition = 'claim' and l.source_table <> 'claim_groups'
        and not exists (select 1 from lin c where c.prototype_source = l.source_table and c.prototype_row_id = l.source_row_id)),
    'gate4_child_violations', (select count(*) from fat.migration_source_rows l where l.disposition <> 'claim' and (
        (l.disposition = 'entitlement' and (select count(*) from ents e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 1)
        or (l.disposition = 'excluded' and ((select count(*) from ents e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 0
            or l.exclusion_code not in (${Object.keys(EXCLUSIONS).map((c) => `'${c}'`).join(', ')}) or l.source_snapshot is null)))),
    'gate5_missing_source_rows', (select count(*) from val where not has_source),
    'gate5_value_mismatches', (select count(*) from val where has_source and target_value is distinct from source_value),
    'gate5_adjustment_mismatches', (select count(*) from val where has_source and (edited_amount is distinct from (case when edited_source is not null then source_adjusted end))),
    'gate5_totals', jsonb_build_object(
        'dollars_target', (select coalesce(sum(target_value), 0) from val where unit = 'dollars'),
        'dollars_source', (select coalesce(sum(source_value), 0) from val where unit = 'dollars'),
        'hours_target', (select coalesce(sum(target_value), 0) from val where unit = 'hours'),
        'hours_source', (select coalesce(sum(source_value), 0) from val where unit = 'hours')),
    'gate7_cross_owner_entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where e.owner_id <> c.owner_id),
    'gate7_cross_owner_fy', (select count(*) from fat.operational_claims c join fat.financial_years f on f.id = c.financial_year_id where f.user_id <> c.owner_id),
    'gate7_ledger_orphan_or_cross_owner', (select count(*) from fat.migration_source_rows l left join fat.operational_claims c on c.id = l.target_claim_id
        where l.target_claim_id is not null and (c.id is null or c.owner_id <> l.owner_id)),
    'gate7_orphan_details', (select ${detailTables.map((t) => `(select count(*) from fat.${t} d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id))`).join(' + ')}),
    'gate7_payment_links_on_lineage', (select count(*) from fat.entitlement_payment_links l join ents e on e.id = l.entitlement_id),
    'gate7_rls_disabled', (select count(*) from pg_class where relnamespace = 'fat'::regnamespace and relkind = 'r' and not relrowsecurity),
    'gate7_api_privileges_on_migration_tables', (select count(*) from (values ('anon'), ('authenticated')) r(role), (values ('fat.migration_batches'), ('fat.migration_source_rows')) t(tbl)
        where has_table_privilege(r.role, t.tbl, 'SELECT') or has_table_privilege(r.role, t.tbl, 'INSERT') or has_table_privilege(r.role, t.tbl, 'UPDATE') or has_table_privilege(r.role, t.tbl, 'DELETE')),
    'native', jsonb_build_object(
        'claims', (select count(*) from fat.operational_claims where prototype_row_id is null and migration_batch_id is null),
        'entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null),
        'fingerprint', md5(coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from fat.operational_claims c where c.prototype_row_id is null and c.migration_batch_id is null), '')
          || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
          || coalesce((select string_agg(to_jsonb(d)::text, '|' order by d.claim_id) from fat.standby_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
          || coalesce((select string_agg(to_jsonb(d)::text, '|' order by d.claim_id) from fat.muster_dismiss_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), ''))))
)`
}

export function verifySql(batchKey) {
  return `-- C2 verify (WORK-190). Read-only; re-proves gates 2, 3, 4, 5 and 7 from the database.\nselect ${verifyExpr(batchKey)} as verify;\n`
}

/** Compare a verify result with the gates it must satisfy. Returns { ok, failures }. */
export function checkVerify(report, verify) {
  const f = []
  const zero = ['gate2_number_or_fy_mismatch', 'gate2_scope_duplicates', 'gate3_bad_detail', 'gate3_parents_without_claim', 'gate4_child_violations',
    'gate5_missing_source_rows', 'gate5_value_mismatches', 'gate5_adjustment_mismatches', 'gate7_cross_owner_entitlements', 'gate7_cross_owner_fy',
    'gate7_ledger_orphan_or_cross_owner', 'gate7_orphan_details', 'gate7_payment_links_on_lineage', 'gate7_rls_disabled', 'gate7_api_privileges_on_migration_tables']
  for (const k of zero) if (Number(verify[k]) !== 0) f.push(`${k} = ${verify[k]}`)
  const t = verify.gate5_totals || {}
  if (Number(t.dollars_source) !== Number(t.dollars_target)) f.push('gate5 dollar totals differ')
  if (Number(t.hours_source) !== Number(t.hours_target)) f.push('gate5 hour totals differ')
  if (!verify.batch) f.push('batch row missing')
  else {
    if (verify.batch.status !== 'completed') f.push(`batch status ${verify.batch.status}`)
    if (verify.batch.outcome !== report.outcome) f.push('stored report outcome differs')
  }
  return { ok: f.length === 0, failures: f }
}

// ── Rollback (rehearsal reset; CUTOVER_PLAN rollback boundary) ──────────────

export function rollbackSql(batchKey) {
  const k = quoteKey(batchKey)
  return `-- C2 rehearsal reset (WORK-190) — removes ONLY rows tagged to batch ${batchKey}.
-- Claims cascade their details, entitlements, overrides and targeted ledger rows.
-- Roll back the newest batch first: a later batch may have reused (verified) rows of an earlier one.
do $c2rollback$
declare b uuid; n_claims int; n_ents int; n_ledger int; n_pay int;
begin
  select id into b from fat.migration_batches where batch_key = ${k};
  if b is null then
    perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', ${k}, 'found', false)::text, false);
    return;
  end if;
  delete from fat.payment_records where migration_batch_id = b;              -- C3 rows, if any
  get diagnostics n_pay = row_count;
  delete from fat.claim_entitlements where migration_batch_id = b;           -- incl. any added to an earlier batch's claim
  get diagnostics n_ents = row_count;
  delete from fat.operational_claims where migration_batch_id = b;
  get diagnostics n_claims = row_count;
  delete from fat.migration_source_rows where batch_id = b;
  get diagnostics n_ledger = row_count;
  delete from fat.migration_batches where id = b;
  perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', ${k}, 'found', true,
    'claims_deleted', n_claims, 'entitlements_deleted_directly', n_ents, 'ledger_deleted', n_ledger, 'payment_records_deleted', n_pay)::text, false);
end
$c2rollback$;
select current_setting('fat_c2.rollback_result')::jsonb as rollback_result;
`
}

// ── Synthetic DEV rehearsal harness (transaction-scoped; always rolled back) ─

const GENERATED_COLUMNS = { recalls: ['total_km'] }

function fixtureInserts(source, varName) {
  return SOURCE_TABLES.filter((t) => (source[t] || []).length).map((t) => {
    const keys = [...new Set(source[t].flatMap((r) => Object.keys(r)))].filter((c) => !(GENERATED_COLUMNS[t] || []).includes(c)).sort()
    return `  insert into fat.${t} (${keys.join(', ')})
    select ${keys.map((c) => `x.${c}`).join(', ')} from jsonb_populate_recordset(null::fat.${t}, ${varName}->'${t}') x;`
  }).join('\n')
}

export const fixtureJson = (fixtureSource) => canonicalJson(Object.fromEntries(SOURCE_TABLES.map((t) => [t, fixtureSource[t] || []])))

const nativeExpr = `(select jsonb_build_object(
    'claims', (select count(*) from fat.operational_claims where prototype_row_id is null and migration_batch_id is null),
    'entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null),
    'fingerprint', md5(coalesce((select string_agg(to_jsonb(c)::text, '|' order by c.id) from fat.operational_claims c where c.prototype_row_id is null and c.migration_batch_id is null), '')
      || coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
      || coalesce((select string_agg(to_jsonb(d)::text, '|' order by d.claim_id) from fat.standby_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), '')
      || coalesce((select string_agg(to_jsonb(d)::text, '|' order by d.claim_id) from fat.muster_dismiss_details d join fat.operational_claims c on c.id = d.claim_id where c.prototype_row_id is null and c.migration_batch_id is null), ''))))`

/**
 * Plan B (changed source) as plan A plus the exact rows the planner changed.
 * Asserts the changed-source plan differs from A only in its batch and the
 * given entitlement/ledger rows, so the in-database proof is the real one.
 */
export function planDelta(planA, planB) {
  const a = planPayload(planA)
  const b = planPayload(planB)
  for (const k of ['claims', 'details']) {
    if (canonicalJson(a[k]) !== canonicalJson(b[k])) throw new Error(`planDelta: ${k} differ; the conflict proof expects an entitlement-level change`)
  }
  const changed = (xs, ys) => ys.map((y, i) => ({ i, y })).filter(({ i, y }) => canonicalJson(xs[i]) !== canonicalJson(y))
  if (a.entitlements.length !== b.entitlements.length || a.ledger.length !== b.ledger.length) throw new Error('planDelta: row sets differ')
  return { batch: b.batch, entitlements: changed(a.entitlements, b.entitlements), ledger: changed(a.ledger, b.ledger) }
}

/**
 * One DO block that: inserts the synthetic prototype rows (and proves they are
 * stored as given); applies plan A (first run) and again (identical rerun);
 * verifies; proves conflicts fail closed (tampered target; changed source =
 * plan B); resets the batch; then RAISES with the evidence as JSON — so the
 * whole rehearsal, fixtures included, is rolled back and nothing persists.
 */
export function syntheticHarnessSql({ fixtureSource, planA, planB }) {
  const delta = planDelta(planA, planB)
  const tamperId = planA.claims[0]?.id
  if (!tamperId) throw new Error('synthetic harness needs at least one planned claim')
  const k = quoteKey(planA.batch_key)
  const deltaSql = [
    `plan_b := jsonb_set(plan_b, '{batch}', ${literal(canonicalJson(delta.batch), 'c2db')}::jsonb);`,
    ...delta.entitlements.map(({ i, y }) => `plan_b := jsonb_set(plan_b, '{entitlements,${i}}', ${literal(canonicalJson(y), 'c2de')}::jsonb);`),
    ...delta.ledger.map(({ i, y }) => `plan_b := jsonb_set(plan_b, '{ledger,${i}}', ${literal(canonicalJson(y), 'c2dl')}::jsonb);`),
  ].join('\n  ')
  return `-- C2 synthetic DEV rehearsal (WORK-190). Transaction-scoped: ends in RAISE, so every
-- fixture row and every canonical row it creates is rolled back. evidence_class = synthetic.
do $c2syn$
declare
  c2_plan jsonb; c2_result jsonb;
  fx_text text := ${literal(fixtureJson(fixtureSource), 'c2fx')};
  plan_a_text text := ${literal(canonicalJson(planPayload(planA)), 'c2planA')};
  fx jsonb := fx_text::jsonb;
  plan_a jsonb := plan_a_text::jsonb;
  plan_b jsonb;
  step int; outcome jsonb := '{}'::jsonb; v jsonb; fixture_check jsonb; before_native jsonb; after_reset jsonb;
begin
  plan_b := plan_a;
  ${deltaSql}
  before_native := ${nativeExpr};
${fixtureInserts(fixtureSource, 'fx')}
  fixture_check := (select jsonb_object_agg(t, jsonb_build_object('fixture_rows', jsonb_array_length(fx->t),
      'stored_as_given', (select count(*) from jsonb_array_elements(fx->t) f where exists (
        select 1 from (${SOURCE_TABLES.map((t) => `select '${t}'::text tbl, to_jsonb(r) j from fat.${t} r`).join(' union all ')}) s where s.tbl = t and s.j @> f)))))
    from unnest(array[${SOURCE_TABLES.map((t) => `'${t}'`).join(', ')}]) t);

  -- steps: 1 first run, 2 identical rerun, 3 tampered target, 4 changed source (plan B)
  for step in 1..4 loop
    if step = 3 then
      update fat.operational_claims set notes = coalesce(notes, '') || ' [tampered]' where id = '${tamperId}';
    end if;
    c2_plan := case when step = 4 then plan_b else plan_a end;
    begin
${applyBlock('c2_step')}
      outcome := outcome || jsonb_build_object('step' || step, jsonb_build_object('ok', true, 'result', c2_result));
      if step >= 3 then raise exception 'C2_HARNESS_UNDO step % applied without conflict', step; end if;
    exception when others then
      outcome := outcome || jsonb_build_object('step' || step, jsonb_build_object('ok', false, 'error', sqlerrm));
    end;
    if step = 2 then v := ${verifyExpr(planA.batch_key)}; end if;
    if step = 3 then
      update fat.operational_claims set notes = (select x->>'notes' from jsonb_array_elements(plan_a->'claims') x where x->>'id' = '${tamperId}') where id = '${tamperId}';
    end if;
  end loop;

  -- rehearsal reset (rollbackSql semantics) removes only the batch's rows
  delete from fat.claim_entitlements where migration_batch_id = (select id from fat.migration_batches where batch_key = ${k});
  delete from fat.operational_claims where migration_batch_id = (select id from fat.migration_batches where batch_key = ${k});
  delete from fat.migration_source_rows where batch_id = (select id from fat.migration_batches where batch_key = ${k});
  delete from fat.migration_batches where batch_key = ${k};
  after_reset := jsonb_build_object(
    'lineage_claims', (select count(*) from fat.operational_claims where prototype_row_id is not null),
    'lineage_entitlements', (select count(*) from fat.claim_entitlements where prototype_row_id is not null),
    'ledger', (select count(*) from fat.migration_source_rows),
    'batches', (select count(*) from fat.migration_batches),
    'native', ${nativeExpr});

  raise exception 'C2_SYNTHETIC_RESULT %', jsonb_build_object(
    'plan_a_sha256', encode(sha256(convert_to(plan_a_text, 'UTF8')), 'hex'), 'fixture_sha256', encode(sha256(convert_to(fx_text, 'UTF8')), 'hex'),
    'before_native', before_native, 'fixture_check', fixture_check, 'steps', outcome, 'verify', v,
    'after_reset', after_reset, 'delta', jsonb_build_object('entitlements', ${delta.entitlements.length}, 'ledger', ${delta.ledger.length}))::text;
end
$c2syn$;
`
}
