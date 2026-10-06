-- FAT catalog fingerprint (WORK-254)
-- Read-only. Runs unchanged on Neon and on legacy Supabase (no Neon/Supabase
-- specific object referenced) so the two catalogs can be compared mechanically:
-- one row per (kind, object) with an md5 over the object's definition.
--   kind = columns | constraints | indexes | triggers  (per fat table)
--        | function (per fat function: signature, security, config, normalized body)
-- Prototype-only tables are excluded so Supabase and Neon cover the same set.
with t as (
  select c.oid, c.relname from pg_class c
   where c.relnamespace = 'fat'::regnamespace and c.relkind = 'r'
     and c.relname not in ('recalls','retain','standby','spoilt_meals','claim_groups','user_rates')
)
select 'columns' as kind, t.relname as object,
       md5(string_agg(format('%s %s %s %s', a.attname, format_type(a.atttypid, a.atttypmod),
                             coalesce(pg_get_expr(d.adbin, d.adrelid), '-'), a.attnotnull), '|' order by a.attnum)) as md5
  from t join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  left join pg_attrdef d on d.adrelid = t.oid and d.adnum = a.attnum
 group by t.relname
union all
select 'constraints', t.relname, md5(string_agg(k.conname || ' ' || pg_get_constraintdef(k.oid), '|' order by k.conname))
  from t join pg_constraint k on k.conrelid = t.oid group by t.relname
union all
select 'indexes', t.relname, md5(string_agg(pg_get_indexdef(i.indexrelid), '|' order by pg_get_indexdef(i.indexrelid)))
  from t join pg_index i on i.indrelid = t.oid group by t.relname
union all
select 'triggers', t.relname, md5(string_agg(pg_get_triggerdef(g.oid), '|' order by g.tgname))
  from t join pg_trigger g on g.tgrelid = t.oid and not g.tgisinternal group by t.relname
union all
select 'function', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
       md5(concat_ws('|', pg_get_function_result(p.oid), p.prosecdef, p.provolatile, array_to_string(p.proconfig, ','),
           (select string_agg(x, E'\n' order by n) from (
              select n, rtrim(regexp_replace(lower(replace(replace(line, E'\r', ''), '—', '--')), '\s+--\s[^'']*$', '')) x
                from regexp_split_to_table(p.prosrc, E'\n') with ordinality as l(line, n)
               where btrim(line) <> '' and btrim(line) !~ '^--') s where x <> '')))
  from pg_proc p where p.pronamespace = 'fat'::regnamespace
order by 1, 2;
