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

  const { oppId, action, opportunity } = request.data;
  const db = getFirestore();
  
  if (action === 'approve') {
    await db.collection('opportunities').doc(oppId).update({
      is_approved: true,
      is_active: true,
      review_status: 'approved',
      approved_by: email,
      approved_at: new Date(),
      updated_at: new Date(),
    });
  } else if (action === 'reject') {
    await db.collection('opportunities').doc(oppId).update({
      is_approved: false,
      is_active: false,
      review_status: 'rejected',
      rejected_by: email,
      updated_at: new Date(),
    });
  } else if (action === 'create') {
    if (!opportunity || !opportunity.title || !opportunity.link) {
      throw new Error("Missing opportunity title or link");
    }
    await db.collection('opportunities').add({
      ...opportunity,
      is_approved: true,
      is_active: true,
      review_status: 'approved',
      source_type: 'admin_manual',
      created_by: email,
      created_at: new Date(),
      updated_at: new Date(),
    });
  } else if (action === 'update') {
    if (!oppId || !opportunity) throw new Error("Missing opportunity update payload");
    await db.collection('opportunities').doc(oppId).update({
      ...opportunity,
      updated_by: email,
      updated_at: new Date(),
    });
  } else {
    throw new Error("Unsupported admin action");
  }
  return { success: true };
});
