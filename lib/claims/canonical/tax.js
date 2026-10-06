// ─── Tax summary from canonical entitlements (Neon backend, WORK-256) ────────
// Same output shape as lib/calculations/engine.js calcTaxSummary so the tax page
// renders unchanged, but every figure comes from the canonical record instead
// of workbook rates:
//   * meals  — one per meal-allowance entitlement at its actual versioned amount
//              (small_meal → "small"; every other meal allowance → "large");
//   * travel — recall mileage entitlements: km = the recorded round-trip
//              distance, $ = the generated (or overridden) amount.
// Hours entitlements are never converted to dollars here (CLAUDE.md §7).

const SMALL = new Set(['small_meal'])
const LARGE = new Set(['recall_meal', 'retain_meal', 'spoilt_meal', 'delayed_meal'])
const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100

export function calcCanonicalTaxSummary(rows) {
  let smallMealCount = 0, smallMealTotal = 0, largeMealCount = 0, largeMealTotal = 0
  let travelKm = 0, travelTotal = 0
  for (const r of rows || []) {
    const c = r?.canonical
    if (!c || c.unit !== 'dollars') continue
    const amount = Number(c.editedAmount ?? c.generatedAmount) || 0
    if (SMALL.has(c.entitlementType)) { smallMealCount++; smallMealTotal += amount }
    else if (LARGE.has(c.entitlementType)) { largeMealCount++; largeMealTotal += amount }
    else if (c.entitlementType === 'recall_mileage') { travelKm += Number(c.quantity) || 0; travelTotal += amount }
  }
  travelKm = round2(travelKm)
  smallMealTotal = round2(smallMealTotal)
  largeMealTotal = round2(largeMealTotal)
  travelTotal = round2(travelTotal)
  return {
    smallMealCount, smallMealTotal, largeMealCount, largeMealTotal,
    totalMeals: smallMealCount + largeMealCount,
    travelKm,
    travelRate: travelKm > 0 ? round2(travelTotal / travelKm) : 0,
    travelTotal,
    grandTotal: round2(smallMealTotal + largeMealTotal + travelTotal),
    // Average actual allowance per meal (display only — amounts are versioned per date).
    smallMealRate: smallMealCount ? round2(smallMealTotal / smallMealCount) : 0,
    largeMealRate: largeMealCount ? round2(largeMealTotal / largeMealCount) : 0,
    canonical: true,
  }
}
