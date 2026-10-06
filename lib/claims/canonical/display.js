// Display helpers for canonical (Neon) claim rows (WORK-256). Hours-first:
// an hours entitlement shows its hours; the snapshot $ figure is an estimate
// only and is never added to dollar totals (CLAUDE.md §7).

export function isCanonicalRow(claim) {
  return !!claim?.canonical
}

export function isHoursRow(claim) {
  return claim?.canonical?.unit === 'hours'
}

export function formatHours(h) {
  const n = Number(h)
  return Number.isFinite(n) ? `${n.toFixed(2)} h` : '— h'
}

/** Sum of hours across canonical hours rows (0 when none). */
export function totalHours(rows) {
  return (rows || []).reduce((s, c) => s + (isHoursRow(c) ? Number(c.canonical.hours) || 0 : 0), 0)
}

export const FACT_LABELS = {
  recall_start_at: 'recall start time',
  recall_end_at: 'booked-off time',
  recall_travel_minutes: 'recall travel minutes',
  recall_travel_sunday_or_ph: 'Sunday / public holiday',
  travel_distance_km: 'round-trip km',
  recall_station_id: 'recall station',
  rostered_station_id: 'rostered station (profile)',
  recall_duty: 'shift',
  retain_start_at: 'rostered finish',
  retain_end_at: 'booked-off time',
  meal_interrupted_at: 'meal interrupted time',
  emergency_response: 'emergency response',
  delay_cause: 'delay cause',
  meal_window_start_at: 'meal break start',
  meal_window_end_at: 'meal break end',
  actual_meal_at: 'actual meal time',
  delay_notice_2h: '2 h notice',
  duty_start_at: 'duty start',
  duty_end_at: 'duty end',
}

export function describeMissingFacts(facts) {
  return (facts || []).map((f) => FACT_LABELS[f] || f).join(', ')
}
