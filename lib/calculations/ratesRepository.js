// ─── Rate catalog + member classification access (both backends, WORK-256) ─
// Extracted verbatim from RatesContext. Runs in the browser against the
// Supabase `fat` client, or server-side against the Neon adapter under the
// verified session identity (`uid` is then always the session's identity).

/** Global versioned catalog (live versions only) + the member's classification history. */
export async function loadRateCatalog(client, uid) {
  const [ratesRes, versionsRes, classRes] = await Promise.all([
    client.from('rates').select('id, code, display_name, unit, description'),
    client.from('rate_versions')
      .select('id, rate_id, version_label, value, effective_from, classification, source_kind, source_ref, withdrawn_at')
      .is('withdrawn_at', null),
    client.from('member_classifications')
      .select('id, classification, effective_from, source_ref, created_at')
      .eq('owner_id', uid)
      .order('effective_from', { ascending: false }),
  ])
  if (ratesRes.error) throw ratesRes.error
  if (versionsRes.error) throw versionsRes.error
  if (classRes.error) throw classRes.error
  return {
    catalog: { rates: ratesRes.data || [], versions: versionsRes.data || [] },
    classificationHistory: classRes.data || [],
  }
}

/** Append a classification (effective-dated). History is never edited in place. */
export async function addMemberClassification(client, uid, { classification, effectiveFrom, sourceRef }) {
  const { error } = await client.from('member_classifications').insert({
    owner_id: uid, classification, effective_from: effectiveFrom, source_ref: sourceRef,
  })
  if (error) throw error
}

export async function removeMemberClassification(client, uid, id) {
  const { error } = await client.from('member_classifications').delete().eq('id', id).eq('owner_id', uid)
  if (error) throw error
}
