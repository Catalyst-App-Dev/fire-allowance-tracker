// Input validation helpers for FAT domain operations (WORK-256).
import { RequestError } from '../route.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/

export function uuid(v, name) {
  if (typeof v !== 'string' || !UUID.test(v)) throw new RequestError(`${name} must be a UUID`)
  return v
}
export function int(v, name, { min = -Infinity, max = Infinity, nullable = false } = {}) {
  if (nullable && (v === null || v === undefined || v === '')) return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new RequestError(`${name} must be an integer`)
  return n
}
export function num(v, name, { nullable = true } = {}) {
  if (nullable && (v === null || v === undefined || v === '')) return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw new RequestError(`${name} must be a number`)
  return n
}
export function str(v, name, { max = 2000, nullable = true, pattern = null } = {}) {
  if (nullable && (v === null || v === undefined)) return null
  if (typeof v !== 'string' || v.length > max) throw new RequestError(`${name} must be a string`)
  if (pattern && !pattern.test(v)) throw new RequestError(`${name} has an invalid format`)
  return v
}
export function date(v, name, { nullable = false } = {}) {
  if (nullable && (v === null || v === undefined || v === '')) return null
  if (typeof v !== 'string' || !DATE.test(v)) throw new RequestError(`${name} must be YYYY-MM-DD`)
  return v
}
export function oneOf(v, name, allowed) {
  if (!allowed.includes(v)) throw new RequestError(`${name} must be one of ${allowed.join(', ')}`)
  return v
}
export function args(input, n) {
  const a = Array.isArray(input?.args) ? input.args : []
  if (a.length > n) throw new RequestError('too many arguments')
  return a
}
