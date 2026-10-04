# Legacy ChatGPT Project Sources — Fire Allowance Tracker

> **Status: HISTORICAL / PROVENANCE. Not current product authority.**
> Current FAT architecture authority is [`docs/architecture/`](../../architecture/)
> ([Current Model](../../architecture/CURRENT_MODEL.md),
> [Projected Model](../../architecture/PROJECTED_MODEL.md),
> [Gap Register](../../architecture/GAP_REGISTER.md)). Where a file here disagrees
> with those, they win. Repository workflow authority is [`CLAUDE.md`](../../../CLAUDE.md).

## Provenance

| | |
|---|---|
| Original location | `Tinnaz45/governance-system` → `chatgpt-project-sources/fire-allowance-tracker/` (branch `dev`) |
| Copied from commit | `5c35863ea7f3b1538bea0997b4d5d155ef0190cd` (governance-system `dev`, 2026-10-04) |
| Relocated under | Linear [WORK-220](https://linear.app/catalyst-app-development/issue/WORK-220) — prerequisite for Governance v2 Phase C2 (retirement of `chatgpt-project-sources/`) |
| Governance model | Governance v2 Projected model `sha256:42b22a018acb709858f8ddbe58a02781ed0a59ce142ff43b7022f2ae924c3cd2` |
| Copy method | Verbatim, byte-for-byte. Each copy has the same git blob SHA as its source (table below). No file was edited. |

These six documents are the June-2026 "rebuild target" set. They were written as
ChatGPT Project Sources and kept in the shared Governance System repository, although
they are FAT-specific. FAT now owns them here.

**How to read them.** Per WORK-164 decision **D9h**
([`PROJECTED_MODEL.md` § Authority and approval](../../architecture/PROJECTED_MODEL.md#authority-and-approval)),
they are **inputs, not authority**. They assumed "not live / no production data /
greenfield", and that premise is **false**. A concept from them is current only where
the Projected Model re-approves it. The
[`CURRENT_MODEL.md` document trust map](../../architecture/CURRENT_MODEL.md#document-trust-map-as-of-2026-10-01)
rates them FUTURE-DESIGN INPUT / provenance.

**Why they are kept.** FAT code and docs cite them by filename and section
(e.g. `ENTITLEMENT_RULES_v1.0.md § FRV Matrix Hours → Payable Bridge`), including
`lib/fat/models/*`, `lib/fat/engine/generators/*`, `supabase/canonical/01_*.sql` and
`02_*.sql`, and docs such as `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`,
`CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md`, `RECONCILIATION_STATE_ARCHITECTURE_v1.0.md`,
`SCHEMA_READINESS_v1.0.md`, `REBUILD_PLAN_v1.0.md` and `REBUILD_AUDIT_v1.0.md`.
**A bare citation of one of these filenames anywhere in this repository resolves to the
copy in this directory.** Older citations that give a
`…\governance-system\chatgpt-project-sources\fire-allowance-tracker\` path refer to the
same files, now here.

**Links inside the copies.** Cross-references between the six files use unversioned
names (`ENTITLEMENT_RULES.md`, etc.) and mean the `_v1.0` copies here. Relative links
that start with `../../` were written relative to the Governance System repository and
do not resolve in FAT. Examples are `../../.claude/memory/…` in `ENTITLEMENT_RULES_v1.0.md`
and the shared-governance links in `ORIGINAL_SOURCE_README.md`. Treat them as historical
text.

## Disposition record (WORK-220)

Disposition codes: **A** RETAIN COPY · **B** MERGED/SUPERSEDED · **C** PARTIAL OVERLAP
(some content is current elsewhere, but unique material remains and is preserved here).

| Source file (governance-system path `chatgpt-project-sources/fire-allowance-tracker/…`) | FAT destination | Blob SHA (source = copy) | Disp. | Where it overlaps current FAT docs | Unique material that exists only here |
|---|---|---|---|---|---|
| `ALLOWANCE_ARCHITECTURE_v1.0.md` | [`ALLOWANCE_ARCHITECTURE_v1.0.md`](ALLOWANCE_ARCHITECTURE_v1.0.md) | `2e4ed7f` | **C** | Three-layer split and subsystem picture: `PROJECTED_MODEL.md`, `CURRENT_MODEL.md`. Station `(id, bare_name)` / write-only `rostered_station_label`: code and `REBUILD_AUDIT_v1.0.md`. | Subsystem map diagram. Per-claim-type travel-source scope rationale ("intentional, not negotiable without re-planning"). Flag that a server-side Maps route is architecturally significant. Priority order *Automation → Correctness → Flexibility → Simplicity*. Architecture TODO list. |
| `ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md` | [`ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md`](ALLOWANCE_ENGINE_DATA_MODEL_v1.0.md) | `3d7c3ea` | **C** | Operational claim → entitlement → payment model: `PROJECTED_MODEL.md` (D1, D9b, D9c), `CLAIM_LIFECYCLE_STATE_MACHINE_v1.0.md`. | Product framing as a *semi-official working-record system* (not payroll, not an FRV record). "Claim Philosophy": model distinct events as distinct claims, never merge for shared rates/pathways. Entitlement snapshot field list. Duplicate detection *warns, never hard-blocks*. Rule-engine bugs must not silently rewrite history. Calculation-transparency list. |
| `CLAIM_TYPES_v1.0.md` | [`CLAIM_TYPES_v1.0.md`](CLAIM_TYPES_v1.0.md) | `97011b5` | **C** | RC/RT/SB/MD/DM/SM catalogue and Standby/M&D entitlement sets: `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`, `CALCULATION_RULES.md`, `lib/fat/engine/generators/*`. | Commit lineage of the Standby split (`08c81f4`, `6435b54`), M&D promotion (`902be2b`), `md` export label (`506aa8a`) and Photon AU prefix (`2469687`). Of these, only `902be2b` is also recorded elsewhere, in `REBUILD_AUDIT_v1.0.md`. "Retired / Renamed Concepts" list (guard against reintroduction). Claim-type codes are stable for the system's lifetime. |
| `DATABASE_ARCHITECTURE_v1.0.md` | [`DATABASE_ARCHITECTURE_v1.0.md`](DATABASE_ARCHITECTURE_v1.0.md) | `9e6480f` | **C** | Table shape is implemented in `supabase/canonical/01_canonical_foundation.sql` and assessed in `SCHEMA_READINESS_v1.0.md` (which records known divergences). Typedefs are in `lib/fat/models/*`. | Original design intent, including RLS intent per table, the immutable/editable field list (§ 9) and the copy-on-write sharing design (§ 6). Open design TODOs (void state, per-stream `payment_status`, matrix-version pin location, soft- vs hard-delete, `parent_claim_id` FK) that current docs cite as `DATABASE_ARCHITECTURE_v1.0.md § TODO`. Guidance that live sharing is a separate `claim_subscriptions` concept. Note: its *Rebuild Assumption* section is the false greenfield premise. |
| `ENTITLEMENT_RULES_v1.0.md` | [`ENTITLEMENT_RULES_v1.0.md`](ENTITLEMENT_RULES_v1.0.md) | `5320d62` | **C** | Hours-first Standby/M&D entitlements, rates and payment routing: `CALCULATION_RULES.md`, `ENTITLEMENT_ENGINE_CONTRACTS_v1.0.md`, `supabase/canonical/02_entitlement_amount_nullable.sql`. | The recorded **2026-05-26 hours-first architecture decision** and its "Why hours-first" rationale (no shift-band/penalty-rate modelling, so no implicit hours → $ conversion). Rounding decision (matrix value stored verbatim). Optional future hourly-rate estimate. Open rule TODOs (Recall, Retain, DM, SM, Relieving) that the generators cite. |
| `PAYMENT_RECONCILIATION_v1.0.md` | [`PAYMENT_RECONCILIATION_v1.0.md`](PAYMENT_RECONCILIATION_v1.0.md) | `5369d45` | **C** | Streams, status lifecycle, audit trail and matching: `RECONCILIATION_STATE_ARCHITECTURE_v1.0.md`, `PAYMENT_RECORDS_LAYER_DESIGN_v1.0.md`, `PAYSLIP_MATCHING_ENGINE_v1.0.md`, `OCR_PAYSLIP_IMPORT_ARCHITECTURE_v1.0.md`. | Discrepancy-handling options (link with override note / mark *out of scope* / mark *payroll error*). Overdue-past-pay-cycle rule. Manual marking as the permanent baseline. Reconciliation-layer guidance ("what did this pay cycle look like?" as a first-class question). Open TODOs cited by current docs. |
| `README.md` | [`ORIGINAL_SOURCE_README.md`](ORIGINAL_SOURCE_README.md) (renamed so it does not act as this folder's index) | `3ae3ad8` | Provenance only | n/a | Shows how the folder was used and its 2026-05-26 date. **Its instructions are stale v1 shared-governance conventions** (`CORE_RULES.md` references, upload bundles, the old local path). They are **not** live FAT instructions. |

**Fully superseded (B): none.** Each of the six substantive documents still holds
material, rationale or cited section anchors that no current FAT document carries.
None was dropped, so no `B` disposition was recorded.

**Not copied:** no generated shared Governance v1 module (`canonical-shared-governance/`,
`chatgpt-upload-bundles/`) was brought into FAT. Only the seven files of the
FAT-specific source folder are here.

## Maintenance

- Do **not** edit these copies to "modernise" them. Record new or changed intent in
  `docs/architecture/` (Projected Model changes need recorded operator approval).
- When the Projected Model re-approves or rejects a concept from these files, record
  that in `docs/architecture/`, not here.
