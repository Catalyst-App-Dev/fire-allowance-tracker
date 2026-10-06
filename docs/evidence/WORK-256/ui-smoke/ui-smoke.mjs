// WORK-256 — browser UI smoke of the Neon DEV path (synthetic user only).
// Not part of the app or its dependencies: needs `playwright-core` installed alongside.
//   BASE_URL=http://localhost:3001 CHROMIUM_PATH=/path/to/chrome SHOTS_DIR=./shots node ui-smoke.mjs > report.json
import { chromium } from 'playwright-core'
const S = process.env.SHOTS_DIR || '.'
const BASE = process.env.BASE_URL || 'http://localhost:3001'
const run = Date.now().toString(36)
const email = `work256-ui-${run}@example.invalid`
const pw = `Synthetic-${run}-Pass!`
const out = { email, steps: [], log: [], external: new Set() }
const step = (name, ok, detail) => { out.steps.push({ name, ok: !!ok, detail: detail ?? null }); if (!ok) console.error('✗', name, detail ?? '') }
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const ctx = await browser.newContext({ viewport: { width: 430, height: 1000 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => out.log.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') out.log.push('console: ' + m.text()) })
page.on('request', (r) => { const u = r.url(); if (!u.startsWith(BASE) && !u.startsWith('data:')) out.external.add(new URL(u).host) })
page.on('requestfailed', (r) => out.log.push('requestfailed: ' + r.method() + ' ' + r.url().replace(BASE,'') + ' ' + (r.failure()?.errorText) + ' @' + new Date().toISOString()))
page.on('framenavigated', (f) => { if (f === page.mainFrame()) out.log.push('nav: ' + f.url().replace(BASE,'') + ' @' + new Date().toISOString()) })
page.on('response', (r) => { if (r.status() === 401) out.log.push('401: ' + r.url().replace(BASE,'') + ' @' + new Date().toISOString()) })
const shot = (n) => page.screenshot({ path: `${S}/${n}.png`, fullPage: true })
const op = (name, input = {}) => page.evaluate(async ([n, i]) => {
  const r = await fetch(`/api/fat/${n}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(i) })
  return { status: r.status, json: await r.json().catch(() => null) }
}, [name, input])
const inputAfterLabel = (text) => page.locator(`label:has-text("${text}") + input, label:has-text("${text}") ~ input`).first()
const selectAfterLabel = (text) => page.locator(`label:has-text("${text}") ~ select`).first()

try {
  // 1. Sign up → dashboard
  await page.goto(`${BASE}/signup`)
  await page.fill('#email', email); await page.fill('#password', pw); await page.fill('#confirmPassword', pw)
  await page.click('button[type=submit]')
  await page.waitForURL(`${BASE}/`, { timeout: 30000 })
  await page.getByText('+ Retain').waitFor({ timeout: 60000 })
  step('signup → dashboard renders (FY + rates + claims loaded)', true)
  await shot('10-dashboard-empty')

  // 2. Profile (station via the domain op, names via the UI)
  const ps = await op('profile.save', { firstName: 'Ui', lastName: 'Smoke', stationId: 9001, stationLabel: 'Synthetic Station 9001', homeAddress: '1 Example St, Testville', platoon: 'C' })
  step('profile: set rostered station 9001', ps.status === 200, ps)
  await page.goto(`${BASE}/profile`)
  await page.waitForFunction(() => [...document.querySelectorAll('input')].some((i) => i.value === 'Ui'), null, { timeout: 60000 })
  step('profile page loads saved values', true)
  await shot('11-profile')

  // 3. Settings (rates + classification)
  await page.goto(`${BASE}/settings`)
  await page.waitForTimeout(4000)
  const settingsText = await page.textContent('body')
  step('settings page renders the rate catalog', /rate|Rate/.test(settingsText || ''), null)
  await shot('12-settings')
  const cl = await op('rates.addClassification', { classification: 'lff', effectiveFrom: '2026-07-01', sourceRef: 'WORK-256 UI smoke' })
  step('classification recorded', cl.status === 200, cl)

  // 4. New Spoilt Meal claim through the form
  await page.goto(`${BASE}/`)
  await page.getByText('+ Spoilt Meal').waitFor({ timeout: 60000 })
  await page.getByText('+ Spoilt Meal').click()
  await page.getByText('FROM PROFILE').first().waitFor({ timeout: 60000 })
  await page.waitForTimeout(1500)
  await page.fill('#meal-firecall-number-input', '34567')
  await inputAfterLabel('Incident Time').fill('12:40')
  await selectAfterLabel('emergency call').selectOption('yes')
  await page.getByText('Spoilt meal allowance').first().waitFor({ timeout: 60000 })
  await shot('13-spoilt-form-preview')
  const submitText = await page.locator('button[type=submit]').last().textContent()
  step('form: canonical preview + submit label', /1 entitlement/.test(submitText || ''), submitText)
  await page.locator('button[type=submit]').last().click()
  await page.getByText('Claim saved successfully!').waitFor({ timeout: 60000 })
  step('form: spoilt meal claim saved', true)

  // 5. New Retain claim (night, interrupted) through the form
  await page.getByText('+ Retain').click()
  await page.waitForTimeout(2500)
  const shiftSelect = selectAfterLabel('Shift Type')
  if (await shiftSelect.count()) await shiftSelect.selectOption('Night')
  else await page.locator('button:has-text("Night")').first().click()
  await inputAfterLabel('Booked Off Time').fill('09:30')
  await selectAfterLabel('night shift interrupted').selectOption('yes')
  await inputAfterLabel('Travel home').fill('45')
  await page.getByText('Retain overtime').first().waitFor({ timeout: 60000 })
  await shot('14-retain-form-preview')
  const retainSubmit = await page.locator('button[type=submit]').last().textContent()
  step('form: retain preview has 3 entitlements', /3 entitlements/.test(retainSubmit || ''), retainSubmit)
  await page.locator('button[type=submit]').last().click()
  await page.getByText('Claim saved successfully!').waitFor({ timeout: 60000 })
  step('form: retain claim saved', true)
  await page.waitForTimeout(2500)
  await shot('15-dashboard-two-claims')

  // 6. List + expand + override edit
  const body = await page.textContent('body')
  step('list: both claims shown with numbers', /Spoilt Meal #1/.test(body) && /Retain #1/.test(body), null)
  await page.getByText('Retain #1').first().click()
  await page.getByText('Retain overtime').first().waitFor({ timeout: 20000 })
  const expanded = await page.textContent('body')
  step('list: hours shown with estimate (hours-first)', /4\.00 h/.test(expanded) && /est\./.test(expanded), null)
  step('list: no Mark Paid toggle on canonical rows', !(await page.getByText('Mark Paid').count()), null)
  await shot('16-retain-expanded')
  await page.getByText('Spoilt Meal #1').first().click()
  await page.getByText('Spoilt meal allowance').first().waitFor({ timeout: 20000 })
  const editButtons = page.locator('button:has-text("Edit")')
  const n = await editButtons.count()
  await editButtons.nth(n - 1).click()
  await page.getByText('Edit Entitlement').waitFor({ timeout: 10000 })
  await shot('17-edit-entitlement')
  await page.locator('input[type=number]').last().fill('19.50')
  await page.locator('input[type=text]').last().fill('UI smoke: receipt amount')
  await page.getByText('Save Override').click()
  await page.getByText('Edit Entitlement').waitFor({ state: 'detached', timeout: 30000 })
  await page.waitForTimeout(2000)

  // 7. Reload persistence
  await page.reload()
  await page.getByText('Spoilt Meal #1').first().waitFor({ timeout: 60000 })
  await page.getByText('Spoilt Meal #1').first().click()
  await page.waitForTimeout(1000)
  const afterReload = await page.innerText('body')
  step('reload: override persisted ($19.50, Adj)', /\$19\.50/.test(afterReload) && /Adj/.test(afterReload), null)
  await shot('18-after-reload')

  // 8. Tax page + Payments dark
  await page.goto(`${BASE}/tax`)
  await page.getByText('Total Meals').first().waitFor({ timeout: 90000 })
  const tax = await page.innerText('body')
  step('tax page: canonical meals (spoilt $19.50 override + retain $20.53 = $40.03)', /Total Meals \(2\)/.test(tax || '') && /40\.03/.test(tax || ''), (tax || '').slice(0, 400))
  await shot('19-tax')
  await page.goto(`${BASE}/payments`)
  await page.waitForTimeout(2500)
  const pay = await page.textContent('body')
  step('payments page is dark/unavailable on Neon', /isn.t available yet|not enabled/i.test(pay || ''), (pay || '').slice(0, 200))
  await shot('20-payments-dark')
  await page.goto(`${BASE}/payments/imports`)
  await page.waitForTimeout(2000)
  step('payslip imports page is dark', /isn.t available yet|not enabled/i.test((await page.textContent('body')) || ''), null)

  // 9. Delete claim
  await page.goto(`${BASE}/`)
  await page.getByText('Retain #1').first().waitFor({ timeout: 60000 })
  await page.getByText('Retain #1').first().click()
  await page.getByText('Delete Claim').first().click()
  await page.locator('button:has-text("Delete Claim")').last().click()
  await page.waitForTimeout(4000)
  const afterDelete = await page.textContent('body')
  step('delete: claim removed', !/Retain #1/.test(afterDelete), null)
  await shot('21-after-delete')

  // 10. Sign out → protected route redirects
  await page.getByText('Logout').first().click()
  await page.waitForURL(`${BASE}/login`, { timeout: 30000 })
  await page.goto(`${BASE}/settings`)
  await page.waitForURL(`${BASE}/login`, { timeout: 30000 })
  step('sign-out: protected page redirects to /login', true)
  // 11. Sign back in → data still there
  await page.fill('#email', email); await page.fill('#password', pw)
  await page.click('button[type=submit]')
  await page.waitForURL(`${BASE}/`, { timeout: 30000 })
  await page.getByText('Spoilt Meal #1').first().waitFor({ timeout: 60000 })
  step('sign-in again: same member data restored', true)
  await shot('22-signed-in-again')
} catch (e) {
  step('exception', false, e.message)
  await shot('99-error')
}
out.external = [...out.external]
out.passed = out.steps.filter((s) => s.ok).length
out.failed = out.steps.filter((s) => !s.ok).length
console.log(JSON.stringify(out, null, 1))
await browser.close()
process.exit(out.failed ? 1 : 0)
