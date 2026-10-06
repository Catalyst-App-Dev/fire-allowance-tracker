-- FAT Neon backend — 4/6 payment records, reconciliation and payslip staging (WORK-254, N1)
-- Owner: fat. Rollback: neon/rollbacks/20261006060300_fat_neon_payments_reconciliation.rollback.sql
--
-- Consolidated end state of canonical 01 (payment records, links, audit),
-- 08/09 (reconciliation service layer, retract/route), 10/11/12/14
-- (payslip import staging, confirm bridge, duplicate detection, extract
-- confidence), 15–18 (Tier-1 status check, over-allocation lock, duplicate-
-- confirm lock, retract re-opens lines) and 20261005121500 (C1: the
-- `prototype_migration` source and idempotent migration_source_key, WORK-189;
-- the representation C3/WORK-191 maps prototype payment state into).
--
-- Every function body below is taken from the repository file named
-- on its first line (code verbatim; decorative comment rules shortened); they
-- are SECURITY INVOKER with explicit actor ids and
-- contain no Supabase reference (portable unchanged).
-- Payments remain dark: nothing here activates the Payments feature.

create table fat.payment_records (
  id                    uuid not null default gen_random_uuid(),
  owner_id              uuid not null,
  stream                text not null,
  record_date           date not null,
  reference             text,
  gross_amount          numeric(12,2) not null,
  raw_payload           jsonb,
  source                text,
  created_at            timestamptz not null default now(),
  migration_batch_id    uuid,
  migration_source_key  text,
  constraint payment_records_pkey primary key (id),
  constraint payment_records_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint payment_records_migration_batch_id_fkey foreign key (migration_batch_id) references fat.migration_batches(id),
  constraint payment_records_gross_amount_nonneg check (gross_amount >= (0)::numeric),
  constraint payment_records_migration_pair check ((migration_batch_id is null) = (migration_source_key is null)),
  constraint payment_records_migration_source check ((coalesce(source, ''::text) = 'prototype_migration'::text) = (migration_batch_id is not null)),
  constraint payment_records_source_check check (source = any (array['manual'::text, 'payslip_screenshot'::text, 'payslip_pdf'::text, 'petty_cash_export'::text, 'prototype_migration'::text])),
  constraint payment_records_stream_check check (stream = any (array['payslip'::text, 'petty_cash'::text]))
);
create index idx_payment_records_migration_batch on fat.payment_records using btree (migration_batch_id) where (migration_batch_id is not null);
create index idx_payment_records_owner_stream_date on fat.payment_records using btree (owner_id, stream, record_date desc);
create unique index uq_payment_records_migration_source_key on fat.payment_records using btree (migration_source_key) where (migration_source_key is not null);
create trigger guard_migration_provenance
  before insert or update on fat.payment_records
  for each row execute function fat.guard_migration_provenance('migration_batch_id', 'migration_source_key');

create table fat.entitlement_payment_links (
  id                 uuid not null default gen_random_uuid(),
  entitlement_id     uuid not null,
  payment_record_id  uuid not null,
  allocated_amount   numeric(12,4) not null,
  link_kind          text not null,
  note               text,
  created_at         timestamptz not null default now(),
  constraint entitlement_payment_links_pkey primary key (id),
  constraint entitlement_payment_links_entitlement_id_fkey foreign key (entitlement_id) references fat.claim_entitlements(id) on delete cascade,
  constraint entitlement_payment_links_payment_record_id_fkey foreign key (payment_record_id) references fat.payment_records(id) on delete cascade,
  constraint entitlement_payment_links_link_kind_check check (link_kind = any (array['auto_match'::text, 'manual'::text, 'discrepancy_note'::text])),
  constraint epl_allocated_amount_nonneg check (allocated_amount >= (0)::numeric)
);
create index idx_entitlement_payment_links_entitlement on fat.entitlement_payment_links using btree (entitlement_id);
create index idx_entitlement_payment_links_payment_record on fat.entitlement_payment_links using btree (payment_record_id);
create unique index uq_epl_entitlement_record_kind on fat.entitlement_payment_links using btree (entitlement_id, payment_record_id, link_kind) where (link_kind = any (array['auto_match'::text, 'manual'::text]));

create table fat.reconciliation_audit (
  id              uuid not null default gen_random_uuid(),
  entitlement_id  uuid not null,
  actor_id        uuid not null,
  action          text not null,
  prior_status    text,
  new_status      text,
  reason          text,
  automated       boolean not null default false,
  created_at      timestamptz not null default now(),
  constraint reconciliation_audit_pkey primary key (id),
  constraint reconciliation_audit_actor_id_fkey foreign key (actor_id) references fat.profiles(id) on delete cascade,
  constraint reconciliation_audit_entitlement_id_fkey foreign key (entitlement_id) references fat.claim_entitlements(id) on delete cascade
);
create index idx_reconciliation_audit_entitlement_time on fat.reconciliation_audit using btree (entitlement_id, created_at desc);

create table fat.payslip_imports (
  id                   uuid not null default gen_random_uuid(),
  owner_id             uuid not null,
  source               text not null,
  status               text not null default 'uploaded'::text,
  file_ref             text,
  file_hash            text,
  pay_date             date,
  pay_period_ref       text,
  parser_name          text,
  parser_version       text,
  line_count           integer not null default 0,
  raw_extract          jsonb,
  error                text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  confirmed_at         timestamptz,
  content_fingerprint  text,
  duplicate_check      jsonb,
  constraint payslip_imports_pkey primary key (id),
  constraint payslip_imports_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint payslip_imports_source_check check (source = any (array['manual_entry'::text, 'payslip_screenshot'::text, 'payslip_pdf'::text])),
  constraint payslip_imports_status_check check (status = any (array['uploaded'::text, 'parsing'::text, 'parsed'::text, 'needs_review'::text, 'confirmed'::text, 'rejected'::text, 'superseded'::text, 'failed'::text]))
);
create index ix_payslip_imports_owner_created on fat.payslip_imports using btree (owner_id, created_at desc);
create index ix_payslip_imports_owner_fingerprint on fat.payslip_imports using btree (owner_id, content_fingerprint) where (content_fingerprint is not null);
create index ix_payslip_imports_owner_status on fat.payslip_imports using btree (owner_id, status);
create trigger set_updated_at before update on fat.payslip_imports
  for each row execute function fat.set_updated_at();

create table fat.payslip_import_lines (
  id                        uuid not null default gen_random_uuid(),
  import_id                 uuid not null,
  owner_id                  uuid not null,
  line_index                integer not null,
  raw_text                  text,
  parsed_reference          text,
  parsed_description        text,
  parsed_amount             numeric(12,2),
  parsed_date               date,
  candidate_entitlement_id  uuid,
  match_confidence          numeric(5,4),
  match_breakdown           jsonb,
  status                    text not null default 'parsed'::text,
  payment_record_id         uuid,
  link_id                   uuid,
  resolution_note           text,
  error                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  confirmed_at              timestamptz,
  content_fingerprint       text,
  extract_confidence        numeric(5,4),
  extract_meta              jsonb,
  constraint payslip_import_lines_pkey primary key (id),
  constraint payslip_import_lines_import_id_fkey foreign key (import_id) references fat.payslip_imports(id) on delete cascade,
  constraint payslip_import_lines_owner_id_fkey foreign key (owner_id) references fat.profiles(id) on delete cascade,
  constraint payslip_import_lines_candidate_entitlement_id_fkey foreign key (candidate_entitlement_id) references fat.claim_entitlements(id) on delete set null,
  constraint payslip_import_lines_payment_record_id_fkey foreign key (payment_record_id) references fat.payment_records(id) on delete set null,
  constraint payslip_import_lines_link_id_fkey foreign key (link_id) references fat.entitlement_payment_links(id) on delete set null,
  constraint payslip_import_lines_status_check check (status = any (array['parsed'::text, 'needs_review'::text, 'confirmed'::text, 'rejected'::text, 'superseded'::text, 'failed'::text]))
);
create index ix_payslip_import_lines_candidate on fat.payslip_import_lines using btree (candidate_entitlement_id) where (candidate_entitlement_id is not null);
create index ix_payslip_import_lines_import on fat.payslip_import_lines using btree (import_id);
create index ix_payslip_import_lines_owner_fp on fat.payslip_import_lines using btree (owner_id, content_fingerprint) where (content_fingerprint is not null);
create index ix_payslip_import_lines_owner_status on fat.payslip_import_lines using btree (owner_id, status);
create trigger set_updated_at before update on fat.payslip_import_lines
  for each row execute function fat.set_updated_at();

-- Reconciliation service layer (portable unchanged).
-- fat._reconc_recompute: verbatim from supabase/canonical/08_reconciliation_service_layer.sql
create or replace function fat._reconc_recompute(
  p_entitlement_id uuid,
  p_tolerance      numeric default 0.01
) returns table (changed boolean, prior_status text, new_status text)
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_unit           text;
  v_method         text;
  v_prior          text;
  v_eff_amount     numeric;
  v_eligible_count integer;
  v_eligible_sum   numeric;
  v_is_terminal    boolean;
  v_target         text;
begin
  select e.unit, e.payment_method, e.payment_status,
         coalesce(e.edited_amount, e.generated_amount)
    into v_unit, v_method, v_prior, v_eff_amount
    from fat.claim_entitlements e
   where e.id = p_entitlement_id;
  if not found then
    raise exception 'recompute: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  -- Status-eligible aggregates: auto_match / manual only (§ 5.3).
  select count(*), coalesce(sum(l.allocated_amount), 0)
    into v_eligible_count, v_eligible_sum
    from fat.entitlement_payment_links l
   where l.entitlement_id = p_entitlement_id
     and l.link_kind in ('auto_match','manual');

  if v_method is null then
    -- Unrouted ⇒ no status (§ 2.3).
    v_target := null;
  else
    -- Terminal predicate branches on unit (§ 4.3 / § 5.5).
    if v_unit = 'hours' then
      v_is_terminal := v_eligible_count >= 1;
    elsif v_unit = 'dollars' then
      v_is_terminal := v_eff_amount is not null and v_eligible_sum >= (v_eff_amount - p_tolerance);
    else
      v_is_terminal := false;  -- km / unknown: never terminal (transitional)
    end if;

    if v_is_terminal then
      v_target := case v_method when 'payslip' then 'paid' when 'petty_cash' then 'claimed' end;
    else
      v_target := case v_method when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;
    end if;
  end if;

  if v_target is distinct from v_prior then
    update fat.claim_entitlements set payment_status = v_target where id = p_entitlement_id;
    return query select true, v_prior, v_target;
  else
    return query select false, v_prior, v_prior;
  end if;
end;
$$;
-- fat._reconc_write_audit: verbatim from supabase/canonical/08_reconciliation_service_layer.sql
create or replace function fat._reconc_write_audit(
  p_entitlement_id uuid,
  p_actor_id       uuid,
  p_action         text,
  p_prior          text,
  p_new            text,
  p_reason         text,
  p_automated      boolean
) returns uuid
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare v_id uuid;
begin
  insert into fat.reconciliation_audit
    (entitlement_id, actor_id, action, prior_status, new_status, reason, automated)
  values
    (p_entitlement_id, p_actor_id, p_action, p_prior, p_new, p_reason, coalesce(p_automated, false))
  returning id into v_id;
  return v_id;
end;
$$;
-- fat.create_payment_record: verbatim from supabase/canonical/08_reconciliation_service_layer.sql
create or replace function fat.create_payment_record(
  p_owner_id     uuid,
  p_stream       text,
  p_record_date  date,
  p_gross_amount numeric,
  p_source       text,
  p_reference    text  default null,
  p_raw_payload  jsonb default null
) returns fat.payment_records
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare v_row fat.payment_records;
begin
  if p_gross_amount is null or p_gross_amount < 0 then
    raise exception 'create_payment_record: gross_amount must be >= 0 (got %)', p_gross_amount using errcode = 'check_violation';
  end if;
  if p_stream not in ('payslip','petty_cash') then
    raise exception 'create_payment_record: invalid stream %', p_stream using errcode = 'check_violation';
  end if;
  if p_source not in ('manual','payslip_screenshot','payslip_pdf','petty_cash_export') then
    raise exception 'create_payment_record: invalid source %', p_source using errcode = 'check_violation';
  end if;

  insert into fat.payment_records (owner_id, stream, record_date, reference, gross_amount, raw_payload, source)
  values (p_owner_id, p_stream, p_record_date, p_reference, p_gross_amount, p_raw_payload, p_source)
  returning * into v_row;
  return v_row;
end;
$$;
-- fat.link_entitlement_payment: verbatim from supabase/canonical/16_link_overalloc_lock.sql
create or replace function fat.link_entitlement_payment(
  p_entitlement_id    uuid,
  p_payment_record_id uuid,
  p_allocated_amount  numeric,
  p_link_kind         text,
  p_actor_id          uuid,
  p_note              text    default null,
  p_automated         boolean default false,
  p_tolerance         numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_ent_owner    uuid;
  v_ent_method   text;
  v_ent_status   text;
  v_rec_owner    uuid;
  v_rec_stream   text;
  v_gross        numeric;
  v_existing_sum numeric;
  v_link_id      uuid;
  v_changed      boolean;
  v_prior        text;
  v_new          text;
  v_action       text;
  v_audit_id     uuid;
begin
  if p_link_kind not in ('auto_match','manual','discrepancy_note') then
    raise exception 'link: invalid link_kind %', p_link_kind using errcode = 'check_violation';
  end if;
  if p_allocated_amount is null or p_allocated_amount < 0 then
    raise exception 'link: allocated_amount must be >= 0 (got %)', p_allocated_amount using errcode = 'check_violation';
  end if;

  select e.owner_id, e.payment_method, e.payment_status
    into v_ent_owner, v_ent_method, v_ent_status
    from fat.claim_entitlements e where e.id = p_entitlement_id;
  if not found then
    raise exception 'link: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  -- Lock the payment_records row FIRST (P1-3): serializes concurrent links to the
  -- same record so the allocation-cap check below cannot be raced. Also fetches the
  -- record fields. A row that does not exist returns no row → handled below.
  select r.owner_id, r.stream, r.gross_amount
    into v_rec_owner, v_rec_stream, v_gross
    from fat.payment_records r where r.id = p_payment_record_id
    for update;
  if not found then
    raise exception 'link: payment_record % not found', p_payment_record_id using errcode = 'no_data_found';
  end if;

  -- Owner coherence (§ 5.6 invariant 1; cross-owner links forbidden today).
  if v_ent_owner is distinct from v_rec_owner then
    raise exception 'link: owner mismatch (entitlement % vs record %)', v_ent_owner, v_rec_owner;
  end if;

  -- Allocation cap (§ 5.4): SUM(allocated_amount) over ALL links of this record ≤ gross.
  -- Read under the row lock above, so a concurrent link is already serialized here.
  select coalesce(sum(l.allocated_amount), 0) into v_existing_sum
    from fat.entitlement_payment_links l where l.payment_record_id = p_payment_record_id;
  if v_existing_sum + p_allocated_amount > v_gross then
    raise exception 'link: allocation % + existing % exceeds record gross %', p_allocated_amount, v_existing_sum, v_gross using errcode = 'check_violation';
  end if;

  if p_link_kind in ('auto_match','manual') then
    -- Stream coherence (§ 5.6 invariant 2); refuse unrouted (§ 3.5).
    if v_ent_method is null then
      raise exception 'link: entitlement % is unrouted — route it before linking a payment', p_entitlement_id;
    end if;
    if v_ent_method is distinct from v_rec_stream then
      raise exception 'link: stream mismatch (entitlement % vs record %)', v_ent_method, v_rec_stream;
    end if;
  end if;

  insert into fat.entitlement_payment_links
    (entitlement_id, payment_record_id, allocated_amount, link_kind, note)
  values
    (p_entitlement_id, p_payment_record_id, p_allocated_amount, p_link_kind, p_note)
  returning id into v_link_id;

  if p_link_kind in ('auto_match','manual') then
    select changed, prior_status, new_status into v_changed, v_prior, v_new
      from fat._reconc_recompute(p_entitlement_id, p_tolerance);
    v_action := 'link_payment';
    v_audit_id := fat._reconc_write_audit(p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_note, coalesce(p_automated, false));
  else
    -- discrepancy_note: evidence-but-not-counted; status unchanged (§ 5.3, § 6).
    v_changed := false; v_prior := v_ent_status; v_new := v_ent_status;
    v_action := 'note_discrepancy';
    v_audit_id := fat._reconc_write_audit(p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_note, false);
  end if;

  return jsonb_build_object(
    'link_id',        v_link_id,
    'entitlement_id', p_entitlement_id,
    'action',         v_action,
    'status_changed', v_changed,
    'prior_status',   v_prior,
    'new_status',     v_new,
    'audit_id',       v_audit_id
  );
end;
$$;
-- fat.unlink_entitlement_payment: verbatim from supabase/canonical/08_reconciliation_service_layer.sql
create or replace function fat.unlink_entitlement_payment(
  p_link_id   uuid,
  p_actor_id  uuid,
  p_reason    text    default null,
  p_tolerance numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_entitlement_id uuid;
  v_link_kind      text;
  v_status         text;
  v_changed        boolean;
  v_prior          text;
  v_new            text;
  v_action         text;
  v_audit_id       uuid;
begin
  select l.entitlement_id, l.link_kind into v_entitlement_id, v_link_kind
    from fat.entitlement_payment_links l where l.id = p_link_id;
  if not found then
    raise exception 'unlink: link % not found', p_link_id using errcode = 'no_data_found';
  end if;

  select e.payment_status into v_status from fat.claim_entitlements e where e.id = v_entitlement_id;

  delete from fat.entitlement_payment_links where id = p_link_id;

  if v_link_kind in ('auto_match','manual') then
    select changed, prior_status, new_status into v_changed, v_prior, v_new
      from fat._reconc_recompute(v_entitlement_id, p_tolerance);
    v_action := 'unlink_payment';
  else
    v_changed := false; v_prior := v_status; v_new := v_status;
    v_action := 'note_discrepancy';
  end if;

  v_audit_id := fat._reconc_write_audit(v_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_reason, false);

  return jsonb_build_object(
    'link_id',        p_link_id,
    'entitlement_id', v_entitlement_id,
    'action',         v_action,
    'status_changed', v_changed,
    'prior_status',   v_prior,
    'new_status',     v_new,
    'audit_id',       v_audit_id
  );
end;
$$;
-- fat.recompute_entitlement_status: verbatim from supabase/canonical/08_reconciliation_service_layer.sql
create or replace function fat.recompute_entitlement_status(
  p_entitlement_id uuid,
  p_actor_id       uuid,
  p_trigger        text    default 'manual',
  p_reason         text    default null,
  p_tolerance      numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_changed  boolean;
  v_prior    text;
  v_new      text;
  v_action   text;
  v_audit_id uuid;
begin
  select changed, prior_status, new_status into v_changed, v_prior, v_new
    from fat._reconc_recompute(p_entitlement_id, p_tolerance);

  if v_changed then
    if p_trigger = 'link_added' then
      v_action := 'link_payment';
    elsif p_trigger = 'link_removed' then
      v_action := 'unlink_payment';
    elsif v_new = 'paid' then
      v_action := 'mark_paid';
    elsif v_new = 'claimed' then
      v_action := 'mark_claimed';
    else
      v_action := 'regress_status';
    end if;

    v_audit_id := fat._reconc_write_audit(
      p_entitlement_id, p_actor_id, v_action, v_prior, v_new, p_reason,
      case when p_trigger in ('link_added','link_removed') then true else false end);
  end if;

  return jsonb_build_object(
    'entitlement_id', p_entitlement_id,
    'status_changed', coalesce(v_changed, false),
    'prior_status',   v_prior,
    'new_status',     v_new,
    'action',         v_action,
    'audit_id',       v_audit_id
  );
end;
$$;
-- fat.route_entitlement: verbatim from supabase/canonical/09_reconciliation_retract_route.sql
create or replace function fat.route_entitlement(
  p_entitlement_id uuid,
  p_stream         text,
  p_actor_id       uuid,
  p_reason         text default null
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_owner    uuid;
  v_method   text;
  v_initial  text;
  v_audit_id uuid;
begin
  if p_stream not in ('payslip','petty_cash') then
    raise exception 'route_entitlement: invalid stream %', p_stream using errcode = 'check_violation';
  end if;

  select e.owner_id, e.payment_method
    into v_owner, v_method
    from fat.claim_entitlements e
   where e.id = p_entitlement_id;
  if not found then
    raise exception 'route_entitlement: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
  end if;

  -- Only NULL → stream here (§ 3.3). An already-routed entitlement must use an
  -- explicit re-route action (§ 3.4) — refuse so routing changes never happen by
  -- accident through the wrong helper.
  if v_method is not null then
    raise exception 'route_entitlement: entitlement % already routed to % (use a re-route action)', p_entitlement_id, v_method using errcode = 'check_violation';
  end if;

  v_initial := case p_stream when 'payslip' then 'pending' when 'petty_cash' then 'outstanding' end;

  update fat.claim_entitlements
     set payment_method = p_stream,
         payment_status = v_initial
   where id = p_entitlement_id;

  v_audit_id := fat._reconc_write_audit(
    p_entitlement_id, p_actor_id, 'set_payment_method', null, v_initial, p_reason, false);

  return jsonb_build_object(
    'entitlement_id', p_entitlement_id,
    'action',         'set_payment_method',
    'status_changed', true,
    'prior_status',   null,
    'new_status',     v_initial,
    'payment_method', p_stream,
    'audit_id',       v_audit_id
  );
end;
$$;
-- fat.retract_payment: verbatim from supabase/canonical/18_retract_reopen_lines.sql
create or replace function fat.retract_payment(
  p_payment_record_id uuid,
  p_actor_id          uuid,
  p_reason            text    default null,
  p_tolerance         numeric default 0.01
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  v_exists     boolean;
  v_ent_ids    uuid[];
  v_ent_id     uuid;
  v_changed    boolean;
  v_prior      text;
  v_new        text;
  v_recomputed integer := 0;
  v_audits     integer := 0;
  v_line_ids   uuid[];
  v_lines_reopened integer := 0;
begin
  -- Confirm the record is present (and visible under RLS) before mutating.
  select true into v_exists from fat.payment_records r where r.id = p_payment_record_id;
  if not found then
    raise exception 'retract_payment: payment_record % not found', p_payment_record_id using errcode = 'no_data_found';
  end if;

  -- Snapshot the DISTINCT formerly-linked entitlements BEFORE the cascade (§ 4.3).
  -- DISTINCT collapses an entitlement that holds several links to this record
  -- (e.g. an auto_match + a discrepancy_note) to a single recompute + audit row.
  select array_agg(distinct l.entitlement_id)
    into v_ent_ids
    from fat.entitlement_payment_links l
   where l.payment_record_id = p_payment_record_id;

  -- Snapshot the payslip staging lines this record settled, BEFORE the cascade nulls
  -- their payment_record_id (P1-2). The lines themselves are not deleted (FK is SET
  -- NULL), so their ids remain valid for the re-open below.
  select array_agg(l.id)
    into v_line_ids
    from fat.payslip_import_lines l
   where l.payment_record_id = p_payment_record_id;

  -- Hard-delete the record; the on-delete-cascade FK removes every link row.
  delete from fat.payment_records where id = p_payment_record_id;

  if v_ent_ids is not null then
    foreach v_ent_id in array v_ent_ids loop
      -- Recompute reads the REMAINING (post-cascade) links; its prior_status is the
      -- pre-cascade stored status, new_status the recomputed one. It writes the
      -- status only when it actually changed (§ 9.6).
      select changed, prior_status, new_status
        into v_changed, v_prior, v_new
        from fat._reconc_recompute(v_ent_id, p_tolerance);
      v_recomputed := v_recomputed + 1;

      -- One unlink_payment row per formerly-linked entitlement, regardless of
      -- whether status changed — the audit records the evidence loss (§ 4.3).
      -- automated = false: retraction is an operator-initiated action, matching
      -- the single-link unlink path (08 § 6).
      perform fat._reconc_write_audit(
        v_ent_id, p_actor_id, 'unlink_payment', v_prior, v_new, p_reason, false);
      v_audits := v_audits + 1;
    end loop;
  end if;

  -- P1-2: re-open the payslip lines this record had settled
  -- The cascade above already cleared payment_record_id + link_id (SET NULL) but
  -- left status='confirmed'. Revert each such line to 'needs_review' so the operator
  -- can re-confirm corrected content, and re-open any parent import that had gone
  -- 'confirmed' (it now holds an open line again).
  if v_line_ids is not null then
    update fat.payslip_import_lines
       set status = 'needs_review', confirmed_at = null
     where id = any(v_line_ids)
       and status = 'confirmed';
    get diagnostics v_lines_reopened = row_count;

    update fat.payslip_imports i
       set status = 'needs_review'
     where i.status = 'confirmed'
       and i.id in (
         select distinct l.import_id
           from fat.payslip_import_lines l
          where l.id = any(v_line_ids)
       );
  end if;

  return jsonb_build_object(
    'payment_record_id',       p_payment_record_id,
    'entitlements_recomputed', v_recomputed,
    'audit_rows_written',      v_audits,
    'lines_reopened',          v_lines_reopened
  );
end;
$$;
-- fat.payslip_line_content_fp: verbatim from supabase/canonical/12_payslip_duplicate_detection.sql
create or replace function fat.payslip_line_content_fp(
  p_reference   text,
  p_description text,
  p_amount      numeric,
  p_date        date
) returns text
language sql
immutable
set search_path = fat, pg_temp
as $$
  select md5(
    lower(coalesce(btrim(p_reference),   '')) || chr(31) ||
    lower(coalesce(btrim(p_description), '')) || chr(31) ||
    coalesce(to_char(round(p_amount, 2), 'FM999999990.00'), '~') || chr(31) ||
    coalesce(p_date::text, '~')
  )
$$;
-- fat.payslip_line_fp_trigger: verbatim from supabase/canonical/12_payslip_duplicate_detection.sql
create or replace function fat.payslip_line_fp_trigger()
returns trigger
language plpgsql
set search_path = fat, pg_temp
as $$
declare
  v_pay_date date;
begin
  select pay_date into v_pay_date from fat.payslip_imports where id = NEW.import_id;
  NEW.content_fingerprint := fat.payslip_line_content_fp(
    NEW.parsed_reference,
    NEW.parsed_description,
    NEW.parsed_amount,
    coalesce(NEW.parsed_date, v_pay_date)
  );
  return NEW;
end;
$$;
-- fat.confirm_payslip_import_line: verbatim from supabase/canonical/17_confirm_duplicate_lock.sql
create or replace function fat.confirm_payslip_import_line(
  p_line_id          uuid,
  p_actor_id         uuid,
  p_entitlement_id   uuid    default null,   -- operator's final choice (may differ from candidate)
  p_link_kind        text    default null,   -- 'auto_match' | 'manual' | null (record only)
  p_allocated_amount numeric default null,   -- defaults to parsed_amount when linking
  p_tolerance        numeric default 0.01,
  p_allow_duplicate  boolean default false   -- operator override of the dup guard (§ 4)
) returns jsonb
language plpgsql
security invoker
set search_path = fat, pg_temp
as $$
declare
  -- staging line
  v_line_owner    uuid;
  v_line_status   text;
  v_import_id     uuid;
  v_parsed_amount numeric;
  v_parsed_date   date;
  v_parsed_ref    text;
  v_parsed_desc   text;
  v_raw_text      text;
  v_match_break   jsonb;
  v_existing_rec  uuid;
  v_existing_link uuid;
  v_line_fp       text;
  -- duplicate guard
  v_dup_line      uuid;
  v_dup_rec       uuid;
  v_dup_import    uuid;
  -- import
  v_import_source text;
  v_import_paydate date;
  v_rec_source    text;
  -- record date
  v_record_date   date;
  v_gross         numeric;
  -- chosen entitlement
  v_ent_method    text;
  v_do_link       boolean := false;
  v_alloc         numeric;
  -- outputs
  v_record        fat.payment_records;
  v_link_result   jsonb;
  v_link_id       uuid;
  v_open_remaining integer;
  v_import_status text;
begin
  -- Step 0: owner coherence (§ 6.1 step 0 — load-bearing)
  select l.owner_id, l.status, l.import_id, l.parsed_amount, l.parsed_date,
         l.parsed_reference, l.parsed_description, l.raw_text, l.match_breakdown,
         l.payment_record_id, l.link_id, l.content_fingerprint
    into v_line_owner, v_line_status, v_import_id, v_parsed_amount, v_parsed_date,
         v_parsed_ref, v_parsed_desc, v_raw_text, v_match_break,
         v_existing_rec, v_existing_link, v_line_fp
    from fat.payslip_import_lines l
   where l.id = p_line_id;
  if not found then
    raise exception 'confirm_payslip_import_line: line % not found', p_line_id using errcode = 'no_data_found';
  end if;
  if v_line_owner is distinct from p_actor_id then
    raise exception 'confirm_payslip_import_line: actor % is not the line owner %', p_actor_id, v_line_owner;
  end if;

  -- Step 1: idempotency / terminal guard (§ 6.1 step 1, § 6.3)
  if v_line_status = 'confirmed' and v_existing_rec is not null then
    select e.status into v_import_status from fat.payslip_imports e where e.id = v_import_id;
    return jsonb_build_object(
      'line_id',           p_line_id,
      'idempotent',        true,
      'payment_record_id', v_existing_rec,
      'link_id',           v_existing_link,
      'line_status',       'confirmed',
      'import_status',     v_import_status
    );
  end if;
  if v_line_status not in ('parsed','needs_review') then
    raise exception 'confirm_payslip_import_line: line % is %, only parsed/needs_review are confirmable', p_line_id, v_line_status using errcode = 'check_violation';
  end if;

  -- Step 1.5: DOUBLE-CONFIRMATION GUARD (blocker #1b, § 4)
  -- Refuse to mint a SECOND payment_record for content that an already-confirmed
  -- line (a different line — re-typed/re-uploaded payslip) already settled. The
  -- match is on the SQL content fingerprint (owner-scoped), so it spans imports,
  -- which the per-line idempotency guard (step 1) deliberately does not. The
  -- operator can override explicitly (p_allow_duplicate) — detection warns, the
  -- operator decides (governance: manual override always available). NOTE: a
  -- record-only confirm that was later RETRACTED clears payment_record_id (line is
  -- on delete set null, § 6.5) so a re-confirm of corrected content is NOT blocked.
  if v_line_fp is not null then
    -- P1-4: serialize concurrent confirmations of identical content for this owner
    -- so the guard probe below cannot be raced. Transaction-scoped; released on
    -- commit/rollback. Keyed on owner+fingerprint, so unrelated confirms never block.
    perform pg_advisory_xact_lock(hashtextextended(v_line_owner::text || ':' || v_line_fp, 0));

    select l2.id, l2.payment_record_id, l2.import_id
      into v_dup_line, v_dup_rec, v_dup_import
      from fat.payslip_import_lines l2
     where l2.owner_id = v_line_owner
       and l2.id <> p_line_id
       and l2.status = 'confirmed'
       and l2.payment_record_id is not null
       and l2.content_fingerprint = v_line_fp
     order by l2.confirmed_at asc nulls last
     limit 1;
    if found and not p_allow_duplicate then
      raise exception
        'confirm_payslip_import_line: line % duplicates already-confirmed line % (payment record %) — set p_allow_duplicate to override',
        p_line_id, v_dup_line, v_dup_rec
        using errcode = 'unique_violation',
              detail = json_build_object(
                'reason',              'duplicate_confirmed_line',
                'duplicate_line_id',   v_dup_line,
                'duplicate_record_id', v_dup_rec,
                'duplicate_import_id', v_dup_import,
                'fingerprint',         v_line_fp
              )::text;
    end if;
  end if;

  -- Source mapping + record date (§ 6.2)
  select e.source, e.pay_date into v_import_source, v_import_paydate
    from fat.payslip_imports e where e.id = v_import_id;
  v_rec_source := case v_import_source
                    when 'manual_entry'       then 'manual'
                    when 'payslip_screenshot' then 'payslip_screenshot'
                    when 'payslip_pdf'        then 'payslip_pdf'
                    else 'manual'
                  end;

  v_record_date := coalesce(v_parsed_date, v_import_paydate);
  if v_record_date is null then
    raise exception 'confirm_payslip_import_line: line % has no parsed_date and import has no pay_date', p_line_id using errcode = 'not_null_violation';
  end if;
  v_gross := coalesce(v_parsed_amount, 0);

  -- Step 3 (decided BEFORE the link call): link-eligibility pre-branch
  if p_entitlement_id is not null and p_link_kind is not null then
    if p_link_kind not in ('auto_match','manual') then
      raise exception 'confirm_payslip_import_line: invalid link_kind % (auto_match|manual|null)', p_link_kind using errcode = 'check_violation';
    end if;
    select ce.payment_method into v_ent_method
      from fat.claim_entitlements ce where ce.id = p_entitlement_id;
    if not found then
      raise exception 'confirm_payslip_import_line: entitlement % not found', p_entitlement_id using errcode = 'no_data_found';
    end if;
    if v_ent_method = 'payslip' then
      v_do_link := true;
    elsif v_ent_method is null then
      v_do_link := false;
    else
      raise exception 'confirm_payslip_import_line: entitlement % is routed to % — a payslip line cannot settle it', p_entitlement_id, v_ent_method using errcode = 'check_violation';
    end if;
  end if;

  -- Step 2: create the payment record (existing RPC, § 6.1 step 2)
  v_record := fat.create_payment_record(
    v_line_owner,
    'payslip',
    v_record_date,
    v_gross,
    v_rec_source,
    v_parsed_ref,
    jsonb_build_object(
      'import_id',          v_import_id,
      'line_id',            p_line_id,
      'raw_text',           v_raw_text,
      'parsed_reference',   v_parsed_ref,
      'parsed_description', v_parsed_desc,
      'parsed_amount',      v_parsed_amount,
      'parsed_date',        v_parsed_date,
      'match_breakdown',    v_match_break,
      'content_fingerprint', v_line_fp,
      'source',             v_import_source
    )
  );

  -- Step 3 (execute): link IFF the pre-branch said so (existing RPC)
  if v_do_link then
    v_alloc := coalesce(p_allocated_amount, v_parsed_amount, 0);
    v_link_result := fat.link_entitlement_payment(
      p_entitlement_id,
      v_record.id,
      v_alloc,
      p_link_kind,
      p_actor_id,
      null,
      false,
      p_tolerance
    );
    v_link_id := (v_link_result ->> 'link_id')::uuid;
  end if;

  -- Step 4: stamp the line (§ 6.1 step 4)
  update fat.payslip_import_lines
     set status            = 'confirmed',
         payment_record_id = v_record.id,
         link_id           = v_link_id,
         confirmed_at      = now()
   where id = p_line_id;

  -- Step 5: recompute import status (§ 6.1 step 5 / § 4.1)
  select count(*) into v_open_remaining
    from fat.payslip_import_lines l
   where l.import_id = v_import_id
     and l.status in ('parsed','needs_review','failed');

  if v_open_remaining = 0 then
    update fat.payslip_imports
       set status = 'confirmed', confirmed_at = now()
     where id = v_import_id
    returning status into v_import_status;
  else
    update fat.payslip_imports
       set status = 'needs_review'
     where id = v_import_id
       and status not in ('confirmed','needs_review')
    returning status into v_import_status;
    if v_import_status is null then
      select status into v_import_status from fat.payslip_imports where id = v_import_id;
    end if;
  end if;

  return jsonb_build_object(
    'line_id',           p_line_id,
    'idempotent',        false,
    'payment_record_id', v_record.id,
    'link_id',           v_link_id,
    'linked',            v_do_link,
    'link_result',       v_link_result,
    'line_status',       'confirmed',
    'import_status',     v_import_status,
    'open_lines_remaining', v_open_remaining,
    'duplicate_overridden', (p_allow_duplicate and v_dup_line is not null)
  );
end;
$$;

create trigger set_content_fingerprint
  before insert or update of parsed_reference, parsed_description, parsed_amount, parsed_date on fat.payslip_import_lines
  for each row execute function fat.payslip_line_fp_trigger();

revoke all on function fat._reconc_recompute(uuid, numeric) from public;
revoke all on function fat._reconc_write_audit(uuid, uuid, text, text, text, text, boolean) from public;
revoke all on function fat.create_payment_record(uuid, text, date, numeric, text, text, jsonb) from public;
revoke all on function fat.link_entitlement_payment(uuid, uuid, numeric, text, uuid, text, boolean, numeric) from public;
revoke all on function fat.unlink_entitlement_payment(uuid, uuid, text, numeric) from public;
revoke all on function fat.recompute_entitlement_status(uuid, uuid, text, text, numeric) from public;
revoke all on function fat.route_entitlement(uuid, text, uuid, text) from public;
revoke all on function fat.retract_payment(uuid, uuid, text, numeric) from public;
revoke all on function fat.payslip_line_content_fp(text, text, numeric, date) from public;
revoke all on function fat.payslip_line_fp_trigger() from public;
revoke all on function fat.confirm_payslip_import_line(uuid, uuid, uuid, text, numeric, numeric, boolean) from public;
