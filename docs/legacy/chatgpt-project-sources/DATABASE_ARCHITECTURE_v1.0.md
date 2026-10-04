# DATABASE ARCHITECTURE

Version: v1.0
Status: Draft — initial scaffold (clean rebuild target)
App: Fire Allowance Tracker
Last Updated: 2026-05-26

---

# Purpose

Canonical database-design reference for the Fire Allowance Tracker rebuild.

This document defines the recommended table layout, relationships, and
ownership model for the future schema. It is the database-layer counterpart
to:

- App architecture overview → `ALLOWANCE_ARCHITECTURE.md`
- Operational + entitlement data model → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Claim type catalogue → `CLAIM_TYPES.md`
- Entitlement generation rules → `ENTITLEMENT_RULES.md`
- Payment + payroll reconciliation → `PAYMENT_RECONCILIATION.md`

This document specifies *table shape*; rule semantics live in the documents
above and MUST NOT be duplicated here.

---

# Rebuild Assumption

The Fire Allowance Tracker is NOT live. There are no production users and no
production data. Existing dev/test data in Supabase under the `fat.*` schema
can be wiped and re-seeded freely.

Implications:

- No data migrations required from the current schema. The rebuild is a
  greenfield design, not a backwards-compatible evolution.
- The existing `supabase/fat-schema.sql` is treated as historical input,
  not as a constraint. Anything the rebuild keeps is kept on merit.
- Superseded SQL — `supabase-migration-v4-distance-tables.sql` and
  `DISTANCE-SYSTEM-DEPLOY-REPORT.md` — remains out of scope; do not
  consult.
- Bounded domain stays `fat.*`. Cross-domain reads/writes are not part of
  this app's architecture.

---

# Design Principles

1. The three architectural layers — Operational Claims, Generated
   Entitlements, Payment / Reconciliation — each get their own tables.
   They MUST NOT be conflated. See
   `ALLOWANCE_ENGINE_DATA_MODEL.md § Core Architectural Principle`.
2. Operational claims are heterogeneous: each claim type has type-specific
   inputs and gets its own detail table joined 1:1 to a shared core table.
3. Generated entitlements are homogeneous: a single `claim_entitlements`
   table covers every entitlement type (Small Meal, Large Meal, Excess
   Travel, Relieving Allowance, Standby&Dismi, Muster&Dismis, Maint Stn,
   etc.).
4. Sharing is a first-class concept in the data model from day one. Copied
   / shared claims become fully independent drafts — there is no ongoing
   sync. The ownership model must make this explicit.
5. Historical records are static. Once a claim or entitlement is
   generated, downstream rule or rate changes do NOT rewrite it. See
   `ALLOWANCE_ARCHITECTURE.md § Historical Record Philosophy`.
6. Manual overrides are first-class. Every editable amount carries both a
   `generated_amount` (snapshot at creation) and an `edited_amount`
   (current user-edited value), plus an explanation note.
7. Rate snapshots are stored on the entitlement, not looked up at read
   time. The `rates` / `rate_versions` tables are the source of truth at
   generation time only.

---

# Table Map

```
                        ┌──────────────────────┐
                        │  auth.users          │  (Supabase auth)
                        └──────────┬───────────┘
                                   │
                        ┌──────────▼───────────┐
                        │  profiles            │
                        │  (rostered station,  │
                        │   home location)     │
                        └──────────┬───────────┘
                                   │ owner_id
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│                operational_claims (core)                      │
│   id, owner_id, claim_type, claim_date, station_id_snapshot, │
│   source_calculation_mode, status, generated_at,             │
│   parent_claim_id (sharing), notes                           │
└─────┬───────┬───────┬───────┬───────┬───────┬────────────────┘
      │ 1:1   │ 1:1   │ 1:1   │ 1:1   │ 1:1   │ 1:1
      ▼       ▼       ▼       ▼       ▼       ▼
   recall  retain  standby  m&d   delayed  spoilt
   _detail _detail _detail _detail _meal   _meal
                                   _detail _detail

operational_claims ──1:N──▶ claim_entitlements
                              (homogeneous: any entitlement type)
                                       │
                                       │ N:M via entitlement_payment_links
                                       ▼
                              payment_records
                              (Payslip line OR Petty Cash submission)

rates ──1:N──▶ rate_versions ──snapshot──▶ claim_entitlements.rate_snapshot

stations ──N:M (matrix)──▶ station_distance_matrix
                            station_time_matrix
```

---

# 1. Users and Profiles

## `profiles`

One row per user. Joined to `auth.users` by `id`.

| Column                 | Type        | Notes                                            |
|------------------------|-------------|--------------------------------------------------|
| id                     | uuid PK     | = `auth.users.id`                                |
| display_name           | text        | Free-form.                                       |
| rostered_station_id    | int FK      | → `stations.id`. Affects future claims only.     |
| home_location_label    | text        | Bare label of home origin (matches station shape conventions). |
| home_lat               | numeric     | Optional geocode cache.                          |
| home_lng               | numeric     | Optional geocode cache.                          |
| created_at             | timestamptz |                                                  |
| updated_at             | timestamptz |                                                  |

Profile state is NOT versioned in this table — claims snapshot the relevant
profile fields at creation time (see `station_id_snapshot`). Profile edits
are forward-only and never rewrite historical claims.

---

# 2. Operational Claims

## `operational_claims` (core)

Heterogeneous claim types share this core row. Type-specific fields live in
the detail tables below.

| Column                    | Type        | Notes                                          |
|---------------------------|-------------|------------------------------------------------|
| id                        | uuid PK     |                                                |
| owner_id                  | uuid FK     | → `profiles.id`. The user who owns this draft. |
| claim_type                | text enum   | `RC`, `RT`, `SB`, `MD`, `DM`, `SM`.            |
| claim_date                | date        | Operational event date.                        |
| station_id_snapshot       | int         | Rostered station at the time of claim creation.|
| station_name_snapshot     | text        | Bare name snapshot. Display-only.              |
| source_calculation_mode   | text enum   | e.g. `frv_matrix`, `google_maps`, `manual`.    |
| status                    | text enum   | Claim-level lifecycle (draft / submitted / archived). |
| generated_at              | timestamptz | When the claim and its auto-children were created. |
| notes                     | text        | Editable free-text.                            |
| parent_claim_id           | uuid FK NULL| → `operational_claims.id`. Set when this row was created by copying / sharing from another claim. See § 6 Sharing. |
| copy_source_owner_id      | uuid NULL   | For shared copies: the user the draft was copied from. Informational only — no ongoing sync. |
| created_at                | timestamptz |                                                |
| updated_at                | timestamptz |                                                |

Indexes: `(owner_id, claim_date)`, `(claim_type, claim_date)`.

Claim-type rules (which entitlements each generates, allowed travel
sources, payment routing defaults) live in `CLAIM_TYPES.md` and
`ENTITLEMENT_RULES.md`. They are NOT enforced in this table; the engine
validates at generation time.

---

## Claim-Type Detail Tables

One detail row per parent claim, joined 1:1 on `claim_id`. Detail tables
only hold type-specific input fields — never recomputed outputs.

### `recall_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  | → `operational_claims.id`.                      |
| recall_station_id       | int FK      | → `stations.id`.                                |
| recall_start_at         | timestamptz | Start of the recall.                            |
| recall_end_at           | timestamptz | End of the recall.                              |
| travel_distance_km      | numeric     | Google Maps (KM only). Manual override allowed. |
| travel_source           | text enum   | `google_maps` / `manual`.                       |
| meal_break_taken        | boolean     | For Large Meal / Relieving triggers.            |

### `retain_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  |                                                 |
| retain_start_at         | timestamptz |                                                 |
| retain_end_at           | timestamptz |                                                 |
| meal_break_taken        | boolean     |                                                 |

### `standby_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  |                                                 |
| standby_station_id      | int FK      | → `stations.id`.                                |
| standby_start_at        | timestamptz |                                                 |
| standby_end_at          | timestamptz |                                                 |
| matrix_distance_km      | numeric     | FRV Matrix only. Manual override allowed.       |
| matrix_hours            | numeric     | FRV Matrix Index sheet (decimal hours).         |
| matrix_version          | text        | FRV Matrix version pinned at creation.          |

### `muster_dismiss_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  |                                                 |
| md_station_id           | int FK      | → `stations.id`.                                |
| md_event_at             | timestamptz |                                                 |
| matrix_distance_km      | numeric     | FRV Matrix only.                                |
| matrix_hours            | numeric     |                                                 |
| matrix_version          | text        |                                                 |

### `delayed_meal_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  |                                                 |
| meal_window_start_at    | timestamptz | Entitlement window start.                       |
| meal_window_end_at      | timestamptz | Entitlement window end.                         |
| actual_meal_at          | timestamptz NULL | NULL if no meal was taken in the window.   |

### `spoilt_meal_details`

| Column                  | Type        | Notes                                           |
|-------------------------|-------------|-------------------------------------------------|
| claim_id                | uuid PK FK  |                                                 |
| meal_provisioned_at     | timestamptz |                                                 |
| spoilt_reason           | text        | Free-text.                                      |

Forward-only: new claim types add new detail tables. Existing detail tables
MUST NOT be widened to model unrelated claim types.

---

# 3. Generated Entitlements

## `claim_entitlements`

Homogeneous. One row per generated entitlement, regardless of type.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| claim_id               | uuid FK     | → `operational_claims.id`. Cascading delete with the parent. |
| owner_id               | uuid FK     | Denormalised from parent for RLS / sharing checks. |
| entitlement_type       | text enum   | `small_meal`, `large_meal`, `excess_travel`, `relieving`, `standby_dismi`, `muster_dismis`, `maint_stn`, … |
| unit                   | text enum   | `dollars`, `hours`, `km`.                          |
| generated_amount       | numeric     | Engine output at creation. Immutable.              |
| generated_hours        | numeric NULL| Engine output at creation (where applicable).      |
| edited_amount          | numeric NULL| Manual override of `generated_amount`. NULL = no override. |
| edited_hours           | numeric NULL| Manual override of `generated_hours`.              |
| edited_note            | text NULL   | Explanation of the override.                       |
| manual_override        | boolean     | Mirror of `edited_amount IS NOT NULL OR edited_hours IS NOT NULL`. Stored for query convenience. |
| rule_id                | text        | Stable identifier of the rule that fired.          |
| rule_version           | text        | Rule version active at generation time.            |
| rule_explanation       | text        | Human-readable "why was this generated?".          |
| formula_explanation    | text        | Human-readable formula trace.                      |
| rate_id                | uuid FK     | → `rates.id`. Convenience pointer.                 |
| rate_version_id        | uuid FK     | → `rate_versions.id`.                              |
| rate_snapshot          | jsonb       | Frozen copy of the rate value(s) used.             |
| payment_method         | text enum NULL | `payslip` / `petty_cash` / NULL. Some claim types set this at creation; others leave it for later. See `PAYMENT_RECONCILIATION.md § Payment Method Routing`. |
| payment_status         | text enum   | `pending` / `paid` (payslip) OR `outstanding` / `claimed` (petty_cash). NULL until `payment_method` is set. |
| generated_at           | timestamptz |                                                    |
| updated_at             | timestamptz |                                                    |

Indexes: `(claim_id)`, `(owner_id, payment_status)`,
`(entitlement_type, generated_at)`.

Effective payable amount is computed as
`COALESCE(edited_amount, generated_amount)`. The original
`generated_amount` is NEVER overwritten.

Manual edits MUST NOT cause regeneration of sibling entitlements
(see `ENTITLEMENT_RULES.md § Manual Override Rules`).

---

# 4. Rates

## `rates`

Canonical configurable allowance values. The Rates page is the UI surface.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| code                   | text UNIQUE | e.g. `small_meal`, `large_meal`, `travel_per_km`, `standby_hours`, `md_hours`. |
| display_name           | text        |                                                    |
| unit                   | text enum   | `dollars`, `dollars_per_km`, `hours`.              |
| active_version_id      | uuid FK     | → `rate_versions.id`. Current active version.      |
| created_at             | timestamptz |                                                    |

## `rate_versions`

Append-only. One row per rate change.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| rate_id                | uuid FK     | → `rates.id`.                                      |
| version_label          | text        | e.g. `2026-07-01-eba`.                             |
| value                  | numeric     | Rate value for this version.                       |
| effective_from         | date        | First date the rate applies to new claims.         |
| created_at             | timestamptz |                                                    |
| created_by             | uuid FK     | → `profiles.id`. Who set this version.             |

Lookup rule for new claims: pick the `rate_versions` row for the rate where
`effective_from <= claim_date` and there is no later `effective_from` for
the same `rate_id`. The chosen row is snapshotted into
`claim_entitlements.rate_snapshot` at generation time.

Historical claims NEVER re-query `rates` — they read `rate_snapshot`. See
`ALLOWANCE_ENGINE_DATA_MODEL.md § Historical Record Philosophy`.

---

# 5. Stations and Travel Reference Data

## `stations`

In-memory shape is `(station_id, bare_name)` — the bare name comes from
this table. See
`ALLOWANCE_ARCHITECTURE.md § Station Model` for the rule that
`rostered_station_label` is write-only and prefix-stripping must NOT be
reintroduced.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | int PK      | Station number. Stable.                            |
| name                   | text        | Bare name.                                         |
| district               | text NULL   |                                                    |
| street_address         | text NULL   |                                                    |
| lat                    | numeric NULL|                                                    |
| lng                    | numeric NULL|                                                    |
| active                 | boolean     |                                                    |
| created_at             | timestamptz |                                                    |

## `station_distance_matrix`

Sparse matrix of station-to-station distance entries from the FRV Matrix.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| from_station_id        | int FK PK   | → `stations.id`.                                   |
| to_station_id          | int FK PK   | → `stations.id`.                                   |
| matrix_version         | text PK     | Pin per row so multiple matrix versions can coexist.|
| distance_km            | numeric     |                                                    |

## `station_time_matrix`

Companion to the distance matrix. The FRV Matrix Index sheet returns
DECIMAL HOURS — this table stores those raw hours. Conversion to payable
dollars is the engine's responsibility (see
`ENTITLEMENT_RULES.md § FRV Matrix Hours → Payable Bridge`).

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| from_station_id        | int FK PK   | → `stations.id`.                                   |
| to_station_id          | int FK PK   | → `stations.id`.                                   |
| matrix_version         | text PK     |                                                    |
| hours                  | numeric     | 0.25-hour increments.                              |

---

# 6. Sharing Model

Future direction: sharing supported from day one. See
`ALLOWANCE_ENGINE_DATA_MODEL.md § 8. Shared Claims`.

Mechanism:

- A user can copy a claim to another user. The copy is a new
  `operational_claims` row with:
  - new `id`
  - new `owner_id` (recipient)
  - `parent_claim_id` set to the source claim's id
  - `copy_source_owner_id` set to the source owner
- The copy is an independent draft. No triggers, no FKs, no background
  job re-syncs anything from the source after the copy.
- The copy's detail row(s) and any auto-generated entitlements are also
  cloned 1:1 at copy time. Snapshots (station, rate) are re-snapshotted
  against the recipient's current profile at copy time.
- The source row remains untouched.

`parent_claim_id` is purely a provenance pointer. No queries should treat
it as a live link.

RLS:

- `profiles`: each user sees their own row.
- `operational_claims` and detail tables: visible only to `owner_id`.
  Copying is a server-side action that constructs the new owner's rows
  and grants no cross-owner read.
- `claim_entitlements`: same as parent claim.
- `payment_records`, `entitlement_payment_links`: scoped to `owner_id`.
- `rates`, `rate_versions`, `stations`, `station_*_matrix`: shared
  reference data, readable by all authenticated users; mutable only by
  privileged role.

---

# 7. Payment and Reconciliation

## `payment_records`

Real-world payment facts: either a payslip line or a petty-cash submission.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| owner_id               | uuid FK     | → `profiles.id`.                                   |
| stream                 | text enum   | `payslip` / `petty_cash`.                          |
| record_date            | date        | Pay date OR petty-cash submission date.            |
| reference              | text        | Payslip line code / petty-cash form reference.     |
| gross_amount           | numeric     | Amount as observed on the payslip / form.          |
| raw_payload            | jsonb NULL  | Raw OCR / parsed-PDF / export snapshot.            |
| source                 | text enum   | `manual` / `payslip_screenshot` / `payslip_pdf` / `petty_cash_export`. |
| created_at             | timestamptz |                                                    |

## `entitlement_payment_links`

N:M between entitlements and payment records. One entitlement may
ultimately be satisfied by zero, one, or several payment records (e.g.
partial payments) — and one payment line may aggregate several
entitlements.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| entitlement_id         | uuid FK     | → `claim_entitlements.id`.                         |
| payment_record_id      | uuid FK     | → `payment_records.id`.                            |
| allocated_amount       | numeric     | Portion of the payment record attributed here.     |
| link_kind              | text enum   | `auto_match` / `manual` / `discrepancy_note`.      |
| note                   | text NULL   |                                                    |
| created_at             | timestamptz |                                                    |

Status transitions live on `claim_entitlements.payment_status`. Links are
the auditable evidence; the status field is the user-facing summary.

## `reconciliation_audit`

Append-only log of reconciliation actions. See
`PAYMENT_RECONCILIATION.md § Audit Trail Requirements`.

| Column                 | Type        | Notes                                              |
|------------------------|-------------|----------------------------------------------------|
| id                     | uuid PK     |                                                    |
| entitlement_id         | uuid FK     | → `claim_entitlements.id`.                         |
| actor_id               | uuid FK     | → `profiles.id`.                                   |
| action                 | text        | e.g. `mark_paid`, `mark_outstanding`, `link_payment`, `regress_status`. |
| prior_status           | text NULL   |                                                    |
| new_status             | text NULL   |                                                    |
| reason                 | text NULL   |                                                    |
| automated              | boolean     | True if produced by an ingestion / matcher.        |
| created_at             | timestamptz |                                                    |

Reconciliation actions MUST NOT mutate `generated_amount`, `rate_snapshot`,
`rule_id`, or `rule_version`. They only mutate payment-state fields and
append rows here.

---

# 8. Status Enums (Reference)

Claim-level (`operational_claims.status`):

- `draft`
- `submitted`
- `archived`

Entitlement payment-state (`claim_entitlements.payment_status`):

- Payslip stream: `pending` → `paid`
- Petty Cash stream: `outstanding` → `claimed`

Stream is encoded by `payment_method` (`payslip` / `petty_cash`).
`payment_status` values are scoped to their stream. Regression from a
terminal state is allowed but MUST be recorded in `reconciliation_audit`.

---

# 9. Historical Static Accounting Records

The following fields are immutable after a claim or entitlement is created:

- `operational_claims.generated_at`, `station_id_snapshot`,
  `station_name_snapshot`, `source_calculation_mode`,
  `parent_claim_id`, `copy_source_owner_id`
- `claim_entitlements.generated_amount`, `generated_hours`,
  `rule_id`, `rule_version`, `rule_explanation`,
  `formula_explanation`, `rate_id`, `rate_version_id`,
  `rate_snapshot`, `generated_at`

Editable fields:

- `operational_claims.notes`, `status`, `updated_at`
- `claim_entitlements.edited_amount`, `edited_hours`, `edited_note`,
  `manual_override`, `payment_method`, `payment_status`, `updated_at`

Enforcement: at minimum via app-layer guards and Supabase RLS update
policies; constraint triggers may be added once rules stabilise.

---

# 10. Cross-References

- App overview → `ALLOWANCE_ARCHITECTURE.md`
- Full data model rationale → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Claim catalogue → `CLAIM_TYPES.md`
- Entitlement rules → `ENTITLEMENT_RULES.md`
- Payment + reconciliation behaviour → `PAYMENT_RECONCILIATION.md`

---

# TODO

- [ ] Confirm whether `operational_claims.status` needs more states than
      `draft / submitted / archived` (e.g. a separate `void` state).
- [ ] Decide whether `claim_entitlements.payment_status` should be split
      into separate columns per stream rather than a single enum scoped by
      `payment_method`.
- [ ] Codify the FRV Matrix hours → payable bridge in the engine and
      document the dependent rate code(s) here.
- [ ] Decide whether `station_distance_matrix` and `station_time_matrix`
      should be merged into one table with `(distance_km, hours)` columns,
      or kept separate as drafted here.
- [ ] Decide whether to store the source-of-truth FRV Matrix version on
      `profiles` (per-user pin) or `operational_claims` (per-claim pin —
      currently drafted on the detail tables).
- [ ] Add RLS policy specs as a separate document once the schema is
      stamped.
- [ ] Decide on soft-delete vs hard-delete for `operational_claims` and
      whether deletes cascade through `claim_entitlements`.
- [ ] Decide whether `parent_claim_id` and `copy_source_owner_id` should
      enforce existence (FK) or remain informational text columns (so the
      source can be deleted without breaking copies).
- [ ] Document the canonical petty-cash export shape (rows, headers) and
      whether the export is materialised in a table or computed on demand.
- [ ] Document a `payslip_imports` raw-ingest table once the payslip
      ingestion subsystem is designed (per
      `PAYMENT_RECONCILIATION.md § Payslip Verification (Future)`).

---

# Future Architecture Guidance

- Keep the three layers separate at the table level too: do NOT add
  payment-state columns to `operational_claims`, and do NOT add
  operational-input columns to `claim_entitlements`.
- New claim types add new detail tables. Resist the temptation to widen
  an existing detail table to model an unrelated claim type — that path
  rebuilds the heterogeneity the core split exists to avoid.
- Rate evolution is forward-only. Never update a `rate_versions` row in
  place; insert a new version with a new `effective_from`.
- Sharing is copy-on-write. If a future feature wants live-shared claims,
  it should be modelled as a separate `claim_subscriptions` concept —
  do NOT retrofit live sync onto `parent_claim_id`.
- Reconciliation tooling reads entitlement snapshots and writes payment
  state + audit rows only. It should never mutate `generated_*`,
  `rule_*`, or `rate_*` fields.
- Priority order for schema decisions, matching the app-level direction:
  Automation → Correctness → Flexibility → Simplicity.
