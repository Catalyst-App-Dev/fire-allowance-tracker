# Fire Allowance Tracker — Canonical Cutover and Migration Plan

> **Status:** maintained plan authority for **how** FAT moves from the prototype storage
> (Current) to the canonical operational-claim model (Projected). It is a *plan*, not a
> third model: [`CURRENT_MODEL.md`](CURRENT_MODEL.md) remains the only statement of verified
> reality and [`PROJECTED_MODEL.md`](PROJECTED_MODEL.md) the only statement of approved
> target. If this plan and either model disagree, the model wins and this plan is the defect.
> Gaps owned here: **G09** (single payment truth) and **G10** (canonical cutover and
> prototype retirement) in [`GAP_REGISTER.md`](GAP_REGISTER.md).

Established 2026-10-02 by [WORK-171](https://linear.app/catalyst-app-development/issue/WORK-171).
Approval evidence: WORK-171 Linear comments `3f0fd9ec`, `e1801f08`, `d4f91ff2`, Investigation
Evidence Block `work-171-questions-r1` and Investigation Record
`work-171-investigation-record-20261002-r2`. Operator decisions **D1, D2, D6, D9c, D9f, D9g**.

**Inputs, not authority:** `docs/REBUILD_PLAN_v1.0.md` and `docs/REBUILD_AUDIT_v1.0.md`
(June 2026) are historical input. They assumed no production data; that is false. Nothing
here is permission to rebuild PROD from scratch, and abandoned dual-write is **not** revived.

## Principles

1. **Transform-copy, never in-place.** Prototype rows are read from, never rewritten.
2. **Prototype source is read-only from the freeze until C7**, and is never dropped before C7.
3. **Parity before cutover**: every gate below passes, with evidence, before the app switches.
4. **Every PROD step needs its own explicit Production approval** in the current task/chat.
   Plan approval is not Production approval. Nothing here mutates PROD or `main`.
5. **Idempotent and batch-tagged**: every migrated row carries a deterministic migration-batch
   id and source provenance (source table, source id), so a run can be repeated or removed.
6. Each C-step is a separate, narrowly scoped Linear Issue; none is Active until its
   prerequisites are met and it is promoted through the normal lifecycle.

## Prerequisites and ordering (D9g)

```
Tier 1 (PROD parity & security):  WORK-165  WORK-166  WORK-167  WORK-145  WORK-186
Tier 2:                           WORK-171 (this plan)   WORK-172 (rate/rule model)
Tier 3:                           WORK-173 (generators; WORK-170 rule evidence)
Tier 4 (cutover):                 C1 → C2 → C3 → C4 → C5 → C6 → C7
Tier 5:                           WORK-175 (Payments activation)
Tier 6:                           WORK-168 (legacy retirement)
```

- **C1 and C2/C3 (DEV only)** may begin once WORK-171 is merged and WORK-172 has settled the
  rate/rule snapshot shape they must populate.
- **C4 (PROD)** additionally requires: Tier 1 complete, C1–C3 verified in DEV, and a
  separate Production approval.
- No canonical cutover or Payments enablement before Tier 1 is complete.

## Step boundaries

### C1 — Canonical schema/contract readiness
Ensure the canonical destination can preserve: the user-visible **claim number** (with its
existing uniqueness scope) and **July–June FY** grouping; deterministic **migration-batch /
provenance** columns; a canonical representation of **migrated historical payment state**;
and every constraint, index and RLS policy the transform requires. Ledgered migrations,
DEV first. **No PROD mutation** (PROD application belongs to C4's approval).

### C2 — Deterministic transform-copy tool + DEV rehearsal
Idempotent transform from prototype logical events (`claim_groups` + per-type parent and
auto-child rows) into `operational_claims` + the correct detail row + 0..N
`claim_entitlements`. Splits M&D from `standby_type` and Delayed/Spoilt from `meal_type`.
Preserves source ids/provenance, claim number, FY, dates, notes, snapshots and manual
adjustments. Emits a **machine-readable parity report** covering every gate below.
Rehearsed repeatedly in DEV. Does not revive dual-write.

### C3 — Historical payment-state migration (G09)
Maps prototype payment state into auditable canonical payment records, allocations and
reconciliation evidence with source provenance. Bare prototype `payment_status` toggles do
**not** remain authoritative: after C3 there is one payment truth. Does not enable Payments
(WORK-175).

### C4 — PROD transform-copy under explicit write freeze
Only after prerequisites and a separate Production approval. Claim and payment mutations
are frozen (maintenance / read-only). Source is exported and archived with checksums and
counts, then the additive transform-copy runs. The prototype source is not dropped or
rewritten.

### C5 — Parity sign-off and canonical application cutover
While writes remain frozen: prove every parity gate, run smoke, ownership and RLS checks.
Only on pass, switch app reads/writes to canonical claims/entitlements and canonical
reconciliation. Prototype tables stay read-only.

### C6 — Open canonical writes and observation
Reopen mutations only after C5 sign-off. Monitor for prototype readers/writers and for
reconciliation correctness over an agreed observation window. Payments remains owned by
WORK-175 and stays dark until its own gate passes.

### C7 — Prototype retirement (destructive; separate Issue)
After observation: verified archive and checksums, proof of no readers/writers, then retire
`claim_groups`, the prototype per-type primary tables and obsolete payment-status paths,
under explicit Production approval. **Distinct from WORK-168**, which retires the legacy
`fire_allowance_tracker` schema and `public.fat_*` objects.

## Parity gate (all nine must pass before C5 switches the app)

1. Logical operational-event count parity by owner, type and FY.
2. Exact claim-number preservation and existing uniqueness scope.
3. Each prototype parent → exactly one canonical claim + one correct detail row.
4. Each legitimate auto-child → exactly one entitlement, or a named approved exclusion.
5. Amount / hour / unit reconciliation by owner/FY/type and globally, subject only to
   approved exclusions.
6. Historical payment state reconciled to canonical payment records/links/audit; no
   prototype toggle is truth.
7. No orphan details, entitlements or payment links; no cross-owner rows; ownership and RLS
   checks pass.
8. Frozen-source archive counts and checksums match.
9. Application smoke tests pass while the prototype source remains unchanged and read-only.

## Approved legacy exclusion (G12)

The known fake **$0 Recall Excess Travel** auto-child is **not** migrated into a payable
canonical entitlement. It is preserved in the migration archive/provenance and listed in the
parity report as an explicit **excluded legacy artifact**. A future Recall Excess Travel
entitlement exists only where an authoritative rule establishes it (WORK-173/WORK-174).

## Write-freeze semantics

The freeze begins before C4's source export and ends only at C6. During it, claim and
payment mutations are refused (maintenance or read-only mode) while reads continue. The
freeze is lifted earlier only by rollback (below) returning to the prototype. The freeze
window, announcement and mechanism are fixed in the C4 Issue before Production approval.

## Rollback boundaries

- **Before canonical writes reopen (C4–C5):** rollback may remove **only rows tagged to the
  migration batch** and return to the untouched, frozen prototype, after verification.
- **After canonical-only writes open (C6 onward):** never silently fall back to the
  prototype. Use maintenance mode plus an explicit forward-fix, or a separately approved
  reverse-migration.
- **C7:** has its own verified archive and Production approval; it is the point of no return.

## Ownership split

| Concern | Owner |
|---|---|
| PROD parity/security prerequisites | WORK-165, WORK-166, WORK-167, WORK-145, WORK-186 |
| Versioned rate/rule model and snapshots | WORK-172 |
| SB/M&D excess-travel rule evidence | WORK-170 |
| Canonical generators (recall, retain, spoilt, delayed) | WORK-173 |
| Fake $0 Recall Excess Travel runtime removal | WORK-174 |
| Payments/Reconciliation activation | WORK-175 |
| Legacy `fire_allowance_tracker` / `public.fat_*` retirement | WORK-168 |
| Cutover execution | C1–C7 (below) |

## Spawned Issues

| Step | Issue | Blocked by |
|---|---|---|
| C1 | [WORK-189](https://linear.app/catalyst-app-development/issue/WORK-189) — C1 Canonical schema/contract readiness | WORK-172 |
| C2 | [WORK-190](https://linear.app/catalyst-app-development/issue/WORK-190) — C2 Transform-copy tool + DEV rehearsal | C1, WORK-173 |
| C3 | [WORK-191](https://linear.app/catalyst-app-development/issue/WORK-191) — C3 Historical payment-state migration | C2 |
| C4 | [WORK-192](https://linear.app/catalyst-app-development/issue/WORK-192) — C4 PROD transform-copy under write freeze | C3, WORK-165/166/167 |
| C5 | [WORK-193](https://linear.app/catalyst-app-development/issue/WORK-193) — C5 Parity sign-off + canonical cutover | C4 |
| C6 | [WORK-194](https://linear.app/catalyst-app-development/issue/WORK-194) — C6 Open canonical writes + observation | C5 |
| C7 | [WORK-195](https://linear.app/catalyst-app-development/issue/WORK-195) — C7 Prototype retirement (destructive) | C6 |

## Maintenance

When a step completes, verify the new reality, update `CURRENT_MODEL.md`, and close or amend
the matching `GAP_REGISTER.md` row. G09 and G10 close only when `CURRENT_MODEL.md` shows the
canonical model as verified reality — not when this plan or any single step merges.
