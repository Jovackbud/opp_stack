const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { generateText } = require('./llm');

exports.essayAssist = onCall({
  memory: '256MiB',
  secrets: ['LLM_API_KEY']
}, async (request) => {
  if (!request.auth) throw new Error("Unauthenticated");
  const { oppId, notes } = request.data;
  if (!oppId || typeof oppId !== 'string') throw new Error("Missing opportunity id");
  
  const db = getFirestore();
  const opp = await db.collection('opportunities').doc(oppId).get();
  if(!opp.exists) throw new Error("Not found");
  const oppData = opp.data();
  if (!oppData.is_approved || !oppData.is_active) throw new Error("Opportunity is not available");
  
  const safeNotes = String(notes || "None").replace(/\s+/g, ' ').trim().slice(0, 2000);
  const prompt = `You are a highly capable writing assistant and mentor for a Nigerian applicant.
Opportunity Context: ${oppData.about || ''}
Requirements: ${oppData.requirements || ''}
Application steps: ${(oppData.steps || []).map(s => typeof s === 'string' ? s : `${s.title}: ${s.description || ''}`).join('; ')}
User's scratch notes: ${safeNotes}

Please provide:
1. A concise thesis angle.
2. A section-by-section essay outline.
3. Evidence the applicant should gather.
4. Risks to avoid, including exaggeration and generic claims.
5. A short first-draft checklist.

Do not invent personal achievements. Return only clean markdown. Keep it encouraging, analytical, and specific to this opportunity.`;

  const draft = await generateText({
    task: 'essay',
    prompt,
    maxTokens: 800,
  });
  
  return { draft };
});
