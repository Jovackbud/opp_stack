const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');

exports.essayAssist = onCall({
  memory: '256MiB',
  secrets: ['ANTHROPIC_API_KEY']
}, async (request) => {
  if (!request.auth) throw new Error("Unauthenticated");
  const { oppId, notes } = request.data;
  
  const db = getFirestore();
  const opp = await db.collection('opportunities').doc(oppId).get();
  if(!opp.exists) throw new Error("Not found");
  
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const prompt = `You are a highly capable writing assistant and mentor for a Nigerian applicant.
Opportunity Context: ${opp.data().about}
Requirements: ${opp.data().requirements}
User's scratch notes: ${notes || "None"}

Please provide a highly structured, engaging essay outline and drafting tips customized to this specific opportunity and user notes. Return only your tips/outline in cleanly formatted markdown. Keep it encouraging and analytical.`;

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });
  
  return { draft: msg.content[0].text };
});
