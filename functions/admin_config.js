const { onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

exports.adminProcess = onCall(async (request) => {
  if (!request.auth) throw new Error("Unauthenticated");
  const email = request.auth.token.email;
  const adminEmails = (process.env.ADMIN_EMAILS || "").split(",");
  
  // Clean checks
  if (!adminEmails.map(e=>e.trim()).includes(email)) {
    throw new Error("Unauthorized");
  }

  const { oppId, action } = request.data;
  const db = getFirestore();
  
  if (action === 'approve') {
    await db.collection('opportunities').doc(oppId).update({ is_approved: true, is_active: true });
  } else if (action === 'reject') {
    await db.collection('opportunities').doc(oppId).delete();
  }
  return { success: true };
});
