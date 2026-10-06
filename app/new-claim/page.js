'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getCurrentSession } from '@/lib/auth/session'
import ClaimForm from '@/components/claims/ClaimForm'
import AppShell from '@/components/nav/AppShell'

export default function NewClaimPage() {
  const router = useRouter()
  const [session, setSession] = useState(null)
  const [loading, setLoading] = useState(true)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    getCurrentSession().catch(() => null).then((current) => {
      setSession(current)
      setLoading(false)
      if (!current) router.replace('/login')
    })
  }, [router])

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', background: '#0f0f0f',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: '#9ca3af', fontSize: '0.95rem',
      }}>
        Loading…
      </div>
    )
  }

  if (!session) return null

  if (submitted) {
    return (
      <AppShell>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          minHeight: '60vh', flexDirection: 'column', gap: '16px',
          padding: '32px 20px',
        }}>
          <div style={{
            background: 'rgba(34,197,94,0.1)',
            border: '1px solid rgba(34,197,94,0.3)',
            borderRadius: '12px',
            padding: '16px 24px',
            textAlign: 'center',
            color: '#4ade80',
            fontSize: '0.95rem',
          }}>
            ✓ Claim submitted successfully!
          </div>
          <button
            onClick={() => router.push('/')}
            style={{
              padding: '10px 20px',
              background: '#dc2626',
              border: 'none',
              borderRadius: '8px',
              color: 'white',
              fontSize: '0.9rem',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Back to Dashboard
          </button>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell>
      <div style={{
        color: '#e5e7eb',
        padding: '32px 20px',
        boxSizing: 'border-box',
      }}>
        <div style={{ maxWidth: '480px', margin: '0 auto' }}>

          <div style={{ marginBottom: '24px' }}>
            <h1 style={{ margin: '0 0 4px', fontSize: '1.35rem', fontWeight: 700, color: '#f9fafb' }}>
              New Claim
            </h1>
            <p style={{ margin: 0, fontSize: '0.82rem', color: '#6b7280' }}>
              {session.user.email}
            </p>
          </div>

          <div style={{
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: '16px',
            padding: '28px 24px',
          }}>
            <ClaimForm
              userId={session.user.id}
              onSuccess={() => setSubmitted(true)}
              onCancel={() => router.push('/')}
            />
          </div>
        </div>
      </div>
    </AppShell>
  )
}
