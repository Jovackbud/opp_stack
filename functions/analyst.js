const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall }            = require('firebase-functions/v2/https');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const cheerio   = require('cheerio');
const { generateText } = require('./llm');

// ── Shared extraction logic ─────────────────────────────────────────────────
async function fetchPageText(url) {
  const safeUrl = publicHttpUrl(url);
  const res = await fetch(safeUrl, {
    headers: { 'User-Agent': 'OppTrackBot/1.0 (civic-good scholarship aggregator)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $    = cheerio.load(html);
  // Strip nav, footer, scripts, ads
  $('nav, footer, script, style, iframe, .sidebar, #sidebar, .ad, .advertisement').remove();
  // Return main content text, trimmed to ~3000 chars to control token cost
  return $('main, article, .content, body').first().text()
    .replace(/\s+/g, ' ').trim().slice(0, 3000);
}

const ANALYST_PROMPT = (pageText, url) => `
You are an expert opportunity analyst for Nigerian and African students.
Extract structured data from the opportunity page below.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

Required fields:
{
  "title":          "Full official title",
  "org":            "Organisation name",
  "category":       "scholarship|fellowship|internship|job|graduate|grant",
  "industry":       ["array", "of", "fields"],
  "deadline":       "YYYY-MM-DD or 'rolling'",
  "about":          "2–3 engaging paragraphs about the opportunity. Write for a Nigerian student.",
  "requirements":   "1–2 sentence summary of key eligibility criteria",
  "docs":           ["Required Document 1", "Required Document 2"],
  "steps":          [
    {"step": 1, "title": "Short action title", "description": "What to do and how"},
    {"step": 2, "title": "...", "description": "..."}
  ],
  "target_regions": ["Nigeria"|"Africa"|"Global"],
  "funding_type":   "fully_funded|partial|stipend|unpaid|unknown",
  "emoji":          "single most relevant emoji"
}

Rules:
- steps must be concrete and actionable (3–8 steps). This is the most important field.
- docs must be specific (not "documents" — list each one individually).
- deadline: if not found, use "rolling". Never invent a date.
- about: inspire the reader. Mention what makes this worth applying for.
- If the page is irrelevant (404, blog post, not an opportunity), return: {"skip": true}

Page URL: ${url}
Page text:
${pageText}
`;

function publicHttpUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); }
  catch (e) { throw new Error('Invalid opportunity URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
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
    throw new Error('Private or local URLs are not allowed');
  }
  return parsed.href;
}

async function analyseOpportunity(link, title, suppliedText = '') {
  let pageText = String(suppliedText || '').trim();
  if (!pageText) {
    try {
      pageText = await fetchPageText(link);
    } catch (err) {
      console.warn(`Analyst: could not fetch ${link}:`, err.message);
      // Fall back to title-only analysis (lower quality but doesn't block)
      pageText = `Opportunity title: ${title}. Full page could not be fetched.`;
    }
  }

  const raw = (await generateText({
    task: 'analyst',
    prompt: ANALYST_PROMPT(pageText, link),
    maxTokens: 1000,
    json: true,
  })).replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  return normalizeOpportunity(parsed);
}

function normalizeText(value, fallback = '') {
  return String(value || fallback).replace(/\s+/g, ' ').trim();
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(v => normalizeText(v)).filter(Boolean).slice(0, 12);
  return String(value || '').split(/[,;\n]/).map(v => normalizeText(v)).filter(Boolean).slice(0, 12);
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((item, index) => {
    if (typeof item === 'string') {
      return { step: index + 1, title: normalizeText(item).slice(0, 120), description: '' };
    }
    return {
      step: Number(item.step) || index + 1,
      title: normalizeText(item.title || `Step ${index + 1}`).slice(0, 120),
      description: normalizeText(item.description).slice(0, 500),
    };
  }).filter(item => item.title);
}

function normalizeOpportunity(parsed) {
  if (parsed && parsed.skip) return { skip: true };

  const category = normalizeText(parsed.category, 'scholarship').toLowerCase();
  const fundingType = normalizeText(parsed.funding_type, 'unknown').toLowerCase();
  const deadline = normalizeText(parsed.deadline, 'rolling');

  return {
    title: normalizeText(parsed.title, 'Untitled opportunity').slice(0, 220),
    org: normalizeText(parsed.org, 'Unknown organisation').slice(0, 160),
    category: ['scholarship', 'fellowship', 'internship', 'job', 'graduate', 'grant', 'event'].includes(category) ? category : 'scholarship',
    industry: normalizeList(parsed.industry),
    deadline: /^\d{4}-\d{2}-\d{2}$/.test(deadline) ? deadline : 'rolling',
    about: normalizeText(parsed.about).slice(0, 2400),
    requirements: normalizeText(parsed.requirements).slice(0, 900),
    docs: normalizeList(parsed.docs),
    steps: normalizeSteps(parsed.steps),
    target_regions: normalizeList(parsed.target_regions).length ? normalizeList(parsed.target_regions) : ['Global'],
    funding_type: ['fully_funded', 'partial', 'stipend', 'unpaid', 'unknown', 'seed_capital', 'free'].includes(fundingType) ? fundingType : 'unknown',
    emoji: normalizeText(parsed.emoji, 'O').slice(0, 4),
  };
}

// ── Firestore trigger: fires when Scout writes a new opportunity stub ────────
exports.analyst = onDocumentCreated({
  document:        'opportunities/{oppId}',
  memory:          '256MiB',
  timeoutSeconds:  120,
  secrets:         ['LLM_API_KEY'],
}, async (event) => {
  const snap = event.data;
  const data = snap.data();

  // Only process stubs not yet analysed
  if (data.analyst_done) return;

  const db = getFirestore();
  const ref = snap.ref;

  // Lock immediately to prevent double-processing
  await ref.update({ analyst_started_at: Timestamp.now(), analyst_error: null });

  let extracted;
  try {
    extracted = await analyseOpportunity(data.link, data.title);
  } catch (err) {
    console.error(`Analyst: LLM failed for ${data.link}:`, err.message);
    await ref.update({
      analyst_done: false,
      analyst_error: String(err.message || err).slice(0, 500),
      analyst_failed_at: Timestamp.now(),
    });
    return;
  }

  // If the model says skip (irrelevant page), mark inactive and bail
  if (extracted.skip) {
    await ref.update({
      is_active: false,
      is_approved: false,
      review_status: 'rejected',
      analyst_done: true,
      analyst_version: 1,
      updated_at: Timestamp.now(),
    });
    return;
  }

  // Parse deadline into a Firestore Timestamp for ordering
  let deadline_timestamp = null;
  if (extracted.deadline && extracted.deadline !== 'rolling') {
    const d = new Date(extracted.deadline);
    if (!isNaN(d)) deadline_timestamp = Timestamp.fromDate(d);
  }

  await ref.update({
    ...extracted,
    deadline_timestamp,
    is_active: false,
    is_approved: false,
    review_status: data.review_status || 'pending',
    analyst_done:    true,
    analyst_version: 1,
    updated_at:      Timestamp.now(),
  });

  console.log(`Analyst: enriched "${extracted.title}"`);
});

// ── Callable function: on-demand parse for user-uploaded URLs ───────────────
// Called from the frontend Upload page. Same logic, returns JSON to client.
exports.parseUrl = onCall({
  memory:    '256MiB',
  secrets:   ['LLM_API_KEY'],
}, async (request) => {
  if (!request.auth) throw new Error('Unauthenticated');

  const { url, text } = request.data;
  const input = text || url;
  if (!input) throw new Error('Provide a URL or text.');

  let pageText = text || '';
  if (url && !text) {
    try { pageText = await fetchPageText(url); }
    catch (e) { pageText = `URL: ${url}`; }
  }

  const extracted = await analyseOpportunity(url || 'user-upload', 'User submitted opportunity', pageText);
  return extracted;
});
