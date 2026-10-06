# WORK-254 evidence — FAT Neon N0–N1 (2026-10-06)

Governance v2 `main` `b21fb77`, Projected `sha256:e1d30f105abaa9de2e880472262a49221cf49b74afd15594b5dcaf8ad303d3c5`.
Executor: Claude Code session `session_01LaSi6avfyryoxx9bPVGMSN`. No secret appears in any file here.

## Declaration and bootstrap

| Step | Evidence |
|---|---|
| N0 `legacy-shared` declaration | `app.yml.n0-legacy-shared.yml`; `backend-preflight validate` → ok, no findings |
| Bootstrap (empty resources only) | Neon project `cool-meadow-70196410` `fire-allowance-tracker`, `aws-ap-southeast-2`, PG 17.11, created 2026-10-06T05:48:33Z; `main` `br-red-credit-a77927m4` (read: schema `public` only, 0 relations, roles = provider roles, ext `plpgsql`); `dev` `br-wispy-dew-a7vd4v6k` forked from `main` at LSN `0/196B420`, verified identical-empty before any schema |
| N1 `migrating` declaration | `.catalyst/app.yml` (this commit); `validate` → ok, boundary `neon:cool-meadow-70196410` |

## Preflight / verify-applied (`preflight/`)

Every request binds app `fire-allowance-tracker`, provider `neon`, project `cool-meadow-70196410`,
target name + id from a fresh `list_branches` read, operation and change id.

| Label | Operation / change | Preflight | verify-applied (same target) |
|---|---|---|---|
| m1 … m6 | `schema-migration` `20261006060000` … `20261006060500` on `dev` | allow ×6 | verified ×6 (ledger read back from `dev`) |
| seed | `data-load` `fat-dev-synthetic-20261006` on `dev` | allow | verified (`fat_migrations.data_loads`) |
| verify-suite | `data-write` (rolled back) on `dev` | allow | — (no persistent change; row counts unchanged) |
| neg-main-schema / neg-main-seed | same operations on `main` | **refuse**: `dev-not-verified`, `no-rollback`, `clearance-required` | — |
| neg-dev-wrong-id | `dev` name with `main` id | **refuse**: `target-mismatch` | — |
| neg-dev-no-change | keyed op without change id | **refuse**: `no-change-id` | — |

## Schema parity and replay

- `catalog-fingerprint-supabase-dev.txt` (read-only, Supabase DEV) vs
  `catalog-fingerprint-neon-replay.txt` (Neon target): 117/128 shared objects identical; the 11
  differences are the designed adaptations (NEON_BACKEND.md §2/§4), and the 8 constraint
  differences vanish when the FK target `fat.app_identities` is normalised to `auth.users`.
- Neon `dev` catalog (138 objects) md5 `1a3b5edb3fc2b01ed2fd60bc9b0ea3a2` = independent empty
  local PostgreSQL replay md5 `1a3b5edb3fc2b01ed2fd60bc9b0ea3a2`.
- Rate/rule reference data: 14 rates / 32 versions; content md5 `785559f2…3636f` /
  `365900e4…936d` on Neon `dev` = Supabase DEV.
- Each apply's checksum guard matched the repository file sha256 (ledger rows on `dev`).

## Behavioural verification

`neon/verify/fat_neon_verify.sql` on Neon `dev`: **62/62 pass**, result-set md5
`b7a10ee379c6c01b29a59822152813a0` (identical to the local run of the repository file). After the
run: identities 3, claims 7, entitlements 4, overrides 1, payment records 2, links 2, audit 5,
source rows 3, payslip lines 1, `fat_app` members = the creator grant only — unchanged.

## Neon `main` empty (2026-10-06T06:15:28Z)

Schemas `public` only · 0 user relations, functions, types · roles = provider roles only · ext
`plpgsql` · 0 event triggers · default ACLs = 2 provider `cloud_admin` entries only · no
`fat`, no `fat_migrations`, no app roles, no rows.
