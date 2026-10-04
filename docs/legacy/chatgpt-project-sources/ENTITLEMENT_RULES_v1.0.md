# ENTITLEMENT RULES

Version: v1.0
Status: Draft — initial scaffold
App: Fire Allowance Tracker
Last Updated: 2026-05-26

---

# Purpose

Canonical reference for entitlement-generation rules in the Fire Allowance
Tracker.

This document specifies how operational claims (Recall, Retain, Standby,
Muster & Dismiss, Delayed Meal, Spoilt Meal) are decomposed into generated
entitlements (sub-claims) that drive payroll + petty-cash reconciliation.

Related documents:

- Data model → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Claim type catalogue → `CLAIM_TYPES.md`
- Payment + reconciliation → `PAYMENT_RECONCILIATION.md`

---

# Guiding Principles

1. Generated entitlements are static snapshots — they do NOT recalculate
   after creation.
2. Rule changes apply to NEW claims only. Historical entitlements preserve
   the rules and rates that were active when they were generated.
3. Every entitlement records its parent operational claim, the rule that
   triggered it, the formula used, the rate snapshot, and the rate version.
4. Manual overrides are first-class. Original generated values, edited
   values, and explanation notes are all preserved.

See `ALLOWANCE_ENGINE_DATA_MODEL.md § Entitlement Snapshot Requirements`.

---

# Entitlement Catalogue

Entitlements are either **dollars-first** (payable quantity is a dollar
amount; `generated_amount` is the canonical field) or **hours-first**
(payable quantity is a decimal-hour count; `generated_hours` is the
canonical field, `generated_amount` is NULL unless a future hourly-rate
estimate is configured — see § FRV Matrix Hours → Payable Bridge).

| Entitlement              | Quantity model | Unit         | Source                                  | Notes                                                                 |
|--------------------------|----------------|--------------|-----------------------------------------|-----------------------------------------------------------------------|
| Small Meal Allowance     | dollars-first  | $ per event  | Small Meal Rate                         | e.g. $10.90                                                           |
| Large Meal Allowance     | dollars-first  | $ per event  | Large Meal Rate                         | e.g. $20.55                                                           |
| Excess Travel (Recall)   | dollars-first  | $ per km     | Travel Rate × km                        | e.g. $1.20/km. Recall scope only (Google Maps km).                    |
| Relieving Allowance      | TODO           | TODO         | TODO                                    | TODO                                                                  |
| Excess Travel (Standby)  | hours-first    | decimal hrs  | FRV Matrix (rostered ↔ standby station) | `generated_hours` populated, `generated_amount` NULL.                 |
| Standby&Dismi            | hours-first    | decimal hrs  | Fixed 0.5h (rate `standby_hours`)       | `generated_hours = 0.5`, `generated_amount` NULL.                     |
| Excess Travel (M&D)      | hours-first    | decimal hrs  | FRV Matrix (rostered ↔ M&D station)     | `generated_hours` populated, `generated_amount` NULL.                 |
| Muster&Dismis            | hours-first    | decimal hrs  | Fixed 1.0h (rate `md_hours`)            | `generated_hours = 1.0`, `generated_amount` NULL.                     |
| Maint Stn N/N            | TODO           | TODO         | TODO                                    | TODO                                                                  |

---

# Per-Claim Entitlement Generation

This section is the rule table the engine implements. Codify each rule as it
is confirmed; do not invent rules to fill blanks.

---

## Recall → Entitlements

- Trigger inputs: claim date, rostered station, recall station, travel
  distance (Google Maps, KM), recall duration, meal-break status.
- Travel scope: Google Maps (KM only; no reimbursement wiring yet).
- Candidate entitlements:
  - Large Meal Allowance — TODO: define trigger condition.
  - Travel Allowance — TODO: define formula.
  - Excess Travel — TODO: define `excess` threshold and formula.
  - Relieving Allowance — TODO: define trigger condition.

---

## Retain → Entitlements

- Trigger inputs: claim date, retain duration, meal-break status.
- Travel scope: N/A.
- Candidate entitlements: TODO

---

## Standby → Entitlements

- Trigger inputs: claim date, standby station, rostered station, FRV Matrix
  travel-time (decimal hours), standby duration.
- Travel scope: FRV Matrix ONLY (never Google Maps).
- Generated entitlements (post-split, commit `08c81f4`):
  - **Excess Travel (Standby)** — hours-first. `generated_hours` = FRV
    Matrix hours between rostered station and standby station (matrix
    Index sheet output; 0.25-hour increments). `generated_amount` NULL.
    `payment_method = 'payslip'`.
  - **Standby&Dismi** — hours-first. Fixed `generated_hours = 0.5`
    (rate code `standby_hours`, current value 0.5h). `generated_amount`
    NULL. `payment_method = 'payslip'`.
  - **Small Meal Allowance** — dollars-first. `generated_amount` from
    Small Meal Rate. `payment_method = 'petty_cash'`.
- Payment routing: auto-children carry `payment_method` at creation
  ([project_standby_entitlement_split](../../.claude/memory/project_standby_entitlement_split.md)).
- Hours → payable bridge: resolved per § FRV Matrix Hours → Payable
  Bridge. The matrix output IS the payable quantity; no implicit
  hours → $ conversion is required to ship Standby.

---

## Muster & Dismiss → Entitlements

- Trigger inputs: claim date, M&D station, rostered station, FRV Matrix
  travel-time (decimal hours).
- Travel scope: FRV Matrix ONLY.
- Generated entitlements (post-promotion, commit `902be2b`):
  - **Excess Travel (M&D)** — hours-first. `generated_hours` = FRV
    Matrix hours between rostered station and M&D station. `generated_amount`
    NULL. `payment_method = 'payslip'`.
  - **Muster&Dismis** — hours-first. Fixed `generated_hours = 1.0`
    (rate code `md_hours`, current value 1.0h). `generated_amount`
    NULL. `payment_method = 'payslip'`.
- Hours → payable bridge: resolved per § FRV Matrix Hours → Payable
  Bridge.

---

## Delayed Meal → Entitlements

- Trigger inputs: TODO.
- Candidate entitlements: TODO.

---

## Spoilt Meal → Entitlements

- Trigger inputs: TODO.
- Candidate entitlements: TODO.

---

# FRV Matrix Hours → Payable Bridge

**Resolved (2026-05-26).** Architecture decision below.

The FRV Matrix Index sheet returns DECIMAL HOURS in 0.25-hour increments.
For Standby and Muster & Dismiss entitlements, **those hours ARE the
payable quantity** — there is no implicit hours → dollars conversion at
generation time.

## Decision: hours-first entitlements

Standby and M&D produce **hours-first** entitlements. The engine writes
matrix hours (and fixed-hour constants for Standby&Dismi / Muster&Dismis)
directly into `claim_entitlements.generated_hours`. The matrix is the
bridge.

| Entitlement              | `generated_hours` source                      | Rate code      | `generated_amount` |
|--------------------------|-----------------------------------------------|----------------|--------------------|
| Excess Travel (Standby)  | FRV Matrix, rostered ↔ standby station        | (no rate)      | NULL               |
| Standby&Dismi            | Fixed 0.5h                                    | `standby_hours`| NULL               |
| Excess Travel (M&D)      | FRV Matrix, rostered ↔ M&D station            | (no rate)      | NULL               |
| Muster&Dismis            | Fixed 1.0h                                    | `md_hours`     | NULL               |

Rounding: none. The matrix already returns 0.25-hour increments; the
engine stores the matrix value verbatim. No rate-side rounding rule is
required at the entitlement-generation step.

Payment routing: all four entitlements are **payslip** entitlements
(`payment_method = 'payslip'`). The payslip line is the dollar settlement
event — translation from hours to dollars happens off-app, on the
payslip itself, and is reconciled at `entitlement_payment_links` time.

## Why hours-first

- The app is a working-record + reconciliation tool, not the payroll
  system of record (per `ALLOWANCE_ENGINE_DATA_MODEL.md`). It does NOT
  need to predict the dollar payout to do its job.
- Predicting hourly dollars requires shift-band knowledge (penalty
  rates, overtime, leadership loadings) the app does not have and is
  not in scope to model.
- Hours-first preserves the static-accounting-record philosophy: the
  matrix value at generation time is the truth captured on the
  entitlement, and reconciliation only ever compares it against the
  payslip line that materialises later.

## What this means for `claim_entitlements`

- `generated_hours` is the canonical payable quantity for hours-first
  entitlements.
- `generated_amount` is **nullable** for hours-first entitlements (NULL
  unless a future optional hourly-rate estimate is configured).
- `unit` is `'hours'` for these rows.
- `effectivePayable` (the COALESCE helper) remains correct for
  dollars-first entitlements; hours-first entitlements expose payable
  hours via `COALESCE(edited_hours, generated_hours)` in the engine.

**Schema follow-up:** `fat.claim_entitlements.generated_amount` is
currently `NOT NULL` in `01_canonical_foundation.sql`. To support
hours-first entitlements cleanly, the NOT NULL constraint must be
dropped in a follow-up migration (`02_*.sql`). The Phase 1 schema is
otherwise forward-compatible — `generated_hours`, `unit`, and the
`COALESCE(edited_amount, generated_amount)` helper need no change.

## Optional future: hourly-rate estimate

If, later, an operator chooses to configure an estimated hourly rate
for indicative payable preview (e.g. base hourly × matrix hours), the
engine can populate `generated_amount` alongside `generated_hours` from
that rate snapshot. This remains optional and additive; the canonical
quantity on the entitlement is always `generated_hours`.

---

# Manual Override Rules

Generated entitlements are editable. The engine must:

- Preserve the originally generated value.
- Store the edited value alongside.
- Record an explanation note where possible.
- Mark the entitlement as `manual_override = true` so reconciliation tooling
  can flag it.

Manual edits MUST NOT cause regeneration of sibling entitlements.

---

# Rate Snapshotting

Every generated entitlement records:

- the rate value at time of generation
- the rate version identifier
- the generation timestamp

New claims use current active rates; historical claims preserve their
original rate snapshots. The Rates page is the canonical source of
configurable allowance values.

---

# TODO

- [ ] Codify the Recall entitlement trigger conditions.
- [x] Codify the Standby entitlement formulas (Excess Travel, Standby&Dismi,
      Small Meal). *(Resolved 2026-05-26 — see § Standby → Entitlements.)*
- [x] Codify the Muster & Dismiss entitlement set post-promotion.
      *(Resolved 2026-05-26 — see § Muster & Dismiss → Entitlements.)*
- [ ] Codify Delayed Meal and Spoilt Meal entitlements.
- [x] Define the FRV Matrix hours → payable bridge. *(Resolved 2026-05-26
      — hours-first. See § FRV Matrix Hours → Payable Bridge.)*
- [ ] Define the Relieving Allowance trigger and formula.
- [ ] Document rule-version history (when each rule changed, and the cutover
      date).
- [ ] Schema follow-up: drop `NOT NULL` on
      `fat.claim_entitlements.generated_amount` so hours-first entitlements
      can persist with `generated_amount IS NULL` (new migration file under
      `supabase/canonical/`).

---

# Future Architecture Guidance

- New entitlements should be added with an explicit rule version and a
  forward-only cutover; do not retro-apply.
- Rule changes that materially affect payable output must be recorded with a
  rule-version bump so historical entitlements remain reproducible.
- The engine should eventually expose a per-entitlement "Why?" view showing
  the rule triggered, formula used, rate snapshot, and override history.
