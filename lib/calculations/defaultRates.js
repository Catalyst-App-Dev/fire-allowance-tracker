// ─── Default Allowance Rates (offline fallback only) ──────────────────────────
// Authority for every rate is the GLOBAL versioned rate/rule model in
// fat.rates / fat.rate_versions (WORK-172; docs/architecture/RATE_RULE_MODEL.md),
// resolved per claim date by RatesContext.ratesForDate(). Per-user
// fat.user_rates is retired as a rate source (kept until the C7/Neon cutover).
//
// These values are used ONLY when the rate catalog cannot be loaded, so the app
// stays usable offline. They mirror the catalog's current versions and must
// never be treated as the source of a rate.
//
// ── Rate change history ────────────────────────────────────────────────────────
// 2025-06  Initial values set (ATO-sourced km rate, estimated meal rates)
// 2025-06  kilometreRate 0.99 → 1.20 (FRV Allowances workbook)
// 2026-05  largeMealAllowance 21.80 → 20.55; derived meals simplified
// 2026-10  WORK-172: kilometreRate 1.20 → 1.50. $1.20 is a workbook/tax value;
//          the industrial Motor Vehicle / Mileage Allowance (Division A) is
//          $1.50/km from the first pay period after 16 Jun 2023 (PR765587).
//          Meal values unchanged here: small/large meal mapping to the
//          industrial Meal Allowance codes is WORK-173. The retain overtime
//          constant (101.0225) is removed — overtime is a versioned,
//          classification-keyed rule.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RATES = {
  // ── Travel ────────────────────────────────────────────────────────────────
  // Mirror of fat.rate_versions travel_per_km (PR765587 Div A, from 17 Jun 2023).
  kilometreRate: 1.50, // $ per km

  // ── Meals ─────────────────────────────────────────────────────────────────
  // Mirror of fat.rate_versions small_meal / large_meal (workbook provenance;
  // industrial mapping pending WORK-173). Derived: double = small + large;
  // spoilt/delayed/standby night meal = small.
  smallMealAllowance: 10.90,
  largeMealAllowance: 20.55,

  // ── Recall ────────────────────────────────────────────────────────────────
  // Non-monetary recall thresholds. Not used in dollar calculations directly,
  // but reserved for future auto-entitlement logic.
  recallMinimumHours: 3,    // hours — minimum engagement on recall (UNCONFIRMED)
  recallMealieThreshold: 4, // hours — meal allowance threshold (UNCONFIRMED)

  // ── Retain (Maint Stn N/N) ──────────────────────────────────────────────────
  // Retain $ = generated_hours × overtime rule resolved for the claim date and
  // the member's classification (rates.overtime). No offline fallback: with no
  // catalog the retain $ estimate fails closed; hours are unaffected.

  // ── Rounding ──────────────────────────────────────────────────────────────
  // All monetary values are rounded to 2 decimal places.
  // See engine.js roundMoney() for implementation.
  decimalPlaces: 2,
}

// ─── Rate field metadata (read-only Rates view in Settings) ───────────────────
// Maps each prototype rate key to its global catalog code. Rates are no longer
// user-editable (WORK-172): the per-claim override is the only adjustment path.

export const RATE_FIELDS = [
  {
    key: 'kilometreRate',
    code: 'travel_per_km',
    label: 'Kilometre Rate',
    unit: '$/km',
    help: 'Motor Vehicle / Mileage Allowance (Division A), applied to recall and standby travel.',
  },
  {
    key: 'smallMealAllowance',
    code: 'small_meal',
    label: 'Small Meal Allowance',
    unit: '$',
    help: 'Also drives spoilt, delayed and standby night meal allowances. Workbook provenance — industrial mapping pending (WORK-173).',
  },
  {
    key: 'largeMealAllowance',
    code: 'large_meal',
    label: 'Large Meal Allowance',
    unit: '$',
    help: 'Flat rate (not 2× small meal). Workbook provenance — industrial mapping pending (WORK-173).',
  },
]
