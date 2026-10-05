// ─── Prototype rates object for a claim date (pure; WORK-172) ─────────────────
// Resolves the global versioned catalog into the shape the prototype engine
// consumes. No React/Supabase imports so it is testable under plain node.

import { DEFAULT_RATES, RATE_FIELDS } from './defaultRates.js'
import { resolveRateVersion, resolveOvertimeRate } from '../fat/rates/rateModel.js'

/**
 * @param {{rates:any[],versions:any[]}|null} catalog  live fat.rates / fat.rate_versions rows
 * @param {any[]} classificationHistory                member_classifications rows
 * @param {string} date                                ISO claim date
 */
export function buildRatesForDate(catalog, classificationHistory, date) {
  const rates = { ...DEFAULT_RATES }
  const rateVersions = {}
  if (catalog) {
    for (const f of RATE_FIELDS) {
      const r = resolveRateVersion(catalog, f.code, date)
      if (r) {
        rates[f.key] = Number(r.value)
        rateVersions[f.code] = { rate_version_id: r.version.id, value: r.value, effective_from: String(r.version.effective_from).slice(0, 10) }
      } else {
        rates[f.key] = null // no applicable version → not payable from the catalog
      }
    }
  }
  rates.overtime = catalog
    ? resolveOvertimeRate(catalog, { date, classificationHistory })
    : { ok: false, reason: 'catalog-unavailable', message: 'Rate catalog unavailable.' }
  rates.rateVersions = rateVersions
  rates.rateDate = date
  return rates
}
