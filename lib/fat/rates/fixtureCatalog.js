// ─── Rate catalog fixture (tests + validation scenarios only) ────────────────
// Mirrors the WORK-172 seed in
// supabase/migrations/20261005060000_fat_versioned_rate_rule_model.sql so pure
// tests can exercise the versioned model without a database. Never imported by
// runtime code paths — the database catalog is the only rate authority.

const rates = [
  { id: 'r-base',   code: 'enterprise_base_pay_weekly', unit: 'dollars_per_week' },
  { id: 'r-factor', code: 'overtime_rate_factor',       unit: 'multiplier' },
  { id: 'r-div',    code: 'overtime_hourly_divisor',    unit: 'hours' },
  { id: 'r-x2',     code: 'double_time_multiplier',     unit: 'multiplier' },
  { id: 'r-km',     code: 'travel_per_km',              unit: 'dollars_per_km' },
  { id: 'r-small',  code: 'small_meal',                 unit: 'dollars' },
  { id: 'r-large',  code: 'large_meal',                 unit: 'dollars' },
  { id: 'r-meal',   code: 'meal_allowance',             unit: 'dollars' },
  { id: 'r-spoilt', code: 'spoilt_meal_allowance',      unit: 'dollars' },
  { id: 'r-x1',     code: 'single_time_multiplier',     unit: 'multiplier' },
  { id: 'r-x15',    code: 'time_and_half_multiplier',   unit: 'multiplier' },
  { id: 'r-reliev', code: 'relieving_allowance',        unit: 'dollars' },
  { id: 'r-emr',    code: 'emr_allowance_example',      unit: 'dollars_per_week' }, // separately itemised allowance (must never enter Base Pay)
]

const v = (id, rate_id, value, effective_from, classification = null, extra = {}) =>
  ({ id, rate_id, version_label: id, value, effective_from, classification, source_kind: 'fwc_order', source_ref: 'fixture', withdrawn_at: null, ...extra })

const versions = [
  v('base-lff',  'r-base', 1999.60, '2021-01-01', 'lff'),
  v('base-slff', 'r-base', 2121.41, '2021-01-01', 'slff'),
  v('base-so',   'r-base', 2260.73, '2021-01-01', 'so'),
  v('factor',    'r-factor', 0.9093, '2020-07-01', null, { source_kind: 'industrial_instrument' }),
  v('div36',     'r-div', 36, '2020-07-01', null, { source_kind: 'payroll_reconciled' }),
  v('x2',        'r-x2', 2, '2020-07-01', null, { source_kind: 'industrial_instrument' }),
  v('km-2021',   'r-km', 1.37, '2021-01-01'),
  v('km-2023',   'r-km', 1.50, '2023-06-17'),
  v('km-wb',     'r-km', 1.20, '2025-06-01', null, { source_kind: 'workbook', withdrawn_at: '2026-10-05T00:00:00Z' }),
  v('small',     'r-small', 10.90, '2025-06-01', null, { source_kind: 'workbook' }),
  v('large',     'r-large', 20.55, '2025-06-01', null, { source_kind: 'workbook' }),
  v('meal-2021', 'r-meal', 18.75, '2021-01-01'),
  v('meal-2023', 'r-meal', 20.53, '2023-06-17'),
  v('spoilt-2021', 'r-spoilt', 18.74, '2021-01-01'),
  v('spoilt-2023', 'r-spoilt', 20.52, '2023-06-17'),
  v('x1',        'r-x1', 1, '2020-07-01', null, { source_kind: 'industrial_instrument' }),
  v('x15',       'r-x15', 1.5, '2020-07-01', null, { source_kind: 'industrial_instrument' }),
  v('reliev-2023', 'r-reliev', 35.11, '2023-06-17'),
  v('emr',       'r-emr', 999.99, '2020-07-01', 'lff'),
]

export const FIXTURE_CATALOG = Object.freeze({ rates, versions })

/** A Leading Firefighter since 2021 (the available payslip evidence). */
export const FIXTURE_LFF_HISTORY = Object.freeze([
  { classification: 'lff', effective_from: '2021-01-01' },
])
