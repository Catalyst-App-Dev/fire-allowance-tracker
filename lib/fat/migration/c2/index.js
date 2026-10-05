// ─── C2 transform-copy tool (WORK-190) — public entry ───────────────────────
// Contract: docs/architecture/C2_TRANSFORM_CONTRACT.md. CLI: scripts/c2-transform.mjs.

export { planC2 } from './plan.js'
export { extractSql, fixtureSnapshotSql, applySql, verifySql, rollbackSql, syntheticHarnessSql, checkVerify, planPayload, planSha256, fixtureJson } from './sql.js'
export { canonicalJson, sha256Json, normalise } from './util.js'
export { TOOL, REPORT_SCHEMA, SNAPSHOT_SCHEMA } from './constants.js'

import { SNAPSHOT_SCHEMA, SOURCE_TABLES } from './constants.js'
import { canonicalJson, sha256Json, normalise } from './util.js'

/**
 * Bind a synthetic fixture's placeholders to a real environment snapshot:
 *   {{OWNER}}  the first profile (by id) owning the FY starting 2025-07-01
 *   {{FY2026}} that FY;  {{STN_A}} / {{STN_B}} the two lowest station ids.
 * Deterministic. The fixture keeps no real identifier in the repository.
 */
export function bindFixture(fixture, snapshot) {
  const fys = snapshot.reference?.financial_years || []
  const profiles = [...(snapshot.reference?.profiles || [])].sort()
  const owner = profiles.find((p) => fys.some((f) => f.user_id === p && f.start_date === '2025-07-01'))
  if (!owner) throw new Error('bindFixture: no profile owns an FY starting 2025-07-01')
  const fy = fys.filter((f) => f.user_id === owner && f.start_date === '2025-07-01').sort((a, b) => (a.id < b.id ? -1 : 1))[0]
  const stations = (snapshot.reference?.stations || []).map((s) => Number(s.id)).sort((a, b) => a - b)
  return { schema: SNAPSHOT_SCHEMA, source: bindSource(fixture, { owner, fy: fy.id, stations }), reference: snapshot.reference, target: snapshot.target }
}

/** Replace the fixture placeholders with explicit values ({ owner, fy, stations: [a, b, …] }). */
export function bindSource(fixture, { owner, fy, stations }) {
  if (!owner || !fy || !stations || stations.length < 2) throw new Error('bindSource: owner, fy and two stations are required')
  const text = JSON.stringify(fixture.source)
    .replaceAll('"{{OWNER}}"', JSON.stringify(owner))
    .replaceAll('"{{FY2026}}"', JSON.stringify(fy))
    .replaceAll('"{{STN_A}}"', String(Number(stations[0])))
    .replaceAll('"{{STN_B}}"', String(Number(stations[1])))
  if (text.includes('{{')) throw new Error('bindSource: unbound placeholder')
  return JSON.parse(text)
}

/**
 * Plan B for the conflict proof: the same source with one standalone Spoilt
 * Meal's stored amount changed by +$1.00 (amount and total kept consistent).
 */
export function mutateSourceForConflict(snapshot) {
  const s = JSON.parse(JSON.stringify(snapshot))
  const groups = new Map((s.source.claim_groups || []).map((g) => [g.id, g]))
  const row = [...(s.source.spoilt_meals || [])].sort((a, b) => (a.id < b.id ? -1 : 1))
    .find((r) => groups.get(r.claim_group_id)?.claim_type === 'spoilt')
  if (!row) throw new Error('mutateSourceForConflict: no grouped spoilt meal')
  row.meal_amount = Number(row.meal_amount) + 1
  row.total_amount = Number(row.total_amount) + 1
  return s
}

/** Source checksum of a raw extracted source, for comparing extraction runs. */
export function sourceChecksumOf(source) {
  const o = {}
  for (const t of SOURCE_TABLES) o[t] = normalise([...(source?.[t] || [])]).sort((a, b) => (a.id < b.id ? -1 : 1))
  return sha256Json(o)
}

export const reportBytes = (report) => canonicalJson(report)
