-- Rollback of 20261006060400_fat_neon_security.sql (WORK-254).
-- Removes every policy and fat_app/fat_service privilege in fat and disables RLS.
-- Not destructive to data, but it REMOVES ISOLATION: never leave a target in
-- this state with fat_app login members present; roll back 1/6–4/6 next or re-apply 5/6.
do $rb$
declare p record; t record;
begin
  for p in select policyname, schemaname, tablename from pg_policies where schemaname = 'fat' loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
  for t in select c.oid::regclass as rel from pg_class c where c.relnamespace = 'fat'::regnamespace and c.relkind = 'r' loop
    execute format('revoke all on %s from fat_app, fat_service', t.rel);
    execute format('alter table %s disable row level security', t.rel);
  end loop;
end;
$rb$;
revoke execute on all functions in schema fat from fat_app, fat_service;
delete from fat_migrations.schema_migrations where version = '20261006060400';
