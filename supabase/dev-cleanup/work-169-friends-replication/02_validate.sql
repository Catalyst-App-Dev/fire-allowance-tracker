-- ═══════════════════════════════════════════════════════════════════════════════
-- WORK-169 — FAT friends / claim-replication layer (DEV)
-- Step 02: VALIDATION — READ-ONLY
--
-- Run against DEV (kctctvpobbizhkiqkgqw) after 01. Every check returns one row
-- with pass = true. The same queries against PROD (wgcqzamuspuqpedqasbc) are the
-- non-presence proof, except check 6 (no ledger entry there, by design).
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT '1. no layer tables or indexes' AS check,
       count(*) = 0 AS pass, string_agg(c.relname, ', ') AS found
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'fat'
  AND c.relname ~ '^(friend_requests|friendships|claim_replication_events|replication_events_)'

UNION ALL
SELECT '2. no layer functions in any schema (incl. search_user_by_email, replicate_claim_to_friends)',
       count(*) = 0, string_agg(n.nspname || '.' || p.proname, ', ')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND p.proname IN ('search_user_by_email','send_friend_request','accept_friend_request',
                    'reject_friend_request','cancel_friend_request','remove_friend',
                    'list_friends_with_profile','list_friend_requests_with_profile',
                    'replicate_claim_to_friends','mark_replication_events_seen')

UNION ALL
SELECT '3. no orphan routine names or references the layer',
       count(*) = 0, string_agg(n.nspname || '.' || p.proname, ', ')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname NOT IN ('pg_catalog','information_schema')
  AND (p.proname ~* 'friend' OR p.prosrc ~* '\m(friend_requests|friendships|claim_replication_events)\M')

UNION ALL
SELECT '4. no layer policies',
       count(*) = 0, string_agg(policyname, ', ')
FROM pg_policies
WHERE schemaname = 'fat'
  AND (tablename IN ('friend_requests','friendships','claim_replication_events')
       OR policyname IN ('requests_select_own','friendships_select_own','replication_events_select_own'))

UNION ALL
SELECT '5. no authenticated/anon EXECUTE on any fat SECURITY DEFINER routine named for the layer',
       count(*) = 0, string_agg(p.proname, ', ')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'fat' AND p.prosecdef
  AND p.proname ~* 'friend|replicat|search_user'
  AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'))

UNION ALL
SELECT '6. DEV ledger records the removal',
       count(*) = 1, string_agg(version || ' ' || name, ', ')
FROM supabase_migrations.schema_migrations
WHERE name = 'work169_drop_fat_friends_replication_v1'

UNION ALL
SELECT '7. fat schema intact (profiles present)',
       to_regclass('fat.profiles') IS NOT NULL, NULL;
