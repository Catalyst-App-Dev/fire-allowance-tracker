-- ═══════════════════════════════════════════════════════════════════════════════
-- WORK-169 — REMOVE THE ABANDONED FAT FRIENDS / CLAIM-REPLICATION LAYER (DEV)
-- Step 01: THE MIGRATION — DESTRUCTIVE
--
-- Applied to DEV (kctctvpobbizhkiqkgqw) as migration
-- `work169_drop_fat_friends_replication_v1`. PRODUCTION (wgcqzamuspuqpedqasbc)
-- NEVER HAD THIS LAYER AND MUST NOT RECEIVE THIS MIGRATION. Guard 1 refuses to
-- run where the layer is absent, so it cannot be recorded in a ledger that never
-- had the objects.
--
-- Removes exactly the objects created by DEV ledger entry
-- `20260515223705 fat_friends_and_claim_replication` (preserved verbatim, as
-- non-executable text, in provenance/), and nothing else:
--
--   Functions (10, SECURITY DEFINER, EXECUTE granted to authenticated):
--     fat.search_user_by_email(text)
--     fat.send_friend_request(uuid)
--     fat.accept_friend_request(uuid)
--     fat.reject_friend_request(uuid)
--     fat.cancel_friend_request(uuid)
--     fat.remove_friend(uuid)
--     fat.list_friends_with_profile()
--     fat.list_friend_requests_with_profile()
--     fat.replicate_claim_to_friends(text, uuid, uuid[])
--     fat.mark_replication_events_seen(uuid[])
--   Policies (3): requests_select_own, friendships_select_own,
--                 replication_events_select_own
--   Tables (3):   fat.friend_requests, fat.friendships,
--                 fat.claim_replication_events
--                 (with their own 10 indexes, constraints, column defaults and
--                 grants, which are internal to each table)
--
-- WHY
-- Operator decision D5 (WORK-164): the layer is not part of FAT. Gap G14.
-- `search_user_by_email` lets any signed-in user of the shared auth pool resolve
-- an email to a user id and name; `replicate_claim_to_friends` writes claims into
-- another user's ledger through a SECURITY DEFINER path. No FAT code calls any of
-- these objects.
--
-- NO CASCADE
-- Every DROP is explicit RESTRICT with an exact signature, so an unexpected
-- external dependant aborts the migration instead of being silently destroyed.
-- The only catalog dependency inside the set is send_friend_request's return
-- type (fat.friend_requests), so functions are dropped before tables. The three
-- tables do not reference one another; their only FKs point out to auth.users,
-- which is neither read nor altered.
--
-- FAIL CLOSED ON DATA
-- Guard 2 aborts if any of the three tables holds a row. Nothing is discarded
-- silently; a non-empty table needs a separate decision. Before that check the
-- three tables are locked ACCESS EXCLUSIVE (the mode DROP TABLE itself needs, so
-- there is no later lock upgrade), so no concurrent INSERT/UPDATE/DELETE, for
-- example via a still-live SECURITY DEFINER function, can land between the
-- emptiness check and the drops. The locks are held until COMMIT/ROLLBACK.
-- lock_timeout makes a blocked lock attempt abort rather than queue
-- indefinitely.
--
-- Every guard RAISEs EXCEPTION, which rolls the whole migration back.
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── GUARD 1 — the layer is present, complete, and this is a FAT database ────
DO $guard$
DECLARE
  v_tables    integer;
  v_functions integer;
BEGIN
  IF to_regnamespace('fat') IS NULL OR to_regclass('fat.profiles') IS NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: the fat schema / fat.profiles is absent. This is not the FAT database the migration was scoped against.';
  END IF;

  SELECT count(*) INTO v_tables
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'fat' AND c.relkind = 'r'
    AND c.relname IN ('friend_requests','friendships','claim_replication_events');

  SELECT count(*) INTO v_functions
  FROM unnest(ARRAY[
    'fat.search_user_by_email(text)',
    'fat.send_friend_request(uuid)',
    'fat.accept_friend_request(uuid)',
    'fat.reject_friend_request(uuid)',
    'fat.cancel_friend_request(uuid)',
    'fat.remove_friend(uuid)',
    'fat.list_friends_with_profile()',
    'fat.list_friend_requests_with_profile()',
    'fat.replicate_claim_to_friends(text, uuid, uuid[])',
    'fat.mark_replication_events_seen(uuid[])'
  ]) sig
  WHERE to_regprocedure(sig) IS NOT NULL;

  IF v_tables = 0 AND v_functions = 0 THEN
    RAISE EXCEPTION 'WORK-169 abort: the friends/replication layer is absent here. This migration is DEV-only and must not be recorded where the layer never existed (e.g. PROD).';
  END IF;

  IF v_tables <> 3 OR v_functions <> 10 THEN
    RAISE EXCEPTION 'WORK-169 abort: expected 3 tables and 10 functions, found % and %. A partial layer is drift; re-inventory before removing.', v_tables, v_functions;
  END IF;
END
$guard$;


-- ─── LOCK — block every writer before the emptiness check ────────────────────
-- Guard 1 has proved all three tables exist. One LOCK statement takes them in a
-- fixed order; ACCESS EXCLUSIVE conflicts with every other lock mode, so no row
-- can be written (or read) until this transaction ends.
SET LOCAL lock_timeout = '10s';
LOCK TABLE fat.friend_requests, fat.friendships, fat.claim_replication_events
  IN ACCESS EXCLUSIVE MODE;


-- ─── GUARD 2 — every table is empty (checked under the lock above) ───────────
DO $empty$
DECLARE
  v_fr  bigint;
  v_fs  bigint;
  v_cre bigint;
BEGIN
  SELECT count(*) INTO v_fr  FROM fat.friend_requests;
  SELECT count(*) INTO v_fs  FROM fat.friendships;
  SELECT count(*) INTO v_cre FROM fat.claim_replication_events;
  IF v_fr + v_fs + v_cre <> 0 THEN
    RAISE EXCEPTION 'WORK-169 abort: feature tables are not empty (friend_requests=%, friendships=%, claim_replication_events=%). Record the state and decide separately; nothing is discarded silently.', v_fr, v_fs, v_cre;
  END IF;
END
$empty$;


-- ─── GUARD 3 — nothing outside the drop set depends on the drop set ──────────
DO $deps$
DECLARE
  v_offender text;
BEGIN
  -- 3a. No foreign key from outside the three tables may point into them.
  SELECT string_agg(format('%s.%I', con.conrelid::regclass, con.conname), '; ')
    INTO v_offender
  FROM pg_constraint con
  WHERE con.contype = 'f'
    AND con.confrelid IN ('fat.friend_requests'::regclass, 'fat.friendships'::regclass,
                          'fat.claim_replication_events'::regclass)
    AND con.conrelid NOT IN ('fat.friend_requests'::regclass, 'fat.friendships'::regclass,
                             'fat.claim_replication_events'::regclass);
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: foreign key(s) from outside the drop set reference it: %', v_offender;
  END IF;

  -- 3b. No view / materialized view / rule may depend on the three tables.
  SELECT string_agg(DISTINCT r.ev_class::regclass::text, '; ')
    INTO v_offender
  FROM pg_depend d
  JOIN pg_rewrite r ON r.oid = d.objid
  WHERE d.classid = 'pg_rewrite'::regclass
    AND d.refclassid = 'pg_class'::regclass
    AND d.refobjid IN ('fat.friend_requests'::regclass, 'fat.friendships'::regclass,
                       'fat.claim_replication_events'::regclass)
    AND r.ev_class <> d.refobjid;
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: view/rule dependency on the drop set: %', v_offender;
  END IF;

  -- 3c. No trigger anywhere may call one of the ten functions.
  SELECT string_agg(format('%s.%I', t.tgrelid::regclass, t.tgname), '; ')
    INTO v_offender
  FROM pg_trigger t
  JOIN pg_proc p ON p.oid = t.tgfoid
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'fat'
    AND p.proname IN ('search_user_by_email','send_friend_request','accept_friend_request',
                      'reject_friend_request','cancel_friend_request','remove_friend',
                      'list_friends_with_profile','list_friend_requests_with_profile',
                      'replicate_claim_to_friends','mark_replication_events_seen');
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: trigger(s) call a function in the drop set: %', v_offender;
  END IF;

  -- 3d. No routine outside the ten may name the three tables or the ten functions.
  SELECT string_agg(format('%I.%I', n.nspname, p.proname), '; ')
    INTO v_offender
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog','information_schema')
    AND NOT (n.nspname = 'fat'
             AND p.proname IN ('search_user_by_email','send_friend_request','accept_friend_request',
                               'reject_friend_request','cancel_friend_request','remove_friend',
                               'list_friends_with_profile','list_friend_requests_with_profile',
                               'replicate_claim_to_friends','mark_replication_events_seen'))
    AND (p.prosrc ~* '\m(friend_requests|friendships|claim_replication_events)\M'
         OR p.prosrc ~* '\m(search_user_by_email|send_friend_request|accept_friend_request|reject_friend_request|cancel_friend_request|remove_friend|list_friends_with_profile|list_friend_requests_with_profile|replicate_claim_to_friends|mark_replication_events_seen)\M');
  IF v_offender IS NOT NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: routine(s) outside the drop set reference it: %', v_offender;
  END IF;
END
$deps$;


-- ─── SNAPSHOT — every other fat object, compared again after the drops ───────
CREATE TEMP TABLE work169_fat_snapshot ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fat'
      AND c.relname NOT IN ('friend_requests','friendships','claim_replication_events',
                            'friend_requests_pkey','friend_requests_pending_unique',
                            'friend_requests_recipient_idx','friend_requests_sender_idx',
                            'friendships_pkey','friendships_user_id_friend_user_id_key',
                            'friendships_user_idx','claim_replication_events_pkey',
                            'replication_events_recipient_idx','replication_events_source_idx'))   AS fat_rels,
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'fat'
      AND p.proname NOT IN ('search_user_by_email','send_friend_request','accept_friend_request',
                            'reject_friend_request','cancel_friend_request','remove_friend',
                            'list_friends_with_profile','list_friend_requests_with_profile',
                            'replicate_claim_to_friends','mark_replication_events_seen'))          AS fat_fns,
  (SELECT count(*) FROM pg_policies
    WHERE schemaname = 'fat'
      AND tablename NOT IN ('friend_requests','friendships','claim_replication_events'))         AS fat_policies,
  (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'fat' AND NOT t.tgisinternal)                                              AS fat_triggers,
  (SELECT count(*) FROM auth.users)                                                              AS auth_users;


-- ─── THE DROPS — dependency-safe order, exact signatures, explicit RESTRICT ──

-- 1. Functions first: send_friend_request returns fat.friend_requests, and every
--    function reads or writes the tables. Dropping a function removes its grants.
DROP FUNCTION fat.search_user_by_email(text) RESTRICT;
DROP FUNCTION fat.send_friend_request(uuid) RESTRICT;
DROP FUNCTION fat.accept_friend_request(uuid) RESTRICT;
DROP FUNCTION fat.reject_friend_request(uuid) RESTRICT;
DROP FUNCTION fat.cancel_friend_request(uuid) RESTRICT;
DROP FUNCTION fat.remove_friend(uuid) RESTRICT;
DROP FUNCTION fat.list_friends_with_profile() RESTRICT;
DROP FUNCTION fat.list_friend_requests_with_profile() RESTRICT;
DROP FUNCTION fat.replicate_claim_to_friends(text, uuid, uuid[]) RESTRICT;
DROP FUNCTION fat.mark_replication_events_seen(uuid[]) RESTRICT;

-- 2. Policies, explicitly, so their removal is visible rather than implied.
DROP POLICY requests_select_own           ON fat.friend_requests;
DROP POLICY friendships_select_own        ON fat.friendships;
DROP POLICY replication_events_select_own ON fat.claim_replication_events;

-- 3. Tables. None references another; indexes, constraints, defaults and grants
--    are internal to each table and go with it.
DROP TABLE fat.claim_replication_events RESTRICT;
DROP TABLE fat.friendships RESTRICT;
DROP TABLE fat.friend_requests RESTRICT;


-- ─── POST-CHECK — the layer is gone and nothing else in fat moved ────────────
DO $post$
DECLARE
  v_left text;
  v_snap record;
BEGIN
  SELECT string_agg(o, ', ') INTO v_left FROM (
    SELECT 'fat.' || c.relname AS o FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'fat' AND c.relname ~ '^(friend_requests|friendships|claim_replication_events|replication_events_)'
    UNION ALL
    SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog','information_schema')
       AND p.proname IN ('search_user_by_email','send_friend_request','accept_friend_request',
                         'reject_friend_request','cancel_friend_request','remove_friend',
                         'list_friends_with_profile','list_friend_requests_with_profile',
                         'replicate_claim_to_friends','mark_replication_events_seen')
    UNION ALL
    SELECT 'policy ' || policyname FROM pg_policies
     WHERE schemaname = 'fat' AND policyname IN ('requests_select_own','friendships_select_own','replication_events_select_own')
  ) s;
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'WORK-169 abort: objects still present after the drops: %', v_left;
  END IF;

  SELECT * INTO v_snap FROM work169_fat_snapshot;
  IF v_snap.fat_rels <> (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'fat')
     OR v_snap.fat_fns <> (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'fat')
     OR v_snap.fat_policies <> (SELECT count(*) FROM pg_policies WHERE schemaname = 'fat')
     OR v_snap.fat_triggers <> (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                                  JOIN pg_namespace n ON n.oid = c.relnamespace
                                 WHERE n.nspname = 'fat' AND NOT t.tgisinternal)
     OR v_snap.auth_users <> (SELECT count(*) FROM auth.users) THEN
    RAISE EXCEPTION 'WORK-169 abort: an object outside the drop set changed (snapshot %).', row_to_json(v_snap);
  END IF;
END
$post$;
