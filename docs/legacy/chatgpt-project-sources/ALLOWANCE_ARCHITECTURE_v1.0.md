# ALLOWANCE ARCHITECTURE

Version: v1.0
Status: Draft — initial scaffold
App: Fire Allowance Tracker
Last Updated: 2026-05-26

---

# Purpose

High-level architectural overview of the Fire Allowance Tracker app.

This document is the entrypoint for app-specific architecture documentation. It
summarises the system's bounded domain, the major subsystems, and the
relationships between them, and links out to deeper specifications.

Deeper specifications:

- Operational + entitlement data model → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Database / table layout → `DATABASE_ARCHITECTURE.md`
- Claim type catalogue → `CLAIM_TYPES.md`
- Entitlement generation rules → `ENTITLEMENT_RULES.md`
- Payment + payroll reconciliation → `PAYMENT_RECONCILIATION.md`

---

# Scope

The Fire Allowance Tracker is a personal allowance / payroll-verification tool
for an FRV firefighter. It is NOT an official payroll system and NOT an
official FRV record system — it is a semi-official working-record system used
for tracking, reconciliation, verification, auditing, and correction.

In scope:

- operational event tracking (Recall, Retain, Standby, Muster & Dismiss, etc.)
- entitlement generation from operational events
- payroll + petty-cash reconciliation
- rate management
- station + travel reference data

Out of scope:

- timesheet authoring
- shift rostering
- payroll generation
- HR functions

---

# Bounded Domain

The Supabase schema lives entirely under the `fat.*` bounded domain (Fire
Allowance Tracker). Cross-domain reads/writes are not part of this app's
architecture.

Canonical schema source: `supabase/fat-schema.sql`.
Superseded SQL (do not consult): `supabase-migration-v4-distance-tables.sql`
and `DISTANCE-SYSTEM-DEPLOY-REPORT.md`.

---

# Subsystem Map

```
┌────────────────────────────────────────────────────────────┐
│                       UI Layer                              │
│  (claim creation, claim list, reconciliation, rates page)   │
└──────────────────────────┬─────────────────────────────────┘
                           │
              ┌────────────┼─────────────┐
              ▼            ▼             ▼
       ┌───────────┐ ┌───────────┐ ┌───────────┐
       │ Claim     │ │ Rate      │ │ Station / │
       │ Engine    │ │ Snapshot  │ │ Travel    │
       │           │ │ System    │ │ Resolver  │
       └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
             │             │             │
             ▼             ▼             ▼
       ┌───────────────────────────────────────┐
       │      Entitlement Generator             │
       │ (operational claim → sub-claims)       │
       └─────────────────┬─────────────────────┘
                         ▼
       ┌───────────────────────────────────────┐
       │     Payment / Reconciliation Layer     │
       │ (Payslip vs Petty Cash, status, audit) │
       └───────────────────────────────────────┘
```

---

# Layered Concepts

The app deliberately separates three concepts. They MUST NOT be conflated.

1. Operational Claims — real-world incidents/events.
2. Generated Entitlements (Sub-Claims) — payable outcomes derived from claims.
3. Payment / Reconciliation State — payroll + petty-cash settlement.

See `ALLOWANCE_ENGINE_DATA_MODEL.md` for the full data-model rationale.

---

# Travel + Distance Architecture

Travel data sources are scoped per claim type. The scope rule is intentional
and not negotiable without re-planning.

- Recall — Google Maps (KM only; no reimbursement wiring yet).
- Standby — FRV Matrix only.
- Muster & Dismiss — FRV Matrix only.
- Manual entry — always available as an override.

The FRV Matrix Index sheet returns decimal hours, not kilometres. Any
hours-based entitlement using the matrix needs an explicit hours → payable
bridge in the entitlement generator. See `ENTITLEMENT_RULES.md` for the
canonical mapping.

There are no server-side API routes today. All distance/geocoding currently
flows browser → public service. Adding Google Maps server-side would
introduce the first server function and first server-only secret — flag any
such change as architecturally significant.

---

# Station Model

Stations are first-class records with both a numeric ID and a bare name. The
in-memory shape is `(station_id, bare_name)` taken from `fat.stations`.

`rostered_station_label` is write-only; it is NOT hydrated back into the
in-memory station record. Prefix-stripping logic at read time has been
removed and should not be reintroduced.

---

# User Profile Model

- One active rostered station.
- One home location context.
- Changes to rostered station affect future claims only; historical claims
  preserve their original station snapshots.

---

# Historical Record Philosophy

Historical claims are static accounting records. Rule changes, rate changes,
and bug fixes apply only to future claims. The system MUST NOT silently
rewrite history.

---

# Cross-References

- `ALLOWANCE_ENGINE_DATA_MODEL.md` — full operational + entitlement data model
- `DATABASE_ARCHITECTURE.md` — table layout for the future rebuild
- `CLAIM_TYPES.md` — catalogue of operational claim types
- `ENTITLEMENT_RULES.md` — entitlement generation rules
- `PAYMENT_RECONCILIATION.md` — payment + reconciliation behaviour

---

# TODO

- [ ] Add architecture diagram for the entitlement generator's rule pipeline.
- [ ] Document the Rates page's versioning model (rate snapshots vs rate
      definitions).
- [ ] Document how FRV matrix versions are pinned per claim.
- [ ] Document the Supabase + auth boundary (anon vs authenticated user).
- [ ] Document the offline / cache behaviour, if any.
- [ ] Document the shared-claim future architecture (independent draft
      copies; no ongoing sync).

---

# Future Architecture Guidance

Direction of travel:

- Operational-event layer, entitlement layer, and reconciliation layer should
  continue to separate, not merge.
- Payslip ingestion (screenshot + PDF) should land as a discrete subsystem
  feeding the reconciliation layer, not the claim engine.
- Calculation transparency (rule triggered, formula used, rate snapshot,
  override history) should be queryable per entitlement.
- Priority order for new design decisions: Automation → Correctness →
  Flexibility → Simplicity.
