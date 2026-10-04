# CLAIM TYPES

Version: v1.0
Status: Draft — initial scaffold
App: Fire Allowance Tracker
Last Updated: 2026-05-26

---

# Purpose

Canonical catalogue of operational claim types modelled by the Fire Allowance
Tracker.

Each operational claim type represents a distinct real-world event. Operational
claims are NOT merged on the basis of shared rates, shared calculations, or
shared reimbursement pathways — see `ALLOWANCE_ENGINE_DATA_MODEL.md § Claim
Philosophy`.

Related documents:

- Data model → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Entitlement generation rules → `ENTITLEMENT_RULES.md`
- Payment + reconciliation → `PAYMENT_RECONCILIATION.md`

---

# Top-Level Operational Claim Types

| Code | Display Name        | Status   | Notes                                              |
|------|---------------------|----------|----------------------------------------------------|
| RC   | Recall              | Active   | Operational call-back to duty.                     |
| RT   | Retain              | Active   | Held-over duty beyond rostered hours.              |
| SB   | Standby             | Active   | Coverage at another station without performing the |
|      |                     |          | duty itself; split entitlement structure.          |
| MD   | Muster & Dismiss    | Active   | Promoted to a top-level claim type (was a sub).    |
| DM   | Delayed Meal        | Active   | Meal-break delayed past entitlement window.        |
| SM   | Spoilt Meal         | Active   | Provisioned meal rendered unusable by ops.         |

---

# Claim Type Detail Template

Each claim type below uses the same structure. Fill in as rules are codified.

---

# Recall (RC)

- Trigger: Operational call-back to duty outside the rostered shift.
- Travel source: Google Maps (KM only; no reimbursement wiring yet).
- Generates entitlements: (TODO — confirm against current engine output)
  - Large Meal Allowance (conditional)
  - Travel Allowance (conditional)
  - Excess Travel (conditional)
  - Relieving Allowance (conditional)
- Payment routing: TODO
- Notes:
  - Distance calculations preserve the AU unit prefix in Photon autocomplete
    labels (commit `2469687`).

---

# Retain (RT)

- Trigger: Held-over on duty past rostered finish time.
- Travel source: N/A (no travel component by default).
- Generates entitlements: TODO
- Payment routing: TODO
- Notes: TODO

---

# Standby (SB)

- Trigger: Standby coverage at another station.
- Travel source: FRV Matrix only.
- Generates entitlements (post-split, commit `08c81f4`):
  - Excess Travel
  - Standby&Dismi
  - Small Meal Allowance
- Payment routing: auto-children carry `payment_method` at creation (Payslip
  or Petty Cash). This asymmetry vs Recall/Retain is intentional — see the
  2026-05 spec.
- Notes:
  - Standby was previously framed as a payroll line; that framing is hidden
    but the underlying claim-creation breakdown remains operational
    (commit `6435b54`).

---

# Muster & Dismiss (MD)

- Trigger: Muster & dismiss event at a station other than the rostered one.
- Status: Promoted to a top-level claim type (commit `902be2b`). Previously
  modelled as a sub-claim.
- Travel source: FRV Matrix only.
- Generates entitlements: TODO — confirm post-promotion entitlement set.
- Payment routing: TODO
- Notes:
  - Reconciliation export now maps the `md` claimType label correctly via
    child-label utilities (commit `506aa8a`).

---

# Delayed Meal (DM)

- Trigger: Operationally unable to take a meal break inside the entitlement
  window.
- Travel source: N/A.
- Generates entitlements: TODO (likely a meal allowance variant).
- Payment routing: TODO
- Notes: TODO

---

# Spoilt Meal (SM)

- Trigger: Meal provisioned but rendered unusable by operational tasking.
- Travel source: N/A.
- Generates entitlements: TODO
- Payment routing: TODO
- Notes: TODO

---

# Generated Entitlement Sub-Claim Types

Sub-claims are NOT operational claim types. They are payable outcomes linked
to a parent operational claim. Listed here for cross-reference only — the
authoritative list lives in `ENTITLEMENT_RULES.md`.

- Small Meal Allowance
- Large Meal Allowance
- Excess Travel
- Relieving Allowance
- Standby&Dismi
- Muster&Dismis  *(legacy sub-claim form; superseded by top-level MD where
  applicable — TODO confirm rollout boundary)*
- Maint Stn N/N

---

# Retired / Renamed Concepts

Track here so future agents do not reintroduce them.

- *Muster & Dismiss* as a sub-claim only → promoted to top-level claim (MD).
- *Standby* as a single bundled payroll line → split into Excess Travel +
  Standby&Dismi + Small Meal entitlements.

---

# TODO

- [ ] Finalise the per-claim-type entitlement matrix (which entitlements each
      claim generates and under what conditions).
- [ ] Confirm payment routing defaults per claim type (Payslip vs Petty
      Cash).
- [ ] Document each claim type's required inputs at creation (date, station,
      hours, distance, etc.).
- [ ] Document validation rules per claim type.
- [ ] Document duplicate-detection heuristics per claim type.

---

# Future Architecture Guidance

- New claim types should be added as discrete records, not merged into an
  existing type for convenience.
- A claim type code (e.g. `RC`, `MD`) should be stable for the lifetime of
  the system; display names may evolve.
- Promotion of a sub-claim to a top-level claim type (as with M&D) is a
  schema-affecting decision and should be documented here.
