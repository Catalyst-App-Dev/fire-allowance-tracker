#!/usr/bin/env node
// ─── FAT Neon DEV end-to-end proof (WORK-256) ────────────────────────────────
// Drives a running FAT app (FAT_BACKEND=neon, Neon `dev` only) over HTTP exactly
// as the browser does: Neon Auth through /api/auth, data through /api/fat/<op>.
// Synthetic users only (unique @example.invalid addresses per run).
//
//   BASE_URL=http://localhost:3001 node scripts/neon-dev-e2e.mjs > report.json
//
// Proves: auth lifecycle (sign-up, sign-in, reload, sign-out, invalid session,
// unauthenticated denial, synthetic-only provisioning), identity mapping,
// per-user isolation (A ↔ B read/write), FY / profile / rates, canonical claim
// preview → create → list → override → delete for all six types, numbering,
// Payments-dark surfaces. Exit 0 only when every check passes.

const BASE = process.env.BASE_URL || 'http://localhost:3001'
const RUN = process.env.RUN_ID || `${Date.now().toString(36)}`
const checks = []
const facts = {}

function check(name, ok, detail = null) {
  checks.push({ name, ok: !!ok, detail })
  if (!ok) console.error(`✗ ${name}`, detail ?? '')
}

class Jar {
  constructor() { this.cookies = new Map() }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    for (const c of list) {
      const [pair, ...attrs] = c.split(';')
      const i = pair.indexOf('=')
      const name = pair.slice(0, i).trim()
      const value = pair.slice(i + 1).trim()
      const expired = attrs.some((a) => /max-age=0/i.test(a) || /expires=thu, 01 jan 1970/i.test(a))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
}

async function http(jar, method, path, body) {
  const headers = { Origin: BASE, Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (jar && jar.cookies.size) headers.Cookie = jar.header()
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' })
  if (jar) jar.absorb(res)
  let json = null
  try { json = await res.json() } catch { /* non-JSON */ }
  return { status: res.status, json }
}

const op = (jar, name, input = {}) => http(jar, 'POST', `/api/fat/${name}`, input)

async function signUp(jar, email, password) {
  return http(jar, 'POST', '/api/auth/sign-up/email', { email, password, name: email.split('@')[0] })
}

const PASSWORD = `Synthetic-${RUN}-Pass!`
const emailA = `work256-a-${RUN}@example.invalid`
const emailB = `work256-b-${RUN}@example.invalid`

const CLAIMS = {
  recalls: {
    date: '2026-09-10',
    fields: { shift: 'Day', arrivalTime: '08:00', bookedOffTime: '13:30', rosteredStnId: 9001, recallStnId: 9002, notified: false },
    facts: { travelMinutes: 50, travelSundayOrPh: false, travelDistanceKm: 42.5 },
  },
  retain: {
    date: '2026-09-11',
    fields: { shift: 'Night', bookedOffTime: '09:30', rosteredStnId: 9001 },
    facts: { nightShiftInterrupted: true, travelHomeMinutes: 45 },
  },
  standby: {
    date: '2026-09-12',
    fields: { shift: 'Night', arrivedTime: '19:30', rosteredStnId: 9001, standbyStnId: 9002, standbyType: 'Standby' },
    facts: {},
  },
  md: {
    date: '2026-09-13',
    fields: { shift: 'Day', arrivedTime: '07:30', rosteredStnId: 9001, standbyStnId: 9003, standbyType: 'M&D' },
    facts: {},
  },
  spoilt: {
    date: '2026-09-14',
    fields: { shift: 'Day', incidentTime: '12:15', firecallNumber: '12345', operationalStnId: 9001, mealType: 'Spoilt' },
    facts: { emergencyResponse: true },
  },
  delayed_meal: {
    date: '2026-09-15',
    fields: { shift: 'Day', incidentTime: '12:00', firecallNumber: '23456', operationalStnId: 9001, mealType: 'Delayed' },
    facts: { mealWindowStart: '12:00', mealWindowEnd: '13:00', actualMealTime: '13:15', delayNotice2h: false, delayCause: 'other' },
  },
}

async function main() {
  const A = new Jar(); const B = new Jar(); const anon = new Jar()

  // ── AUTH ────────────────────────────────────────────────────────────────
  let r = await op(anon, 'session.get')
  check('auth: unauthenticated op → 401', r.status === 401, r)
  r = await op(anon, 'claims.list')
  check('auth: unauthenticated claims.list → 401', r.status === 401, r)

  r = await signUp(A, emailA, PASSWORD)
  check('auth: sign-up A (synthetic)', r.status === 200 && r.json?.user?.email === emailA, r.status)
  r = await op(A, 'session.get')
  check('auth: A session resolves to an app identity', r.status === 200 && /^[0-9a-f-]{36}$/.test(r.json?.user?.id ?? ''), r)
  const idA = r.json?.user?.id
  facts.identityA = idA

  r = await signUp(B, emailB, PASSWORD)
  check('auth: sign-up B (synthetic)', r.status === 200, r.status)
  // First requests after sign-up arrive concurrently (as the dashboard does):
  // provisioning must be race-free and every request must see ONE identity.
  const burst = await Promise.all(['session.get', 'fy.load', 'rates.load', 'session.get', 'profile.load', 'session.get'].map((n) => op(B, n)))
  check('identity: concurrent first requests all succeed', burst.every((x) => x.status === 200), burst.map((x) => x.status))
  const burstIds = new Set(burst.filter((x) => x.json?.user?.id).map((x) => x.json.user.id))
  check('identity: concurrent first requests resolve one identity', burstIds.size === 1, [...burstIds])
  r = await op(B, 'session.get')
  const idB = r.json?.user?.id
  facts.identityB = idB
  check('identity: A and B map to distinct app identities', idA && idB && idA !== idB, { idA, idB })

  // Reload = a fresh request carrying only the stored cookies.
  const reloaded = new Jar(); reloaded.cookies = new Map(A.cookies)
  r = await op(reloaded, 'session.get')
  check('auth: session restored on reload (cookie only)', r.status === 200 && r.json?.user?.id === idA, r)
  r = await http(reloaded, 'GET', '/api/auth/get-session')
  check('auth: Neon Auth get-session on reload', r.status === 200 && r.json?.user?.email === emailA, r.status)

  r = await http(A, 'POST', '/api/auth/sign-out', {})
  check('auth: sign-out A', r.status === 200, r)
  r = await op(A, 'session.get')
  check('auth: after sign-out → 401', r.status === 401, r)
  r = await http(A, 'POST', '/api/auth/sign-in/email', { email: emailA, password: PASSWORD })
  check('auth: sign-in A', r.status === 200, r.status)
  r = await op(A, 'session.get')
  check('identity: re-sign-in maps to the SAME app identity', r.status === 200 && r.json?.user?.id === idA, r)

  r = await http(new Jar(), 'POST', '/api/auth/sign-in/email', { email: emailA, password: 'wrong-password-123' })
  check('auth: wrong password refused', r.status >= 400, r.status)

  const forged = new Jar()
  for (const [k, v] of A.cookies) forged.cookies.set(k, v.slice(0, -6) + 'AAAAAA')
  r = await op(forged, 'session.get')
  check('auth: tampered/invalid session cookie → 401', r.status === 401, r)

  const real = new Jar()
  r = await signUp(real, `work256-probe-${RUN}@fat-nonreserved-probe.dev`, PASSWORD)
  const realSignup = r.status
  r = await op(real, 'session.get')
  check('identity: non-synthetic e-mail is never provisioned on Neon DEV (403)', r.status === 403 && r.json?.error === 'NOT_SYNTHETIC', { signup: realSignup, op: r })

  // ── FY / PROFILE / RATES ────────────────────────────────────────────────
  r = await op(A, 'fy.load')
  check('fy: A load bootstraps exactly one active FY', r.status === 200 && r.json?.rows?.length >= 1 && r.json?.active?.is_active === true, r)
  const fyA = r.json?.active
  facts.fyA = fyA?.label
  r = await op(B, 'fy.load')
  const fyB = r.json?.active
  check('fy: B gets its own FY row', r.status === 200 && fyB?.id && fyB.id !== fyA?.id, { fyA: fyA?.id, fyB: fyB?.id })

  r = await op(A, 'profile.save', { firstName: 'Synthetic', lastName: 'A', stationId: 9001, stationLabel: 'Synthetic Station 9001', homeAddress: '1 Example St, Testville', platoon: 'B' })
  check('profile: A save', r.status === 200, r)
  r = await op(A, 'profile.load')
  check('profile: A reload shows saved values', r.status === 200 && r.json?.profile?.first_name === 'Synthetic' && r.json?.ext?.station_id === 9001, r.json?.ext)
  r = await op(B, 'profile.load')
  check('isolation: B profile does not see A values', r.status === 200 && r.json?.ext?.station_id !== 9001 && r.json?.profile?.first_name !== 'Synthetic', r.json)

  r = await op(A, 'rates.load')
  check('rates: catalog visible', r.status === 200 && r.json?.catalog?.rates?.length >= 14, r.json?.catalog?.rates?.length)
  r = await op(A, 'rates.addClassification', { classification: 'lff', effectiveFrom: '2026-07-01', sourceRef: `WORK-256 synthetic E2E ${RUN}` })
  check('rates: A records a classification', r.status === 200, r)
  r = await op(A, 'rates.load')
  const cls = r.json?.classificationHistory || []
  check('rates: classification history shows it', cls.some((c) => c.classification === 'lff'), cls)
  r = await op(B, 'rates.load')
  check('isolation: B does not see A classification', (r.json?.classificationHistory || []).length === 0, r.json?.classificationHistory)

  r = await op(A, 'stations.list')
  check('stations: reference list visible', r.status === 200 && Array.isArray(r.json) && r.json.length >= 1, r.json?.length)

  // ── CLAIMS (A) ──────────────────────────────────────────────────────────
  const created = {}
  for (const [type, c] of Object.entries(CLAIMS)) {
    const input = { claimType: type, date: c.date, fields: c.fields, facts: c.facts, routingMeta: null, financialYearId: fyA?.id }
    r = await op(A, 'claims.preview', input)
    check(`claims: preview ${type}`, r.status === 200 && Array.isArray(r.json?.entitlements), r.json ?? r.status)
    const previewTypes = (r.json?.entitlements || []).map((e) => e.entitlementType).sort()
    r = await op(A, 'claims.create', input)
    check(`claims: create ${type}`, r.status === 200 && r.json?.claimId && r.json?.claimNumber >= 1, r.json ?? r.status)
    const createdTypes = (r.json?.entitlements || []).map((e) => e.entitlementType).sort()
    check(`claims: ${type} create = preview (same entitlements)`, JSON.stringify(previewTypes) === JSON.stringify(createdTypes), { previewTypes, createdTypes })
    created[type] = { ...r.json, entitlementTypes: createdTypes }
  }
  facts.created = Object.fromEntries(Object.entries(created).map(([k, v]) => [k, { claimNumber: v.claimNumber, claimType: v.claimType, entitlements: v.entitlements?.map((e) => `${e.entitlementType}:${e.unit === 'hours' ? `${e.hours}h` : `$${e.amount}`}`) }]))

  const rc = created.recalls?.entitlements || []
  const ent = (list, t) => list.find((e) => e.entitlementType === t)
  check('rules RC: overtime 5.5 h (08:00–13:30, ≥4 h min, nearest ¼ h)', Number(ent(rc, 'recall_overtime')?.hours) === 5.5, ent(rc, 'recall_overtime'))
  check('rules RC: travel time 0.75 h (50 min)', Number(ent(rc, 'recall_travel_time')?.hours) === 0.75, ent(rc, 'recall_travel_time'))
  check('rules RC: mileage $63.75 (42.5 km × $1.50)', Number(ent(rc, 'recall_mileage')?.amount) === 63.75, ent(rc, 'recall_mileage'))
  check('rules RC: relieving allowance (recall stn ≠ rostered)', !!ent(rc, 'relieving_allowance'), rc.map((e) => e.entitlementType))
  check('rules RC: 2 recall meals (day, before 10:00, > 2 h)', rc.filter((e) => e.entitlementType === 'recall_meal').length === 2, rc)
  check('rules RC: overtime estimate present (classification lff)', ent(rc, 'recall_overtime')?.estimate != null, ent(rc, 'recall_overtime'))
  const rt = created.retain?.entitlements || []
  check('rules RT: overtime 4 h (90 min ≥ 60 → 4 h minimum)', Number(ent(rt, 'retain_overtime')?.hours) === 4, ent(rt, 'retain_overtime'))
  check('rules RT: travel home 0.75 h (night, interrupted, 45 min)', Number(ent(rt, 'retain_travel_home')?.hours) === 0.75, ent(rt, 'retain_travel_home'))
  check('rules RT: 1 retain meal', rt.filter((e) => e.entitlementType === 'retain_meal').length === 1, rt)
  check('rules SM: spoilt meal allowance', !!ent(created.spoilt?.entitlements || [], 'spoilt_meal'), created.spoilt)
  check('rules DM: delayed meal allowance (75 min > 30, no notice)', !!ent(created.delayed_meal?.entitlements || [], 'delayed_meal'), created.delayed_meal)
  check('rules SB: standby & dismiss generated', !!ent(created.standby?.entitlements || [], 'standby_dismi'), created.standby)
  check('rules MD: muster & dismiss generated', !!ent(created.md?.entitlements || [], 'muster_dismis'), created.md)

  // Numbering: a second recall in the same FY gets the next number.
  r = await op(A, 'claims.create', { claimType: 'recalls', date: '2026-09-20', fields: { ...CLAIMS.recalls.fields, arrivalTime: '20:30', bookedOffTime: '23:30', shift: 'Night' }, facts: {}, financialYearId: fyA?.id })
  check('numbering: second recall → next sequential number', r.status === 200 && r.json?.claimNumber === created.recalls.claimNumber + 1, { first: created.recalls?.claimNumber, second: r.json?.claimNumber })
  const secondRecall = r.json

  // Duplicate meal event is refused (CANONICAL_ENTITLEMENT_RULES § 5.1).
  r = await op(A, 'claims.create', { claimType: 'spoilt', ...CLAIMS.spoilt, financialYearId: fyA?.id })
  check('claims: duplicate spoilt meal event refused (409)', r.status === 409 && r.json?.error === 'DUPLICATE_MEAL_EVENT', r)

  // List / grouped view (reload persistence).
  r = await op(A, 'claims.list', { financialYearId: fyA?.id })
  const groups = r.json?.claimGroups || []
  const rows = r.json?.claims || []
  check('claims: list returns every created claim as a group', groups.length === 7, groups.length)
  check('claims: every child row belongs to a listed group', rows.every((x) => groups.some((g) => g.id === x.claim_group_id)), null)
  check('claims: hours rows carry no dollars (hours-first)', rows.filter((x) => x.canonical?.unit === 'hours').every((x) => x.total_amount === 0 && x.canonical.hours > 0), null)
  check('claims: payment state displayed from canonical (Pending, method set)', rows.every((x) => x.payment_status === 'Pending' && ['Payslip', 'Petty Cash'].includes(x.payment_method)), null)
  const rcGroup = groups.find((g) => g.id === created.recalls?.claimId)
  check('claims: group label uses claim number', rcGroup?.label?.includes(`#${created.recalls?.claimNumber}`), rcGroup?.label)
  facts.listed = { groups: groups.length, rows: rows.length }

  // Override (audited) — a dollar allowance and an hours entitlement.
  const mileage = rows.find((x) => x.claim_group_id === created.recalls?.claimId && x.canonical?.entitlementType === 'recall_mileage')
  r = await op(A, 'claims.override', { entitlementId: mileage?.id, value: 60, reason: 'E2E: corrected km' })
  check('override: dollar entitlement with reason', r.status === 200, r)
  r = await op(A, 'claims.override', { entitlementId: mileage?.id, value: 61, reason: '' })
  check('override: refused without a reason', r.status === 400, r)
  const overtime = rows.find((x) => x.claim_group_id === created.recalls?.claimId && x.canonical?.entitlementType === 'recall_overtime')
  r = await op(A, 'claims.override', { entitlementId: overtime?.id, value: 6, reason: 'E2E: extended recall' })
  check('override: hours entitlement with reason', r.status === 200, r)
  r = await op(A, 'claims.list', { financialYearId: fyA?.id })
  const m2 = (r.json?.claims || []).find((x) => x.id === mileage?.id)
  const o2 = (r.json?.claims || []).find((x) => x.id === overtime?.id)
  check('override: persisted (edited amount, generated kept)', m2?.canonical?.editedAmount === 60 && m2?.canonical?.generatedAmount === 63.75 && m2?.canonical?.manualOverride === true, m2?.canonical)
  check('override: hours persisted (edited 6 h, generated 5.5 h)', o2?.canonical?.hours === 6 && o2?.canonical?.generatedHours === 5.5, o2?.canonical)

  // ── ISOLATION (B against A) ─────────────────────────────────────────────
  r = await op(B, 'claims.list', {})
  check('isolation: B sees none of A claims', r.status === 200 && (r.json?.claimGroups || []).length === 0, (r.json?.claimGroups || []).length)
  r = await op(B, 'claims.delete', { claimId: created.recalls?.claimId })
  check('isolation: B cannot delete A claim (404)', r.status === 404, r)
  r = await op(B, 'claims.override', { entitlementId: mileage?.id, value: 1, reason: 'attack' })
  check('isolation: B cannot override A entitlement (404)', r.status === 404, r)
  r = await op(B, 'fy.switch', { fyId: fyA?.id })
  r = await op(A, 'fy.load')
  check('isolation: B cannot change A FY state', r.json?.active?.id === fyA?.id, r.json?.active?.id)
  r = await op(B, 'claims.create', { claimType: 'spoilt', date: '2026-09-21', fields: CLAIMS.spoilt.fields, facts: CLAIMS.spoilt.facts, financialYearId: fyA?.id })
  check('isolation: B cannot create a claim in A FY (404)', r.status === 404, r)
  r = await op(B, 'claims.create', { claimType: 'spoilt', date: '2026-09-21', fields: { ...CLAIMS.spoilt.fields, incidentTime: '18:10' }, facts: CLAIMS.spoilt.facts, financialYearId: fyB?.id })
  check('B: creates its own claim', r.status === 200, r)
  const claimB = r.json
  r = await op(A, 'claims.list', {})
  check('isolation: A does not see B claim', !(r.json?.claimGroups || []).some((g) => g.id === claimB?.claimId), null)
  r = await op(A, 'claims.delete', { claimId: claimB?.claimId })
  check('isolation: A cannot delete B claim (404)', r.status === 404, r)
  r = await op(A, 'session.get', { userId: idB })
  check('isolation: browser-supplied userId is ignored', r.json?.user?.id === idA, r.json)

  // ── DELETE ──────────────────────────────────────────────────────────────
  r = await op(A, 'claims.delete', { claimId: secondRecall?.claimId })
  check('delete: A deletes own claim', r.status === 200, r)
  r = await op(A, 'claims.list', {})
  check('delete: claim gone after reload', !(r.json?.claimGroups || []).some((g) => g.id === secondRecall?.claimId), null)

  // ── PAYMENTS DARK / SURFACE ─────────────────────────────────────────────
  r = await http(A, 'POST', '/api/payslip/extract', {})
  check('payments dark: payslip extract route 404 on Neon', r.status === 404, r)
  r = await http(A, 'GET', '/api/payslip/extract')
  check('payments dark: payslip availability probe 404 on Neon', r.status === 404, r)
  r = await op(A, 'payments.list')
  check('surface: unknown/payments op → 404', r.status === 404, r)
  r = await op(A, 'constructor')
  check('surface: prototype key is not an op (404)', r.status === 404, r)
  r = await http(anon, 'POST', '/api/travel/google', { from: { lat: -37.8, lng: 144.9 }, to: { lat: -37.7, lng: 144.8 } })
  check('travel: unauthenticated → 401', r.status === 401, r)
  r = await http(A, 'POST', '/api/travel/google', { from: { lat: -37.8, lng: 144.9 }, to: { lat: -37.7, lng: 144.8 } })
  check('travel: Neon session authenticates (not 401/403)', r.status !== 401 && r.status !== 403, r.status)

  const failed = checks.filter((c) => !c.ok)
  const report = { schema: 'fat.work256.neon-dev-e2e/v1', base: BASE, run: RUN, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, facts, checks }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(2) })
