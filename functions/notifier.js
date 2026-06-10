const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { sendTelegram }  = require('./telegram');
const { withRegion, hashIdentifier, logInfo, logWarn } = require('./ops');

exports.notifier = onSchedule(withRegion({
  schedule:    'every day 07:00',   // 07:00 UTC = 08:00 WAT
  timeZone:    'Africa/Lagos',
  memory:      '256MiB',
  timeoutSeconds: 120,
  secrets: ['TELEGRAM_BOT_TOKEN'],
}), async () => {
  const db  = getFirestore();
  const fcm = getMessaging();
  let matchUsers = 0;
  let matchDeliveries = 0;
  let deadlineDeliveries = 0;

  // ── 1. New match notifications ────────────────────────────────────────────
  const users = await db.collection('users').get();

  for (const userDoc of users.docs) {
    const uid      = userDoc.id;
    const userData = userDoc.data();
    const token    = userData.fcm_token;
    const channels = userData.prefs?.notify_channels || userData.reminders?.notify_channels || ['push'];

    // Get unnotified matches for this user
    const matches = await db.collection('users').doc(uid)
      .collection('matches')
      .where('notified', '==', false)
      .orderBy('score', 'desc')
      .limit(5)
      .get();

    if (matches.empty) continue;

    const count   = matches.size;
    const top     = matches.docs[0].data();
    const opp     = await db.collection('opportunities').doc(top.opp_id).get();
    const oppData = opp.data() || {};
    let attempted = false;
    let delivered = false;

    // ── Push ──
    if (channels.includes('push') && token) {
      attempted = true;
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
        delivered = true;
        matchDeliveries++;
      } catch (e) {
        logWarn('notifier_match_fcm_failed', { uidHash: hashIdentifier(uid), code: e.code || null, error: e.message });
        if (isDeadFcmToken(e)) {
          await db.collection('users').doc(uid).update({ fcm_token: null });
        }
      }
    }

    // ── Telegram ──
    if (channels.includes('telegram') && userData.telegram_chat_id) {
      attempted = true;
      const msg = `🔔 <b>${count} new match${count > 1 ? 'es' : ''} for you</b>\n\n` +
                  `Top pick: <b>${oppData.title || 'New opportunity'}</b>\n` +
                  (oppData.org ? `🏢 ${oppData.org}\n` : '') +
                  (oppData.deadline ? `⏳ Deadline: ${oppData.deadline}\n` : '') +
                  `\nOpen OppTrack to view all matches.`;
      try {
        await sendTelegram(userData.telegram_chat_id, msg);
        delivered = true;
        matchDeliveries++;
      } catch (e) {
        logWarn('notifier_match_telegram_failed', { uidHash: hashIdentifier(uid), code: e.code || null, error: e.message });
        if (e.code === 'telegram/dead-chat') {
          await db.collection('users').doc(uid).update({ telegram_chat_id: null });
        }
      }
    }

    if (!attempted || delivered) {
      const batch = db.batch();
      matches.docs.forEach(m => batch.update(m.ref, {
        notified: true,
        notified_at: Timestamp.now(),
        notification_status: delivered ? 'delivered' : 'no_channel',
      }));
      await batch.commit();
      matchUsers++;
    } else {
      logWarn('notifier_match_retry_left_pending', { uidHash: hashIdentifier(uid), matchCount: count });
    }
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
      .where('is_active',          '==', true)
      .where('deadline_timestamp', '>=', dayStart)
      .where('deadline_timestamp', '<',  dayEnd)
      .get();

    for (const oppDoc of dueSoon.docs) {
      const oppData = oppDoc.data();
      // Find users tracking this opportunity
      const relevantTrackers = await db.collectionGroup('applications')
        .where('opp_id', '==', oppDoc.id)
        .limit(500)
        .get();

      for (const appDoc of relevantTrackers.docs) {
        const uid      = appDoc.ref.path.split('/')[1];
        const userDoc  = await db.collection('users').doc(uid).get();
        const userData = userDoc.data() || {};
        const channels = userData.prefs?.notify_channels || userData.reminders?.notify_channels || ['push'];

        // Check doc readiness for smart nudge
        const appData = appDoc.data();
        const missing = (appData.docs || []).filter(d => !d.checked).length;
        const nudge   = missing > 0
          ? `${missing} document${missing > 1 ? 's' : ''} still missing`
          : 'All documents ready — submit now';

        // ── Push ──
        if (channels.includes('push') && userData.fcm_token) {
          try {
            await fcm.send({
              token: userData.fcm_token,
              notification: {
                title: `⏰ ${days} day${days > 1 ? 's' : ''} left — ${oppData.org}`,
                body:  `${oppData.title} · ${nudge}`,
              },
              data: { type: 'deadline_alert', opp_id: oppDoc.id, days: String(days) },
            });
            deadlineDeliveries++;
          } catch (e) {
            logWarn('notifier_deadline_fcm_failed', { uidHash: hashIdentifier(uid), oppId: oppDoc.id, days, code: e.code || null, error: e.message });
            if (isDeadFcmToken(e)) {
              await db.collection('users').doc(uid).update({ fcm_token: null });
            }
          }
        }

        // ── Telegram ──
        if (channels.includes('telegram') && userData.telegram_chat_id) {
          const msg = `⏰ <b>${days} day${days > 1 ? 's' : ''} left!</b>\n\n` +
                      `<b>${oppData.title}</b>\n` +
                      `🏢 ${oppData.org}\n\n` +
                      `📋 ${nudge}\n\n` +
                      `Open OppTrack to review your application.`;
          try {
            await sendTelegram(userData.telegram_chat_id, msg);
            deadlineDeliveries++;
          } catch (e) {
            logWarn('notifier_deadline_telegram_failed', { uidHash: hashIdentifier(uid), oppId: oppDoc.id, days, code: e.code || null, error: e.message });
            if (e.code === 'telegram/dead-chat') {
              await db.collection('users').doc(uid).update({ telegram_chat_id: null });
            }
          }
        }
      }
    }
  }

  logInfo('notifier_run_completed', { userCount: users.size, matchUsers, matchDeliveries, deadlineDeliveries });
});

function isDeadFcmToken(error) {
  return [
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
  ].includes(error?.code);
}
