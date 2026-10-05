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
      const [ratesRes, versionsRes, classRes] = await Promise.all([
        fat.from('rates').select('id, code, display_name, unit, description'),
        fat.from('rate_versions')
          .select('id, rate_id, version_label, value, effective_from, classification, source_kind, source_ref, withdrawn_at')
          .is('withdrawn_at', null),
        fat.from('member_classifications')
          .select('id, classification, effective_from, source_ref, created_at')
          .eq('owner_id', uid)
          .order('effective_from', { ascending: false }),
      ])
      if (ratesRes.error) throw ratesRes.error
      if (versionsRes.error) throw versionsRes.error
      if (classRes.error) throw classRes.error
      setCatalog({ rates: ratesRes.data || [], versions: versionsRes.data || [] })
      setClassificationHistory(classRes.data || [])
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
    const { error: insErr } = await fat.from('member_classifications').insert({
      owner_id: userId, classification, effective_from: effectiveFrom, source_ref: sourceRef,
    })
    if (insErr) throw insErr
    await loadRates(userId)
  }, [userId, loadRates])

  const removeClassification = useCallback(async (id) => {
    if (!userId) throw new Error('No user session.')
    const { error: delErr } = await fat.from('member_classifications').delete().eq('id', id)
    if (delErr) throw delErr
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
