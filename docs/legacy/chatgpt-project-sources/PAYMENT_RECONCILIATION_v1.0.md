# PAYMENT RECONCILIATION

Version: v1.0
Status: Draft — initial scaffold
App: Fire Allowance Tracker
Last Updated: 2026-05-26

---

# Purpose

Canonical reference for how the Fire Allowance Tracker reconciles generated
entitlements against real-world payment outcomes — payslips and petty cash.

Related documents:

- Data model → `ALLOWANCE_ENGINE_DATA_MODEL.md`
- Claim type catalogue → `CLAIM_TYPES.md`
- Entitlement generation rules → `ENTITLEMENT_RULES.md`

---

# Reconciliation Model

The app tracks two independent payment streams. Each generated entitlement
is routed to one of them.

| Stream     | Description                                       | Statuses              |
|------------|---------------------------------------------------|-----------------------|
| Payslip    | Paid through FRV payroll on the regular cycle.    | Pending → Paid        |
| Petty Cash | Reimbursed via station petty-cash claim form.     | Outstanding → Claimed |

Operational claims and their generated entitlements have separate statuses.
The operational claim's lifecycle is independent of the entitlement's
payment lifecycle.

See `ALLOWANCE_ENGINE_DATA_MODEL.md § Claim Status Philosophy`.

---

# Payment Method Routing

Some claim types attach a `payment_method` to their auto-generated children
at creation; others do not.

| Claim Type        | Auto-Children Carry `payment_method`?    |
|-------------------|------------------------------------------|
| Recall            | No                                       |
| Retain            | No                                       |
| Standby           | Yes (per the 2026-05 spec)               |
| Muster & Dismiss  | TODO — confirm post-promotion behaviour. |
| Delayed Meal      | TODO                                     |
| Spoilt Meal       | TODO                                     |

This asymmetry is intentional. Standby's auto-children carry the payment
method because the split-entitlement structure (Excess Travel + Standby&Dismi
+ Small Meal) maps cleanly to specific streams; Recall/Retain auto-children
still don't.

---

# Reconciliation Workflows

## Manual Marking

Users can always:

- mark an entitlement as Paid / Claimed manually
- note discrepancies (e.g. underpayment, missing line)
- note incorrect payments

Manual marking is the always-available baseline. Automation augments it but
never removes it.

---

## Payslip Verification (Future)

Planned reconciliation surfaces:

- Payslip screenshot import → OCR-driven entitlement matching
- Payslip PDF import → structured-line entitlement matching
- Auto-mark Payslip-routed entitlements as Paid when matched
- Surface unmatched lines as discrepancies for user review

Manual override of every auto-match decision must remain available.

---

## Petty Cash Reconciliation

- Petty-cash claims are exported (CSV / form-ready text) from the
  reconciliation surface.
- Export uses the child-label utility so the `md` claimType label is
  rendered correctly (commit `506aa8a`).
- TODO: document the canonical export shape and headers.

---

# Status Lifecycle

```
Payslip stream:
   Pending  ──(matched / manual)──▶  Paid

Petty Cash stream:
   Outstanding  ──(manual / export submitted)──▶  Claimed
```

Transitions are one-way under normal use. A regression from a terminal
state (Paid → Pending, Claimed → Outstanding) should be possible but should
require explicit user action and leave an audit trail.

---

# Discrepancy Handling

When a payslip line does not match an expected entitlement:

- Do NOT silently auto-create a new entitlement.
- Surface the unmatched line for user review.
- Allow the user to:
  - link the line to an existing entitlement (with override notes)
  - mark the line as out-of-scope (not a tracked entitlement)
  - mark the line as a payroll error and capture a note

When an expected entitlement does not appear on a payslip:

- Keep the entitlement in `Pending` past the expected pay cycle.
- Surface it as overdue for follow-up.

---

# Audit Trail Requirements

Reconciliation actions must record:

- timestamp
- prior status
- new status
- reason / note (free text)
- whether the action was manual or automated

History is append-only. Reconciliation actions never overwrite an
entitlement's snapshot (rate, formula, generated value).

---

# TODO

- [ ] Document the payslip ingestion subsystem (screenshot OCR + PDF
      parsing) once it is designed.
- [ ] Document the matching heuristics for payslip lines → entitlements.
- [ ] Document the canonical petty-cash export format.
- [ ] Document the overdue-detection heuristic (how late is "late" per
      claim type / stream).
- [ ] Document the discrepancy-resolution UI states.
- [ ] Document audit-log retention and visibility.

---

# Future Architecture Guidance

- Reconciliation is a separate layer from claim creation and entitlement
  generation; it should not reach back into the engine to mutate snapshots.
- Payslip ingestion should be a discrete subsystem with its own data model
  (raw payslip → parsed lines → match candidates → confirmed matches).
- Discrepancy tracking should be queryable historically — "what did this
  pay cycle look like?" is a first-class question.
- Reconciliation status changes should never alter rate snapshots or
  regenerate entitlements.
