const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore } = require('firebase-admin/firestore');
const fetch = require('node-fetch');

exports.whatsappDigest = onSchedule({
  schedule: 'every friday 09:00',
  timeZone: 'Africa/Lagos',
  secrets: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID']
}, async () => {
  const db = getFirestore();
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (!token || !phoneId) return console.warn("WhatsApp secrets missing");

  // Fetch users opted into whatsapp
  const users = await db.collection('users').where('prefs.notify_channels', 'array-contains', 'whatsapp').get();
  
  for (const user of users.docs) {
    const data = user.data();
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
      await fetch(`https://graph.facebook.com/v17.0/${phoneId}/messages`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: data.whatsapp_number,
          type: "text",
          text: { body: text }
        })
      });
    } catch(e) { console.warn("WhatsApp send failed for " + user.id, e); }
  }
});
