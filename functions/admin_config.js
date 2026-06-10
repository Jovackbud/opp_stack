const { onCall } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { withRegion, requireAuth, publicError, hashIdentifier, logInfo, logWarn } = require('./ops');

exports.adminProcess = onCall(withRegion(), async (request) => {
  const auth = requireAuth(request);
  const email = String(request.auth.token.email || '').trim().toLowerCase();
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);
  
  // Clean checks
  if (!adminEmails.includes(email)) {
    logWarn('admin_access_denied', { uidHash: hashIdentifier(auth.uid) });
    throw publicError('permission-denied', 'Admin access is required.');
  }

  const { oppId, action, opportunity } = request.data;
  const db = getFirestore();
  logInfo('admin_action_started', { action, oppId: oppId || null, uidHash: hashIdentifier(auth.uid) });

  if (action === 'list') {
    const [pendingSnap, publishedSnap] = await Promise.all([
      db.collection('opportunities')
        .where('review_status', '==', 'pending')
        .limit(100)
        .get(),
      db.collection('opportunities')
        .where('is_approved', '==', true)
        .orderBy('updated_at', 'desc')
        .limit(100)
        .get(),
    ]);

    return {
      success: true,
      pending: pendingSnap.docs.map(doc => serializeDoc(doc)),
      published: publishedSnap.docs.map(doc => serializeDoc(doc)),
    };
  }
  
  if (action === 'approve') {
    if (!oppId) throw publicError('invalid-argument', 'Missing opportunity id.');
    await db.collection('opportunities').doc(oppId).update({
      is_approved: true,
      is_active: true,
      review_status: 'approved',
      approved_by: email,
      approved_at: Timestamp.now(),
      updated_at: Timestamp.now(),
    });
  } else if (action === 'reject') {
    if (!oppId) throw publicError('invalid-argument', 'Missing opportunity id.');
    await db.collection('opportunities').doc(oppId).update({
      is_approved: false,
      is_active: false,
      review_status: 'rejected',
      rejected_by: email,
      updated_at: Timestamp.now(),
    });
  } else if (action === 'create') {
    if (!opportunity || !opportunity.title || !opportunity.link) {
      throw publicError('invalid-argument', 'Missing opportunity title or link.');
    }
    await db.collection('opportunities').add({
      ...sanitizeOpportunity(opportunity),
      is_approved: true,
      is_active: true,
      review_status: 'approved',
      source_type: 'admin_manual',
      created_by: email,
      analyst_done: true,
      analyst_version: 1,
      created_at: Timestamp.now(),
      updated_at: Timestamp.now(),
    });
  } else if (action === 'update') {
    if (!oppId || !opportunity) throw publicError('invalid-argument', 'Missing opportunity update payload.');
    await db.collection('opportunities').doc(oppId).update({
      ...sanitizeOpportunity(opportunity),
      updated_by: email,
      updated_at: Timestamp.now(),
    });
  } else {
    throw publicError('invalid-argument', 'Unsupported admin action.');
  }
  logInfo('admin_action_completed', { action, oppId: oppId || null, uidHash: hashIdentifier(auth.uid) });
  return { success: true };
});

function text(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function list(value) {
  if (Array.isArray(value)) return value.map(v => text(v)).filter(Boolean).slice(0, 20);
  return String(value || '').split(/[,;\n]/).map(v => text(v)).filter(Boolean).slice(0, 20);
}

function steps(value) {
  return list(value).map((title, index) => ({ step: index + 1, title, description: '' }));
}

function sanitizeOpportunity(opportunity) {
  const deadline = text(opportunity.deadline, 'rolling');
  const clean = {
    title: text(opportunity.title).slice(0, 220),
    org: text(opportunity.org, 'Unknown organisation').slice(0, 160),
    category: text(opportunity.category, 'scholarship').toLowerCase(),
    industry: list(opportunity.industry),
    target_regions: list(opportunity.target_regions).length ? list(opportunity.target_regions) : ['Global'],
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : 'rolling',
    funding_type: text(opportunity.funding_type, 'unknown').toLowerCase(),
    link: publicHttpUrl(opportunity.link),
    about: text(opportunity.about).slice(0, 2400),
    requirements: text(opportunity.requirements).slice(0, 900),
    docs: list(opportunity.docs),
    steps: Array.isArray(opportunity.steps) && typeof opportunity.steps[0] === 'object' ? opportunity.steps.slice(0, 8) : steps(opportunity.steps),
    tags: list(opportunity.tags),
  };

  if (!['scholarship', 'fellowship', 'internship', 'job', 'graduate', 'grant', 'event'].includes(clean.category)) clean.category = 'scholarship';
  if (!['fully_funded', 'partial', 'stipend', 'unpaid', 'unknown', 'seed_capital', 'free'].includes(clean.funding_type)) clean.funding_type = 'unknown';
  if (clean.deadline !== 'rolling') {
    const parsedDeadline = new Date(clean.deadline);
    if (!Number.isNaN(parsedDeadline.getTime())) clean.deadline_timestamp = Timestamp.fromDate(parsedDeadline);
    else clean.deadline = 'rolling';
  }
  return clean;
}

function publicHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (e) { throw publicError('invalid-argument', 'Invalid opportunity link.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw publicError('invalid-argument', 'Only HTTP(S) opportunity links are allowed.');
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    host.startsWith('169.254.')
  ) {
    throw publicError('invalid-argument', 'Private or local opportunity links are not allowed.');
  }
  return parsed.href;
}

function serializeDoc(doc) {
  return { id: doc.id, ...serializeValue(doc.data()) };
}

function serializeValue(value) {
  if (value && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeValue(item)]));
  }
  return value;
}
