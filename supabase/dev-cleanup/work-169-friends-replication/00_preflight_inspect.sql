-- ═══════════════════════════════════════════════════════════════════════════════
-- WORK-169 — FAT friends / claim-replication layer (DEV)
-- Step 00: PREFLIGHT INSPECTION — READ-ONLY
--
-- Run against DEV (kctctvpobbizhkiqkgqw) before 01. Every statement is a SELECT.
-- Against PROD (wgcqzamuspuqpedqasbc) it is the non-presence proof: sections 1–5
-- must return zero rows there.
-- ═══════════════════════════════════════════════════════════════════════════════


-- 1. Relations (tables + indexes) belonging to the layer, with RLS state and ACL.
SELECT n.nspname, c.relname, c.relkind, c.relrowsecurity, c.relacl
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'fat'
  AND c.relname ~ '^(friend_requests|friendships|claim_replication_events|replication_events_)'
ORDER BY c.relkind, c.relname;

-- 2. Row counts. Must all be 0 — 01 aborts otherwise.
SELECT
  (SELECT count(*) FROM fat.friend_requests)          AS friend_requests,
  (SELECT count(*) FROM fat.friendships)              AS friendships,
  (SELECT count(*) FROM fat.claim_replication_events) AS claim_replication_events;

-- 3. Functions: exact signatures, SECURITY DEFINER, owner, EXECUTE grants, and a
--    definition hash to compare with the provenance file.
SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns, p.prosecdef,
       pg_get_userbyid(p.proowner) AS owner, p.proacl, p.proconfig,
       md5(pg_get_functiondef(p.oid)) AS def_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND (p.proname ~* 'friend|replicat|search_user'
       OR p.prosrc ~* 'friend_requests|friendships|claim_replication_events')
ORDER BY p.proname;

-- 4. Policies.
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'fat' AND tablename IN ('friend_requests','friendships','claim_replication_events');

-- 5. Constraints on, or pointing into, the three tables.
SELECT con.conrelid::regclass AS tbl, con.conname, con.contype, pg_get_constraintdef(con.oid)
FROM pg_constraint con
WHERE con.conrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'fat' AND c.relname IN ('friend_requests','friendships','claim_replication_events'))
   OR con.confrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                         WHERE n.nspname = 'fat' AND c.relname IN ('friend_requests','friendships','claim_replication_events'))
ORDER BY 1, 2;

-- 6. Everything else that depends on the three tables (expected: their own column
--    defaults only).
SELECT d.classid::regclass AS dependent_catalog, d.objid, d.deptype, d.refobjid::regclass AS referenced
FROM pg_depend d
WHERE d.refobjid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'fat' AND c.relname IN ('friend_requests','friendships','claim_replication_events'))
  AND d.classid NOT IN ('pg_class'::regclass, 'pg_constraint'::regclass, 'pg_type'::regclass, 'pg_policy'::regclass);

-- 7. Triggers touching the layer (expected: none).
SELECT t.tgrelid::regclass, t.tgname, pg_get_triggerdef(t.oid)
FROM pg_trigger t
WHERE NOT t.tgisinternal AND pg_get_triggerdef(t.oid) ~* 'friend|replicat';

-- 8. Ledger provenance. Expected on DEV: 20260515223705 fat_friends_and_claim_replication,
--    md5 ea4991186cb5734a27a51f851edb9b0a (identical to the provenance file).
SELECT version, name, md5(array_to_string(statements, E'\n')) AS statements_md5
FROM supabase_migrations.schema_migrations
WHERE name ~* 'friend|replicat';
