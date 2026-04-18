const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall }            = require('firebase-functions/v2/https');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const Anthropic = require('@anthropic-ai/sdk');
const fetch     = require('node-fetch');
const cheerio   = require('cheerio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Shared extraction logic ─────────────────────────────────────────────────
async function fetchPageText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'OppTrackBot/1.0 (civic-good scholarship aggregator)' },
    timeout: 15000,
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

async function analyseOpportunity(link, title) {
  let pageText;
  try {
    pageText = await fetchPageText(link);
  } catch (err) {
    console.warn(`Analyst: could not fetch ${link}:`, err.message);
    // Fall back to title-only analysis (lower quality but doesn't block)
    pageText = `Opportunity title: ${title}. Full page could not be fetched.`;
  }

  const message = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',  // cheapest model; swap to sonnet for quality
    max_tokens: 1000,
    messages: [{ role: 'user', content: ANALYST_PROMPT(pageText, link) }],
  });

  const raw = message.content[0].text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(raw);
  return parsed;
}

// ── Firestore trigger: fires when Scout writes a new opportunity stub ────────
exports.analyst = onDocumentCreated({
  document:        'opportunities/{oppId}',
  memory:          '256MiB',
  timeoutSeconds:  120,
  secrets:         ['ANTHROPIC_API_KEY'],
}, async (event) => {
  const snap = event.data;
  const data = snap.data();

  // Only process stubs not yet analysed
  if (data.analyst_done) return;

  const db = getFirestore();
  const ref = snap.ref;

  // Lock immediately to prevent double-processing
  await ref.update({ analyst_done: true, analyst_started_at: Timestamp.now() });

  let extracted;
  try {
    extracted = await analyseOpportunity(data.link, data.title);
  } catch (err) {
    console.error(`Analyst: Claude failed for ${data.link}:`, err.message);
    await ref.update({ analyst_error: err.message });
    return;
  }

  // If Claude says skip (irrelevant page), mark inactive and bail
  if (extracted.skip) {
    await ref.update({ is_active: false, analyst_done: true });
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
  secrets:   ['ANTHROPIC_API_KEY'],
}, async (request) => {
  if (!request.auth) throw new Error('Unauthenticated');

  const { url, text } = request.data;
  const input = text || url;
  if (!input) throw new Error('Provide a URL or text.');

  let pageText = text || '';
  if (url && !text) {
    try { pageText = await fetchPageText(url); }
    catch (e) { pageText = \`URL: \${url}\`; }
  }

  const extracted = await analyseOpportunity(url || 'user-upload', pageText);
  return extracted;
});
