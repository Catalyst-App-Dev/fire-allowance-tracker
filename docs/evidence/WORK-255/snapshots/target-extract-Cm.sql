-- C2/C3 cross-database TARGET extraction (WORK-255). Runs on the Neon target. Read-only.
-- snapshot_md5 = md5 of the database's own rendering of the snapshot: a copied snapshot is exact iff
-- md5(<copy>::jsonb::text) equals it.
select x.s as snapshot, md5(x.s::text) as snapshot_md5 from (with scope as (select $c2scope${"emails":["synthetic.n3.member.a@example.invalid"],"financial_years":["5eed0255-0000-4000-8000-0000000000a1"],"has_source":true,"owners":["5eed0255-0000-4000-8000-00000000000a"],"rows":[{"id":"5eed0255-0000-4000-8000-0000000e0001","t":"claim_groups"}],"stations":[]}$c2scope$::jsonb as s),
  ref as (select jsonb_build_object(
      'stations', coalesce((select jsonb_agg(jsonb_build_object('id', st.id, 'name', st.name) order by st.id) from fat.stations st
          where st.id in (select (jsonb_array_elements_text((select s from scope)->'stations'))::int)), '[]'::jsonb),
      'rates', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'unit', r.unit) order by r.id) from fat.rates r
          where coalesce(((select s from scope)->>'has_source')::boolean, false) and r.code in ('enterprise_base_pay_weekly', 'overtime_rate_factor', 'overtime_hourly_divisor', 'double_time_multiplier', 'single_time_multiplier', 'time_and_half_multiplier', 'travel_per_km', 'meal_allowance', 'spoilt_meal_allowance', 'relieving_allowance')), '[]'::jsonb),
      'rate_versions', coalesce((select jsonb_agg(jsonb_build_object('id', v.id, 'rate_id', v.rate_id, 'version_label', v.version_label, 'value', v.value::text,
            'effective_from', v.effective_from, 'classification', v.classification, 'source_kind', v.source_kind, 'source_ref', v.source_ref,
            'withdrawn', v.withdrawn_at is not null) order by v.id)
          from fat.rate_versions v join fat.rates r on r.id = v.rate_id where coalesce(((select s from scope)->>'has_source')::boolean, false) and r.code in ('enterprise_base_pay_weekly', 'overtime_rate_factor', 'overtime_hourly_divisor', 'double_time_multiplier', 'single_time_multiplier', 'time_and_half_multiplier', 'travel_per_km', 'meal_allowance', 'spoilt_meal_allowance', 'relieving_allowance')), '[]'::jsonb),
      'native_claims', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'owner_id', c.owner_id, 'claim_type', c.claim_type, 'claim_date', c.claim_date,
            'station_id_snapshot', c.station_id_snapshot, 'dest_station_id', coalesce(sd.standby_station_id, md.md_station_id)) order by c.id)
          from fat.operational_claims c
          left join fat.standby_details sd on sd.claim_id = c.id
          left join fat.muster_dismiss_details md on md.claim_id = c.id
          where c.prototype_row_id is null and c.migration_batch_id is null
            and c.owner_id::text in (select jsonb_array_elements_text((select s from scope)->'owners'))), '[]'::jsonb)) as r)
  select jsonb_build_object(
    'schema', 'fat.c2.target-snapshot/v1',
    'provider', 'neon',
    'scope', (select s from scope),
    'reference', (select r from ref),
    'reference_md5', md5((select r from ref)::text),
    'state', jsonb_build_object(
      'identities', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'origin', i.origin, 'legacy_subject', i.legacy_subject, 'status', i.status) order by i.id)
          from fat.app_identities i where i.id::text in (select jsonb_array_elements_text((select s from scope)->'owners'))
             or lower(i.email) in (select jsonb_array_elements_text((select s from scope)->'emails'))), '[]'::jsonb),
      'profiles', coalesce((select jsonb_agg(p.id order by p.id) from fat.profiles p where p.id::text in (select jsonb_array_elements_text((select s from scope)->'owners'))), '[]'::jsonb),
      'financial_years', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'user_id', f.user_id, 'label', f.label, 'start_date', f.start_date, 'end_date', f.end_date) order by f.id)
          from fat.financial_years f where f.id::text in (select jsonb_array_elements_text((select s from scope)->'financial_years'))
             or f.user_id::text in (select jsonb_array_elements_text((select s from scope)->'owners'))), '[]'::jsonb),
      'claims_in_scope', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'owner_id', c.owner_id, 'financial_year_id', c.financial_year_id, 'claim_type', c.claim_type,
            'claim_number', c.claim_number, 'prototype_source', c.prototype_source, 'prototype_row_id', c.prototype_row_id, 'batch_key', b.batch_key) order by c.id)
          from fat.operational_claims c left join fat.migration_batches b on b.id = c.migration_batch_id
          where c.financial_year_id::text in (select jsonb_array_elements_text((select s from scope)->'financial_years'))
             or c.prototype_row_id::text in (select x->>'id' from jsonb_array_elements((select s from scope)->'rows') x)), '[]'::jsonb),
      'ledger', coalesce((select jsonb_agg(jsonb_build_object('source_table', l.source_table, 'source_row_id', l.source_row_id, 'batch_key', b.batch_key,
            'source_checksum', l.source_checksum, 'disposition', l.disposition) order by l.source_table, l.source_row_id)
          from fat.migration_source_rows l join fat.migration_batches b on b.id = l.batch_id
          where exists (select 1 from jsonb_array_elements((select s from scope)->'rows') x where x->>'t' = l.source_table and x->>'id' = l.source_row_id::text)), '[]'::jsonb),
      'batches', coalesce((select jsonb_agg(jsonb_build_object('batch_key', b.batch_key, 'step', b.step, 'status', b.status, 'source_checksum', b.source_checksum) order by b.batch_key)
          from fat.migration_batches b where b.step = 'C2'), '[]'::jsonb)))) x(s);
