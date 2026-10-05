'use client'

// ─── Allowance Rates Page (read-only) + Classification ────────────────────────
// WORK-172: rates are GLOBAL and versioned (fat.rates / fat.rate_versions) and
// are no longer user-editable — fat.user_rates is retired as a rate source.
// This page shows the rates applicable today with their provenance, and lets
// the member record their FRV classification history, which the overtime rule
// (retain $) is keyed by. Adjustments to a single claim are made on that claim.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabaseClient'
import { useRates } from '@/lib/calculations/RatesContext'
import { RATE_FIELDS } from '@/lib/calculations/defaultRates'
import { calcDoubleMealAllowance } from '@/lib/calculations/engine'
import { CLASSIFICATIONS, resolveRateVersion } from '@/lib/fat/rates/rateModel'
import AppShell from '@/components/nav/AppShell'

const INPUT_STYLE = {
  width: '100%', padding: '10px 12px', background: '#111', border: '1px solid #333',
  borderRadius: '8px', color: '#e5e7eb', fontSize: '0.9rem', outline: 'none', boxSizing: 'border-box',
}
const LABEL_STYLE = {
  display: 'block', fontSize: '0.78rem', fontWeight: 600, color: '#9ca3af',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '6px',
}
const HELP_STYLE = { marginTop: '4px', fontSize: '0.74rem', color: '#6b7280' }
const CARD = { background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: '16px', padding: '24px', marginBottom: '20px' }
const H2 = { margin: '0 0 16px 0', fontSize: '0.95rem', fontWeight: 700, color: '#f9fafb' }
const ROW = { display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0', borderBottom: '1px solid #262626' }
const BANNER = (rgb, color) => ({
  marginBottom: '20px', background: `rgba(${rgb},0.1)`, border: `1px solid rgba(${rgb},0.3)`,
  color, borderRadius: '10px', padding: '12px 16px', fontSize: '0.85rem', lineHeight: 1.5,
})

const labelFor = (code) => CLASSIFICATIONS.find((c) => c.code === code)?.label || code
const today = () => new Date().toISOString().slice(0, 10)

export default function SettingsPage() {
  const router = useRouter()
  const {
    rates, catalog, classificationHistory, loading, error,
    loadRates, addClassification, removeClassification,
  } = useRates()

  const [session, setSession] = useState(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [cls, setCls] = useState('lff')
  const [effFrom, setEffFrom] = useState(today)
  const [sourceRef, setSourceRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) { router.replace('/login'); return }
      setSession(data.session)
      setAuthLoading(false)
      loadRates(data.session.user.id)
    })
  }, [router, loadRates])

  const handleAdd = async (e) => {
    e.preventDefault()
    setFormError(null)
    if (!effFrom) { setFormError('Effective-from date is required.'); return }
    if (!sourceRef.trim()) { setFormError('Give the evidence for this classification (e.g. payslip pay number).'); return }
    setBusy(true)
    try {
      await addClassification({ classification: cls, effectiveFrom: effFrom, sourceRef: sourceRef.trim() })
      setSourceRef('')
    } catch (err) {
      setFormError(err.message || 'Could not record classification.')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (id) => {
    if (!window.confirm('Remove this classification entry? Claims already saved keep the rate they were calculated with.')) return
    try { await removeClassification(id) } catch (err) { setFormError(err.message || 'Could not remove entry.') }
  }

  if (authLoading) {
    return (
      <div style={{ minHeight: '100vh', background: '#0f0f0f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' }}>
        Loading…
      </div>
    )
  }

  const ot = rates.overtime
  const date = today()

  return (
    <AppShell>
      <div style={{ color: '#e5e7eb', padding: '32px 20px', boxSizing: 'border-box' }}>
        <div style={{ maxWidth: '640px', margin: '0 auto' }}>
          <div style={{ marginBottom: '24px' }}>
            <h1 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#f9fafb' }}>Allowance Rates</h1>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#6b7280' }}>{session?.user?.email}</p>
          </div>

          <div style={BANNER('59,130,246', '#93c5fd')}>
            Rates come from the enterprise agreement and Fair Work Commission orders, with effective dates.
            Each claim uses the rates in force on its date, and saved claims never change.
            To adjust one claim, edit that claim — rates are not editable per user.
          </div>

          {error && <div style={BANNER('239,68,68', '#f87171')}>{error}</div>}

          {/* Classification history */}
          <div style={CARD}>
            <h2 style={H2}>Your FRV classification</h2>
            <p style={{ ...HELP_STYLE, marginTop: 0, marginBottom: '12px' }}>
              Overtime (retain) dollars are calculated from your classification's Base Pay
              × 90.93 % ÷ 36 × double time. Without a classification the retain $ estimate is not shown.
            </p>
            {classificationHistory.length === 0 && (
              <p style={{ color: '#f59e0b', fontSize: '0.85rem' }}>No classification recorded.</p>
            )}
            {classificationHistory.map((h) => (
              <div key={h.id} style={ROW}>
                <div>
                  <div style={{ fontWeight: 600 }}>{labelFor(h.classification)}</div>
                  <div style={HELP_STYLE}>From {String(h.effective_from).slice(0, 10)} · {h.source_ref}</div>
                </div>
                <button type="button" onClick={() => handleRemove(h.id)}
                  style={{ background: 'none', border: '1px solid #444', color: '#9ca3af', borderRadius: '8px', padding: '4px 10px', cursor: 'pointer' }}>
                  Remove
                </button>
              </div>
            ))}
            <form onSubmit={handleAdd} noValidate style={{ marginTop: '16px', display: 'grid', gap: '12px' }}>
              <div>
                <label style={LABEL_STYLE}>Classification</label>
                <select value={cls} onChange={(e) => setCls(e.target.value)} style={{ ...INPUT_STYLE, cursor: 'pointer' }}>
                  {CLASSIFICATIONS.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
                </select>
              </div>
              <div>
                <label style={LABEL_STYLE}>Effective from</label>
                <input type="date" value={effFrom} onChange={(e) => setEffFrom(e.target.value)} style={INPUT_STYLE} />
              </div>
              <div>
                <label style={LABEL_STYLE}>Evidence</label>
                <input type="text" value={sourceRef} placeholder="e.g. Payslip 51.2024 — Leading Fire fighter"
                  onChange={(e) => setSourceRef(e.target.value)} style={INPUT_STYLE} />
              </div>
              {formError && <div style={BANNER('239,68,68', '#f87171')}>{formError}</div>}
              <button type="submit" disabled={busy}
                style={{ background: '#dc2626', color: 'white', border: 'none', borderRadius: '8px', padding: '10px 16px', fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
                {busy ? 'Saving…' : 'Add classification'}
              </button>
            </form>
          </div>

          {/* Overtime rule in force today */}
          <div style={CARD}>
            <h2 style={H2}>Overtime rate (today)</h2>
            {ot?.ok ? (
              <>
                <div style={ROW}><span>Classification</span><span>{labelFor(ot.classification)}</span></div>
                <div style={ROW}><span>Weekly Base Pay</span><span>${ot.components.basePayWeekly.value}</span></div>
                <div style={ROW}><span>Overtime factor</span><span>{ot.components.factor.value}</span></div>
                <div style={ROW}><span>Hourly divisor</span><span>{ot.components.divisor.value}</span></div>
                <div style={ROW}><span>Hourly base</span><span>${ot.baseHourly}</span></div>
                <div style={ROW}><span>Double time</span><span>${Number(ot.hourly).toFixed(2)}/h</span></div>
                <p style={HELP_STYLE}>
                  Base Pay excludes separately itemised allowances. The ÷36 divisor is reconciled to FRV payroll;
                  results can differ from payslips by about a cent per line.
                </p>
              </>
            ) : (
              <p style={{ color: '#f59e0b', fontSize: '0.85rem' }}>{ot?.message || 'Unavailable.'}</p>
            )}
          </div>

          {/* Allowance rates in force today */}
          <div style={CARD}>
            <h2 style={H2}>Allowances (today)</h2>
            {loading ? <p style={{ color: '#9ca3af' }}>Loading…</p> : (
              <>
                {RATE_FIELDS.map((f) => {
                  const r = resolveRateVersion(catalog, f.code, date)
                  return (
                    <div key={f.key} style={ROW}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{f.label}</div>
                        <div style={HELP_STYLE}>{f.help}</div>
                        {r && <div style={HELP_STYLE}>From {String(r.version.effective_from).slice(0, 10)} · {r.version.source_ref}</div>}
                      </div>
                      <span style={{ whiteSpace: 'nowrap' }}>
                        {rates[f.key] == null ? '—' : `$${Number(rates[f.key]).toFixed(2)}`}{f.unit === '$/km' ? '/km' : ''}
                      </span>
                    </div>
                  )
                })}
                <div style={ROW}>
                  <div>
                    <div style={{ fontWeight: 600 }}>Double Meal Allowance</div>
                    <div style={HELP_STYLE}>Derived: Small Meal + Large Meal.</div>
                  </div>
                  <span>${calcDoubleMealAllowance(rates).toFixed(2)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  )
}
