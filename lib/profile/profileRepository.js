// ─── Profile / station data access (both backends, WORK-256) ────────────────
// Extracted from app/profile/page.js and components/claims/ClaimForm.js so the
// same queries run in the browser against the Supabase `fat` client or
// server-side against the Neon adapter under the verified session identity.

const STATION_COLUMNS = 'id, name, abbreviation, street_address, suburb, postcode, lat, lng'

/** Active stations (reference data). `columns` is one of the two shapes the UI uses. */
export async function listActiveStations(client, columns = 'id, name, abbreviation') {
  const cols = columns === 'full' ? STATION_COLUMNS : 'id, name, abbreviation'
  const { data, error } = await client.from('stations').select(cols).eq('is_active', true).order('id', { ascending: true })
  if (error) throw error
  return data || []
}

/** Profile page bundle: identity names, FAT profile extension, active stations. */
export async function loadProfileBundle(client, uid) {
  const [profileResult, extResult, stations] = await Promise.all([
    client.from('profiles').select('first_name, last_name').eq('id', uid).maybeSingle(),
    client.from('profile_ext').select('home_address, platoon, pay_number, station_id, home_dist_km').eq('user_id', uid).maybeSingle(),
    listActiveStations(client, 'full'),
  ])
  if (profileResult.error) throw profileResult.error
  if (extResult.error) throw extResult.error
  return { profile: profileResult.data || null, ext: extResult.data || null, stations }
}

/**
 * Save the profile (fat.profiles + fat.profile_ext). `email` must be the
 * authenticated identity's e-mail (server-supplied on the Neon path).
 */
export async function saveProfile(client, uid, { email, firstName, lastName, stationId, stationLabel, homeAddress, platoon, payNumber }) {
  const sid = stationId ? parseInt(stationId, 10) : null
  const { error: profileError } = await client.from('profiles').upsert({
    id: uid,
    email,
    first_name: (firstName || '').trim(),
    last_name: (lastName || '').trim(),
    // Canonical rostered station read by the entitlement engine
    // (lib/fat/engine/context.js § buildEngineContext); kept in lockstep with
    // profile_ext.station_id. Affects future claims only.
    rostered_station_id: sid,
  }, { onConflict: 'id' })
  if (profileError) throw profileError

  const { error: extError } = await client.from('profile_ext').upsert({
    user_id: uid,
    home_address: (homeAddress || '').trim(),
    platoon: platoon || null,
    station_id: sid,
    rostered_station_label: stationLabel || null,
    pay_number: (payNumber || '').trim() || null,
  }, { onConflict: 'user_id' })
  if (extError) throw extError
}

/** ClaimForm pre-fill: profile extension + rostered station bare name. */
export async function loadClaimFormProfile(client, uid) {
  const { data: ext, error } = await client
    .from('profile_ext')
    .select('station_id, home_dist_km, home_address, platoon')
    .eq('user_id', uid)
    .maybeSingle()
  if (error) throw error
  let stationName = ''
  if (ext?.station_id) {
    const { data: stn } = await client.from('stations').select('name').eq('id', ext.station_id).maybeSingle()
    stationName = stn?.name || ''
  }
  return { ext: ext || null, stationName }
}
