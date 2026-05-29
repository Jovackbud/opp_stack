const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');

exports.matcher = onDocumentUpdated({
  document: 'opportunities/{oppId}',
  memory: '256MiB',
}, async (event) => {
  const after = event.data.after.data();
  const before = event.data.before.data();

  const analystChanged = before.analyst_version !== after.analyst_version;
  const approvalChanged = before.review_status !== 'approved' && after.review_status === 'approved';
  if (!analystChanged && !approvalChanged) return;
  if (!after.is_approved || !after.is_active) return;

  const db = getFirestore();
  const users = await db.collection('users').get();
  const batch = db.batch();

  users.forEach(userDoc => {
    const userData = userDoc.data();
    const score = scoreMatch(after, userData.profile || userData.prefs || {});
    if (score === 0) return;

    const matchRef = db
      .collection('users').doc(userDoc.id)
      .collection('matches').doc(event.params.oppId);

    batch.set(matchRef, {
      opp_id: event.params.oppId,
      score,
      notified: false,
      created_at: new Date(),
    });
  });

  await batch.commit();
  console.log(`Matcher: scored "${after.title}" against ${users.size} users.`);
});

function splitList(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
}

function scoreMatch(opp, profile) {
  let score = 0;
  const profileText = [
    profile.waec_neco,
    profile.jamb,
    profile.cgpa,
    profile.field_of_study,
    profile.school,
    profile.certifications,
    profile.nysc_status,
    profile.locations,
    profile.interests,
    profile.skills_volunteering,
    profile.linkedin,
    ...splitList(profile.fields),
    ...splitList(profile.keywords),
  ].filter(Boolean).join(' ').toLowerCase();

  const userFields = [
    ...splitList(profile.fields),
    ...splitList(profile.interests),
    profile.field_of_study,
  ].filter(Boolean).map(f => String(f).toLowerCase());
  const oppIndustry = (opp.industry || []).map(i => String(i).toLowerCase());
  if (userFields.some(f => oppIndustry.some(i => i.includes(f) || f.includes(i)))) score += 40;

  const userLocs = splitList(profile.locations || 'Nigeria').map(l => l.toLowerCase());
  const oppRegions = (opp.target_regions || ['Global']).map(r => String(r).toLowerCase());
  if (oppRegions.includes('global') || userLocs.some(l => oppRegions.includes(l))) score += 30;

  const keywords = [
    ...splitList(profile.keywords),
    ...splitList(profile.skills_volunteering),
    ...splitList(profile.certifications),
  ].map(k => String(k).toLowerCase());
  const haystack = `${opp.title} ${opp.about} ${opp.requirements} ${(opp.tags || []).join(' ')}`.toLowerCase();
  if (keywords.some(k => k && haystack.includes(k))) score += 20;

  const oppTags = [...(opp.tags || []), ...(opp.industry || []), opp.category, opp.funding_type]
    .filter(Boolean).map(t => String(t).toLowerCase());
  if (oppTags.some(t => t && profileText.includes(t))) score += 15;

  if (opp.funding_type === 'fully_funded') score += 10;
  return Math.min(score, 100);
}
