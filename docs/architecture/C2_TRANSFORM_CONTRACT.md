# Fire Allowance Tracker — C2 Transform-Copy Contract

> **Status:** maintained contract for cutover step **C2** of
> [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md): the deterministic transform-copy from the prototype
> claim model into the canonical claim model, its parity report, and how it is rehearsed in
> DEV. It builds on the destination contract in
> [`C1_CUTOVER_CONTRACT.md`](C1_CUTOVER_CONTRACT.md) and adds **no schema**. It is not a
> model: [`CURRENT_MODEL.md`](CURRENT_MODEL.md) states verified reality and
> [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md) the approved target.

Re-cut 2026-10-06 by [WORK-255](https://linear.app/catalyst-app-development/issue/WORK-255)
(tool **2.0.0**): C2/C3 is now **cross-database** — the prototype source is read (read-only) on
the legacy Supabase project and the canonical target is the Neon backend
([`NEON_BACKEND.md`](NEON_BACKEND.md)). The single-database `extract-sql` / `harness-sql` path of
tool 1.x is retired; § 11 is the authoritative description of the 2.0.0 pipeline, snapshot
contracts, `EMPTY_CLAIM_GROUP`, owner-identity preservation, admission and rollback. Sections
2, 8, 9 and 10 below describe tool 1.x and are kept as history where § 11 does not override them.

Extended 2026-10-06 by [WORK-191](https://linear.app/catalyst-app-development/issue/WORK-191)
(tool 1.1.0): the same run now also maps historical payment state (C3) and evaluates gate 6 —
see [`C3_PAYMENT_STATE_CONTRACT.md`](C3_PAYMENT_STATE_CONTRACT.md). Where this contract says
`payment_status = NULL` or "gates 1–5 and 7", read the C3 contract.

Established 2026-10-05 by [WORK-190](https://linear.app/catalyst-app-development/issue/WORK-190)
(design record: WORK-190 *Investigation Record — C2 transform design*, PROMPT #18).
Code: [`lib/fat/migration/c2/`](../../lib/fat/migration/c2/), CLI
[`scripts/c2-transform.mjs`](../../scripts/c2-transform.mjs), tests
[`__tests__/c2-transform.test.mjs`](../../__tests__/c2-transform.test.mjs). Rehearsal
evidence: [`docs/evidence/WORK-190/`](../evidence/WORK-190/). **DEV only.** PROD runs
only inside C4 (WORK-192) under its own approval and write freeze.

## 1. What C2 owns and what it does not

| Owned by C2 (this contract) | Owned elsewhere |
|---|---|
| Prototype logical event → one `operational_claims` + exactly one detail row + 0..N `claim_entitlements` | Destination columns, constraints, RLS — **C1, WORK-189** |
| One `migration_source_rows` disposition per consumed source row | Historical payment state → payment records / links / audit — **C3, WORK-191** (acceptance gate 6) |
| The `migration_batches` envelope and the machine-readable parity report | Write freeze, frozen-source archive and checksums — **C4, WORK-192** (gate 8) |
| WORK-173 generator parity (RC / RT / SM / DM), report-only | App cutover, smoke tests, bridge-mirror retirement, `claim_sequences` alignment — **C5, WORK-193** (gate 9) |
| Acceptance gates 1, 2, 3, 4, 5 and 7 | Rate / rule model (WORK-172, WORK-246), entitlement rules (WORK-170, WORK-250) |

C2 never recalculates a stored historical value, never invents a missing fact, never
adopts, edits or deletes a native canonical claim, and never writes payment state.

## 2. Pipeline

```
extract-sql ──► snapshot.json ──► plan ──► report.json  plan.json  apply.sql  verify.sql  rollback.sql  plan.sha256
 (read-only)    (source + reference      (pure JS,      (apply.sql only when outcome = pass)
                 + native target)         deterministic)
```

1. **Extract** (`node scripts/c2-transform.mjs extract-sql`) — one read-only `select`
   returning the five prototype source tables in full, plus only the reference rows the
   source references (financial years, stations, profiles, the station-classification and
   rate codes the generators need) and the native canonical claims (for the bridge-mirror
   listing). No write.
2. **Plan** (`plan --snapshot S --env dev|prod [--evidence synthetic] --out DIR`) — a pure,
   deterministic function of the snapshot. Same snapshot → byte-identical `report.json`,
   `plan.json` and `apply.sql`. Any refusal makes `outcome = fail` and **no** `apply.sql` is
   written.
3. **Apply** — a single statement (`do` block) that writes the batch, claims, details,
   entitlements, adjustments and ledger, then re-proves the postconditions inside the same
   transaction. It returns `{ batch_id, batch_key, inserted/verified counts, plan_sha256 }`.
4. **Verify** (`verify.sql`, checked by `check --report R --verify V`) — an independent
   read-only re-derivation of gates 2, 3, 4, 5 and 7 from the database, plus a native-data
   fingerprint.
5. **Rollback** (`rollback.sql`) — removes exactly the rows tagged with the batch, then the
   batch. Used for rehearsal reset; the prototype source is never touched.

## 3. Event discovery and type mapping

A **logical event** is a `claim_groups` row with exactly one parent row and its auto-children
(`calculation_inputs.autoChild`), or an ungrouped legacy parent row. Type is established only
from evidence:

| Prototype | Canonical | Evidence |
|---|---|---|
| `recalls` parent | **RC** | group `claim_type = recalls` |
| `retain` parent | **RT** | group `claim_type = retain` |
| `standby` parent, `standby_type = 'Standby'` | **SB** | `standby_type` (group `standby`) |
| `standby` parent, `standby_type = 'M&D'` | **MD** | `standby_type` (group `md`) — WORK-170 split, no M&D formula re-applied |
| `spoilt_meals` parent, `meal_type ∈ {Spoilt, Spoilt / Meal}` | **SM** | `meal_type` |
| `spoilt_meals` parent, `meal_type = 'Delayed'` | **DM** | `meal_type` |

Spoilt vs Delayed is **never** inferred from an amount. A child's `meal_type` is never read
for type (RC/RT/SB meal children live in `spoilt_meals`). Group/parent disagreement, an
unknown type, a missing or duplicated parent, a cross-owner group, an orphan or
unrecognised child are **refusals** (`events.js`), never guesses.

## 4. Field map

**`operational_claims`** — `id` = UUIDv5(namespace, `claim:<table>:<parent id>`);
`owner_id` = source `user_id`; `claim_type` per §3; `claim_number` and `financial_year_id`
from the group (else the parent row), refused on conflict, on a missing FY, on an FY the owner
does not own or that is not July–June, and on a duplicate in the C1 scope
`(owner_id, financial_year_id, claim_type, claim_number)`; `claim_date` = parent `date`;
`generated_at` = parent `created_at`; `station_id_snapshot` / `station_name_snapshot` = the
rostered station at claim time (validated against `stations`); `notes` = group notes + parent
notes (deduplicated, blank-line joined); `status = 'submitted'` (payment state is C3's);
`source_calculation_mode = 'frv_matrix'` only for SB/MD with a matrix version; lineage
`prototype_claim_group_id`, `prototype_source`, `prototype_row_id`, `migration_batch_id`.

**Detail rows** (exactly one per claim) — local wall-clock times are composed in
`Australia/Melbourne`; a time that falls in a DST gap/overlap is **withheld** (NULL) and
noted, never guessed.

| Type | Detail | Mapped facts |
|---|---|---|
| RC | `recall_details` | start = date + arrival; end = date + booked-off (next day if earlier); duty from shift; recall station |
| RT | `retain_details` | start = date + prototype rostered finish (Day 18:00 / Night 08:00, the basis of the stored hours); end = date + booked-off (next day if earlier); shift |
| SB | `standby_details` | start = date + arrival; standby station; matrix hours / version as stored |
| MD | `muster_dismiss_details` | event = date + arrival; M&D station; raw `home_to_rostered_km` / `home_to_target_km` |
| SM | `spoilt_meal_details` | `meal_interrupted_at` from the recorded time; `emergency_call_ref` = call number |
| DM | `delayed_meal_details` | no prototype fact exists for any field → all NULL (reported as missing inputs) |

**`claim_entitlements`** — one per legitimate stored component: auto-child components per
`CHILD_RULES`, parent-carried components per `PARENT_COMPONENTS` (both in
[`constants.js`](../../lib/fat/migration/c2/constants.js)). The stored prototype value is
copied **verbatim** (`generated_amount` for dollars, `generated_hours` for hours — hours-first,
the historical retain dollars kept only in `rate_snapshot.historical_amount`, never derived);
`rule_id = prototype.preserved.v1`, `rule_version = fat-c2-transform@1.0.0`,
`rate_snapshot.kind = prototype_preserved` (with the prototype rates snapshot and retain rate
used); `payment_status` = the canonical status C3 derives (tool 1.0.0: NULL). A prototype `adjusted_amount` becomes `edited_amount` with
`edited_source = prototype:<table>:<id>.adjusted_amount` and an `edited_note`, through the C1
override audit trigger. Parent/child totals that do not reconcile, an unattributable parent
amount or adjustment, an unmapped or missing stored component, and a **non-zero** recall
excess travel are refusals.

**`migration_source_rows`** — one row per consumed source row (group, parent, each child):
`claim`, `entitlement` or `excluded`, with a per-row `source_checksum` (SHA-256 of the
canonical JSON of the row) for C4. `source_snapshot` is written only for `excluded` rows.

## 5. Exclusions and intended differences

**Empty claim group** (tool 2.0.0, WORK-255 / WORK-192 B1) — `EMPTY_CLAIM_GROUP`: a prototype
`claim_groups` row with **zero** member rows in recalls / retain / standby / spoilt_meals. No
logical event exists, so **no claim** is created; the group is **not dropped and not a failure**:
it gets one `migration_source_rows` row (`disposition = excluded`, `target_claim_id = NULL`,
full source snapshot + checksum), is counted in gate 1 (`groups_excluded_empty`) and listed in
`report.empty_claim_groups`. The source row stays untouched. An empty group whose owner has no
identity is refused (`owner_missing`), never silently excluded. § 11.4.

**Excluded legacy artifact** — `G12_FAKE_RECALL_EXCESS_TRAVEL`: the known $0 Recall Excess
Travel auto-child. Disposition `excluded`, full source snapshot preserved, no entitlement,
listed in `report.exclusions` (refs: CUTOVER_PLAN G12, C1 contract § 4,
CANONICAL_ENTITLEMENT_RULES § 2, WORK-174). A non-zero amount on such a row is refused, not
excluded.

**Intended differences** (generator parity, every one cites its rule; `report.intended_difference_classes`):
`RT_NEAREST_QUARTER_128_1` (cl 128.1 nearest quarter vs the prototype ceiling — WORK-250),
`MEAL_RATE_SCHEDULE_4`, `RC_MEAL_RULE_85_6_3`, `RT_MEAL_RULE_85_6_4`, `RC_OVERTIME_128_2`,
`RC_TRAVEL_TIME_128_4`, `RC_RELIEVING_85_8_10`, `RT_TRAVEL_HOME_85_8_9`,
`SM_SPOILT_ALLOWANCE_85_7_1`, `DM_MEAL_ALLOWANCE_85_6_6`. The retain rounding difference is
classified intended only when |canonical − prototype| ≤ 0.25 h and the prototype is the higher
(the ceiling signature); anything else is a **genuine failure**.

## 6. Generator parity (WORK-173)

For RC, RT, SM and DM the canonical WORK-173 generators run **in memory** on the mapped facts
and are compared with the prototype stored behaviour. Nothing is persisted and no stored
value is changed. Each item is exactly one of `exact_match`, `intended_difference`,
`genuine_failure`, `excluded_artifact`, `unable_to_generate` (with `missing_inputs` and
reasons). `report.generator_parity.by_type` counts them per type; `missing_inputs` counts each
missing fact. Unknown classes fail the plan (`assertKnownClasses`).

## 7. Report schema (`fat.c2.parity-report/v1`; v2 since tool 1.1.0 adds gate 6, `payments` and `planned.payment_links` — C3 contract § 6)

`schema`, `tool {name, version}`, `environment`, `evidence_class` (`real` | `synthetic`),
`batch_key`, `source_checksum`, `input_fingerprint`, `source {rows, events, events_migrated,
events_refused, migrated_by_type}`, `outcome` (`pass` | `fail`), `acceptance {passed,
required_gates}`, `gates {1..9: name, status, evidence, owner?}` (6 → C3, 8 → C4, 9 → C5 are
`not_evaluated` with their owner), `planned {claims, details, entitlements, adjustments,
ledger, payment_records = 0}`, `events[]`, `refused[]`, `exclusions[]`, `exclusion_codes`,
`generator_parity {scope, basis, by_type, missing_inputs, items[]}`,
`intended_difference_classes`, `bridge_mirrors` (native claims listed, never adopted). The
report is canonical JSON (sorted keys, normalised numbers and UTC instants); its SHA-256 is
stable for a given snapshot.

## 8. Idempotency

- **Deterministic identity** — every target id is UUIDv5 over its source identity; the batch
  key is `c2:<env>:<tool version>:<input fingerprint[0:32]>`. The same source always plans the
  same rows under the same batch.
- **Insert-if-absent, then prove equality** — every row is `insert … on conflict do nothing`;
  an existing row is then compared column-by-column (typed, via `jsonb_populate_recordset`) with
  the planned row. Equal → counted `verified_existing`. Different, or the lineage held by another
  row → `raise` (**`C2 conflict: …`**): the whole statement rolls back. Nothing is ever silently
  overwritten.
- **Envelope** — `migration_batches` row: `batch_key`, `step = C2`, `environment`, `tool`,
  `tool_version`, `source_checksum`, `status`/`completed_at`, and the full report. A re-run of the same plan verifies the
  envelope instead of inserting it.
- **Plan integrity** — the plan is embedded as a single dollar-quoted literal with a
  content-derived tag; `apply` returns `plan_sha256` so the operator can match it to
  `plan.sha256`.

## 9. Rehearsal (DEV)

- **Real DEV** — extract → plan → apply → apply again → verify → check, from merged code.
- **Synthetic DEV** — `harness-sql` builds one statement that inserts the synthetic fixture
  ([`__tests__/fixtures/c2/synthetic-source.json`](../../__tests__/fixtures/c2/synthetic-source.json),
  bound to DEV reference ids), proves the fixture stored as given, then runs: (1) first apply,
  (2) re-apply — zero inserts, all verified, plus the verify query, (3) tamper a target row →
  must fail closed, (4) apply a changed-source plan → must fail closed; then resets and ends in
  `raise C2_SYNTHETIC_RESULT`, so **everything is rolled back**. `evidence_class = synthetic`.
- Native canonical data is fingerprinted (time-zone independent) before and after; it must not
  change.

## 10. Security and portability

The tool runs as a privileged operator connection only. On the Neon target the migration and
identity tables are closed to `fat_app` (no privilege, `no_api_access` policy) and writable by
`fat_service`; gate 7 / verify re-check exactly that and that no Supabase API role
(`anon` / `authenticated` / `service_role`) exists there (tool 2.0.0; tool 1.x checked
`anon`/`authenticated` on Supabase). No service-role key reaches the
client. The generated SQL is plain PostgreSQL 14+ (core `sha256()`, `jsonb_populate_recordset`,
`set_config`/`current_setting`; no extension, no Supabase-only feature), so it is Neon-portable
(GOV-481).

## 11. Cross-database C2/C3 (tool 2.0.0, WORK-255)

### 11.1 Topology and pipeline

```
Supabase (legacy, READ-ONLY)                 Neon target (dev; prod only inside C4)
source-extract-sql ─► source.json ─┐
                                   ├─► target-extract-sql ─► target.json (reference + state + md5)
                                   ▼
            plan --source --target --env --project --target-name --target-id
              ─► report.json plan.json admission.json apply.sql verify.sql rollback.sql residue.sql plan.sha256
```

1. `source-extract-sql` — one read-only `select` on Supabase: the five prototype tables in full,
   `claim_sequences` and `financial_years` of the owners they reference, owner `profiles`
   (`id`, e-mail), referenced stations and member classifications. Schema
   `fat.c2.source-snapshot/v2`. Never a write, freeze, grant or schema change.
2. `target-extract-sql --source S` — one read-only `select` on the Neon target, scoped by the
   source (owners, e-mails, FYs, stations, source row ids). Schema `fat.c2.target-snapshot/v1`:
   `reference` (stations, the generator rates/versions with `value` as **text**, native claims of
   the owners), `reference_md5` = `md5(reference::text)` computed by the database, and `state`
   (identities, profiles, FYs, claims in scope, ledger rows of the source rows, C2 batches). The
   row also returns `snapshot_md5`; a copied snapshot is exact iff `md5(copy::jsonb::text)`
   equals it (numbers travel as text so no JSON transport can alter them).
3. `plan` — pure and deterministic: **the plan is a function of source + target reference
   only**; target *state* feeds admission alone. Same inputs → byte-identical plan, report and
   SQL (proved on Neon: re-plan after apply and after rollback both reproduce sha
   `799e83aa…`). Gates **R** (target reference readiness) and **I** (identity) join gates 1–7
   in acceptance. Batch key `c2:<env>:2.0.0:<fingerprint[0:32]>`; change id
   `fat-c2-<env>-<fingerprint[0:24]>` (the governed data-load key).
4. `admit --plan P --target T` (also written as `admission.json` at plan time) — `apply` (nothing
   present), `already_applied` (exactly this batch present and equal) or `refuse` with named
   conflicts (`source_row_held_by_other_batch`, `claim_held_by_other_batch`, identity / FY
   conflicts, a different batch definition). A stale or conflicting plan is refused before any
   write.
5. `apply.sql` — one `do` block + result `select`, one transaction:
   **transport guard** (sha256 of the embedded plan literal must equal the reviewed
   `plan.sha256`, else `C2 refused`) → **stale guard** (the target recomputes its reference md5;
   any difference → `C2 stale plan`) → **prerequisites** (`fat.ensure_app_identity(id, email,
   'legacy_supabase')` per owner, source FYs insert-if-absent with equality proof) →
   `fat_migrations.data_loads` row (`kind migration_batch`, `checksum sha256:<plan sha>`) → batch,
   claims, details, entitlements, adjustments, C3 payment records/links → ledger → postconditions
   (gates 1, 3, 4, 7 incl. the `EMPTY_CLAIM_GROUP` postcondition). The batch row stores a summary
   report with `full_report_sha256` of the full report.
6. `verify.sql` — read-only (the RLS probe runs as `fat_app` inside a rolled-back
   sub-transaction). It embeds the source rows' canonical JSON and **does not read any prototype
   table**: the database rebuilds the canonical text, hashes it and compares it with the plan's
   `source_checksum` and every ledger row's checksum, then re-derives gates 1–7 and I on the
   batch, the `fat_app`/`fat_service` security posture and a native-data fingerprint.
   `check --plan P --verify V` decides pass/fail.
7. `rollback.sql` — deletes **only** this batch's rows (payment records → links/audit cascade,
   entitlements → overrides cascade, claims → details and targeted ledger cascade, remaining
   ledger rows, the batch), removes the batch's data-load row and records
   `<change id>-rollback`. Owner identities and FYs are foundation and stay. `residue.sql`
   proves zero batch rows remain, the foundation intact and other batches untouched.

### 11.2 Governed mutation

Every Neon mutation is preceded by `backend-preflight preflight` (operation `data-load` keyed
by the change id; verify runs `data-write`) bound to app, provider, project, target name and id
from a fresh branch read, and followed by `verify-applied` against `fat_migrations.data_loads`.
A refused preflight stops the run. `main` is refused (`dev-not-verified`, `no-rollback`,
`clearance-required`) until C4.

### 11.3 Owner identity

Owner UUIDs are preserved: each migrated owner becomes a `legacy_supabase` FAT app identity
whose id **is** the Supabase `auth.users` id (`legacy_subject = id`, no password, no provider
link) via `fat.ensure_app_identity` (WORK-254 seam). On `dev`, gate I accepts only reserved
test-domain e-mails (RFC 2606 / 6761); a real address refuses the plan.

### 11.4 `EMPTY_CLAIM_GROUP`

Rule in § 5. Tests cover one, many, mixed (with migrated groups), rerun (verified, not
re-inserted) and checksum conflict (a changed empty group refuses admission and raises
`C2 conflict` in the database).

### 11.5 Payment contract

Unchanged from [`C3_PAYMENT_STATE_CONTRACT.md`](C3_PAYMENT_STATE_CONTRACT.md) (WORK-191): the same
records, links, audit and recompute postconditions run in the cross-database apply; gate 6 is
re-derived by verify on the target.

### 11.6 Rehearsal evidence

[`docs/evidence/WORK-255/`](../evidence/WORK-255/) — Neon `dev` rehearsal with a synthetic source
(real Supabase DEV was planned read-only and is empty): apply, identical rerun, verify, conflict
and stale refusals in the database, admission refusals, rollback, residue, rerun after rollback,
second verify; Neon `main` empty before and after.
