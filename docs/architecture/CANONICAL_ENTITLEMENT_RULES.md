<!-- Durable repository copy of the operator-approved WORK-173 rule specification
     (Linear WORK-173 document "Recall, Retain, Spoilt Meal and Delayed Meal rule
     specification (v0.2, approved)", ChatGPT PROMPT #15, 2026-10-05).
     Implemented by lib/fat/engine/generators/{recall,retain,spoiltMeal,delayedMeal}.js;
     worked examples are tests in __tests__/work173-generators.test.mjs. -->

# Canonical Recall, Retain, Spoilt Meal and Delayed Meal rule specification (v0.2, operator-approved)

**Status:** **APPROVED** by the operator through ChatGPT PROMPT #15 (2026-10-05). This satisfies the WORK-173 Acceptance gate "written rule spec per type, with sources, approved before code".
- **One edge is deliberately left fail-closed:** a day recall commencing at exactly 10:00 (see § 6). It does not block implementation.
- **Supersedes v0.1.** v0.1 is kept only as history in this document's revision history; its D1, D2, D3 and D7 are now source-settled, and its E-1 evidence request is answered.

**Governance:** Governance v2 resolved from `Tinnaz45/governance-system@main` `3aca935`. Projected modelHash `sha256:2e0dbf5c8ff8a3ff3022ec09d29206deabe882ae1659b17133907f01e220a20f`.
**Repository baseline:** `fire-allowance-tracker@dev` `a4cf1a6`.
**Compatible with:** WORK-170 (SB/M&D Excess Travel, D3), WORK-172 (`RATE_RULE_MODEL.md`) and WORK-246 (estimate convention `fat.overtime_estimate.cents_base.v1`).

---

## 0. Evidence

**Authoritative.** FRV EBA 2020 (Project copy, Division A), read verbatim by the operator / ChatGPT. PROMPT #15 corrects the v0.1 finding that the source was unavailable: that was a limit of the Drive extraction tool, not of the source.

| Clause | Content |
|---|---|
| **128.1** | Overtime beyond the rostered shift is paid at **double time**, calculated to the **nearest quarter hour**. |
| **128.2** | Recall: **minimum 4 h at double time**. The member need not work the full 4 h if the recalled job finishes earlier. |
| **128.4** | A recalled employee is paid **travelling time at ordinary rates** (**time and one half on Sundays and public holidays**), **plus mileage** for the distance travelled **from home to work and return**. |
| **128.5** | Retained on duty at the conclusion of a rostered shift for **60 minutes or more** → **minimum 4 h at double time**. |
| **128.7** | All recall and retention provisions apply **regardless of whether notice was provided**. |
| **127.1–127.4** | **127.1** a paid one-hour meal break each shift, the employee remaining on duty. **127.2** subject to operational requirements, meal breaks are at regular times and commence within 5 h of commencing duty. **127.3** continuous fire duty of 3 h or more → a paid 30-minute refreshment break. **127.4** overtime → a paid 20-minute rest after each 4 h worked if work continues. **No fixed clock-time meal windows** are established. |
| **85.6.1 / 85.6.8** | A meal allowance, where specified, is the Schedule 4 amount. |
| **85.6.2** | Overtime of 2 h or more before or after a rostered shift → a meal allowance for every meal, unless the employer provides the meal. |
| **85.6.3** | **Recall.** **(a)** Day duty: starts **before 10:00** and continues **more than 2 h** → **2** meal allowances; starts **after 10:00** and continues **more than 3 h** → **1**. **(b)** Night duty: starts **before 20:00** and continues **more than 2 h** → **1**. |
| **85.6.4** | **Retain** (within 128.5): **1** meal allowance; if retention **exceeds 2 h**, a further one; then one more **at the end of each additional 2 h period**. |
| **85.6.5** | Overtime of **more than 2 h** before or after a rostered shift → a meal allowance for each meal. |
| **85.6.6** | **Delayed meal:** the normal meal break is delayed **more than 30 minutes**, **without 2 h prior notice**, other than for the 85.6.7 reason → a meal allowance. |
| **85.6.7** | A fire call, salvage or watching duty of **3 h or more** that includes a normal meal break → a meal allowance. |
| **85.7.1** | A meal **interrupted** because of **response to an emergency call** → **Spoilt Meal Allowance** (Schedule 4). |
| **85.8.9** | Retention after a **night shift** that was **interrupted by a fire call, incident or fire duty** → a travel allowance covering **reasonable travelling time to the residence** after the retention. |
| **85.8.10** | Recall to a work location **different from the rostered station** → **Relieving Allowance**, **per shift**. |
| **Schedule 4** (original Part A) | Meal $17.83; Motor Vehicle / Mileage $1.31/km; Relieving $30.52; Spoilt Meal $17.83. These are historical values, superseded by date. |

**Authoritative, FWC.** PR765587 Division A, from 2023-06-17:
- Meal $20.53;
- Spoilt Meal $20.52;
- Mileage $1.50/km;
- Relieving $35.11.

The 2021-01-01 variation values seeded by WORK-172 are Meal $18.75, Spoilt Meal $18.74 and Mileage $1.37.

**Reconciliation only (never entitlement).** LFF payslip 21.2025 recall:
- Callback-Ops 12.25 h $1,237.53;
- Excess Travel 2.50 h $126.28;
- Relieving All 1.00 $35.11.

Retain: Maint Stn N/N 4.00 h $404.09; travel home "Excess Travel" 1.00 h / 1.25 h; "Fire Call" 0.75 h $75.77.

**Non-authoritative.** The operator workbook ($10.90 / $20.55 meals, $1.20/km, 12:00–13:00 / 18:30–19:30 meal windows) and the MFB 2010 lineage. Neither is used for any entitlement value or condition.

---

## 1. Shared contract

### 1.1 Estimate (WORK-246, unchanged)
```
estimate = round_half_up( hours × round_half_up( BasePayWeekly[classification on claim date] × 0.9093 ÷ 36 , 2 ) × multiplier , 2 )
```
- This is the FAT best-fit estimate convention, not FRV payroll's method.
- Generators call `ctx.overtimeLookup(claim_date, multiplierCode)` and freeze the returned `overtimeSnapshot()`, plus `{hours, estimate}`, in `rate_snapshot`.
- `ok:false` → hours only, with `estimate: null` and the reason.
- There is no hard-coded $50.51 / $101.02. Accepted residuals are not fitted away.

### 1.2 Hours-first and dollars-first
- **Time entitlements** (recall overtime, recall travel time, retain overtime, retain travel home): `unit = 'hours'`, `generated_amount = NULL`. The estimate lives only in the snapshot.
- **Allowances and reimbursements** (meals, Relieving, mileage): `unit = 'dollars'`, `generated_amount` = the exact versioned industrial amount.

### 1.3 Quarter-hour rounding (`q`)
- Under 128.1, worked overtime is calculated to the **nearest** quarter hour: `q(m) = round_half_up(m / 15) × 0.25 h`, where m is minutes. An exact 7.5-minute remainder rounds up.
- **FAT convention:** travelling time (128.4, 85.8.9) is recorded in minutes and expressed in the same quarter-hour unit, with the same nearest rounding. This is a FAT expression of the time in payslip units, not quoted clause wording.

### 1.4 Multipliers
| Code | Value | Use |
|---|---|---|
| `double_time_multiplier` | 2 | exists; 128.1 / 128.2 / 128.5 |
| **`single_time_multiplier`** | 1 | **new.** 128.4 / 85.8.9 / 85.8.1 / 85.8.4 "ordinary rates" |
| **`time_and_half_multiplier`** | 1.5 | **new.** 128.4 recall travel on Sundays / public holidays |

### 1.5 Fail closed
- A missing or ambiguous required fact suppresses **only** the dependent entitlement: no row, never a $0 row (D9d / G12).
- No condition is added beyond the clause text.

### 1.6 Local time
- Clock comparisons (10:00, 20:00) use **Australia/Melbourne** local time of the stored `timestamptz`.
- Durations are measured on absolute time.

### 1.7 Payment routes
- **`payslip`:** recall overtime, recall travel time, Relieving, retain overtime, retain travel home.
- **`petty_cash`:** meals and mileage.

---

## 2. RECALL (RC) — generator `recall.js`

| Entitlement | Trigger | Quantity | Rate / rule | Route |
|---|---|---|---|---|
| `recall_overtime` | off-duty member recalled (128.2) | `max(4.0, q(recall_end_at − recall_start_at))` h | `recall.overtime.v1`; `overtimeLookup(date, double_time_multiplier)` | payslip |
| `recall_travel_time` | **every** recall (128.4; no further-from-home gate) | `q(recall_travel_minutes)` h: the actual home → recall work location → home trip | `recall.travel_time.v1`; `overtimeLookup(date, recall_travel_sunday_or_ph ? time_and_half_multiplier : single_time_multiplier)` | payslip |
| `recall_mileage` | every recall (128.4) | `round_half_up(travel_distance_km × travel_per_km, 2)` $, where `travel_distance_km` is the actual home → recall work location → home distance | `recall.mileage.v1`; `travel_per_km` version | petty_cash |
| `relieving_allowance` | recall to a work location **different from the rostered station** (85.8.10) | 1 per recall shift × `relieving_allowance` | `recall.relieving.v1` | payslip |
| `recall_meal` × n | 85.6.3 | n per § 2.1 | `meal.recall.v1`; `meal_allowance` | petty_cash |

**Fail closed.**
- No overtime row without start and end.
- No travel row without `recall_travel_minutes` (and none if Sunday / public holiday is NULL).
- No mileage row without `travel_distance_km`.
- No Relieving row without `recall_station_id` or the rostered station.
- No meal row without `recall_duty`, start or end (or per § 2.1).

**Not copied.** The SB/M&D radius-band rule (85.8.1 / 85.8.4) is **not** used. Excess Travel is not a separate recall entitlement: recall travel is fully `recall_travel_time` plus `recall_mileage`.

### 2.1 Recall meals (85.6.3)
`recall_duty` is an explicit fact (`day` | `night`), never inferred from the clock. With start time `t` (local) and duration `D`:
- **Day:**
  - `t` before 10:00:00 and D > 2 h → **2**;
  - `t` after 10:00:00 and D > 3 h → **1**;
  - **`t` exactly 10:00:00 → no meal row, `needs_operator_decision` (§ 6)**;
  - otherwise 0.
- **Night:** `t` before 20:00 **on the duty's evening** and D > 2 h → **1**. Exactly 20:00 → 0.
  - **Modelling interpretation, not clause text:** night-duty commencements between 00:00 and 11:59 are early-morning starts. They are not treated as "before 20:00".
  - They fail closed (no meal row, `needs_operator_decision`) rather than being read literally.

---

## 3. RETAIN (RT) — generator `retain.js`

`retain_start_at` is the conclusion of the rostered shift; `retain_end_at` is release. D = end − start.

| Entitlement | Trigger | Quantity | Rate / rule | Route |
|---|---|---|---|---|
| `retain_overtime` (128.5) | D ≥ 60 min | `max(4.0, q(D))` h | `retain.overtime.v1`; double time | payslip |
| `retain_overtime` (128.1) | 0 < D < 60 min | `q(D)` h (ordinary 128.1 overtime) | `retain.overtime_short.v1`; double time | payslip |
| `retain_travel_home` | `retain_shift = 'night'` **and** `night_shift_interrupted = true` (fire call / incident / fire duty) (85.8.9) | `q(retain_travel_home_minutes)` h | `retain.travel_home.v1`; single time | payslip |
| `retain_meal` × n | 128.5 retention only (D ≥ 60 min) (85.6.4) | `n = 1 + (D > 2h ? 1 + floor((D − 2h) / 2h) : 0)` → 1st on qualifying; 2nd > 2 h; 3rd at 4 h; 4th at 6 h … | `meal.retain.v1`; `meal_allowance` | petty_cash |

**Notes.**
- Notice is irrelevant (128.7); there is no notice field.
- Retention of less than 60 min gets no 85.6.4 meal. The 85.6.2 / 85.6.5 overtime-meal rule is a separate Issue (§ 7).
- **Fail closed:**
  - no overtime row without start and end, or where end ≤ start;
  - no travel-home row unless shift is `night`, `night_shift_interrupted` is true and the minutes are present;
  - no meal row without start and end.

---

## 4. SPOILT MEAL (SM) — generator `spoiltMeal.js`

| Entitlement | Trigger (85.7.1) | Quantity | Rate / rule | Route |
|---|---|---|---|---|
| `spoilt_meal` | `meal_interrupted_at` is present (the meal had begun) **and** `emergency_response = true` | 1 × `spoilt_meal_allowance` | `meal.spoilt.v1` | petty_cash |

- **No added conditions.** No call-reference requirement and no clock window. `emergency_call_ref` is optional evidence, stored in the snapshot.
- A non-emergency interruption (`emergency_response = false`) gives no row. NULL gives no row (fail closed).

---

## 5. DELAYED MEAL (DM) — generator `delayedMeal.js`

| Entitlement | Trigger | Quantity | Rate / rule | Route |
|---|---|---|---|---|
| `delayed_meal` (85.6.6) | delay = `actual_meal_at − meal_window_start_at` **> 30 min** and `delay_notice_2h = false` and `delay_cause = 'other'` | 1 × `meal_allowance` | `meal.delayed.v1` | petty_cash |
| `delayed_meal` (85.6.7) | `delay_cause ∈ {fire_call, salvage, watching}` and `duty_end_at − duty_start_at` **≥ 3 h** and the duty interval overlaps the normal meal break `[meal_window_start_at, meal_window_end_at]` | 1 × `meal_allowance` | `meal.fire_call_3h.v1` | petty_cash |

- `meal_window_start_at` / `meal_window_end_at` are the member's **normal meal break as recorded on the claim** (127.2: regular times). No fixed clock time is assumed.
- Boundaries (source-settled): exactly 30 min → none; exactly 3 h → qualifies.
- A fire-call cause of less than 3 h → none (85.6.6 excludes the 85.6.7 reason).
- Missing facts → none.

### 5.1 Spoilt vs Delayed; meals during Recall / Retain
- **Semantic modelling interpretation, not quoted EBA text:**
  - a meal that **has begun** and is interrupted by an emergency response is **Spoilt**;
  - a break that **has not begun** and is instead delayed is **Delayed**.
  - The generators encode this by their required facts. The EBA is **not** claimed to state universal mutual exclusivity.
- **Recall / Retain:** Spoilt and Delayed are **not** blanket-excluded during recall or retain. The 85.6.3 / 85.6.4 recall and retain allowances are per-period allowances, not tied to a particular meal event.
  - The only known double-count risk is the **same meal event** claimed twice (for example, two DM/SM claims for one break, or one break claimed as both). Cross-claim detection of the same event is a claim-writer validation.
  - It **fails closed (rejects the second claim for the same break)**. It belongs in the write path, not in the per-claim pure generators.

---

## 6. Exactly 10:00 (the only open edge)
- 85.6.3 says "before 10:00" and "after 10:00". A day recall commencing at exactly 10:00:00 is not expressly covered.
- **Treatment:** no recall meal row, with explanation "85.6.3 does not cover a 10:00 start — operator decision required". Every other recall entitlement still generates.
- This is the only unresolved item. It does **not** block implementation.
- The night-recall early-morning interpretation in § 2.1 fails closed the same way.

## 7. Routing of related items
- **Relieving Allowance (85.8.10):** **inside** the Recall generator (§ 2). Rate `relieving_allowance`: $35.11 from 2023-06-17 (PR765587).
  - The 2020 Schedule 4 $30.52 is recorded here as history but **not seeded**. The 2021-01-01 variation value of that allowance is unknown, so a $30.52 version would misstate the 2021–2023 window.
  - A pre-2023-06-17 claim therefore fails closed (no Relieving row) until that value is evidenced. FAT holds no claims before 2026-05-29.
- **85.6.2 / 85.6.5 general overtime meal:** a separate Workshop FAT Issue. It is not one of the four types.
- **Standby night meal:** unchanged in WORK-173. The SB generator emits workbook `small_meal` with no industrial clause found, so a separate follow-up Issue is opened.
- **Prototype rounding:** the canonical generators use nearest-quarter (128.1). The prototype `calcRetainHours` rounds up; its correction goes to a separate Issue.

## 8. Generator input contract: new claim-fact columns (WORK-173 migration, DEV first)
The columns are generator inputs owned by WORK-173. WORK-189 (C1) scope explicitly excludes generators; C1 and C2 must carry these columns.

| Table | Existing columns used | New columns |
|---|---|---|
| `recall_details` | `recall_station_id`, `recall_start_at`, `recall_end_at`, `travel_distance_km` (redefined: actual home → recall location → home km) | `recall_duty text check in ('day','night')`, `recall_travel_minutes numeric check ≥ 0`, `recall_travel_sunday_or_ph boolean` |
| `retain_details` | `retain_start_at` (shift conclusion), `retain_end_at` (release) | `retain_shift text check in ('day','night')`, `night_shift_interrupted boolean`, `retain_travel_home_minutes numeric check ≥ 0` |
| `spoilt_meal_details` | `meal_provisioned_at`, `spoilt_reason` | `meal_interrupted_at timestamptz`, `emergency_response boolean`, `emergency_call_ref text` |
| `delayed_meal_details` | `meal_window_start_at`, `meal_window_end_at`, `actual_meal_at` | `delay_notice_2h boolean`, `delay_cause text check in ('other','fire_call','salvage','watching')`, `duty_start_at timestamptz`, `duty_end_at timestamptz` |

All columns are nullable, additive and non-destructive. RLS and grants are unchanged (column-level additions inherit the table policies).

## 9. Rate seeds (same migration)
- `single_time_multiplier` 1 (2020-07-01, `industrial_instrument`, EBA 128.4 / 85.8 "ordinary rates").
- `time_and_half_multiplier` 1.5 (2020-07-01, `industrial_instrument`, EBA 128.4 Sundays / public holidays).
- `relieving_allowance` 35.11 (2023-06-17, `fwc_order`, PR765587 Division A).
- No meal or km changes. WORK-173 generators never read `small_meal` / `large_meal`.

## 10. Worked examples (LFF base $50.51; SO $57.10)

| # | Facts | Result |
|---|---|---|
| R1 | Night recall 10/11/2025, 19:50–08:00, R 45 → 44; travel 150 min; 146 km | OT 12.25 h ×2 (est $1,237.50; payslip $1,237.53). Travel 2.50 h ×1 (est $126.28 ✓). Mileage 146 × $1.50 = $219.00. Relieving $35.11 ✓. Meal 1 × $20.53 |
| R2 | Day, 10:05–18:00, same station | OT 8.0 h (est $808.16). Meal 1. No Relieving |
| R3 | Day, 07:30–09:00 | 4.0 h (minimum); meal 0 |
| R4 | Day, 08:00–10:30 | 4.0 h; meals 2 |
| R5 | Day, **10:00**–14:00 | 4.0 h; **no meal row (needs decision)** |
| R6 | Night, 20:00–23:00 | 4.0 h; meal 0 |
| R7 | Recall on a Sunday, travel 60 min | Travel 1.0 h, estimate at ×1.5 = $75.77 |
| R8 | No classification | hours rows with estimate null; dollars rows unaffected |
| T1 | Day retain 18:00–19:05 | 4.0 h (est $404.08; payslip $404.09); meal 1 |
| T2 | 18:00–20:10 | 4.0 h; meals 2 |
| T3 | 18:00–18:40 | 0.75 h (128.1; est $75.77 = payslip "Fire Call"); meal 0 |
| T4 | 18:00–22:00 | 4.0 h; meals 3 (at 4 h) |
| T5 | 18:00–22:55 | q(4 h 55 m) = 5.0 h (est $505.10); meals 3 |
| T6 | Night retain 08:00–09:40, night interrupted by fire call, travel home 60 min | 4.0 h; travel home 1.0 h (est $50.51 ✓); meal 1 |
| T7 | 18:00–18:07 | q(7 min) = 0.0 h → no overtime row; meal 0 |
| T8 | SO after promotion, 18:00–19:05 | 4.0 h (est $456.80) |
| S1 | Meal interrupted 12:35 by an emergency call | $20.52 (pre-2023-06-17 claim: $18.74) |
| S2 | Interrupted by a non-emergency | none |
| D1 | Break due 12:00, began 12:45, no notice, cause other | $20.53 |
| D2 | Delay exactly 30 min | none |
| D3 | Delay 60 min with 2 h notice | none |
| D4 | Fire call 11:30–14:30 (exactly 3 h) spanning the break | $20.53 (85.6.7) |
| D5 | Fire call 2.5 h delaying the break 70 min | none |

## 11. Rejected alternatives
- A further-from-home gate on recall travel (contradicts 128.4).
- The radius-band rule for recall travel (no source).
- Ceiling rounding (contradicts 128.1).
- Workbook meal values as entitlement.
- Collapsing Delayed onto Spoilt.
- A hard-coded hourly rate.
- A cosmetic $0 row.
- An estimate in `generated_amount`.
- Treating exactly 10:00 as "after".
- Call reference or clock windows as spoilt-meal conditions.
- Seeding $30.52 across 2021–2023.

## 12. Compatibility
- **WORK-170:** SB/M&D rules are untouched.
- **WORK-172 / 246:** snapshots and the estimate convention are reused.
- **CLAUDE.md § 7:**
  - hours-first, with no implicit hours → $;
  - historical amounts are never recalculated;
  - duplicate and over-allocation protections are unchanged (one row per allowance).
- **WORK-189:** these columns are added, and WORK-189 is notified to carry them.
