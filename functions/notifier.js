const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

exports.notifier = onSchedule({
  schedule:    'every day 07:00',   // 07:00 UTC = 08:00 WAT
  timeZone:    'Africa/Lagos',
  memory:      '256MiB',
  timeoutSeconds: 120,
}, async () => {
  const db  = getFirestore();
  const fcm = getMessaging();
  const now = Timestamp.now();

  // ── 1. New match notifications ────────────────────────────────────────────
  const users = await db.collection('users').get();

  for (const userDoc of users.docs) {
    const uid   = userDoc.id;
    const token = userDoc.data().fcm_token;
    if (!token) continue;

    // Get unnotified matches for this user
    const matches = await db.collection('users').doc(uid)
      .collection('matches')
      .where('notified', '==', false)
      .orderBy('score', 'desc')
      .limit(5)
      .get();

    if (matches.empty) continue;

    const count = matches.size;
    const top   = matches.docs[0].data();
    const opp   = await db.collection('opportunities').doc(top.opp_id).get();
    const oppData = opp.data() || {};

    try {
      await fcm.send({
        token,
        notification: {
          title: `${count} new match${count > 1 ? 'es' : ''} for you`,
          body:  `Top pick: ${oppData.title || 'New opportunity'} — tap to view`,
        },
        data: { type: 'new_matches', opp_id: top.opp_id },
        android: { priority: 'high' },
        apns:    { payload: { aps: { badge: count } } },
      });
    } catch (e) {
      console.warn(`Notifier: FCM failed for ${uid}:`, e.message);
      // Token expired — clean it up
      if (e.code === 'messaging/registration-token-not-registered') {
        await db.collection('users').doc(uid).update({ fcm_token: null });
      }
    }

    // Mark all as notified
    const batch = db.batch();
    matches.docs.forEach(m => batch.update(m.ref, { notified: true }));
    await batch.commit();
  }

  // ── 2. Deadline alerts for tracked applications ───────────────────────────
  // Find opportunities with deadlines in 7 days, 3 days, 1 day
  const ALERT_WINDOWS = [1, 3, 7]; // days

  for (const days of ALERT_WINDOWS) {
    const targetDate = new Date();
    targetDate.setDate(targetDate.getDate() + days);
    targetDate.setHours(0, 0, 0, 0);
    const dayStart = Timestamp.fromDate(targetDate);
    const dayEnd   = Timestamp.fromDate(new Date(targetDate.getTime() + 86400000));

    const dueSoon = await db.collection('opportunities')
      .where('is_active',        '==', true)
      .where('deadline_timestamp', '>=', dayStart)
      .where('deadline_timestamp', '<',  dayEnd)
      .get();

    for (const oppDoc of dueSoon.docs) {
      const oppData = oppDoc.data();
      // Find users tracking this opportunity
      const trackers = await db.collectionGroup('applications')
        .where('__name__', '>=', `users/`)
        .limit(500) // safety limit
        .get();

      // Filter to only users tracking this oppId
      const relevantTrackers = trackers.docs.filter(d =>
        d.ref.path.includes(`/applications/${oppDoc.id}`)
      );

      for (const appDoc of relevantTrackers) {
        const uid      = appDoc.ref.path.split('/')[1];
        const userDoc  = await db.collection('users').doc(uid).get();
        const token    = userDoc.data()?.fcm_token;
        if (!token) continue;

        // Check doc readiness for smart nudge
        const appData  = appDoc.data();
        const missing  = (appData.docs || []).filter(d => !d.checked).length;
        const nudge    = missing > 0
          ? `${missing} document${missing > 1 ? 's' : ''} still missing`
          : 'All documents ready — submit now';

        try {
          await fcm.send({
            token,
            notification: {
              title: `⏰ ${days} day${days > 1 ? 's' : ''} left — ${oppData.org}`,
              body:  `${oppData.title} · ${nudge}`,
            },
            data: { type: 'deadline_alert', opp_id: oppDoc.id, days: String(days) },
          });
        } catch (e) {
          console.warn(`Notifier: deadline alert failed for ${uid}:`, e.message);
        }
      }
    }
  }

  console.log('Notifier: run complete.');
});
