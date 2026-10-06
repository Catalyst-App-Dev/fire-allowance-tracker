'use client'

// ─── Rates Context ─────────────────────────────────────────────────────────────
// Loads the GLOBAL versioned rate/rule catalog (fat.rates + live
// fat.rate_versions) and the signed-in member's classification history
// (fat.member_classifications), and resolves rates per claim date.
//
// WORK-172 (docs/architecture/RATE_RULE_MODEL.md):
//   - Rates are global and versioned; fat.user_rates is no longer read or
//     written (retired as primary; table retained until the C7/Neon cutover).
//   - ratesForDate(date) returns the prototype rates object for that date,
//     including `overtime` (classification Base Pay × 90.93 % ÷ 36, cents-rounded
//     under the FAT estimate convention (WORK-246), × 2) and the
//     exact version ids applied (`rateVersions`) for snapshotting.
//   - `rates` = ratesForDate(today), for screens that are not date-specific.
//   - If the catalog cannot be loaded, DEFAULT_RATES is the offline fallback and
//     the overtime rule fails closed (no retain $ estimate).
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback, useMemo } from 'react'
import { fat } from '@/lib/supabaseClient'
import { isNeonBackend } from '@/lib/backend'
import { callFat } from '@/lib/data/fatApi'
import { loadRateCatalog, addMemberClassification, removeMemberClassification } from '@/lib/calculations/ratesRepository'
import { buildRatesForDate } from '@/lib/calculations/ratesForDate'

const RatesContext = createContext(null)

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function RatesProvider({ children }) {
  const [catalog, setCatalog] = useState(null)
  const [classificationHistory, setClassificationHistory] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [userId, setUserId] = useState(null)

  const loadRates = useCallback(async (uid) => {
    if (!uid) return
    setUserId(uid)
    setLoading(true)
    setError(null)
    try {
      // lib/calculations/ratesRepository.js — server-side on Neon (WORK-256).
      const loaded = isNeonBackend() ? await callFat('rates.load') : await loadRateCatalog(fat, uid)
      setCatalog(loaded.catalog)
      setClassificationHistory(loaded.classificationHistory)
    } catch (err) {
      console.error('[Rates] Catalog load failed:', err)
      setError('Could not load the rate catalog. Using offline fallback rates; retain $ estimates are unavailable.')
      setCatalog(null)
    } finally {
      setLoading(false)
    }
  }, [])

  /** Append a classification (effective-dated). History is never edited in place. */
  const addClassification = useCallback(async ({ classification, effectiveFrom, sourceRef }) => {
    if (!userId) throw new Error('No user session — cannot record classification.')
    const input = { classification, effectiveFrom, sourceRef }
    if (isNeonBackend()) await callFat('rates.addClassification', input)
    else await addMemberClassification(fat, userId, input)
    await loadRates(userId)
  }, [userId, loadRates])

  const removeClassification = useCallback(async (id) => {
    if (!userId) throw new Error('No user session.')
    if (isNeonBackend()) await callFat('rates.removeClassification', { id })
    else await removeMemberClassification(fat, userId, id)
    await loadRates(userId)
  }, [userId, loadRates])

  const ratesForDate = useCallback(
    (date) => buildRatesForDate(catalog, classificationHistory, date || todayIso()),
    [catalog, classificationHistory],
  )
  const rates = useMemo(() => ratesForDate(todayIso()), [ratesForDate])

  return (
    <RatesContext.Provider value={{
      rates, ratesForDate, catalog, classificationHistory, loading, error,
      loadRates, addClassification, removeClassification,
    }}>
      {children}
    </RatesContext.Provider>
  )
}

export function useRates() {
  const ctx = useContext(RatesContext)
  if (!ctx) throw new Error('useRates must be used inside <RatesProvider>')
  return ctx
}
