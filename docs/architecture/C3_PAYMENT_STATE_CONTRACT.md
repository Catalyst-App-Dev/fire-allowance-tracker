# Fire Allowance Tracker — C3 Historical Payment-State Contract

> **Status:** maintained contract for cutover step **C3** of
> [`CUTOVER_PLAN.md`](CUTOVER_PLAN.md): how prototype payment state becomes canonical
> payment records, entitlement allocations and reconciliation audit, and how parity gate 6 is
> proved. It extends the C2 transform ([`C2_TRANSFORM_CONTRACT.md`](C2_TRANSFORM_CONTRACT.md))
> inside the same tool and batch, uses the destination C1 made representable
> ([`C1_CUTOVER_CONTRACT.md`](C1_CUTOVER_CONTRACT.md) § 6) and adds **no schema**.

Established 2026-10-06 by [WORK-191](https://linear.app/catalyst-app-development/issue/WORK-191)
(design record: WORK-191 *Investigation Record — C3 payment-state mapping*, PROMPT #19).
Code: [`lib/fat/migration/c2/payments.js`](../../lib/fat/migration/c2/payments.js) plus the C3
phase of [`sql.js`](../../lib/fat/migration/c2/sql.js); tests
[`__tests__/c3-payment-state.test.mjs`](../../__tests__/c3-payment-state.test.mjs). Rehearsal
evidence: [`docs/evidence/WORK-191/`](../evidence/WORK-191/). **DEV only.** C3 does **not**
enable Payments, change a feature flag or touch a user-facing payment workflow — activation
belongs to WORK-175.

## 1. What C3 owns

| Owned by C3 | Owned elsewhere |
|---|---|
| Prototype payment evidence → `payment_records` (`source = prototype_migration`) + `entitlement_payment_links` + `reconciliation_audit` | Representation, uniqueness, provenance guard — **C1, WORK-189** |
| Each migrated entitlement's `payment_status`, derived exactly as `fat._reconc_recompute` derives it | Claims, details, entitlements, ledger, gates 1–5 and 7 — **C2, WORK-190** |
| Acceptance gate 6 and its report section | Freeze/archive (gate 8) — **C4**; app cutover (gate 9) — **C5** |
| | Payments/Reconciliation activation — **WORK-175** |

After C3 the prototype toggles are **historical evidence only**: the canonical truth is the
payment record, its link (allocation) and audit row, and the derived entitlement status.

## 2. Prototype payment truth (verified 2026-10-06)

- State lives **per prototype row**: `payment_status`, `payment_date`, `payslip_pay_nbr`
  (`ClaimsContext.updatePaymentStatus`). Marking *Paid* writes `payment_date = now()` (and the
  pay number when captured); marking *Pending* clears the date. There is no partial-payment or
  amount concept — *Paid* means the row's whole amount.
- `claim_groups.parent_status` is a cached projection (the code says never authoritative) and
  is **ignored**. `pay_number` on claim rows is not written by the payment toggle and is not
  payment evidence.
- The two prototype readers disagree on one shape only: `payment_status` NULL with a legacy
  `status` other than Pending (`calcParentStatus` falls back to `status`; `groupedView` reads
  NULL as Pending).
- PROD (read-only aggregate): one `callback_ops` child ($162.00) and one `petty_cash_meal`
  child ($31.45) are *Paid* with a date; every other row is NULL (legacy `Pending`); no pay
  number, adjustment or *Disputed*. DEV holds no prototype rows.

## 3. Source evidence classification

| `payment_status` | `payment_date` | legacy `status` | Result |
|---|---|---|---|
| Paid | present | any | **paid** |
| Pending | absent | any | **unpaid** |
| NULL | absent | NULL / Pending | **unpaid** |
| Paid | absent | — | fail `C3_PAID_WITHOUT_DATE` (a record date cannot be invented) |
| Pending | present | — | fail `C3_PENDING_WITH_DATE` |
| NULL | present | — | fail `C3_UNPAID_WITH_DATE` |
| NULL | absent | Paid / Disputed / other | fail `C3_LEGACY_STATUS_CONFLICT` |
| anything else | — | — | fail `C3_UNKNOWN_PAYMENT_STATUS` |

Comparison is case- and whitespace-insensitive. A failure is a **genuine gate-6 failure**: the
plan's outcome is `fail` and no apply SQL is produced. Nothing is silently chosen.

## 4. Mapping

**Unpaid** — no payment record and no link. The entitlement is inserted with the canonical
open status of its route (`pending` for payslip, `outstanding` for petty cash), exactly what the
canonical generators emit and what the recompute derives with no eligible link. (C2 1.0.0 left
it NULL; C3 settles it.) There is no "pending payment record" in the canonical model.

**Paid** — per paid entitlement:

| Canonical | Value |
|---|---|
| `payment_records.id` | UUIDv5(namespace, `payment_record:<key>`) |
| `migration_source_key` | `c3:<prototype table>:<prototype row id>:<component>` — batch-independent |
| `source` / `migration_batch_id` | `prototype_migration` / the run's batch |
| `owner_id`, `stream` | the entitlement's owner and route (`payment_method`) |
| `record_date` | the **Australia/Melbourne calendar date** of the prototype `payment_date` instant |
| `reference` | `payslip_pay_nbr` when recorded, else NULL (no identifier is invented) |
| `gross_amount` | the allocation below |
| `raw_payload` | the source evidence verbatim (status, exact `payment_date` instant, legacy status, pay number), the bases used, and a note that this is not a payslip line, bank settlement or payroll identifier |
| link | `link_entitlement_payment(entitlement, record, allocation, 'manual', owner, note = 'prototype_migration <key> (C3, WORK-191)', automated = true)` — the canonical function checks owner, stream and over-allocation, recomputes the status (→ `paid` / `claimed`) and writes **one** `link_payment` audit row |

**Allocation** = the effective historical payable amount, never recalculated:

- dollars: `edited_amount` when C2 preserved a prototype adjustment (through the audited
  override), else `generated_amount`;
- hours (retain overtime): the stored historical dollars `rate_snapshot.historical_amount`
  (`retain_amount`) — the hours-first terminal rule needs only the link; the dollars are the
  stored prototype value, **never derived from hours**. Missing → fail
  `C3_ALLOCATION_UNESTABLISHED`.

## 5. Entitlement-level vs row-level

- Every auto-child row decides **its own** entitlement. One paid child never pays a sibling,
  and the group is never read.
- A legacy row that carries two components (parent-carried Recall travel + meal, Standby travel
  + night meal) has one toggle for the row: it is applied to both components. This is the
  documented **row-level inference boundary**, counted in
  `gates.6.evidence.inference_boundaries.row_level_shared_toggle`.
- Rows with no payable entitlement — the container/marker parent of a child-carried event and
  the G12-excluded $0 Recall Excess Travel — carry no payment mapping. Their state is listed in
  `report.payments.structural` as an **intended structural difference**
  (`CONTAINER_ROW_NOT_PAYABLE`, `EXCLUDED_ARTIFACT_NOT_PAYABLE`), including any *Paid* toggle.

## 6. Gate 6

Passes only when there is no contradictory or insufficient evidence and the canonical
representation reconciles exactly: one record and one link per paid entitlement, none for
unpaid ones, allocation = source payable amount (per entitlement, by owner/type/FY and in
total), record gross = its allocation, a record date for every record, no duplicate identity,
no cross-owner or cross-stream link, and every status equal to the recompute derivation.

Report section `gates.6.evidence` (schema `fat.c2.parity-report/v2`):
`source_payable_entitlements`; `source_paid` / `source_unpaid` `{count, amount,
by_owner_type_fy}`; `source_invalid`; `canonical {payment_records, payment_links,
allocated_amount, allocated_by_owner_type_fy, entitlement_status}`;
`unmatched_source_payment_state`; `over_allocated`; `under_allocated`;
`record_allocation_mismatches`; `duplicate_migration_payment_identities`;
`records_without_date`; `status_mismatches`; `cross_owner_or_stream_links`;
`contradictory_or_insufficient_source_states`; `genuine_failures`;
`intended_structural_differences`; `inference_boundaries`. Per-entitlement detail is in
`report.payments.items`, failures in `report.payments.failures`. `planned.payment_records` and
`planned.payment_links` count the plan. Gate 7 additionally counts orphan and cross-owner
payment links.

The verify query re-derives gate 6 from the database alone (prototype rows + canonical
tables): source states, exactly-one migration link per paid entitlement, no link on an unpaid
one, allocation and gross, Melbourne record date, derived status, exactly one audit per link,
no unlinked migration record, no duplicate key, and the totals; `check` compares them.

## 7. Idempotency and fail-closed behaviour

The C3 phase runs inside the C2 apply statement, after entitlements and **before** the ledger:

1. records: `insert … on conflict do nothing`, then column-by-column equality with the plan
   (batch id and `created_at` excepted, as in C2); a different row or a key held by another id →
   `C2 conflict`;
2. links: created **only** together with a record inserted in the same run; an existing record
   whose planned link is missing is a conflict, never re-created; an existing link must equal the
   planned allocation and note and have exactly one matching audit row;
3. any link on a migrated entitlement that the plan does not contain → conflict;
4. every entitlement's stored status must equal the planned status **and** `_reconc_recompute`
   must report no change (any change it made is undone by the raise);
5. no payment record tagged to the batch outside the plan.

An identical rerun inserts nothing, links nothing and writes no audit; a tampered record or
link, or a changed source (including paid → unpaid), raises and rolls the whole statement back.
Nothing is overwritten. The batch-scoped `rollback` deletes payment records first (links
cascade), then entitlements (audit rows cascade) and claims.

## 8. Rehearsal (DEV)

- **Real DEV**: extract → plan → apply → apply again → verify → check from merged code.
- **Synthetic DEV**: the C2 harness, extended to seven steps — first run, identical rerun,
  tampered claim, changed source amount (plan B), **tampered payment record**, **deleted payment
  link**, **changed source payment state paid → unpaid (plan C)** — ends in `RAISE`, so every
  fixture and canonical row is rolled back. The fixture
  ([`synthetic-source.json`](../../__tests__/fixtures/c2/synthetic-source.json)) covers paid,
  unpaid, adjusted-and-paid, hours-first paid, mixed claims, Melbourne date roll-over, pay-number
  reference and a paid container parent. Contradictory evidence is proved at plan level (no apply
  SQL exists for it).

## 9. Security and boundaries

No new table, column, function, grant or policy. `prototype_migration` records are minted only
by the privileged migration connection (the C1 guard refuses API roles; `create_payment_record`
does not accept the source). No feature flag, no PROD read beyond aggregates, no PROD write.
