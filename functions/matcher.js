const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore }      = require('firebase-admin/firestore');

exports.matcher = onDocumentUpdated({
  document: 'opportunities/{oppId}',
  memory:   '256MiB',
}, async (event) => {
  const after  = event.data.after.data();
  const before = event.data.before.data();

  // Only run when Analyst just finished (analyst_version went from 0 → 1)
  if (before.analyst_version === after.analyst_version) return;
  if (!after.analyst_done || !after.is_active) return;

  const db    = getFirestore();
  const users = await db.collection('users').get();

  const batch = db.batch();

  users.forEach(userDoc => {
    const prefs = userDoc.data().prefs || {};
    const score = scoreMatch(after, prefs);
    if (score === 0) return; // no match at all, don't notify

    // Write match score into a sub-collection for efficient per-user queries
    const matchRef = db
      .collection('users').doc(userDoc.id)
      .collection('matches').doc(event.params.oppId);

    batch.set(matchRef, {
      opp_id:       event.params.oppId,
      score,
      notified:     false,
      created_at:   new Date(),
    });
  });

  await batch.commit();
  console.log(`Matcher: scored "${after.title}" against ${users.size} users.`);
});

function scoreMatch(opp, prefs) {
  let score = 0;

  // Field/industry match
  const userFields  = (prefs.fields || []).map(f => f.toLowerCase());
  const oppIndustry = (opp.industry || []).map(i => i.toLowerCase());
  if (userFields.some(f => oppIndustry.some(i => i.includes(f) || f.includes(i)))) score += 40;

  // Region match
  const userLocs = (prefs.locations || ['Nigeria']).map(l => l.toLowerCase());
  const oppRegions = (opp.target_regions || ['Global']).map(r => r.toLowerCase());
  if (oppRegions.includes('global') || userLocs.some(l => oppRegions.includes(l))) score += 30;

  // Keyword match
  const kw = (prefs.keywords || []).map(k => k.toLowerCase());
  const haystack = `${opp.title} ${opp.about} ${opp.requirements}`.toLowerCase();
  if (kw.some(k => haystack.includes(k))) score += 20;

  // Funding type bonus — fully funded always surfaced
  if (opp.funding_type === 'fully_funded') score += 10;

  return score;
}
