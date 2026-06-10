const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore } = require('firebase-admin/firestore');
const { withRegion, hashIdentifier, logInfo, logWarn } = require('./ops');

exports.whatsappDigest = onSchedule(withRegion({
  schedule: 'every friday 09:00',
  timeZone: 'Africa/Lagos',
  secrets: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID']
}), async () => {
  const db = getFirestore();
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) {
    logWarn('whatsapp_digest_skipped', { reason: 'missing_config' });
    return;
  }

  // Fetch users opted into whatsapp
  const users = await db.collection('users').where('prefs.notify_channels', 'array-contains', 'whatsapp').get();
  
  let delivered = 0;
  for (const user of users.docs) {
    const data = user.data();
    const channels = data.prefs?.notify_channels || data.reminders?.notify_channels || [];
    if (!channels.includes('whatsapp')) continue;
    if (!data.whatsapp_number) continue;

    // Fetch top 3 matches
    const matches = await db.collection('users').doc(user.id).collection('matches')
      .orderBy('score', 'desc').limit(3).get();
      
    if (matches.empty) continue;
    
    let text = `🌟 *OppTrack Weekly Digest*\nHere are your top matches:\n\n`;
    for(const m of matches.docs){
      const opp = await db.collection('opportunities').doc(m.data().opp_id).get();
      if(opp.exists) text += `*${opp.data().title}*\n⏳ Deadline: ${opp.data().deadline||'Rolling'}\n🔗 ${opp.data().link}\n\n`;
    }

    try {
      const res = await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: data.whatsapp_number,
          type: "text",
          text: { body: text }
        })
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Meta API ${res.status}: ${body.slice(0, 180)}`);
      }
      delivered++;
    } catch(e) {
      logWarn('whatsapp_digest_send_failed', { uidHash: hashIdentifier(user.id), error: e.message });
    }
  }
  logInfo('whatsapp_digest_completed', { userCount: users.size, delivered });
});
