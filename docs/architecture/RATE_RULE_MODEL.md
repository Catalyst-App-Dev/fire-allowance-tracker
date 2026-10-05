# Fire Allowance Tracker — Versioned Rate/Rule Model

> **Status:** architecture contract for rates, rules, snapshots and overrides (WORK-172, gap G11).
> **Migration:** [`supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql`](../../supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql)
> (rollback in `supabase/rollbacks/`).
> **Code:** [`lib/fat/rates/rateModel.js`](../../lib/fat/rates/rateModel.js) (pure lookup and arithmetic),
> [`lib/calculations/ratesForDate.js`](../../lib/calculations/ratesForDate.js) (prototype adapter),
> [`lib/fat/engine/context.js`](../../lib/fat/engine/context.js) (`ctx.overtimeLookup` for canonical generators).
> **Decision record:** Linear WORK-172 (design `e3f01997`, corrections `8516344a` / `c0f76c81`, operator decision D-172-1 `4f129331`);
> overtime estimate convention and payslip reconciliation: Linear **WORK-246** (investigation `31e2b7e9`, operator Option A `f8ce703b`, gate `bcc7537f`).
> WORK-246 supersedes the D-172-1 wording that called the cents-rounded base "payroll's rate boundary" with a "±$0.01 accepted" tolerance.

## 1. Principles

- Rates are **global**, **versioned** and **effective-dated**. They are never per-user. `fat.user_rates` is retired as a rate source (§ 7).
- Entitlements are **hours-first**. A dollar figure is a derived estimate from the applicable rule. There is no implicit hours→dollars conversion.
- A version is **immutable**. A correction is a new version, and a non-authoritative version is **withdrawn**, never deleted.
- Every version carries **provenance**:
  - `source_kind`: `industrial_instrument` | `fwc_order` | `payroll_reconciled` | `workbook`;
  - `source_ref`: the citation.
- Industrial instruments (the EBA and operative FWC orders) **outrank** the personal FRV Allowances workbook. Tax and accounting values are not entitlement values.
- Historical stored amounts are static records and are never recalculated.

## 2. Data model (portable PostgreSQL core)

| Object | Purpose |
|---|---|
| `fat.rates` | Rule/rate identity: `code`, `display_name`, `unit` (`dollars`, `dollars_per_km`, `hours`, `dollars_per_hour`, `dollars_per_week`, `multiplier`), `description`. |
| `fat.rate_versions` | One immutable row per version. Columns: `value numeric` (unconstrained precision), `effective_from`, `classification` (NULL = all), `source_kind`, `source_ref`, `withdrawn_at` / `withdrawn_reason`. Unique per live (`rate`, `classification`, `effective_from`). An append-only trigger allows only a one-way withdrawal. |
| `fat.frv_classification` (domain) | Closed set of Division A ranks: recruit, ff1–ff3, qff, sff, lff, slff, so, sso, cmdr_commencement / cmdr_12m / cmdr_24m, fscc, sfscc. |
| `fat.member_classifications` | Effective-dated classification history per member (`owner_id`, `classification`, `effective_from`, `source_ref`). Supports promotion. No row means overtime $ fails closed. |
| `fat.claim_entitlements.rate_version_id` / `rate_snapshot` | References and freezes the applied version(s). Immutable after generation, enforced by trigger. |
| `fat.entitlement_overrides` | Append-only override audit. |

**Lookup semantics.**
- `effective_from` is inclusive.
- A version applies until the next `effective_from` for the same (`rate`, `classification`). No `effective_to` is stored, so overlaps are impossible.
- Withdrawn versions are never selected.
- An exact classification match is preferred, else the NULL-classification version.
- If nothing applies, the result is **fail closed**: no estimate.

## 3. Overtime rule (`overtime.enterprise_rate.v1`) and the FAT estimate convention

The industrial rule (90.93 % of the enterprise rate, × the overtime multiplier) is turned into
dollars under an **operator-approved FAT best-fit estimate convention**
(`fat.overtime_estimate.cents_base.v1`, WORK-246 `f8ce703b`):

```
base     = round_half_up( BasePayWeekly[classification on claim date] × 0.9093 ÷ 36 , 2 )   -- $/h, single time
estimate = round_half_up( hours × base × multiplier , 2 )                                  -- estimated line
```

**This is a FAT estimate, not FRV payroll's formula.** FRV's internal payroll formula is not
known, and the EBA does not state a divisor. Every dollar figure derived from this rule is an
estimate, and every snapshot says so (`is_estimate`, `estimate_convention`, `evidence`).

| Component | Code | Value | Evidence class | Source |
|---|---|---|---|---|
| Weekly enterprise **Base Pay** | `enterprise_base_pay_weekly` (per classification) | LFF 1,999.60; SO 2,260.73; … | `fwc_order` | PR765587 Annexure A, Division A "Current Wage", in force since the 2.5 % variation wef 1 Jan 2021 ([2023] FWC 2020 [16]) |
| Overtime factor | `overtime_rate_factor` | 0.9093 | `industrial_instrument` | FRV EBA 2020: "In all cases when calculating overtime the rate to be used will be 90.93% of the enterprise rate" (inherited MFB/UFU 2010 cl 96.2) |
| Hourly divisor | `overtime_hourly_divisor` | 36 | **`payroll_reconciled`** (an approximation) | Operator decision D-172-1. **Not** stated in the EBA, and **not** derived from the 38/42-hour roster clause. The nearest simple divisor to payroll behaviour; it does not reproduce payslips exactly (WORK-246) |
| Double time | `double_time_multiplier` | 2 | `industrial_instrument` | EBA cl 128.1 (overtime), 128.2 (recall minimum 4 h), 128.5 (retained 60 min or more: minimum 4 h) |

**Base Pay rule.**
- Base Pay is the classification **Base Pay only**.
- Every separately itemised allowance is excluded: EMR, Cert IV, Academy/RCRS/Instructor, Day Duty, meal, travel, mileage, retain, M&D, Excess Travel and reimbursements. These are different rate codes and are never read by the rule.

**Roster context.** The EBA sets 38 ordinary hours, rostered 42, with 2 h paid as overtime and 2 h accrued leave. This is context only; it is not the divisor's source.

**Evidence classes (kept distinct).**

| Part | Class |
|---|---|
| 90.93 % factor; overtime multiplier (×2) | industrial instrument (authoritative) |
| Weekly Base Pay per classification | FWC order (authoritative) |
| ÷36 | payroll-reconciled approximation / inference |
| Rounding the single-time hourly base to cents | **FAT estimate convention**, chosen by the operator because it best fits the available payslips without inventing an unsupported hidden rate or divisor |

**Rounding contract.**
- Components are stored exactly, and arithmetic is exact (BigInt rationals; no floating point).
- The single-time hourly base is rounded half-up to cents. This is the **FAT convention**, not a published FRV rate and not FRV payroll's method.
- Each estimated line is rounded half-up at cents.
- The unrounded base (`base_hourly_exact`) is snapshotted alongside.

**What the payslips show (payroll-reconciled inference, WORK-246 `31e2b7e9`).** Across all
28 applicable Base-Pay-basis lines on 19 LFF payslips, every single- and double-time line fits
one hourly rate of ≈ $50.5112–50.5116 (held to at least 4 dp), rounded once per line.
FRV payroll therefore does **not** use a cents-rounded $50.51 base. No simple formula on
$1,999.60 × 0.9093 ÷ 36 reproduces every line; this convention is the best fit.

**Accepted estimate error (LFF payslips).** These residuals are estimate error. They are
deliberately **not** fitted away (no hidden rate or divisor).

| Line | Estimate | Payslip | Difference |
|---|---|---|---|
| 4 h double time (Maint Stn, Fire Call; 11 lines) | $404.08 | $404.09 | −$0.01 each |
| 12.25 h double time (Callback-Ops) | $1,237.50 | $1,237.53 | −$0.03 |
| 0.25 / 0.5 / 0.75 h double time; 0.25–2.5 h single-time Excess Travel (16 lines) | as payslip | | 0 |
| **All 28 lines** | 15 exact | | **net −$0.15** |

The matrix is a test (`__tests__/rate-model.test.mjs`).

**Classification and promotion.**
- The classification is resolved **on the claim date** from `fat.member_classifications`
  (latest `effective_from` ≤ claim date, inclusive). Then the Base Pay version for that
  classification and date is resolved.
- A promotion is recorded in `/settings` as a new effective-dated row. Claims before its
  effective date keep the prior classification and rate; claims on or after it use the new ones.
- Saved claims never change: they store their amount and the frozen snapshot.
- There is no hard-coded rate. LFF $50.51 is only what the convention yields for LFF Base Pay $1,999.60.

## 4. Seeded version history

| Code | Versions |
|---|---|
| `enterprise_base_pay_weekly` | 15 Division A classifications, effective 2021-01-01 |
| `overtime_rate_factor` / `overtime_hourly_divisor` / `double_time_multiplier` | 0.9093 / 36 / 2, effective 2020-07-01 (FRV commencement) |
| `travel_per_km` (Motor Vehicle / Mileage, Div A) | 1.37 from 2021-01-01, then **1.50 from 2023-06-17**. The workbook $1.20 (2025-06-01) is **withdrawn** |
| `meal_allowance` (Div A) | 18.75 from 2021-01-01, then 20.53 from 2023-06-17 |
| `spoilt_meal_allowance` (Div A) | 18.74 from 2021-01-01, then 20.52 from 2023-06-17 |
| `small_meal` / `large_meal` | 10.90 / 20.55 from 2025-06-01, `workbook` provenance. **WORK-173 canonical generators never read them**: recall/retain/delayed meals use `meal_allowance` and spoilt meals `spoilt_meal_allowance` (see `CANONICAL_ENTITLEMENT_RULES.md`). Still read by the SB night meal (WORK-249) and the prototype path (WORK-250) |
| `standby_hours` / `md_hours` | 0.5 / 1.0 h, `industrial_instrument` (EBA cl 85.8.4(b) / 85.8.1; WORK-170) |
| `single_time_multiplier` / `time_and_half_multiplier` | 1 / 1.5 from 2020-07-01, `industrial_instrument` — "ordinary rates" (cl 128.4, 85.8.9, 85.8.1/85.8.4) and Sunday/public-holiday recall travel (cl 128.4). WORK-173 |
| `relieving_allowance` (Div A) | **35.11 from 2023-06-17** (PR765587). The 2020 Schedule 4 $30.52 is **not** seeded because the 2021-01-01 variation value is not evidenced; earlier dates fail closed. WORK-173 |

PR765587 makes the new rates payable "from the first pay period after 16 June 2023". The effective date of 2023-06-17 is the date-level lower bound of that pay period. FAT holds no claims before 2026-05-29, so the up-to-a-week approximation affects nothing stored.

## 5. Snapshot contract (consumed by WORK-173 and WORK-189)

An overtime-derived entitlement or prototype row freezes `overtimeSnapshot()`:

```json
{ "rule_id": "overtime.enterprise_rate.v1", "is_estimate": true,
  "estimate_convention": { "id": "fat.overtime_estimate.cents_base.v1", "kind": "fat_estimate_convention",
                           "decision_ref": "Linear WORK-246 comment f8ce703b (operator Option A, 2026-10-05)",
                           "formula": "…", "note": "Best fit to available FRV payslips; not FRV payroll's published or internal formula. …" },
  "classification": "lff",
  "base_hourly_exact": "50.506563333333", "base_hourly": "50.51",
  "multiplier": "2", "hourly": "101.0200",
  "formula": "round_half_up(hours × round_half_up(base_pay_weekly × factor ÷ divisor, 2) × multiplier, 2)",
  "evidence": { "factor": "industrial_instrument", "multiplier": "industrial_instrument",
                "base_pay_weekly": "fwc_order", "divisor": "payroll_reconciled_approximation",
                "base_cents_rounding": "fat_estimate_convention",
                "versions": { "basePayWeekly": "fwc_order", "factor": "industrial_instrument",
                              "divisor": "payroll_reconciled", "multiplier": "industrial_instrument" } },
  "components": { "basePayWeekly": {"rate_version_id": "…", "code": "…", "value": "1999.6", "effective_from": "2021-01-01", "classification": "lff", "source_kind": "fwc_order"},
                  "factor": {…}, "divisor": {…}, "multiplier": {…} } }
```

- **Canonical** `claim_entitlements`: hours entitlements keep `generated_amount = NULL`, `rate_version_id` → the Base Pay version, and `rate_snapshot` = the object above.
- **Prototype** `fat.retain`: `retain_rate_used` (now unconstrained `numeric`) = applied double-time $/h, and `calculation_inputs.retainRate` = the snapshot.
- **Canonical generators** use `ctx.overtimeLookup(claimDate[, multiplierCode])`. `ok:false` means emit hours only.

## 6. Audited per-claim override

- An override is made on one entitlement: `edited_hours` and/or `edited_amount`, with a **mandatory reason** in `edited_note` and optional provenance in `edited_source`.
- The BEFORE UPDATE trigger `claim_entitlements_override_audit`:
  - rejects an override without a reason;
  - rejects any change to generation fields (`generated_*`, `rule_*`, `rate_id`, `rate_version_id`, `rate_snapshot`, `generated_at`);
  - sets `manual_override`;
  - appends one `fat.entitlement_overrides` row per changed field: generated, previous and new value, reason, source, actor and time.
- Actor comes from `fat.current_actor()`.
- Overrides never touch `rates` or `rate_versions`. `authenticated` has no write privilege on either, and has only SELECT on the audit table.

## 7. `fat.user_rates` disposition

- **Readers removed.** `RatesContext` and `/settings` no longer read or write `user_rates`. `/settings` is a read-only view of today's versions with provenance, plus classification history.
- **Column audit before retirement:**
  - read until now: `kilometre_rate`, `small_meal_allowance`, `large_meal_allowance`;
  - orphaned: `retain_hourly_rate`, `spoilt_meal_allowance`, `delayed_meal_allowance`, `double_meal_allowance`, `overnight_allowance`, `standby_night_meal_allowance`.
- **Table and data retained** (DEV 1 row; PROD 0 rows). Drop with the prototype objects at cutover step C7, or by **not carrying the table to Neon** (GOV-481).

## 8. Neon portability (GOV-481 handoff)

| Element | Class |
|---|---|
| `rates`, `rate_versions`, `frv_classification`, `member_classifications`, `entitlement_overrides`, `edited_source`, both triggers, the lookup and rounding semantics, the seed history (§ 4) | **Portable core**: carry as-is |
| RLS policies (`auth.uid() = owner_id`, `auth.role()`), `fat.current_actor()` body (`auth.uid()`), grants to `authenticated` / `service_role`, PostgREST exposure | **Supabase-specific**: replace with server-session identity and the Neon access model |
| `fat.retain.retain_rate_used` widening; `fat.user_rates` | **Temporary compatibility**: retire with the prototype tables |

What the Neon migration must preserve:
- `member_classifications` rows;
- every `rate_versions` row, including withdrawn ones and their ids, because snapshots reference them;
- `entitlement_overrides` rows.

It must also re-establish:
- append-only behaviour on `rate_versions`;
- immutability of entitlement generation fields;
- the reason-required override audit;
- read-only rate reference data for end users.

## 9. Deployment ordering

The application code needs this migration in the target database. Without it:
- the rate catalog fails to load;
- the app falls back to `DEFAULT_RATES`;
- retain $ estimates fail closed (hours unaffected);
- the canonical bridge stays non-fatal.

Therefore **PROD must receive this migration (separately approved) before a `dev → main` promotion carrying this code**, unless that degraded behaviour is explicitly accepted, or PROD moves to Neon first.
