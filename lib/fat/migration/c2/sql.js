// ─── C2/C3 transform — SQL emitter (WORK-190, WORK-191; cross-database WORK-255) ─
// Portable PostgreSQL (no extensions beyond core). Every artefact runs on the
// TARGET (Neon) only, as the migration owner; nothing here reads a prototype table
// (they stay in legacy Supabase — see crossdb.js for the two extraction queries).
// Each artefact is one DO block plus one result SELECT, run as ONE transaction
// (psql --single-transaction, or Neon run_sql_transaction with the two statements).
//
//   applySql(plan)          atomic: stale-reference guard, owner identities + FYs
//                           (prerequisites), batch, insert-if-absent, then PROVE every
//                           planned row equals the stored row; any difference raises and
//                           rolls the whole run back. Records the data-load change id.
//   verifySql(plan)         batch-scoped gates re-proved from the canonical tables and the
//                           EMBEDDED source snapshot (its checksum re-derived in the DB);
//                           security on the Neon fat_app / fat_service model; an RLS probe
//                           as fat_app in an always-rolled-back sub-transaction.
//   rollbackSql(plan)       removes ONLY rows tagged to the batch, its ledger rows and the
//                           batch; replaces the data-load row with <change>-rollback.
//   residueSql(plan)        read-only: what of the batch is left on the target.
//
// Data enters SQL only as one dollar-quoted JSON literal per plan (no per-value
// escaping); the tag is derived from the content and asserted absent from it.

import { CLAIM_COLUMNS, DETAIL_COLUMNS, ENTITLEMENT_COLUMNS, LEDGER_COLUMNS, DETAIL_TABLE, SOURCE_TABLES, SNAPSHOT_TABLES, EXCLUSIONS, GROUP_EXCLUSIONS, PAYMENT_RECORD_COLUMNS } from './constants.js'
import { canonicalJson, sha256 } from './util.js'
import { targetReferenceExpr } from './crossdb.js'

const BATCH_KEY = /^[a-z0-9:._-]{1,200}$/
const CHANGE_ID = /^[a-z0-9][a-z0-9._-]{2,80}$/

function literal(json, prefix) {
  const tag = `$${prefix}_${sha256(json).slice(0, 12)}$`
  if (json.includes(tag)) throw new Error('dollar-quote tag collision')
  return `${tag}${json}${tag}`
}

const quoteKey = (k) => {
  if (!BATCH_KEY.test(k)) throw new Error(`unsafe batch key ${k}`)
  return `'${k}'`
}

/**
 * The parity report stored in fat.migration_batches.report (WORK-255): every gate with its evidence, the planned
 * counts, source/group accounting, EMPTY_CLAIM_GROUP, payment failures and structural differences, generator parity
 * by type and bridge mirrors — bound to the complete report.json (per-event, per-payment and per-parity-item detail,
 * class definitions) by full_report_sha256. Keeps the batch envelope small enough for any SQL transport.
 */
export function batchReport(report) {
  const { events, intended_difference_classes: idc, exclusion_codes: xc, ...rest } = report
  return {
    ...rest,
    payments: { failures: report.payments.failures, structural: report.payments.structural, items: report.payments.items.length },
    generator_parity: { ...report.generator_parity, items: report.generator_parity.items.length },
    events: events.length,
    full_report_sha256: sha256(canonicalJson(report)),
  }
}

/** Plan → the JSON the SQL consumes (adjustments merged onto their entitlements). */
export function planPayload(plan) {
  const adj = new Map(plan.adjustments.map((a) => [a.id, a]))
  return {
    batch: { batch_key: plan.batch_key, environment: plan.environment, source_checksum: plan.source_checksum, report: batchReport(plan.report) },
    claims: plan.claims,
    details: plan.details,
    entitlements: plan.entitlements.map((e) => ({
      ...e, edited_hours: null,
      edited_amount: adj.get(e.id)?.edited_amount ?? null,
      edited_note: adj.get(e.id)?.edited_note ?? null,
      edited_source: adj.get(e.id)?.edited_source ?? null,
    })),
    ledger: plan.ledger,
    payment_records: plan.payment_records || [],
    payment_links: plan.payment_links || [],
    change_id: plan.change_id,
    prerequisites: plan.prerequisites,
    target_scope: plan.target_scope,
    target_reference_md5: plan.target_reference_md5,
  }
}

/** Drop comment-only lines and indentation from generated SQL code (never applied to data literals). */
const compact = (code) => code.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')).join('\n')

function requireCrossDb(plan) {
  if (plan?.topology !== 'cross-database' || !plan.prerequisites || !plan.target_scope || !/^[0-9a-f]{32}$/.test(plan.target_reference_md5 || '')) {
    throw new Error('C2 SQL is emitted only for a cross-database plan (crossdb.js planCrossDb): the prototype source is not in the target database')
  }
  if (!CHANGE_ID.test(plan.change_id || '')) throw new Error(`unsafe change id ${plan.change_id}`)
  quoteKey(plan.batch_key)
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
  // payment_status is proved after the C3 payment phase (it moves from the open status to paid/claimed there).
  const entCmp = [...ENTITLEMENT_COLUMNS.filter((c) => c !== 'id' && c !== 'payment_status'), 'edited_amount', 'edited_hours', 'edited_note', 'edited_source']
  const payCmp = PAYMENT_RECORD_COLUMNS.filter((c) => c !== 'id')
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
    rp fat.payment_records; ep fat.payment_records; elk fat.entitlement_payment_links; lk record; ps record;
    new_recs uuid[] := '{}'; ch boolean; cur_status text;
    ins_pay int := 0; tot_pay int := 0; ins_links int := 0; tot_links int := 0;
    ins_ids int := 0; tot_ids int := 0; ins_fys int := 0; tot_fys int := 0; nd int := 0;
    pi record; ai fat.app_identities; pf fat.financial_years; ef fat.financial_years;
    ${detailDecl}
    k text := c2_plan#>>'{batch,batch_key}';
  begin
    -- Stale-plan guard (WORK-255): the target reference the plan was made from (stations, rates,
    -- rate versions, in-scope native claims) must still be exactly what this target holds.
    if md5((${targetReferenceExpr("(c2_plan->'target_scope')")})::text) is distinct from c2_plan->>'target_reference_md5' then
      raise exception 'C2 stale plan: the target reference rows changed since this plan was made; re-extract the target and re-plan' using errcode = 'P0001';
    end if;

    -- Prerequisites (WORK-255): every owner becomes / is the legacy_supabase FAT app identity whose id IS
    -- the Supabase owner UUID (WORK-254 seam; no password, no provider link), then the source FYs it needs.
    for pi in select * from jsonb_to_recordset(c2_plan#>'{prerequisites,identities}') as x(id uuid, email text) loop
      tot_ids := tot_ids + 1;
      if not exists (select 1 from fat.app_identities i where i.id = pi.id) then ins_ids := ins_ids + 1; end if;
      perform fat.ensure_app_identity(pi.id, pi.email, 'legacy_supabase');
      select * into ai from fat.app_identities i where i.id = pi.id;
      if not found or ai.origin <> 'legacy_supabase' or ai.legacy_subject is distinct from pi.id or ai.status <> 'active'
         or lower(ai.email) <> lower(pi.email) or not exists (select 1 from fat.profiles p where p.id = pi.id) then
        raise exception 'C2 conflict: app identity % is not the preserved legacy_supabase identity this plan requires', pi.id using errcode = 'P0001';
      end if;
    end loop;
    for pf in select * from jsonb_populate_recordset(null::fat.financial_years, c2_plan#>'{prerequisites,financial_years}') loop
      tot_fys := tot_fys + 1;
      insert into fat.financial_years (id, user_id, label, start_date, end_date, is_active)
      values (pf.id, pf.user_id, pf.label, pf.start_date, pf.end_date, coalesce(pf.is_active, false)) on conflict do nothing;
      get diagnostics n = row_count; ins_fys := ins_fys + n;
      select * into ef from fat.financial_years f where f.id = pf.id;
      if not found or (ef.user_id, ef.label, ef.start_date, ef.end_date) is distinct from (pf.user_id, pf.label, pf.start_date, pf.end_date) then
        raise exception 'C2 conflict: financial year % differs from the source FY (or its owner/label is held by another FY)', pf.id using errcode = 'P0001';
      end if;
    end loop;

    -- Governed data-load ledger (backend-preflight verify-applied reads it): same change ⇒ same plan bytes.
    insert into fat_migrations.data_loads (change_id, kind, checksum) values (c2_plan->>'change_id', 'migration_batch', 'sha256:' || c2_plan_sha)
    on conflict (change_id) do nothing;
    get diagnostics nd = row_count;
    if not exists (select 1 from fat_migrations.data_loads d where d.change_id = c2_plan->>'change_id' and d.kind = 'migration_batch' and d.checksum = 'sha256:' || c2_plan_sha) then
      raise exception 'C2 conflict: data load % is recorded with a different plan checksum', c2_plan->>'change_id' using errcode = 'P0001';
    end if;

    -- Batch envelope: same key ⇒ same definition and byte-equal report, else conflict.
    insert into fat.migration_batches (batch_key, step, environment, tool, tool_version, source_checksum, status, completed_at, report, notes)
    values (k, 'C2', c2_plan#>>'{batch,environment}', c2_plan#>>'{batch,report,tool,name}', c2_plan#>>'{batch,report,tool,version}',
            c2_plan#>>'{batch,source_checksum}', 'completed', now(), c2_plan#>'{batch,report}',
            'C2/C3 cross-database transform-copy (WORK-255; C2 WORK-190, C3 WORK-191); change=' || (c2_plan->>'change_id') || '; evidence_class=' || (c2_plan#>>'{batch,report,evidence_class}'))
    on conflict (batch_key) do nothing;
    get diagnostics nb = row_count;
    select mb.id into b from fat.migration_batches mb
     where mb.batch_key = k and mb.step = 'C2' and mb.environment = c2_plan#>>'{batch,environment}'
       and mb.tool = c2_plan#>>'{batch,report,tool,name}' and mb.tool_version = c2_plan#>>'{batch,report,tool,version}'
       and mb.source_checksum = c2_plan#>>'{batch,source_checksum}' and mb.status = 'completed' and mb.report = c2_plan#>'{batch,report}';
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
      -- C3: inserted with the canonical open status of its route; a paid one reaches paid/claimed only through its link below.
      re.payment_status := case re.payment_method when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;
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

    -- C3 (WORK-191): historical payment state. Records insert-if-absent + equality proof; a link is
    -- created (through the canonical link_entitlement_payment: owner/stream/over-allocation checks,
    -- recompute, audit) only together with its newly inserted record — never re-created later.
    for rp in select * from jsonb_populate_recordset(null::fat.payment_records, c2_plan->'payment_records') loop
      insert into fat.payment_records (${PAYMENT_RECORD_COLUMNS.join(', ')}, migration_batch_id)
      values (${cols(PAYMENT_RECORD_COLUMNS, 'rp')}, b) on conflict do nothing;
      get diagnostics n = row_count; ins_pay := ins_pay + n; tot_pay := tot_pay + 1;
      if n = 1 then new_recs := new_recs || rp.id; end if;
      select * into ep from fat.payment_records where id = rp.id;
      if not found or ${tuple(payCmp, 'ep')} is distinct from ${tuple(payCmp, 'rp')} then
        raise exception 'C2 conflict: payment_records % differs from the planned migrated payment record (or its migration_source_key is held by another row)', rp.id using errcode = 'P0001';
      end if;
    end loop;
    for lk in select * from jsonb_to_recordset(c2_plan->'payment_links') as x(entitlement_id uuid, payment_record_id uuid, allocated_amount numeric, link_kind text, note text, actor_id uuid) loop
      tot_links := tot_links + 1;
      select * into elk from fat.entitlement_payment_links l
       where l.entitlement_id = lk.entitlement_id and l.payment_record_id = lk.payment_record_id and l.link_kind = lk.link_kind;
      if not found then
        if not (lk.payment_record_id = any(new_recs)) then
          raise exception 'C2 conflict: planned payment link % -> % is missing although its payment record already existed; it is not re-created', lk.entitlement_id, lk.payment_record_id using errcode = 'P0001';
        end if;
        perform fat.link_entitlement_payment(lk.entitlement_id, lk.payment_record_id, lk.allocated_amount, lk.link_kind, lk.actor_id, lk.note, true);
        ins_links := ins_links + 1;
        select * into elk from fat.entitlement_payment_links l
         where l.entitlement_id = lk.entitlement_id and l.payment_record_id = lk.payment_record_id and l.link_kind = lk.link_kind;
      end if;
      if elk.allocated_amount is distinct from lk.allocated_amount or elk.note is distinct from lk.note then
        raise exception 'C2 conflict: payment link % -> % differs from the planned allocation', lk.entitlement_id, lk.payment_record_id using errcode = 'P0001';
      end if;
      select count(*) into n from fat.reconciliation_audit a
       where a.entitlement_id = lk.entitlement_id and a.action = 'link_payment' and a.reason = lk.note and a.actor_id = lk.actor_id and a.automated;
      if n <> 1 then
        raise exception 'C2 conflict: payment link % -> % has % link_payment audit row(s), expected exactly 1', lk.entitlement_id, lk.payment_record_id, n using errcode = 'P0001';
      end if;
    end loop;
    select count(*) into n from fat.entitlement_payment_links l
     where l.entitlement_id in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'entitlements') x)
       and not exists (select 1 from jsonb_array_elements(c2_plan->'payment_links') y
                        where (y->>'entitlement_id')::uuid = l.entitlement_id and (y->>'payment_record_id')::uuid = l.payment_record_id and y->>'link_kind' = l.link_kind);
    if n > 0 then raise exception 'C2 conflict: % payment link(s) on migrated entitlements are not in the plan', n using errcode = 'P0001'; end if;
    -- Every entitlement's stored payment_status is the planned one AND what the canonical recompute derives
    -- (_reconc_recompute would change nothing; any change it made is undone by the raise).
    for ps in select * from jsonb_to_recordset(c2_plan->'entitlements') as x(id uuid, payment_status text) loop
      select e.payment_status into cur_status from fat.claim_entitlements e where e.id = ps.id;
      if cur_status is distinct from ps.payment_status then
        raise exception 'C2 conflict: claim_entitlements % payment_status % differs from the planned %', ps.id, cur_status, ps.payment_status using errcode = 'P0001';
      end if;
      select r.changed into ch from fat._reconc_recompute(ps.id) r;
      if ch then raise exception 'C3 postcondition: claim_entitlements % payment_status is not the canonical recompute derivation', ps.id using errcode = 'P0001'; end if;
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
    select count(*) into n from fat.operational_claims oc
     where oc.migration_batch_id = b and oc.id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'claims') x);
    if n > 0 then raise exception 'C2 postcondition: % claim(s) tagged to batch % are not in the plan', n, k using errcode = 'P0001'; end if;
    select count(*) into n from fat.claim_entitlements ce
     where ce.migration_batch_id = b and ce.id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'entitlements') x);
    if n > 0 then raise exception 'C2 postcondition: % entitlement(s) tagged to batch % are not in the plan', n, k using errcode = 'P0001'; end if;
    select count(*) into n from fat.migration_source_rows ms
     where ms.batch_id = b and ms.id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'ledger') x);
    if n > 0 then raise exception 'C2 postcondition: % ledger row(s) of batch % are not in the plan', n, k using errcode = 'P0001'; end if;
    select count(*) into n from fat.payment_records pr
     where pr.migration_batch_id = b and pr.id not in (select (x->>'id')::uuid from jsonb_array_elements(c2_plan->'payment_records') x);
    if n > 0 then raise exception 'C2 postcondition: % payment record(s) tagged to batch % are not in the plan', n, k using errcode = 'P0001'; end if;

    -- Gate 3: exactly one detail row, in the correct table, per planned claim.
    select count(*) into n from jsonb_array_elements(c2_plan->'claims') x, lateral (select
        (select count(*) from fat.recall_details dd where dd.claim_id = (x->>'id')::uuid) n_rc,
        (select count(*) from fat.retain_details dd where dd.claim_id = (x->>'id')::uuid) n_rt,
        (select count(*) from fat.standby_details dd where dd.claim_id = (x->>'id')::uuid) n_sb,
        (select count(*) from fat.muster_dismiss_details dd where dd.claim_id = (x->>'id')::uuid) n_md,
        (select count(*) from fat.spoilt_meal_details dd where dd.claim_id = (x->>'id')::uuid) n_sm,
        (select count(*) from fat.delayed_meal_details dd where dd.claim_id = (x->>'id')::uuid) n_dm) d
     where d.n_rc + d.n_rt + d.n_sb + d.n_md + d.n_sm + d.n_dm <> 1
        or (case x->>'claim_type' when 'RC' then d.n_rc when 'RT' then d.n_rt when 'SB' then d.n_sb when 'MD' then d.n_md when 'SM' then d.n_sm else d.n_dm end) <> 1;
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
    -- EMPTY_CLAIM_GROUP (WORK-255): provenance only — no target claim, and no claim carries that group.
    select count(*) into n from jsonb_array_elements(c2_plan->'ledger') x
     where x->>'exclusion_code' in (${GROUP_EXCLUSIONS.map((c) => `'${c}'`).join(', ')})
       and (x->>'target_claim_id' is not null or x->>'source_table' <> 'claim_groups'
            or exists (select 1 from fat.operational_claims oc where oc.prototype_claim_group_id = (x->>'source_row_id')::uuid));
    if n > 0 then raise exception 'C2 postcondition (gate 1): % EMPTY_CLAIM_GROUP row(s) carry or produced a claim', n using errcode = 'P0001'; end if;

    -- Manual adjustments carry exactly one audited override row.
    select count(*) into n from jsonb_array_elements(c2_plan->'entitlements') x
     where x->>'edited_source' is not null
       and (select count(*) from fat.entitlement_overrides o where o.entitlement_id = (x->>'id')::uuid and o.field = 'edited_amount' and o.source_ref = x->>'edited_source') <> 1;
    if n > 0 then raise exception 'C2 postcondition: % adjustment(s) without exactly one audited override', n using errcode = 'P0001'; end if;

    c2_result := jsonb_build_object(
      'batch_key', k, 'batch_id', b, 'batch_inserted', nb, 'change_id', c2_plan->>'change_id', 'data_load_inserted', nd,
      'identities', jsonb_build_object('planned', tot_ids, 'inserted', ins_ids, 'verified_existing', tot_ids - ins_ids),
      'financial_years', jsonb_build_object('planned', tot_fys, 'inserted', ins_fys, 'verified_existing', tot_fys - ins_fys),
      'claims', jsonb_build_object('planned', tot_claims, 'inserted', ins_claims, 'verified_existing', tot_claims - ins_claims),
      'details', jsonb_build_object('planned', tot_details, 'inserted', ins_details, 'verified_existing', tot_details - ins_details),
      'entitlements', jsonb_build_object('planned', tot_ents, 'inserted', ins_ents, 'verified_existing', tot_ents - ins_ents, 'adjustments_applied', ins_adj),
      'ledger', jsonb_build_object('planned', tot_ledger, 'inserted', ins_ledger, 'verified_existing', tot_ledger - ins_ledger),
      'payment_records', jsonb_build_object('planned', tot_pay, 'inserted', ins_pay, 'verified_existing', tot_pay - ins_pay),
      'payment_links', jsonb_build_object('planned', tot_links, 'linked', ins_links, 'verified_existing', tot_links - ins_links));
  end ${label};`
}

/** SHA-256 of the exact plan text embedded in apply SQL (and returned by it as plan_sha256). */
export const planSha256 = (plan) => sha256(canonicalJson(planPayload(plan)))

export function applySql(plan) {
  requireCrossDb(plan)
  if (plan.report.outcome !== 'pass') {
    throw new Error(`C2 apply refused: acceptance gates fail (${Object.entries(plan.report.gates).filter(([, g]) => g.status === 'fail').map(([k]) => k).join(', ')}). Fix the source or the tool; nothing is written.`)
  }
  const json = canonicalJson(planPayload(plan))
  const expected = sha256(json)
  return `-- C2/C3 cross-database apply (WORK-255) — batch ${plan.batch_key} — data-load ${plan.change_id} — plan sha256 ${expected}
-- Generated by scripts/c2-transform.mjs. Runs on the Neon TARGET as the migration owner, as ONE transaction:
-- the DO block, then the result SELECT (psql --single-transaction -f apply.sql, or run_sql_transaction).
-- Atomic and safe to re-run: an identical rerun inserts nothing and proves equivalence; any difference raises.
do $c2apply$
declare
  c2_plan_text text := ${literal(json, 'c2plan')};
  c2_plan jsonb := c2_plan_text::jsonb;
  c2_plan_sha text := encode(sha256(convert_to(c2_plan_text, 'UTF8')), 'hex');
  c2_result jsonb;
begin
  -- Transport guard: nothing is written unless the embedded plan is byte-identical to the reviewed plan.
  if c2_plan_sha <> '${expected}' then
    raise exception 'C2 refused: embedded plan sha256 % is not the reviewed plan ${expected}', c2_plan_sha using errcode = 'P0001';
  end if;
${compact(applyBlock())}
  -- plan_sha256 proves the SQL that ran carried exactly the reviewed plan (compare with plan.sha256).
  c2_result := c2_result || jsonb_build_object('plan_sha256', c2_plan_sha);
  perform set_config('fat_c2.apply_result', c2_result::text, true);
end
$c2apply$;
select nullif(current_setting('fat_c2.apply_result', true), '')::jsonb as apply_result;
`
}

/** Row → jsonb with its timestamptz columns as epoch numbers, so fingerprints ignore the session TimeZone. */
const tzFree = (alias, cols) => `(to_jsonb(${alias}) || jsonb_build_object(${cols.map((c) => `'${c}', extract(epoch from ${alias}.${c})`).join(', ')}))`
const NATIVE = 'c.prototype_row_id is null and c.migration_batch_id is null'

/** Native (non-migrated) canonical claims, their entitlements and SB/MD details: counts + a TimeZone-independent fingerprint. */
export const nativeExpr = `(select jsonb_build_object(
    'claims', (select count(*) from fat.operational_claims c where ${NATIVE}),
    'entitlements', (select count(*) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where ${NATIVE}),
    'fingerprint', md5(coalesce((select string_agg(${tzFree('c', ['created_at', 'updated_at', 'generated_at'])}::text, '|' order by c.id) from fat.operational_claims c where ${NATIVE}), '')
      || coalesce((select string_agg(${tzFree('e', ['generated_at', 'updated_at'])}::text, '|' order by e.id) from fat.claim_entitlements e join fat.operational_claims c on c.id = e.claim_id where ${NATIVE}), '')
      || coalesce((select string_agg(${tzFree('d', ['standby_start_at', 'standby_end_at'])}::text, '|' order by d.claim_id) from fat.standby_details d join fat.operational_claims c on c.id = d.claim_id where ${NATIVE}), '')
      || coalesce((select string_agg(${tzFree('d', ['md_event_at'])}::text, '|' order by d.claim_id) from fat.muster_dismiss_details d join fat.operational_claims c on c.id = d.claim_id where ${NATIVE}), ''))))`


// ── Verify (batch-scoped; no prototype table is read) ──────────────────────

const PROTECTED_FROM_APP = ['fat.migration_batches', 'fat.migration_source_rows', 'fat.identity_links']

/** What verify embeds: the source snapshot rows (canonical JSON), the planned ids and counts, the probe identities. */
export function verifyPayload(plan) {
  const owners = [...new Set(plan.claims.map((c) => c.owner_id))].sort()
  const claimsBy = (o) => plan.claims.filter((c) => c.owner_id === o).length
  const probeOwner = owners.sort((a, b) => claimsBy(b) - claimsBy(a) || (a < b ? -1 : 1))[0] ?? null
  const other = plan.prerequisites.identities.map((i) => i.id).filter((i) => i !== probeOwner).sort()[0] ?? null
  return {
    batch_key: plan.batch_key, change_id: plan.change_id, source_checksum: plan.source_checksum,
    tables: [...SNAPSHOT_TABLES].sort(), rows: plan.source_rows,
    planned: {
      claim_ids: plan.claims.map((c) => c.id), entitlement_ids: plan.entitlements.map((e) => e.id),
      ledger_ids: plan.ledger.map((l) => l.id), payment_record_ids: plan.payment_records.map((r) => r.id),
      identities: plan.prerequisites.identities.map((i) => i.id), financial_years: plan.prerequisites.financial_years.map((f) => f.id),
      adjustments: plan.adjustments.length, payment_links: plan.payment_links.length,
      ledger_by_disposition: plan.report.planned.ledger, empty_claim_groups: plan.report.empty_claim_groups.count,
    },
    probe: { owner: probeOwner, owner_claims: probeOwner ? claimsBy(probeOwner) : 0, other_owner: other },
  }
}

function verifyBlock() {
  const detailTables = Object.values(DETAIL_TABLE)
  const claimTables = SOURCE_TABLES.map((t) => `'${t}'`).join(', ')
  const excl = Object.keys(EXCLUSIONS).map((c) => `'${c}'`).join(', ')
  const grp = GROUP_EXCLUSIONS.map((c) => `'${c}'`).join(', ')
  const ids = (k) => `(select (jsonb_array_elements_text(v->'planned'->'${k}'))::uuid)`
  return `
  create temp table c2v_src on commit drop as
    select x.t, x.id::uuid as id, x.canon, x.canon::jsonb as j, o.ord
      from jsonb_array_elements(v->'rows') with ordinality o(e, ord), lateral jsonb_to_record(o.e) x(t text, id text, canon text);
  select id, status, source_checksum, report into bt from fat.migration_batches where batch_key = v->>'batch_key';

  -- Source snapshot integrity: the canonical source text is rebuilt from the embedded rows and must hash to
  -- the batch's source_checksum (and the plan's); every ledger row's checksum is its embedded row's sha256.
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
    'source_rows_without_exactly_one_ledger_row', (select count(*) from c2v_src s where s.t in (${claimTables})
        and (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.source_table = s.t and l.source_row_id = s.id) <> 1),
    'planned_vs_target', jsonb_build_object(
        'claims_missing', (select count(*) from ${ids('claim_ids')} p(id) where not exists (select 1 from fat.operational_claims c where c.id = p.id and c.migration_batch_id = bt.id)),
        'claims_unplanned', (select count(*) from fat.operational_claims c where c.migration_batch_id = bt.id and c.id not in ${ids('claim_ids')}),
        'entitlements_missing', (select count(*) from ${ids('entitlement_ids')} p(id) where not exists (select 1 from fat.claim_entitlements e where e.id = p.id and e.migration_batch_id = bt.id)),
        'entitlements_unplanned', (select count(*) from fat.claim_entitlements e where e.migration_batch_id = bt.id and e.id not in ${ids('entitlement_ids')}),
        'ledger_missing', (select count(*) from ${ids('ledger_ids')} p(id) where not exists (select 1 from fat.migration_source_rows l where l.id = p.id and l.batch_id = bt.id)),
        'ledger_unplanned', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.id not in ${ids('ledger_ids')}),
        'payment_records_missing', (select count(*) from ${ids('payment_record_ids')} p(id) where not exists (select 1 from fat.payment_records r where r.id = p.id and r.migration_batch_id = bt.id)),
        'payment_records_unplanned', (select count(*) from fat.payment_records r where r.migration_batch_id = bt.id and r.id not in ${ids('payment_record_ids')}),
        'payment_links', (select count(*) from c2v_lnk), 'payment_links_planned', (v->'planned'->>'payment_links')::int,
        'adjustment_overrides', (select count(*) from fat.entitlement_overrides o join c2v_val x on x.id = o.entitlement_id where o.field = 'edited_amount'),
        'adjustments_planned', (v->'planned'->>'adjustments')::int,
        'duplicate_canonical_ids', (select count(*) - count(distinct id) from (select id from fat.operational_claims where migration_batch_id = bt.id
            union all select id from fat.claim_entitlements where migration_batch_id = bt.id) z)),
    'ledger_by_disposition', coalesce((select jsonb_object_agg(disposition, n) from (select disposition, count(*) n from fat.migration_source_rows where batch_id = bt.id group by 1) x), '{}'::jsonb),
    'ledger_by_disposition_planned', v->'planned'->'ledger_by_disposition',
    'gate1_empty_claim_groups', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.exclusion_code in (${grp})),
    'gate1_empty_claim_groups_planned', (v->'planned'->>'empty_claim_groups')::int,
    'gate1_empty_group_violations', (select count(*) from fat.migration_source_rows l left join c2v_src s on s.t = 'claim_groups' and s.id = l.source_row_id
        where l.batch_id = bt.id and l.exclusion_code in (${grp}) and (l.source_table <> 'claim_groups' or l.target_claim_id is not null or l.source_snapshot is null
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
        ${detailTables.map((t) => `(select count(*) from fat.${t} d where d.claim_id = c.id)`).join(' + ')} <> 1
        or (case c.claim_type ${Object.entries(DETAIL_TABLE).map(([ct, t]) => `when '${ct}' then (select count(*) from fat.${t} d where d.claim_id = c.id)`).join(' ')} end) <> 1)),
    'gate3_parents_without_claim', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.disposition = 'claim' and l.source_table <> 'claim_groups'
        and not exists (select 1 from fat.operational_claims c where c.migration_batch_id = bt.id and c.prototype_source = l.source_table and c.prototype_row_id = l.source_row_id)),
    'gate4_child_violations', (select count(*) from fat.migration_source_rows l where l.batch_id = bt.id and l.disposition <> 'claim' and (
        (l.disposition = 'entitlement' and (select count(*) from c2v_val e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 1)
        or (l.disposition = 'excluded' and ((select count(*) from fat.claim_entitlements e where e.prototype_source = l.source_table and e.prototype_row_id = l.source_row_id) <> 0
            or l.exclusion_code not in (${excl}) or l.source_snapshot is null)))),
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
    'gate7_orphan_details', (select ${detailTables.map((t) => `(select count(*) from fat.${t} d where not exists (select 1 from fat.operational_claims c where c.id = d.claim_id))`).join(' + ')}),
    'gate7_payment_links_cross_owner_or_stream', (select count(*) from c2v_lnk where rec_owner <> ent_owner or stream is distinct from payment_method),
    -- Gate I (identity): every owner of a batch row is the preserved legacy_supabase identity (id = Supabase UUID) with a profile.
    'gateI_identity_violations', (select count(*) from (select owner_id from fat.operational_claims where migration_batch_id = bt.id
          union select owner_id from fat.migration_source_rows where batch_id = bt.id) o
        where not exists (select 1 from fat.app_identities i join fat.profiles p on p.id = i.id
                           where i.id = o.owner_id and i.origin = 'legacy_supabase' and i.legacy_subject = i.id and i.status = 'active')),
    'gateI_planned_identities_missing', (select count(*) from ${ids('identities')} p(id) where not exists (select 1 from fat.app_identities i where i.id = p.id and i.origin = 'legacy_supabase' and i.legacy_subject = p.id)),
    'gateI_planned_fys_missing', (select count(*) from ${ids('financial_years')} p(id) where not exists (select 1 from fat.financial_years f where f.id = p.id)),
    -- Gate 7 security on the Neon model (WORK-254): fat_app (API, RLS-scoped) / fat_service (server, explicit policies).
    'gate7_security', jsonb_build_object(
        'rls_disabled', (select count(*) from pg_class where relnamespace = 'fat'::regnamespace and relkind = 'r' and not relrowsecurity),
        'fat_app_privileges_on_protected_tables', (select count(*) from (values ${PROTECTED_FROM_APP.map((t) => `('${t}')`).join(', ')}) t(tbl), (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
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
    'native', ${nativeExpr});

  -- RLS probe as fat_app (WORK-254 session contract: SET LOCAL fat.app_user_id). Always rolled back.
  begin
    execute format('grant fat_app to %I with inherit false, set true', current_user);
    perform set_config('fat.app_user_id', coalesce(v#>>'{probe,owner}', ''), true);
    execute 'set local role fat_app';
    select count(*) into vn from fat.operational_claims where id in ${ids('claim_ids')};
    probe := jsonb_build_object('owner', v#>>'{probe,owner}', 'owner_sees_own_migrated_claims', vn, 'expected', (v#>>'{probe,owner_claims}')::int);
    select count(*) into vn from fat.claim_entitlements where id in ${ids('entitlement_ids')} and owner_id <> fat.current_app_user_id();
    probe := probe || jsonb_build_object('owner_sees_other_owners_entitlements', vn);
    perform set_config('fat.app_user_id', coalesce(v#>>'{probe,other_owner}', ''), true);
    select count(*) into vn from fat.operational_claims where id in ${ids('claim_ids')} and owner_id = (v#>>'{probe,owner}')::uuid;
    probe := probe || jsonb_build_object('other_owner_sees_owner_claims', vn);
    perform set_config('fat.app_user_id', '', true);
    select count(*) into vn from fat.operational_claims where id in ${ids('claim_ids')};
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
  res := res || jsonb_build_object('rls_probe', probe);`
}

export function verifySql(plan) {
  requireCrossDb(plan)
  return `-- C2/C3 cross-database verify (WORK-255) — batch ${plan.batch_key}. Runs on the Neon TARGET as ONE transaction.
-- Changes nothing that survives: temp tables drop on commit; the fat_app RLS probe is always rolled back.
-- Never reads a prototype table: the source rows are the embedded snapshot, whose checksum is re-derived here.
do $c2verify$
declare
  v jsonb := ${literal(canonicalJson(verifyPayload(plan)), 'c2ver')}::jsonb;
  bt record; src_sha text; res jsonb; probe jsonb := '{}'::jsonb; vn int;
begin
${compact(verifyBlock())}
  perform set_config('fat_c2.verify_result', res::text, true);
end
$c2verify$;
select nullif(current_setting('fat_c2.verify_result', true), '')::jsonb as verify;
`
}

/** Compare a verify result with what the plan requires. Returns { ok, failures }. */
export function checkVerify(plan, verify) {
  const f = []
  const zero = ['ledger_checksum_mismatches', 'source_rows_without_exactly_one_ledger_row',
    'gate1_empty_group_violations', 'gate1_groups_without_exactly_one_disposition',
    'gate2_number_or_fy_mismatch', 'gate2_scope_duplicates', 'gate3_bad_detail', 'gate3_parents_without_claim', 'gate4_child_violations',
    'gate5_missing_source_rows', 'gate5_value_mismatches', 'gate5_adjustment_mismatches',
    'gate6_source_invalid', 'gate6_paid_without_exactly_one_migration_link', 'gate6_unpaid_with_links', 'gate6_allocation_mismatches', 'gate6_record_date_mismatches',
    'gate6_status_mismatches', 'gate6_audit_mismatches', 'gate6_unlinked_migration_records', 'gate6_duplicate_source_keys',
    'gate7_cross_owner_entitlements', 'gate7_cross_owner_fy', 'gate7_ledger_orphan_or_cross_owner', 'gate7_orphan_details', 'gate7_payment_links_cross_owner_or_stream',
    'gateI_identity_violations', 'gateI_planned_identities_missing', 'gateI_planned_fys_missing']
  for (const k of zero) if (Number(verify[k]) !== 0) f.push(`${k} = ${verify[k]}`)
  for (const [k, x] of Object.entries(verify.gate7_security || {})) if (Number(x) !== 0) f.push(`gate7_security.${k} = ${x}`)
  const pv = verify.planned_vs_target || {}
  for (const k of ['claims_missing', 'claims_unplanned', 'entitlements_missing', 'entitlements_unplanned', 'ledger_missing', 'ledger_unplanned',
    'payment_records_missing', 'payment_records_unplanned', 'duplicate_canonical_ids']) if (Number(pv[k]) !== 0) f.push(`planned_vs_target.${k} = ${pv[k]}`)
  if (Number(pv.payment_links) !== Number(pv.payment_links_planned)) f.push('payment links differ from the plan')
  if (Number(pv.adjustment_overrides) !== Number(pv.adjustments_planned)) f.push('audited adjustment overrides differ from the plan')
  if (Number(verify.gate1_empty_claim_groups) !== Number(verify.gate1_empty_claim_groups_planned)) f.push('EMPTY_CLAIM_GROUP count differs from the plan')
  const want = Object.fromEntries(Object.entries(verify.ledger_by_disposition_planned || {}).filter(([, n]) => Number(n) > 0))
  const got = Object.fromEntries(Object.entries(verify.ledger_by_disposition || {}).map(([k, n]) => [k, Number(n)]))
  if (canonicalJson(want) !== canonicalJson(got)) f.push('ledger dispositions differ from the plan')
  const ss = verify.source_snapshot || {}
  if (!(ss.embedded_sha256 && ss.embedded_sha256 === plan.source_checksum && ss.plan_source_checksum === plan.source_checksum && ss.batch_source_checksum === plan.source_checksum)) {
    f.push('embedded source snapshot does not hash to the batch source_checksum')
  }
  if (Number(ss.canon_parse_mismatches) !== 0) f.push('embedded source rows do not parse to themselves')
  const t = verify.gate5_totals || {}
  if (Number(t.dollars_source) !== Number(t.dollars_target)) f.push('gate5 dollar totals differ')
  if (Number(t.hours_source) !== Number(t.hours_target)) f.push('gate5 hour totals differ')
  const p6 = verify.gate6_totals || {}
  if (Number(p6.source_paid_amount) !== Number(p6.allocated_amount)) f.push('gate6 paid amount differs from allocated amount')
  if (Number(p6.source_paid_entitlements) !== Number(p6.links_on_lineage) || Number(p6.links_on_lineage) !== Number(p6.migration_records)) f.push('gate6 paid entitlements / links / migration records differ')
  const pr = verify.rls_probe || {}
  if (pr.error) f.push(`rls probe error: ${pr.error}`)
  else if (plan.claims.length) {
    if (Number(pr.owner_sees_own_migrated_claims) !== Number(pr.expected)) f.push('rls: owner does not see exactly their migrated claims')
    if (Number(pr.owner_sees_other_owners_entitlements) !== 0) f.push('rls: owner sees another owner\'s entitlements')
    if (Number(pr.other_owner_sees_owner_claims) !== 0) f.push('rls: another identity sees the owner\'s claims')
    if (Number(pr.unset_identity_sees) !== 0) f.push('rls: an unset identity sees migrated claims')
    if (pr.ledger_readable_by_fat_app !== false) f.push('rls: fat_app can read the migration ledger')
  }
  if (!verify.batch) f.push('batch row missing')
  else {
    if (verify.batch.status !== 'completed') f.push(`batch status ${verify.batch.status}`)
    if (verify.batch.outcome !== plan.report.outcome) f.push('stored report outcome differs')
    if (verify.batch.full_report_sha256 !== sha256(canonicalJson(plan.report))) f.push('stored report is not bound to this plan\'s report.json')
  }
  if (!verify.data_load || verify.data_load.kind !== 'migration_batch') f.push('data-load ledger row missing')
  return { ok: f.length === 0, failures: f }
}

// ── Rollback (C1 § 3 boundary: only rows tagged to the batch) ──────────────

export function rollbackSql(plan) {
  requireCrossDb(plan)
  const k = quoteKey(plan.batch_key)
  const rb = `${plan.change_id}-rollback`
  if (!CHANGE_ID.test(rb)) throw new Error(`unsafe rollback change id ${rb}`)
  return `-- C2/C3 batch rollback (WORK-255) — removes ONLY rows tagged to batch ${plan.batch_key} on the Neon TARGET.
-- Payment records (links cascade) → entitlements (details-free; audit + overrides cascade) → claims (details and
-- targeted ledger rows cascade) → remaining ledger rows of the batch (EMPTY_CLAIM_GROUP / untargeted) → the batch.
-- Owner identities and FYs (prerequisites) are foundation and are NOT removed. The data-load row ${plan.change_id}
-- is replaced by ${rb}. Run as ONE transaction (DO block + result SELECT). Roll back the newest batch first.
do $c2rollback$
declare b uuid; n_claims int := 0; n_ents int := 0; n_ledger int := 0; n_pay int := 0; n_links int := 0; n_audit int := 0; n_over int := 0; n_dl int := 0;
begin
  select id into b from fat.migration_batches where batch_key = ${k};
  if b is null then
    perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', ${k}, 'found', false)::text, true);
    return;
  end if;
  select count(*) into n_links from fat.entitlement_payment_links l join fat.claim_entitlements e on e.id = l.entitlement_id where e.migration_batch_id = b;
  select count(*) into n_audit from fat.reconciliation_audit a join fat.claim_entitlements e on e.id = a.entitlement_id where e.migration_batch_id = b;
  select count(*) into n_over from fat.entitlement_overrides o join fat.claim_entitlements e on e.id = o.entitlement_id where e.migration_batch_id = b;
  delete from fat.payment_records where migration_batch_id = b;
  get diagnostics n_pay = row_count;
  delete from fat.claim_entitlements where migration_batch_id = b;
  get diagnostics n_ents = row_count;
  delete from fat.operational_claims where migration_batch_id = b;
  get diagnostics n_claims = row_count;
  delete from fat.migration_source_rows where batch_id = b;
  get diagnostics n_ledger = row_count;
  delete from fat.migration_batches where id = b;
  delete from fat_migrations.data_loads where change_id = '${plan.change_id}';
  get diagnostics n_dl = row_count;
  insert into fat_migrations.data_loads (change_id, kind, checksum) values ('${rb}', 'migration_batch', 'sha256:${planSha256(plan)}')
  on conflict (change_id) do nothing;
  perform set_config('fat_c2.rollback_result', jsonb_build_object('batch_key', ${k}, 'found', true,
    'payment_records_deleted', n_pay, 'links_cascaded', n_links, 'audit_cascaded', n_audit, 'overrides_cascaded', n_over,
    'entitlements_deleted_directly', n_ents, 'claims_deleted', n_claims, 'untargeted_ledger_deleted', n_ledger,
    'data_load_removed', n_dl, 'rollback_change', '${rb}')::text, true);
end
$c2rollback$;
select nullif(current_setting('fat_c2.rollback_result', true), '')::jsonb as rollback_result;
`
}

/** Read-only: what of this batch exists on the target (after rollback every count must be 0). */
export function residueSql(plan) {
  requireCrossDb(plan)
  const p = verifyPayload(plan).planned
  const arr = (xs) => `(select (jsonb_array_elements_text(${literal(canonicalJson(xs), 'c2ids')}::jsonb))::uuid)`
  return `-- C2/C3 batch residue (WORK-255) — batch ${plan.batch_key}. Read-only, Neon TARGET.
select jsonb_build_object(
  'batch', (select count(*) from fat.migration_batches where batch_key = ${quoteKey(plan.batch_key)}),
  'claims', (select count(*) from fat.operational_claims where id in ${arr(p.claim_ids)}),
  'details', (select ${Object.values(DETAIL_TABLE).map((t) => `(select count(*) from fat.${t} where claim_id in ${arr(p.claim_ids)})`).join(' + ')}),
  'entitlements', (select count(*) from fat.claim_entitlements where id in ${arr(p.entitlement_ids)}),
  'overrides', (select count(*) from fat.entitlement_overrides where entitlement_id in ${arr(p.entitlement_ids)}),
  'payment_records', (select count(*) from fat.payment_records where id in ${arr(p.payment_record_ids)}),
  'payment_links', (select count(*) from fat.entitlement_payment_links where entitlement_id in ${arr(p.entitlement_ids)}),
  'reconciliation_audit', (select count(*) from fat.reconciliation_audit where entitlement_id in ${arr(p.entitlement_ids)}),
  'ledger', (select count(*) from fat.migration_source_rows where id in ${arr(p.ledger_ids)}),
  'data_load', (select count(*) from fat_migrations.data_loads where change_id = '${plan.change_id}'),
  'rollback_record', (select count(*) from fat_migrations.data_loads where change_id = '${plan.change_id}-rollback'),
  'foundation', jsonb_build_object(
    'identities_kept', (select count(*) from fat.app_identities where id in ${arr(p.identities)}),
    'financial_years_kept', (select count(*) from fat.financial_years where id in ${arr(p.financial_years)}),
    'schema_migrations', (select count(*) from fat_migrations.schema_migrations),
    'stations', (select count(*) from fat.stations), 'rates', (select count(*) from fat.rates), 'rate_versions', (select count(*) from fat.rate_versions),
    'other_batches', (select coalesce(jsonb_agg(batch_key order by batch_key), '[]'::jsonb) from fat.migration_batches)),
  'native', ${nativeExpr}) as residue;
`
}
