'use client'

// ─── Financial Year Context ────────────────────────────────────────────────────
// Manages the active financial year workspace.
//
// On first load, if no FY records exist for the user, the current FY is
// auto-created. The active FY is stored in Supabase (is_active flag) so it
// persists across sessions on the same device.
//
// All claim loading and tax summaries should filter by the active FY's
// start_date / end_date.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { fat } from '@/lib/supabaseClient'
import { isNeonBackend } from '@/lib/backend'
import { callFat } from '@/lib/data/fatApi'
import { loadFinancialYears, switchActiveFinancialYear, createFinancialYear } from '@/lib/fy/fyRepository'
import { getFYLabel, getFYDateRange, currentFYLabel } from '@/lib/calculations/engine'

// ─── Context ──────────────────────────────────────────────────────────────────

const FinancialYearContext = createContext(null)

// ─── Provider ─────────────────────────────────────────────────────────────────

export function FinancialYearProvider({ children }) {
  const [allFYs, setAllFYs]         = useState([])   // all FY rows for user
  const [activeFY, setActiveFY]     = useState(null) // the currently selected FY row
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState(null)
  const [userId, setUserId]         = useState(null)

  // Coalesces concurrent loadFYs invocations. React Strict Mode double-invokes
  // effects in dev, and the dashboard + tax effects can overlap on a fast
  // re-render — without this guard two runs both see zero rows and both attempt
  // the bootstrap INSERT, so the loser hit a 23505 duplicate-key error.
  const inFlight = useRef(false)

  // ── Load (and auto-create if needed) all FYs for a user ──────────────────

  const loadFYs = useCallback(async (uid) => {
    if (!uid) return
    if (inFlight.current) return   // a load is already running for this session
    inFlight.current = true
    setUserId(uid)
    setLoading(true)
    setError(null)

    try {
      // Same queries on both backends (lib/fy/fyRepository.js). On Neon they
      // run server-side under the verified session identity (WORK-256).
      const { rows, active } = isNeonBackend()
        ? await callFat('fy.load')
        : await loadFinancialYears(fat, uid)

      setAllFYs(rows)
      setActiveFY(active)
    } catch (err) {
      console.error('[FY] Load failed:', err)
      setError('Could not load financial year data.')
    } finally {
      setLoading(false)
      inFlight.current = false
    }
  }, [])

  // ── Switch the active FY ──────────────────────────────────────────────────

  const switchFY = useCallback(async (fyId) => {
    if (!userId) return
    try {
      // Clear all is_active, then set the chosen one (lib/fy/fyRepository.js)
      if (isNeonBackend()) await callFat('fy.switch', { fyId })
      else await switchActiveFinancialYear(fat, userId, fyId)

      const chosen = allFYs.find((r) => r.id === fyId)
      if (chosen) {
        setActiveFY({ ...chosen, is_active: true })
        setAllFYs((prev) => prev.map((r) => ({ ...r, is_active: r.id === fyId })))
      }
    } catch (err) {
      console.error('[FY] Switch failed:', err)
    }
  }, [userId, allFYs])

  // ── Create a new FY ───────────────────────────────────────────────────────

  const createFY = useCallback(async (label) => {
    if (!userId) return null
    // Prevent duplicates
    if (allFYs.some((r) => r.label === label)) {
      return allFYs.find((r) => r.label === label)
    }

    const newRow = isNeonBackend()
      ? await callFat('fy.create', { label })
      : await createFinancialYear(fat, userId, label)

    setAllFYs((prev) => [newRow, ...prev])
    return newRow
  }, [userId, allFYs])

  // ── Compute available FY labels (to show in the "add new" dropdown) ───────

  const availableFYLabels = (() => {
    const existing = new Set(allFYs.map((r) => r.label))
    // Offer current FY ± 2 years
    const now = new Date()
    const base = parseInt(currentFYLabel().replace('FY', ''), 10)
    const labels = []
    for (let y = base - 1; y <= base + 2; y++) {
      const lbl = `${y}FY`
      if (!existing.has(lbl)) labels.push(lbl)
    }
    return labels
  })()

  return (
    <FinancialYearContext.Provider value={{
      allFYs,
      activeFY,
      loading,
      error,
      loadFYs,
      switchFY,
      createFY,
      availableFYLabels,
    }}>
      {children}
    </FinancialYearContext.Provider>
  )
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFY() {
  const ctx = useContext(FinancialYearContext)
  if (!ctx) throw new Error('useFY must be used inside <FinancialYearProvider>')
  return ctx
}
