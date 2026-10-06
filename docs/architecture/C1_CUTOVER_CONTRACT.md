# Fire Allowance Tracker — C1 Canonical Destination Contract

> **Status:** maintained contract for cutover step **C1** of
> [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md): what the canonical destination provides so that
> C2 (transform-copy + parity rehearsal, WORK-190) and C3 (historical payment state,
> WORK-191) can run deterministically. It describes schema **representation** only.
> It is not a model: [`CURRENT_MODEL.md`](CURRENT_MODEL.md) states verified reality and
> [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md) the approved target.

Established 2026-10-05 by [WORK-189](https://linear.app/catalyst-app-development/issue/WORK-189)
(design record: WORK-189 *Investigation Record — C1 schema-gap and design*, PROMPT #17).
Migration: [`supabase/migrations/20261005121500_fat_work189_c1_cutover_readiness.sql`](../../supabase/migrations/20261005121500_fat_work189_c1_cutover_readiness.sql)
(rollback alongside in `supabase/rollbacks/`). DEV first; PROD only under C4's separate
approval.

## 1. What C1 owns and what it does not

| Owned by C1 (this contract) | Owned elsewhere |
|---|---|
| Columns, constraints, indexes, RLS/privileges the transform needs | Transform-copy tool and parity report — **C2, WORK-190** |
| Canonical representation of migrated payment state | Mapping prototype payment state into it — **C3, WORK-191** |
| Batch and source-row provenance | Matching / adopting existing bridge-mirrored SB/MD claims — **C2** |
| Claim number + FY on the canonical claim | Aligning `fat.claim_sequences` with migrated numbers before canonical writes — **C5** |
| — | Generator inputs (WORK-173), rate/rule model (WORK-172/246), ledger drift (WORK-180) |

## 2. Claim number and financial year

- `operational_claims.claim_number integer` (> 0) and `financial_year_id uuid`.
  A number requires an FY.
- **Uniqueness scope:** `(owner_id, financial_year_id, claim_type, claim_number)`
  (`uq_operational_claims_claim_number`, partial on `claim_number is not null`). This is the
  established `fat.claim_sequences` scope `(user_id, financial_year_id, claim_type)`: the
  prototype sequence key is the app claim type, which maps 1:1 onto the canonical type —
  `recalls → RC`, `retain → RT`, `standby → SB`, `md → MD`, `spoilt → SM`,
  `delayed_meal → DM`.
- **FY** is the per-user `fat.financial_years` row, kept as the canonical FY entity. It is
  stored, never derived from `claim_date`, because the prototype assigns the *active* FY at
  save time. `financial_years_july_june` makes every FY exactly 1 July → 30 June;
  `(financial_year_id, owner_id)` → `financial_years(id, user_id)` stops a claim pointing at
  another member's FY.
- Both columns are **set-once**: NULL → value is allowed, a value never changes.

## 3. Batch provenance and idempotent identity

`fat.migration_batches` — one row per C2/C3 run: `batch_key` (unique, deterministic,
caller-chosen — e.g. step + environment + source checksum + tool version, so a rerun resolves
to the same batch), `step` (`C2`|`C3`), `environment` (`dev`|`prod`), `tool`,
`tool_version`, `source_checksum`, `status`, timestamps and `report jsonb` (the
machine-readable parity report).

| Target | Batch tag | Batch-independent identity (unique) |
|---|---|---|
| `operational_claims` | `migration_batch_id` | `(prototype_source, prototype_row_id)`; `prototype_claim_group_id` |
| `claim_entitlements` | `migration_batch_id` | `(prototype_source, prototype_row_id, prototype_component)` |
| `payment_records` | `migration_batch_id` | `migration_source_key` |
| `entitlement_payment_links` | via record/entitlement | existing `uq_epl_entitlement_record_kind` |
| `migration_source_rows` | `batch_id` | `(source_table, source_row_id)` |

- `prototype_source` ∈ `recalls | retain | standby | spoilt_meals` — the prototype table of
  the row. `prototype_component` names which stored amount of that row an entitlement carries
  (e.g. `total_amount`, `travel_amount`, `night_mealie`, `meal_amount`).
- `operational_claims.prototype_claim_group_id` / `prototype_source` already existed in both
  projects from the abandoned dual-write branch (no repository file, every value NULL). C1
  **adopts** them (`if not exists`) instead of adding duplicates.
- Identity never includes the batch, so a rerun **skips or conflicts — it never duplicates**.
  Rollback before C6: delete the batch-tagged claims and payment records (details,
  entitlements, overrides, links, audit and ledger rows cascade), then the batch row.
- Rows natively created by the app keep every provenance column NULL.

## 4. Source-row ledger and exclusions

`fat.migration_source_rows` records **every prototype row a C2 batch consumed, exactly once**:

| Column | Meaning |
|---|---|
| `source_table`, `source_row_id` | the row (`claim_groups`, `recalls`, `retain`, `standby`, `spoilt_meals`) |
| `source_claim_group_id`, `source_claim_type` | lineage and the prototype type as stored (per-type counts) |
| `source_checksum` | per-row checksum (parity gate 8) |
| `disposition` | `claim` (became `target_claim_id`), `entitlement` (its amounts became entitlements on `target_claim_id`), `excluded` |
| `exclusion_code`, `exclusion_reason`, `source_snapshot` | required for `excluded`; the snapshot preserves the artifact |

The known **fake $0 Recall Excess Travel** auto-child (G12) is recorded as `excluded` with
its snapshot — preserved as provenance, never a payable entitlement. The ledger plus the
batch-tagged rows give C2 what its report needs: source event → canonical claim mapping,
per-type counts, and the excluded artifacts. Exact matches, intended EBA corrections and
genuine parity failures are computed by the C2 tool by comparing stored prototype values
(read through this lineage) with generator output, and written to `migration_batches.report`.
**Stored historical amounts are never recalculated.**

`(target_claim_id, owner_id)` is bound to the claim's owner.

## 5. Entitlements, manual adjustments and rate snapshots

- `(claim_id, owner_id)` → `operational_claims(id, owner_id)`: an entitlement can never
  belong to a different member than its claim (parity gate 7).
- **Manual adjustments** need no new schema: insert the entitlement with the stored amount,
  then `UPDATE edited_amount|edited_hours` with `edited_note` and
  `edited_source` (e.g. `prototype:recalls:<id>.adjusted_amount`). The WORK-172 trigger
  writes the audited `fat.entitlement_overrides` row; generation fields stay immutable.
- **Rate snapshots:** `rate_snapshot` stays NOT NULL. Prototype rows carry
  `calculation_inputs.retainRate` where present, otherwise a provenance marker
  (WORK-172 contract). Withdrawn `rate_versions` are never deleted.

## 6. Historical payment state (representation for C3)

C3 maps prototype `payment_status` / `payment_date` / `pay_number` into the existing
canonical payment model; C1 only makes that representable and idempotent:

| Prototype fact | Canonical destination |
|---|---|
| route (payslip / petty cash) | `claim_entitlements.payment_method` |
| `Paid` + `payment_date` (+ `payslip_pay_nbr`; C3 found claim-row `pay_number` is not payment evidence) | `payment_records` row with `source = 'prototype_migration'`, `record_date`, `reference`, `gross_amount`, `raw_payload`, `migration_batch_id`, `migration_source_key` |
| allocation | `entitlement_payment_links` (`link_entitlement_payment` checks owner, stream and over-allocation and writes the audit) |
| status | `claim_entitlements.payment_status`, derived by the existing recompute |
| who/why | `reconciliation_audit` |

`'prototype_migration'` is allowed by the table CHECK but **not** by the user-facing
`fat.create_payment_record` RPC, and the guard trigger refuses it from API roles. PROD
evidence (2026-10-05): prototype status is only `Pending`/`Paid`; no `Disputed` state exists,
so no new status is introduced.

## 7. Security model

- `fat.guard_migration_provenance` (BEFORE INSERT/UPDATE on `operational_claims`,
  `claim_entitlements`, `payment_records`): API roles (`anon`, `authenticated`) cannot set or
  change any provenance/batch column or mint `prototype_migration` records; once set, a
  provenance value is immutable for every role. The migration runs as a service role.
- `fat.migration_batches` and `fat.migration_source_rows`: RLS enabled, explicit
  `no_api_access` deny policy, no `anon`/`authenticated` grants, `service_role` only.
- Existing owner policies (`users_manage_own`) and grants are unchanged; nothing widens.

## 8. Neon portability (GOV-481)

Everything above is portable PostgreSQL — tables, partial unique indexes, composite foreign
keys, CHECKs and a plpgsql trigger. The only Supabase seam is the guard's comparison of
`current_user` with the API role names (inert on Neon, where the server-side session is the
authority) and the deny policies. No new `auth.*` reference is introduced.

## 9. Verification (DEV)

Recorded on WORK-189: ledger ↔ repository, transaction-scoped synthetic rows (rolled back)
proving claim-number uniqueness, the FY CHECK and owner-bound FKs, idempotent claim /
entitlement / ledger / payment identity, the API-role guard and set-once behaviour; WORK-173
columns intact; existing rows unchanged; RLS, grants and default ACLs; security advisors.
