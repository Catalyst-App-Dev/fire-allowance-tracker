# ALLOWANCE ENGINE DATA MODEL

Version: v1.0  
Status: Draft  
App: Fire Allowance Tracker

---

# Purpose

Defines the canonical operational, entitlement, payment, and persistence model for the Fire Allowance Tracker app.

This document is the authoritative reference for:
- claim architecture
- entitlement generation
- payment tracking
- reconciliation
- historical record behavior
- future schema evolution

---

# Core Architectural Principle

The app models:

1. Operational Claims
2. Generated Entitlements (Sub-Claims)
3. Payment/Reconciliation State

These are separate concepts.

Operational claims are NOT the same thing as financial entitlements.

Example:

Operational Claim:
- Recall

Generated Entitlements:
- Large Meal Allowance
- Travel Allowance
- Excess Travel
- Relieving Allowance

---

# Primary User Workflow

The app primarily functions as:

- a financial allowance tracker
- a payroll verification tool
- an operational event tracker

The app is NOT intended to be:
- an official payroll system
- an official FRV record system

It is a semi-official working-record system used for:
- tracking
- reconciliation
- verification
- auditing
- correction

---

# Core Entity Model

---

# 1. Operational Claims

Operational claims represent:
- real operational incidents/events
- user-created allowance events

Operational claims are standalone records.

Examples:
- Recall
- Retain
- Standby
- Muster & Dismiss
- Delayed Meal
- Spoilt Meal

Operational claims may occur:
- independently
- on the same day
- during overlapping operational periods

Operational claims remain separate records even when related.

---

# Operational Claim Requirements

Every operational claim should contain:

- unique ID
- claim type
- claim date
- rostered station snapshot
- generated date
- editable notes
- source calculation mode
- claim status
- generated entitlements
- manual override indicators

---

# Claim Philosophy

If the user operationally thinks of something as a different event type, the system should model it as a different operational claim.

Operational claims should NOT be merged together merely because:
- they share rates
- they share calculations
- they share reimbursement pathways

---

# 2. Generated Entitlements (Sub-Claims)

Generated entitlements represent:
- payable outcomes
- reimbursement components
- payroll verification items

Generated entitlements are ALWAYS linked to a parent operational claim.

Examples:
- Small Meal Allowance
- Large Meal Allowance
- Excess Travel
- Relieving Allowance
- Standby&Dismi
- Muster&Dismis
- Maint Stn N/N

---

# Entitlement Generation Philosophy

Operational claims generate entitlements automatically based on:
- claim type
- shift context
- station relationships
- travel rules
- payment rules
- configured rates

Generated entitlements:
- are static snapshots
- preserve historical calculations
- do NOT automatically recalculate after creation

Future rule changes only affect:
- newly created claims

NOT:
- historical claims

---

# Entitlement Snapshot Requirements

Every generated entitlement should permanently store:

- entitlement type
- generated amount
- generated hours
- source operational claim
- rule explanation
- calculation explanation
- rate snapshot
- rate version
- generated timestamp
- payment state
- manual override status
- edited values
- edited notes

---

# Manual Editing Philosophy

Generated entitlements are editable.

Users may:
- manually override values
- manually correct calculations
- manually mark payment states

The system should preserve:
- original generated values
- edited values
- explanation notes where possible

---

# 3. Rate System

The Rates page is the canonical source of configurable allowance values.

Examples:
- Small Meal Allowance
- Large Meal Allowance
- Travel Rate ($/km)
- Standby Hours
- Muster & Dismiss Hours

---

# Rate Philosophy

Rates:
- are configurable
- change over time
- should support future EBA updates

New claims use:
- current active rates

Historical claims preserve:
- original rate snapshots

---

# Example Rate Structure

Examples:

- Small Meal Allowance = $10.90
- Large Meal Allowance = $20.55
- Travel Rate = $1.20/km
- Standby Hours = 0.5
- Muster & Dismiss Hours = 1.0

---

# 4. Station Data Model

Stations are structured records.

Station records should contain:

- station number
- station name
- district
- street address
- distance matrix
- travel-time matrix

---

# Distance / Travel Sources

Claim creation should support:

- FRV Matrix
- Google Maps
- Manual Entry

---

# Matrix Philosophy

The station matrix is a core calculation engine component.

The matrix may provide:

- station-to-station distance
- station-to-station travel time
- home-to-station distance
- home-to-station travel time

Travel times may use:
- 0.25-hour increments

---

# 5. User Profile Model

Users have:

- one active rostered station
- one home location context

Changes to rostered station should:
- affect future claims only

Historical claims preserve:
- historical station snapshots

---

# 6. Claim Status Philosophy

Operational claims and generated entitlements have separate statuses.

---

# Petty Cash Statuses

- Outstanding
- Claimed

---

# Payslip Statuses

- Pending
- Paid

---

# Payment Verification Philosophy

The app should eventually support:

- payslip screenshot verification
- payslip PDF import
- automatic pending-item matching

Manual verification must also remain available.

Users should be able to:
- manually mark claims paid
- note discrepancies
- note incorrect payments

---

# 7. Duplicate Detection

The system should:
- warn about likely duplicates
- NOT hard-block duplicate creation

---

# 8. Shared Claims

Future architecture may support:
- sharing a claim draft with another user

Shared claim behavior:
- creates independent draft copies
- copied claims become fully independent
- no ongoing synchronization exists

---

# 9. Historical Record Philosophy

Historical claims are static accounting records.

Historical claims should:
- preserve original calculations
- preserve original rates
- preserve original generated entitlements

Rule-engine bugs discovered later should NOT:
- silently rewrite history

---

# 10. Calculation Transparency

Users should eventually be able to inspect:

- rule triggered
- formula used
- generated explanation
- rate snapshot
- source operational claim
- override history

for every entitlement.

---

# 11. Architectural Direction

The system should evolve toward:

- operational-event separation
- entitlement-layer separation
- reconciliation-layer separation

The app should avoid conflating:
- operational incidents
- payroll outcomes
- reimbursement tracking
- accounting records

into a single abstraction.

---

# Long-Term Direction

Priority order:

1. Automation
2. Correctness
3. Flexibility
4. Simplicity

The system should optimize for:
- future automation
- payroll verification
- auditability
- entitlement transparency
- maintainability