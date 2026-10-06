# Fire Allowance Tracker — Neon Backend (N0–N1)

> **Status:** architecture contract for FAT's application-owned Neon backend, established by
> [WORK-254](https://linear.app/catalyst-app-development/issue/WORK-254) under Governance v2
> `data.application-backend` (programme: GOV-481). **DEV only.** Legacy Supabase remains the one
> authoritative PROD, writes open. Nothing here routes the app to Neon, migrates users or
> changes Production.
> **Companions:** [`CURRENT_MODEL.md`](CURRENT_MODEL.md) · [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md) ·
> [`C1_CUTOVER_CONTRACT.md`](C1_CUTOVER_CONTRACT.md) · [`RATE_RULE_MODEL.md`](RATE_RULE_MODEL.md) ·
> [`../../neon/README.md`](../../neon/README.md) (apply procedure).

## 1. Backend boundary (declared in `.catalyst/app.yml`)

| Field | Value |
|---|---|
| `backend.schema` | `catalyst/backend@1` |
| `backend.state` | `migrating` (legacy Supabase authoritative until cutover) |
| `backend.provider` / `project` | `neon` / `cool-meadow-70196410` (`fire-allowance-tracker`, `aws-ap-southeast-2`, PostgreSQL 17) |
| `targets.prod` | `main` · `br-red-credit-a77927m4` — protected production target, **empty** |
| `targets.dev` | `dev` · `br-wispy-dew-a7vd4v6k` — forked from the empty `main`; synthetic data only |
| `preview` | `risk-triggered` (forked from `dev` only) |
| `legacy` | `supabase`, projects dev `kctctvpobbizhkiqkgqw` / prod `wgcqzamuspuqpedqasbc`, schema `fat`, `authoritative`, writes `open` |

A target's role comes only from this declaration. Every backend mutation is preceded by
`backend-preflight.js preflight` against a fresh provider read and followed by
`verify-applied` against the same target (evidence: `docs/evidence/WORK-254/`).

## 2. Canonical target (what lives in Neon `fat`)

The Neon schema is **not a replay** of `supabase/migrations` or `supabase/canonical`. It is a
consolidated, portable definition of the canonical target, written as six ordered migrations
(`neon/migrations/`), each with a rollback (`neon/rollbacks/`):

| # | File | Carries |
|---|---|---|
| 1 | `20261006060000_fat_neon_foundation` | ledger `fat_migrations.*`, schema `fat`, roles `fat_app`/`fat_service`, no-PUBLIC-execute default, `fat.frv_classification`, identity seam (§5) |
| 2 | `20261006060100_fat_neon_reference_and_identity_data` | stations + matrices + travel index, profiles/profile_ext/home_address/station_distances/user_feature_flags, July–June `financial_years`, caller-bound `claim_sequences`, `rates`/`rate_versions` (append-only), `member_classifications` |
| 3 | `20261006060200_fat_neon_canonical_claims` | `operational_claims` + 6 `*_details` (WORK-173 columns), `claim_entitlements` (composite owner FK, immutable snapshots), `entitlement_overrides` + audit trigger, C1 `migration_batches` / `migration_source_rows`, provenance guard |
| 4 | `20261006060300_fat_neon_payments_reconciliation` | `payment_records` (`prototype_migration` + idempotent key), links, `reconciliation_audit`, payslip staging, every reconciliation function incl. Tier-1 locks |
| 5 | `20261006060400_fat_neon_security` | RLS on every table, owner policies, least-privilege grants, postconditions |
| 6 | `20261006060500_fat_neon_rate_rule_seed` | rate/rule reference data from canonical 04 + WORK-172 + WORK-173 (byte-identical to Supabase DEV) |

**Parity with Supabase DEV (mechanical, `neon/verify/fat_catalog_fingerprint.sql`).** Over the
32 carried tables and every function, 117 of 128 shared fingerprints are identical (all column
definitions, all indexes, all triggers, 15 of 18 carried functions). The 11 differences are exactly the
designed adaptations: the 8 tables whose FK pointed at `auth.users` (identical once the FK target
`fat.app_identities` ↔ `auth.users` is normalised) and the 3 adapted functions
(`current_actor`, `increment_claim_sequence`, `guard_migration_provenance`). Rate/rule reference
data: 14 rates / 32 versions, content md5 equal to DEV.

**Deliberately omitted (stay in legacy Supabase only):** prototype `recalls`, `retain`,
`standby`, `spoilt_meals`, `claim_groups` (the authoritative C2/C3 source and rollback point —
lineage refers to them by `(source_table, source_row_id)` value, never by FK) and `user_rates`
(retired as a rate source by WORK-172). Already-removed objects (`distance_cache`, friends layer,
legacy `fire_allowance_tracker`) are not recreated.

## 3. Replay proof

The six migrations were applied from an **empty** Neon `dev` (forked from empty `main`) and,
independently, to an empty local PostgreSQL database. Both catalogs fingerprint identically
(138 objects, md5 `1a3b5edb3fc2b01ed2fd60bc9b0ea3a2`). Each Neon apply is a checksum-guarded block
that refuses to run unless the SQL it executes hashes to the repository file's sha256, and writes
the ledger row in the same transaction.

## 4. Supabase → Neon adaptation matrix

| Supabase dependency | Disposition | Neon form |
|---|---|---|
| `auth.uid()` (27 RLS policies, `current_actor`, `increment_claim_sequence`) | **Replaced** | `fat.current_app_user_id()` — transaction-local `fat.app_user_id`, set by the server (F3) after it verifies the session; NULL ⇒ every owner policy denies |
| `auth.role()` (`authenticated_read`, `service_role_manage`) | **Replaced** | policies `TO fat_app` (read) and `TO fat_service` (manage) |
| `auth.users` FKs (8 tables: profiles, profile_ext, home_address, station_distances, financial_years, claim_sequences, user_feature_flags ×2, travel_matrix_versions.imported_by) | **Replaced** | FK to `fat.app_identities(id)`, same `ON DELETE` action; owner UUIDs unchanged |
| `fat.handle_new_user` + `on_auth_user_created_fat` trigger on `auth.users` | **Replaced** | `fat.ensure_app_identity(id, email, origin)` (server-called, `fat_service` only, idempotent) |
| `anon` grants | **Deliberately omitted** | no anonymous database role exists |
| `authenticated` grants | **Adapted** | `fat_app`: S/I/U/D on member tables, SELECT on reference/audit; **no TRUNCATE/REFERENCES/TRIGGER** (narrower than DEV) |
| `service_role` grants / BYPASSRLS | **Adapted** | `fat_service`: explicit `fat_service_manage` policy on every table, no BYPASSRLS; `entitlement_overrides` SELECT only |
| PostgREST exposure (`fat` exposed schema, `/rest/v1/rpc/*`) | **Deliberately omitted** | no Data API; access is server-side (F3). Functions keep their signatures |
| SECURITY DEFINER functions | **Portable unchanged** | only `claim_entitlements_override_audit` (trigger-only, not executable by `fat_app`) — asserted |
| SECURITY INVOKER functions (reconciliation, payslip, travel lookup) | **Portable unchanged** | code byte-equivalent to DEV (normalised fingerprint) |
| `fat.current_actor()` | **Adapted** | `select fat.current_app_user_id()` |
| `fat.increment_claim_sequence` caller check (WORK-167) | **Adapted** | caller = `fat.current_app_user_id()`; unset identity refused |
| RLS (`users_manage_own`, detail `exists` policies, read-own, insert/delete-own) | **Adapted** | same predicates on the seam, scoped `TO fat_app` |
| C1 provenance guard (`current_user in ('anon','authenticated')`) | **Adapted** | `pg_has_role(current_user, 'fat_app', 'USAGE')` — owner and `fat_service` are the migration path |
| C1 `no_api_access` deny policies | **Adapted** | `TO fat_app using (false)`, also on `identity_links` |
| No-PUBLIC-execute event trigger `fat_enforce_no_public_execute` (WORK-166) | **Replaced** | `ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` for the migrating role + explicit revokes + postcondition (no superuser event trigger needed) |
| `pgcrypto` / `gen_random_uuid()` | **Portable unchanged** | core PostgreSQL 13+; `md5`, `sha256` core |
| Extensions (`pgcrypto`, `uuid-ossp`, `pg_net`, `pg_cron`, `vector`, `supabase_vault`) | **Deliberately omitted** | none used by `fat`; postcondition asserts only `plpgsql` |
| Storage (`payslip-screenshots` bucket, `storage.objects` policies; `payslip_imports.file_ref`) | **Deliberately omitted (F3)** | `file_ref` stays a portable text reference; object storage is F3 |
| `supabase_migrations.schema_migrations` ledger | **Replaced** | `fat_migrations.schema_migrations` (version, name, sha256) + `fat_migrations.data_loads` |
| Realtime / Edge Functions / cron | **Not used** | — |

Integrity is never weakened to remove a Supabase dependency: every Tier-1 invariant
(WORK-165/166/167), WORK-172 append-only/immutability rule and C1 identity is verified on Neon
(`neon/verify/fat_neon_verify.sql`, 62 checks).

## 5. Application identity seam

- `fat.app_identities(id)` **is** the FAT owner UUID. A member migrated from Supabase keeps their
  `auth.users.id` as `id` (`origin = 'legacy_supabase'`, `legacy_subject = id`, enforced by CHECK),
  so every `owner_id` / `user_id` is unchanged across the cutover. Native members get a fresh UUID.
  No credential or password is stored.
- `fat.identity_links(provider, provider_subject → app_identity_id)` links an authentication
  provider subject (Neon Auth user id; legacy Supabase uid) to that identity — one subject per
  provider, one link per provider per identity. Neon Auth is linked by verified e-mail (GOV-481
  programme pattern); passwords are not migrated (members reset at cutover).
- `fat.resolve_app_identity(provider, subject)` returns the active identity; the F3 server sets
  `SET LOCAL fat.app_user_id` from it inside each transaction. The database trusts that setting
  only from server-held credentials (`fat_app` login roles are server-side; clients never connect).
- Disabling an identity stops resolution; deleting one cascades through every owned row exactly
  as deleting `auth.users` did.

## 6. DEV data

`neon/dev-seed/20261006070000_fat_dev_synthetic_fixture.sql` (data-load
`fat-dev-synthetic-20261006`): three synthetic identities (`5eed…` UUIDs, `@example.invalid`),
synthetic stations 9001–9003, classifications, July–June FYs, all six claim types with detail
rows, hours-first entitlements with rate snapshots, an audited override, routed/paid/claimed
payments, a payslip line, and C1/C3 provenance (batch, source-row ledger with an excluded G12
artifact, prototype-lineage claim/entitlement, `prototype_migration` payment). Nothing was copied
from Supabase DEV or PROD.

## 7. Rollback and what comes next

- DEV rollback: the `neon/rollbacks/` files in reverse order (data-destructive on DEV only), or
  Neon branch reset of `dev` from the empty `main` — both are destructive and need operator approval.
- `main` holds nothing, so there is no PROD rollback surface yet. Any PROD apply needs
  `data.application-backend` rules 9–10: verified DEV evidence for the same change, a named
  rollback, and explicit Production clearance bound to that exact operation.
- **F2 — N3:** cross-database C2/C3 transform (Supabase prototype → Neon canonical),
  `EMPTY_CLAIM_GROUP`, DEV rehearsal — **delivered and DEV-proven by WORK-255** (tool 2.0.0,
  `C2_TRANSFORM_CONTRACT.md` § 11, evidence `docs/evidence/WORK-255/`; `main` untouched). **F3 — N2:** server-side data access, Neon Auth, storage on
  DEV. WORK-192 (C4) Production preparation depends on both.
