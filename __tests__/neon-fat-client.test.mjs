// WORK-256 — server PostgREST-shaped adapter: SQL generation and guards (pure).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFatClient, FatClientError } from '../lib/server/fatClient.js'

function recorder(rows = []) {
  const calls = []
  const query = async (sql, params) => { calls.push({ sql, params }); return typeof rows === 'function' ? rows(sql, params) : rows }
  return { calls, client: createFatClient(query) }
}

test('select with filters/order/limit is fully parameterised and schema-qualified', async () => {
  const { calls, client } = recorder([{ id: 1 }])
  const r = await client.from('financial_years').select('id, label').eq('user_id', 'u1').in('label', ['2026FY', '2027FY']).is('created_at', null).order('start_date', { ascending: false }).limit(5)
  assert.deepEqual(r, { data: [{ id: 1 }], error: null, count: null })
  assert.equal(calls[0].sql, 'select "id", "label" from fat."financial_years" where "user_id" = $1 and "label" = any($2) and "created_at" is null order by "start_date" desc limit 5')
  assert.deepEqual(calls[0].params, ['u1', ['2026FY', '2027FY']])
})

test('non-allowlisted tables, injected identifiers and functions are refused', async () => {
  const { client } = recorder()
  assert.throws(() => client.from('users'), FatClientError)
  assert.throws(() => client.from('neon_auth.user'), FatClientError)
  assert.throws(() => client.from('stations').select('id; drop table x'), FatClientError)
  assert.throws(() => client.from('stations').select('*').eq('id"; --', 1), FatClientError)
  const r = await client.rpc('ensure_app_identity', { p_id: null })
  assert.equal(r.error.code, 'FAT_RPC')
})

test('update binds values before filters; unfiltered update/delete are refused', async () => {
  const { calls, client } = recorder()
  await client.from('financial_years').update({ is_active: true }).eq('id', 'f1').eq('user_id', 'u1')
  assert.equal(calls[0].sql, 'update fat."financial_years" set "is_active" = $1 where "id" = $2 and "user_id" = $3')
  assert.deepEqual(calls[0].params, [true, 'f1', 'u1'])
  const u = await client.from('financial_years').update({ is_active: false })
  const d = await client.from('financial_years').delete()
  assert.equal(u.error.code, 'FAT_WRITE')
  assert.equal(d.error.code, 'FAT_WRITE')
  assert.equal(calls.length, 1, 'refused writes never reach the database')
})

test('upsert builds ON CONFLICT; objects bind as JSON; returning on .select()', async () => {
  const { calls, client } = recorder([{ id: 'x' }])
  const r = await client.from('home_address').upsert({ user_id: 'u', address_text: 'a', meta: { k: 1 } }, { onConflict: 'user_id' }).select().single()
  assert.equal(r.data.id, 'x')
  assert.match(calls[0].sql, /^insert into fat."home_address" \("user_id", "address_text", "meta"\) values \(\$1, \$2, \$3\) on conflict \("user_id"\) do update set "address_text" = excluded."address_text", "meta" = excluded."meta" returning \*$/)
  assert.equal(calls[0].params[2], '{"k":1}')
  await client.from('financial_years').upsert({ user_id: 'u', label: 'L' }, { onConflict: 'user_id,label', ignoreDuplicates: true })
  assert.match(calls[1].sql, /on conflict \("user_id", "label"\) do nothing$/)
})

test('single / maybeSingle follow PostgREST semantics; errors are returned, not thrown', async () => {
  const two = recorder([{ a: 1 }, { a: 2 }]).client
  assert.equal((await two.from('stations').select('*').single()).error.code, 'PGRST116')
  assert.equal((await recorder([]).client.from('stations').select('*').maybeSingle()).data, null)
  const failing = createFatClient(async () => { throw Object.assign(new Error('permission denied'), { code: '42501' }) })
  const r = await failing.from('stations').select('*')
  assert.equal(r.error.code, '42501')
  assert.equal(r.data, null)
})

test('allowlisted rpc: scalar vs set shapes, named bind parameters', async () => {
  const { calls, client } = recorder((sql) => (sql.includes('increment_claim_sequence') ? [{ v: 7 }] : [{ value: 1 }]))
  const n = await client.rpc('increment_claim_sequence', { p_user_id: 'u', p_financial_year_id: 'f', p_claim_type: 'RC' })
  assert.equal(n.data, 7)
  assert.equal(calls[0].sql, 'select fat."increment_claim_sequence"("p_user_id" => $1, "p_financial_year_id" => $2, "p_claim_type" => $3) as v')
  const set = await client.rpc('travel_matrix_lookup', { p_origin_id: 1, p_dest_id: 2 })
  assert.deepEqual(set.data, [{ value: 1 }])
})

test('head count and not() filters', async () => {
  const { calls, client } = recorder([{ __count: 4 }])
  const r = await client.from('payslip_imports').select('id', { count: 'exact', head: true }).not('status', 'in', '(superseded,rejected)').not('payment_record_id', 'is', null)
  assert.equal(r.count, 4)
  assert.equal(calls[0].sql, 'select count(*)::int as __count from fat."payslip_imports" where not ("status" = any($1)) and "payment_record_id" is not null')
  assert.deepEqual(calls[0].params, [['superseded', 'rejected']])
})
