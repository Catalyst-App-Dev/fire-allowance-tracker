// ─── FAT server data layer — PostgREST-shaped adapter over one transaction ───
// WORK-256. The existing FAT domain services and the canonical entitlement
// engine (lib/fat/engine/*) were written against the supabase-js query builder.
// This adapter implements exactly the narrow subset they use, translated to
// parameterised SQL over ONE database transaction that the caller has already
// bound to a role and an app identity (lib/server/db.js withMemberTx). It lets
// those modules run server-side unchanged on Neon.
//
// It is NEVER exposed to the browser and never reachable as a generic query
// endpoint: only domain route handlers (app/api/fat/*) construct it, inside
// their own transaction. Every table and function name is checked against an
// allowlist of `fat` objects; every identifier against a strict pattern; every
// value is a bind parameter. Row-level security still decides what any query
// can see or change — this layer adds no authority.
//
// Result contract mirrors supabase-js: `await builder` → { data, error, count }.
// Errors are returned (not thrown) with { message, code, details }.

const IDENT = /^[a-z_][a-z0-9_]*$/

export const FAT_TABLES = Object.freeze(new Set([
  'app_identities', 'claim_entitlements', 'claim_sequences', 'delayed_meal_details', 'entitlement_overrides',
  'entitlement_payment_links', 'financial_years', 'home_address', 'member_classifications', 'muster_dismiss_details',
  'operational_claims', 'payment_records', 'payslip_import_lines', 'payslip_imports', 'profile_ext', 'profiles',
  'rate_versions', 'rates', 'recall_details', 'reconciliation_audit', 'retain_details', 'spoilt_meal_details',
  'standby_details', 'station_aliases', 'station_distance_matrix', 'station_distances', 'station_time_matrix',
  'stations', 'travel_matrix_cells', 'travel_matrix_versions', 'user_feature_flags',
]))

// fat functions a member transaction may call, with their PostgREST result shape.
export const FAT_RPCS = Object.freeze({
  increment_claim_sequence: 'scalar',
  travel_matrix_lookup: 'set',
})

function ident(name, what) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new FatClientError(`invalid ${what} identifier: ${JSON.stringify(name)}`, 'FAT_IDENT')
  return name
}

function columnList(cols) {
  if (cols == null || cols === '' || cols === '*') return '*'
  return String(cols).split(',').map((c) => c.trim()).filter(Boolean).map((c) => `"${ident(c, 'column')}"`).join(', ')
}

export class FatClientError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

/** Value → bind parameter. Plain objects / arrays of objects are JSON (jsonb). */
function bindValue(v) {
  if (v === undefined) return null
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    if (!Array.isArray(v) || v.some((x) => x !== null && typeof x === 'object')) return JSON.stringify(v)
  }
  return v
}

function toError(e) {
  return { message: e?.message ?? String(e), code: e?.code ?? null, details: e?.detail ?? null, hint: e?.hint ?? null }
}

class Builder {
  constructor(query, table) {
    this._q = query
    this._table = `fat."${table}"`
    this._op = 'select'
    this._cols = '*'
    this._where = []
    this._params = []
    this._order = []
    this._limit = null
    this._single = null
    this._returning = null
    this._count = null
    this._head = false
  }

  _p(v) { this._params.push(bindValue(v)); return `$${this._params.length}` }

  select(cols = '*', opts = {}) {
    if (this._op === 'select') {
      this._cols = columnList(cols)
      if (opts.count === 'exact') this._count = true
      if (opts.head) this._head = true
    } else {
      this._returning = columnList(cols)
    }
    return this
  }

  insert(rows) { this._op = 'insert'; this._rows = Array.isArray(rows) ? rows : [rows]; return this }
  upsert(rows, opts = {}) {
    this._op = 'upsert'
    this._rows = Array.isArray(rows) ? rows : [rows]
    this._conflict = (opts.onConflict ?? '').split(',').map((c) => c.trim()).filter(Boolean).map((c) => ident(c, 'conflict column'))
    this._ignoreDuplicates = !!opts.ignoreDuplicates
    return this
  }
  update(values) { this._op = 'update'; this._values = values; return this }
  delete() { this._op = 'delete'; return this }

  eq(col, v) { this._where.push(`"${ident(col, 'column')}" = ${this._p(v)}`); return this }
  neq(col, v) { this._where.push(`"${ident(col, 'column')}" <> ${this._p(v)}`); return this }
  gt(col, v) { this._where.push(`"${ident(col, 'column')}" > ${this._p(v)}`); return this }
  gte(col, v) { this._where.push(`"${ident(col, 'column')}" >= ${this._p(v)}`); return this }
  lt(col, v) { this._where.push(`"${ident(col, 'column')}" < ${this._p(v)}`); return this }
  lte(col, v) { this._where.push(`"${ident(col, 'column')}" <= ${this._p(v)}`); return this }
  in(col, arr) { this._where.push(`"${ident(col, 'column')}" = any(${this._p(Array.isArray(arr) ? arr : [arr])})`); return this }
  match(obj) { for (const [k, v] of Object.entries(obj ?? {})) this.eq(k, v); return this }
  is(col, v) {
    const c = `"${ident(col, 'column')}"`
    if (v === null) this._where.push(`${c} is null`)
    else if (v === true) this._where.push(`${c} is true`)
    else if (v === false) this._where.push(`${c} is false`)
    else throw new FatClientError(`is(): unsupported value ${JSON.stringify(v)}`, 'FAT_FILTER')
    return this
  }
  not(col, op, v) {
    const c = `"${ident(col, 'column')}"`
    if (op === 'is' && v === null) this._where.push(`${c} is not null`)
    else if (op === 'eq') this._where.push(`${c} is distinct from ${this._p(v)}`)
    else if (op === 'in') {
      const list = Array.isArray(v) ? v : String(v).replace(/^\(|\)$/g, '').split(',').map((s) => s.trim()).filter(Boolean)
      this._where.push(`not (${c} = any(${this._p(list)}))`)
    } else throw new FatClientError(`not(): unsupported operator ${op}`, 'FAT_FILTER')
    return this
  }

  order(col, opts = {}) {
    const dir = opts.ascending === false ? 'desc' : 'asc'
    const nulls = opts.nullsFirst === true ? ' nulls first' : opts.nullsFirst === false ? ' nulls last' : ''
    this._order.push(`"${ident(col, 'column')}" ${dir}${nulls}`)
    return this
  }
  limit(n) {
    const v = Number(n)
    if (!Number.isInteger(v) || v < 0) throw new FatClientError('limit(): integer expected', 'FAT_FILTER')
    this._limit = v
    return this
  }
  single() { this._single = 'single'; return this }
  maybeSingle() { this._single = 'maybe'; return this }

  _whereSql() { return this._where.length ? ` where ${this._where.join(' and ')}` : '' }

  _sql() {
    if (this._op === 'select') {
      if (this._head) return `select count(*)::int as __count from ${this._table}${this._whereSql()}`
      let sql = `select ${this._cols}${this._count ? ', count(*) over ()::int as __count' : ''} from ${this._table}${this._whereSql()}`
      if (this._order.length) sql += ` order by ${this._order.join(', ')}`
      if (this._limit != null) sql += ` limit ${this._limit}`
      return sql
    }
    const ret = this._returning ? ` returning ${this._returning}` : ''
    if (this._op === 'insert' || this._op === 'upsert') {
      if (!this._rows.length) throw new FatClientError('insert(): no rows', 'FAT_WRITE')
      const cols = [...new Set(this._rows.flatMap((r) => Object.keys(r)))].map((c) => ident(c, 'column'))
      const values = this._rows.map((r) => `(${cols.map((c) => (r[c] === undefined ? 'default' : this._p(r[c]))).join(', ')})`)
      let sql = `insert into ${this._table} (${cols.map((c) => `"${c}"`).join(', ')}) values ${values.join(', ')}`
      if (this._op === 'upsert') {
        if (!this._conflict.length) throw new FatClientError('upsert(): onConflict is required', 'FAT_WRITE')
        const target = `(${this._conflict.map((c) => `"${c}"`).join(', ')})`
        const set = cols.filter((c) => !this._conflict.includes(c)).map((c) => `"${c}" = excluded."${c}"`)
        sql += this._ignoreDuplicates || !set.length ? ` on conflict ${target} do nothing` : ` on conflict ${target} do update set ${set.join(', ')}`
      }
      return sql + ret
    }
    if (!this._where.length) throw new FatClientError(`${this._op}(): refusing an unfiltered ${this._op}`, 'FAT_WRITE')
    if (this._op === 'update') {
      const entries = Object.entries(this._values ?? {}).filter(([, v]) => v !== undefined)
      if (!entries.length) throw new FatClientError('update(): no values', 'FAT_WRITE')
      // Values first, then filters: rebuild params in that order.
      const whereParams = this._params
      this._params = []
      const set = entries.map(([k, v]) => `"${ident(k, 'column')}" = ${this._p(v)}`)
      const offset = this._params.length
      const where = this._where.map((w) => w.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`))
      this._params.push(...whereParams)
      return `update ${this._table} set ${set.join(', ')} where ${where.join(' and ')}${ret}`
    }
    return `delete from ${this._table}${this._whereSql()}${ret}`
  }

  async _run() {
    let rows
    try {
      rows = await this._q(this._sql(), this._params)
    } catch (e) {
      return { data: null, error: toError(e), count: null }
    }
    let count = null
    if (this._head) return { data: null, error: null, count: rows[0]?.__count ?? 0 }
    if (this._count) {
      count = rows[0]?.__count ?? 0
      rows = rows.map(({ __count, ...r }) => r)
    }
    const isWrite = this._op !== 'select'
    if (isWrite && !this._returning) return { data: null, error: null, count }
    if (this._single === 'single') {
      if (rows.length !== 1) return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})`, code: 'PGRST116', details: null, hint: null }, count }
      return { data: rows[0], error: null, count }
    }
    if (this._single === 'maybe') {
      if (rows.length > 1) return { data: null, error: { message: `multiple rows returned (${rows.length})`, code: 'PGRST116', details: null, hint: null }, count }
      return { data: rows[0] ?? null, error: null, count }
    }
    return { data: rows, error: null, count }
  }

  then(resolve, reject) { return this._run().then(resolve, reject) }
}

/**
 * @param {(sql: string, params: unknown[]) => Promise<object[]>} query — runs
 *   inside the caller's already-bound transaction and returns rows.
 */
export function createFatClient(query) {
  return {
    from(table) {
      if (!FAT_TABLES.has(table)) throw new FatClientError(`table not allowed: ${JSON.stringify(table)}`, 'FAT_TABLE')
      return new Builder(query, table)
    },
    async rpc(fn, args = {}) {
      const shape = FAT_RPCS[fn]
      if (!shape) return { data: null, error: { message: `function not allowed: ${fn}`, code: 'FAT_RPC', details: null, hint: null } }
      const params = []
      const named = Object.entries(args).map(([k, v]) => { params.push(bindValue(v)); return `"${ident(k, 'argument')}" => $${params.length}` })
      try {
        if (shape === 'scalar') {
          const rows = await query(`select fat."${fn}"(${named.join(', ')}) as v`, params)
          return { data: rows[0]?.v ?? null, error: null }
        }
        return { data: await query(`select * from fat."${fn}"(${named.join(', ')})`, params), error: null }
      } catch (e) {
        return { data: null, error: toError(e) }
      }
    },
  }
}
