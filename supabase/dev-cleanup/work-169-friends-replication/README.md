# WORK-169 — Remove the abandoned FAT friends / claim-replication layer (DEV)

Linear Issue: **WORK-169** (Workshop · Problem · Architecture · App-specific), Gap
**G14** in [`docs/architecture/GAP_REGISTER.md`](../../../docs/architecture/GAP_REGISTER.md),
operator decision **D5** (remove; any future sharing is a fresh Idea).

Target: **DEV Supabase project `kctctvpobbizhkiqkgqw`** only.
**Production (`wgcqzamuspuqpedqasbc`) never had this layer and must not receive this
migration.** Guard 1 of `01` aborts where the layer is absent, so it cannot be recorded in
a ledger that never had the objects. The package deliberately lives outside
`supabase/canonical/`, which feeds the PROD rollout order.

---

## What this package removed

Exactly the objects created by DEV ledger entry
`20260515223705 fat_friends_and_claim_replication` (no repo SQL, no app code):

| Kind | Objects | Rows at removal |
|---|---|---|
| Tables (RLS on) | `fat.friend_requests`, `fat.friendships`, `fat.claim_replication_events` | 0 / 0 / 0 |
| Functions (SECURITY DEFINER, EXECUTE to authenticated) | `search_user_by_email(text)`, `send_friend_request(uuid)`, `accept_friend_request(uuid)`, `reject_friend_request(uuid)`, `cancel_friend_request(uuid)`, `remove_friend(uuid)`, `list_friends_with_profile()`, `list_friend_requests_with_profile()`, `replicate_claim_to_friends(text, uuid, uuid[])`, `mark_replication_events_seen(uuid[])` | — |
| Policies | `requests_select_own`, `friendships_select_own`, `replication_events_select_own` | — |
| Indexes / constraints | 10 indexes, CHECK/UNIQUE constraints and 6 outbound FKs to `auth.users`, all internal to the three tables | — |

Why: `search_user_by_email` let any signed-in user of the shared auth pool resolve an
email to a user id and name; `replicate_claim_to_friends` inserted claims into another
user's ledger through a SECURITY DEFINER path, bypassing per-user isolation.

## Files

| # | File | Type | Notes |
|---|------|------|-------|
| 0 | `00_preflight_inspect.sql` | read-only | Inventory, row counts, dependencies, ledger provenance. On PROD it is the non-presence proof. |
| 1 | `01_drop_friends_replication.sql` | **DDL — destructive** | The migration. md5 `8d81f1a5d2fcd733a405d430173883b7`. |
| 1a | `01a_sql_editor_apply_with_ledger.sql` | DDL + ledger insert | Generated from `01`: runs it verbatim and records it in `supabase_migrations.schema_migrations` in one transaction. Used because the Supabase connector's `apply_migration` timed out four times without reaching Postgres. |
| 2 | `02_validate.sql` | read-only | Seven post-checks; all pass on DEV. |
| — | `provenance/20260515223705_fat_friends_and_claim_replication.sql.txt` | **non-executable** | Byte-exact copy of the original ledger statement (md5 `ea4991186cb5734a27a51f851edb9b0a`; the 10 live function bodies matched it). Kept as `.txt` so no tool applies it; it must never be re-run. |

There is no recover script: restoring the unsafe layer is not a supported outcome (D5).

## How `01` stays fail-closed

1. **Guard 1** — `fat` / `fat.profiles` present; exactly 3 tables and 10 functions, or abort
   (absent everywhere → "not applicable here"; partial → drift).
2. **Lock** — `LOCK TABLE … IN ACCESS EXCLUSIVE MODE` on all three tables (with
   `lock_timeout = 10s`) **before** the emptiness check, so no concurrent write, including
   one through a still-live SECURITY DEFINER function, can land between the check and the
   drops. Added after operator review.
3. **Guard 2** — every table empty, or abort; nothing is discarded silently.
4. **Guard 3** — no external FK, view/rule, trigger or routine depends on the drop set.
5. **Drops** — functions (exact signatures) → policies → tables, all explicit `RESTRICT`,
   never `CASCADE`.
6. **Post-check** — nothing left; every other `fat` object count and `auth.users` unchanged.

## Applied (DEV)

- Ledger: `20261001232645 work169_drop_fat_friends_replication_v1`, applied by the operator
  through the SQL Editor with `01a`.
- Recorded `statements[1]` is the committed `01` **without its final trailing newline**
  (14,563 vs 14,564 chars; `md5(statements[1] || E'\n')` = `8d81f1a5…`). The content is
  identical. The difference arose in the manual SQL Editor path.
- Catalog diff against the pre-removal baseline (feature objects excluded): `fat` 323
  objects, md5 `1a2a05ca4ce15988fe8a296b5632c2c2`; all schemas 2,164 objects, md5
  `d0044e456e8a6852e3e4bf74b5f0295f`. Both are **identical** before and after.
- Security advisors: lint 0029 (signed-in users can execute SECURITY DEFINER) 14 → 4; all
  10 removed findings were this layer. Every other lint is unchanged.
- PROD re-checked read-only: no matching objects or ledger rows; latest version
  `20260926064252` unchanged.
