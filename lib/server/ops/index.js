// ─── FAT domain operation registry (WORK-256, Neon backend) ──────────────────
// The complete server surface the browser can reach on FAT_BACKEND=neon (besides
// /api/auth and /api/travel/google). Every operation:
//   * runs inside the caller's transaction (SET LOCAL ROLE fat_app +
//     fat.app_user_id = the session-derived identity — lib/server/route.js);
//   * takes the acting identity from `appUserId`, NEVER from `input`;
//   * validates its input explicitly;
//   * reuses the same domain queries the Supabase path runs in the browser.
// Payments / payslip / reconciliation operations are deliberately absent:
// Payments is dark on the Neon path (WORK-257).

import { loadFinancialYears, switchActiveFinancialYear, createFinancialYear } from '../../fy/fyRepository.js'
import { loadRateCatalog, addMemberClassification, removeMemberClassification } from '../../calculations/ratesRepository.js'
import { loadProfileBundle, saveProfile, loadClaimFormProfile, listActiveStations } from '../../profile/profileRepository.js'
import { createAddressCache } from '../../distance/addressCache.js'
import { matrixQueries } from '../../distance/matrix/matrixClient.js'
import { CLASSIFICATIONS } from '../../fat/rates/rateModel.js'
import { CLAIM_OPERATIONS } from './claims.js'
import { RequestError } from '../route.js'
import { uuid, int, num, str, date, oneOf, args } from './validate.js'

const FY_LABEL = /^\d{4}FY$/
const CLASSIFICATION_CODES = CLASSIFICATIONS.map((c) => (typeof c === 'string' ? c : c.code))

async function identityEmail(db) {
  const rows = await db.query('select email from fat.app_identities where id = fat.current_app_user_id()')
  if (!rows[0]?.email) throw new RequestError('identity not found', 'NO_IDENTITY', 403)
  return rows[0].email
}

const ops = {
  // ── Session ─────────────────────────────────────────────────────────────
  'session.get': async ({ db, appUserId, user }) => ({
    user: { id: appUserId, email: await identityEmail(db), emailVerified: user.emailVerified === true },
  }),

  // ── Financial years ─────────────────────────────────────────────────────
  'fy.load': ({ db, appUserId }) => loadFinancialYears(db.fat, appUserId),
  'fy.switch': async ({ db, appUserId, input }) => {
    await switchActiveFinancialYear(db.fat, appUserId, uuid(input.fyId, 'fyId'))
    return { ok: true }
  },
  'fy.create': ({ db, appUserId, input }) => createFinancialYear(db.fat, appUserId, str(input.label, 'label', { nullable: false, pattern: FY_LABEL })),

  // ── Rates / classifications ─────────────────────────────────────────────
  'rates.load': ({ db, appUserId }) => loadRateCatalog(db.fat, appUserId),
  'rates.addClassification': async ({ db, appUserId, input }) => {
    await addMemberClassification(db.fat, appUserId, {
      classification: oneOf(input.classification, 'classification', CLASSIFICATION_CODES),
      effectiveFrom: date(input.effectiveFrom, 'effectiveFrom'),
      sourceRef: str(input.sourceRef, 'sourceRef', { nullable: false, max: 500 }),
    })
    return { ok: true }
  },
  'rates.removeClassification': async ({ db, appUserId, input }) => {
    await removeMemberClassification(db.fat, appUserId, uuid(input.id, 'id'))
    return { ok: true }
  },

  // ── Profile / stations ──────────────────────────────────────────────────
  'profile.load': ({ db, appUserId }) => loadProfileBundle(db.fat, appUserId),
  'profile.save': async ({ db, appUserId, input }) => {
    await saveProfile(db.fat, appUserId, {
      email: await identityEmail(db),
      firstName: str(input.firstName, 'firstName', { max: 200 }) ?? '',
      lastName: str(input.lastName, 'lastName', { max: 200 }) ?? '',
      stationId: int(input.stationId, 'stationId', { min: 0, nullable: true }),
      stationLabel: str(input.stationLabel, 'stationLabel', { max: 300 }),
      homeAddress: str(input.homeAddress, 'homeAddress', { max: 500 }) ?? '',
      platoon: str(input.platoon, 'platoon', { max: 20 }),
      payNumber: str(input.payNumber, 'payNumber', { max: 50 }),
    })
    return { ok: true }
  },
  'profile.claimForm': ({ db, appUserId }) => loadClaimFormProfile(db.fat, appUserId),
  'stations.list': ({ db }) => listActiveStations(db.fat),

  // ── Home address / station distance cache (args mirror lib/distance/addressCache.js,
  //    the leading userId argument is replaced by the session identity) ──
  'address.getHomeAddress': ({ db, appUserId }) => createAddressCache(db.fat).getHomeAddress(appUserId),
  'address.saveHomeAddress': async ({ db, appUserId, input }) => {
    const [text, lat, lng, status] = args(input, 4)
    return createAddressCache(db.fat).saveHomeAddress(appUserId,
      str(text, 'addressText', { nullable: false, max: 500 }), num(lat, 'lat'), num(lng, 'lng'),
      oneOf(status, 'geocodeStatus', ['ok', 'pending', 'failed', 'not_found', 'error']))
  },
  'address.getStationDistance': ({ db, appUserId, input }) => {
    const [stationId] = args(input, 1)
    return createAddressCache(db.fat).getStationDistance(appUserId, int(stationId, 'stationId', { min: 0 }))
  },
  'address.saveDistanceEstimate': async ({ db, appUserId, input }) => {
    const [stationId, hash, version, est, sLat, sLng] = args(input, 6)
    await createAddressCache(db.fat).saveDistanceEstimate(appUserId, int(stationId, 'stationId', { min: 0 }),
      str(hash, 'homeAddressHash', { nullable: false, max: 500 }), int(version, 'homeAddressVersion', { min: 0 }),
      num(est, 'estimatedDistanceKm'), num(sLat, 'stationLat'), num(sLng, 'stationLng'))
    return { ok: true }
  },
  'address.saveConfirmedDistance': async ({ db, appUserId, input }) => {
    const [stationId, hash, version, est, confirmed, source, sLat, sLng] = args(input, 8)
    await createAddressCache(db.fat).saveConfirmedDistance(appUserId, int(stationId, 'stationId', { min: 0 }),
      str(hash, 'homeAddressHash', { nullable: false, max: 500 }), int(version, 'homeAddressVersion', { min: 0 }),
      num(est, 'estimatedDistanceKm'), num(confirmed, 'confirmedDistanceKm', { nullable: false }),
      str(source, 'confirmationSource', { max: 50 }), num(sLat, 'stationLat'), num(sLng, 'stationLng'))
    return { ok: true }
  },
  'address.markAllDistancesStale': async ({ db, appUserId, input }) => {
    const [reason] = args(input, 1)
    await createAddressCache(db.fat).markAllDistancesStale(appUserId, str(reason, 'reason', { max: 100 }) ?? undefined)
    return { ok: true }
  },

  // ── Travel matrix (reference data) ──────────────────────────────────────
  'matrix.activeVersionByUnit': ({ db, input }) => matrixQueries.activeVersionByUnit(db.fat, oneOf(input.unit, 'unit', ['hours', 'km'])),
  'matrix.hoursRows': ({ db, input }) => matrixQueries.hoursRows(db.fat, int(input.originId, 'originId', { min: 0 }), int(input.destId, 'destId', { min: 0 })),
  'matrix.kmCell': ({ db, input }) => matrixQueries.kmCell(db.fat, uuid(input.versionId, 'versionId'), int(input.a, 'a', { min: 0 }), int(input.b, 'b', { min: 0 })),
  'matrix.activeVersion': ({ db }) => matrixQueries.activeVersion(db.fat),

  // ── Canonical claims ────────────────────────────────────────────────────
  ...CLAIM_OPERATIONS,
}

/** Frozen, prototype-free registry: only these names are routable. */
export const OPERATIONS = Object.freeze(Object.assign(Object.create(null), ops))
