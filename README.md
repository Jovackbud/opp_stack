# OppTrack AI — Production README & Build Spec
> **Civic Good Project** | Zero-to-production spec for an agentic IDE build.
> Stack: Firebase (free tier) · Claude Sonnet API · Vanilla JS/HTML · Cloud Functions

---

## 0. Mission Statement

OppTrack is a free, AI-powered opportunity companion for Nigerian and African students. It automatically discovers scholarships, fellowships, grants, and graduate programmes — extracts every requirement, deadline, and application step using AI — and gives each user a personalised tracker so nothing falls through the cracks.

**Cost target:** Under $5/month at 1,000 active users. Firebase free tier + Claude API at ~$0.003 per opportunity analysed.

---

## 1. Repository Structure

```
opptrack/
├── README.md                  ← this file
├── .env.example               ← env var template (never commit .env)
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── storage.rules
│
├── public/                    ← frontend (single HTML app)
│   ├── index.html             ← main app shell (see Section 5)
│   ├── manifest.json          ← PWA manifest
│   ├── sw.js                  ← service worker (offline + push)
│   └── icons/                 ← PWA icons (192, 512)
│
└── functions/                 ← Firebase Cloud Functions (Node 20)
    ├── package.json
    ├── index.js               ← exports all functions
    ├── scout.js               ← The Scout: RSS crawler + dedup
    ├── analyst.js             ← The Analyst: Claude Sonnet extractor
    ├── matcher.js             ← The Matcher: user-opportunity scoring
    └── notifier.js            ← The Nudge Engine: FCM push + digest
```

---

## 2. Environment Variables

Create `.env` in `functions/` (never commit):

```env
ANTHROPIC_API_KEY=sk-ant-...
```

All Firebase config goes in `public/index.html` via the Firebase SDK config object (safe to expose — secured by Firestore rules).

---

## 3. Firebase Setup

### 3a. Services to enable
- **Firestore** (Native mode, region: `europe-west1` — closest to Nigeria)
- **Cloud Functions** (Node 20 runtime)
- **Firebase Auth** (Email/Password + Google sign-in)
- **Cloud Messaging** (FCM for push notifications)
- **Hosting** (serve `public/`)

### 3b. Firestore Schema

```
opportunities/{oppId}
  title:              string
  org:                string
  category:           "scholarship" | "fellowship" | "internship" | "job" | "graduate" | "grant"
  industry:           string[]           // ["STEM", "Engineering"]
  deadline:           string             // "YYYY-MM-DD" or "rolling"
  deadline_timestamp: timestamp          // for ordering + alerts
  about:              string             // 2–3 paragraphs, AI-generated
  requirements:       string             // 1–2 sentence summary
  docs:               string[]           // ["CV/Resume", "Transcript", ...]
  steps:              ApplicationStep[]  // [{step:1, title:"Register", description:"..."}]
  link:               string             // official URL
  emoji:              string             // single emoji for visual identity
  target_regions:     string[]           // ["Nigeria", "Africa", "Global"]
  funding_type:       "fully_funded" | "partial" | "stipend" | "unpaid" | "unknown"
  source:             string             // source site URL
  source_name:        string             // "OpportunitiesForAfricans"
  discovered_at:      timestamp
  analyst_version:    number             // increment when re-analysing
  is_active:          boolean            // false = expired/closed

users/{uid}
  email:              string
  display_name:       string
  prefs:
    level:            "undergrad" | "postgrad" | "phd" | "any"
    fields:           string[]           // ["STEM", "Business", ...]
    locations:        string[]           // ["Nigeria", "Africa", "Global"]
    keywords:         string[]           // user-typed tags
    notify_channels:  string[]           // ["push", "email", "whatsapp"]
    digest_time:      string             // "08:00" WAT
    custom_reminders: CustomReminder[]   // [{text, days_before}]
  fcm_token:          string
  whatsapp_number:    string             // optional
  created_at:         timestamp
  last_active:        timestamp

users/{uid}/applications/{oppId}          ← cloned on "Track This"
  status:             "saved" | "applied" | "pending" | "offer" | "rejected"
  current_stage:      number             // index into STAGES array (-1 = not started)
  docs:               DocItem[]          // [{name, checked: bool}]
  steps:              StepItem[]         // [{...step, completed: bool}] — cloned from opp
  notes:              object             // {stage_key: "note text"}
  reminders_set:      boolean
  tracked_at:         timestamp
  updated_at:         timestamp
```

**TypeScript interfaces for functions:**
```typescript
interface ApplicationStep { step: number; title: string; description: string; }
interface DocItem         { name: string; checked: boolean; }
interface CustomReminder  { text: string; days_before: number; id: string; }
```

### 3c. Firestore Security Rules (`firestore.rules`)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Public opportunities — anyone can read, only functions can write
    match /opportunities/{oppId} {
      allow read: if true;
      allow write: if false; // Cloud Functions use Admin SDK (bypasses rules)
    }

    // User profile — only the owner
    match /users/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;

      // Applications sub-collection — only the owner
      match /applications/{oppId} {
        allow read, write: if request.auth != null && request.auth.uid == uid;
      }
    }
  }
}
```

### 3d. Firestore Indexes (`firestore.indexes.json`)

```json
{
  "indexes": [
    {
      "collectionGroup": "opportunities",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "is_active",          "order": "ASCENDING" },
        { "fieldPath": "deadline_timestamp", "order": "ASCENDING" }
      ]
    },
    {
      "collectionGroup": "opportunities",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "is_active",     "order": "ASCENDING" },
        { "fieldPath": "category",      "order": "ASCENDING" },
        { "fieldPath": "target_regions","order": "ASCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

---

## 4. Cloud Functions (`functions/`)

### 4a. `package.json`

```json
{
  "name": "opptrack-functions",
  "version": "1.0.0",
  "engines": { "node": "20" },
  "main": "index.js",
  "dependencies": {
    "firebase-admin": "^12.0.0",
    "firebase-functions": "^4.0.0",
    "@anthropic-ai/sdk": "^0.24.0",
    "rss-parser": "^3.13.0",
    "node-fetch": "^3.3.2",
    "cheerio": "^1.0.0-rc.12"
  }
}
```

### 4b. `index.js` — Function Exports

```javascript
const { initializeApp } = require('firebase-admin/app');
initializeApp();

exports.scout    = require('./scout').scout;       // scheduled: every day 07:00 WAT
exports.analyst  = require('./analyst').analyst;   // firestore trigger: on new opportunity
exports.matcher  = require('./matcher').matcher;   // firestore trigger: on new opportunity
exports.notifier = require('./notifier').notifier; // scheduled: every day 08:00 WAT
exports.parseUrl = require('./analyst').parseUrl;  // callable: on-demand URL parse (upload flow)
```

### 4c. `scout.js` — The Scout

**Role:** Discovers new opportunities. Runs once daily. Writes raw entries to Firestore. Never analyses — that is the Analyst's job.

```javascript
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const Parser = require('rss-parser');
const fetch = require('node-fetch');

// ── Sources (RSS-first, then light scrape) ──────────────────────────────────
// Priority order: RSS feeds are zero-cost and ToS-safe.
// Add/remove sources here without touching any other file.
const RSS_SOURCES = [
  { name: 'OpportunitiesForAfricans', url: 'https://www.opportunitiesforafricans.com/feed/' },
  { name: 'OpportunityDesk',          url: 'https://opportunitydesk.org/feed/' },
  { name: 'ScholarshipAir',           url: 'https://scholarshipair.com/feed/' },
  { name: 'ScholarshipsHall',         url: 'https://scholarshipshall.com/feed/' },
  { name: 'AfterSchoolAfrica',        url: 'https://www.afterschoolafrica.com/feed/' },
];

// Daily cap: keeps Claude API costs predictable.
// At $0.003/opp, 40 new opps/day = ~$0.12/day = ~$3.60/month.
const DAILY_NEW_OPP_CAP = 40;

exports.scout = onSchedule({
  schedule: 'every day 06:00',    // 06:00 UTC = 07:00 WAT
  timeZone: 'Africa/Lagos',
  memory: '256MiB',
  timeoutSeconds: 300,
}, async () => {
  const db = getFirestore();
  const parser = new Parser({ timeout: 10000 });
  let newCount = 0;

  for (const source of RSS_SOURCES) {
    if (newCount >= DAILY_NEW_OPP_CAP) break;

    let feed;
    try {
      feed = await parser.parseURL(source.url);
    } catch (err) {
      console.warn(`Scout: failed to fetch ${source.name}:`, err.message);
      continue; // skip this source, try next
    }

    for (const item of (feed.items || [])) {
      if (newCount >= DAILY_NEW_OPP_CAP) break;

      const link = item.link?.trim();
      if (!link) continue;

      // Dedup by link URL — the canonical unique key for an opportunity
      const existing = await db.collection('opportunities')
        .where('link', '==', link).limit(1).get();
      if (!existing.empty) continue;

      // Write a stub. The Analyst Cloud Function picks this up via Firestore trigger.
      await db.collection('opportunities').add({
        title:           item.title?.trim() || 'Untitled',
        link,
        source:          source.url,
        source_name:     source.name,
        is_active:       true,
        analyst_done:    false,    // ← Analyst watches for this === false
        discovered_at:   Timestamp.now(),
        analyst_version: 0,
      });
      newCount++;
    }
  }

  console.log(`Scout: discovered ${newCount} new opportunities.`);
});
```

### 4d. `analyst.js` — The Analyst

**Role:** Reads each raw stub written by the Scout. Fetches the full page. Calls Claude Sonnet with a structured JSON prompt. Writes the enriched opportunity back. Runs *once per opportunity* (idempotent via `analyst_done` flag).

**Cost note:** Claude `claude-sonnet-4-5` (Haiku is even cheaper — swap model string if budget is tight). Input: ~2,000 tokens page text. Output: ~600 tokens JSON. At Haiku pricing this is ~$0.0003/opp.

```javascript
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
    catch (e) { pageText = `URL: ${url}`; }
  }

  const extracted = await analyseOpportunity(url || 'user-upload', pageText);
  return extracted;
});
```

### 4e. `matcher.js` — The Matcher

**Role:** When a new enriched opportunity lands, score it against every registered user's preferences and write personalised match scores. Lightweight — no AI calls, pure logic.

```javascript
const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore }      = require('firebase-admin/firestore');

exports.matcher = onDocumentUpdated({
  document: 'opportunities/{oppId}',
  memory:   '256MiB',
}, async (event) => {
  const after  = event.data.after.data();
  const before = event.data.before.data();

  // Only run when Analyst just finished (analyst_version went from 0 → 1)
  if (before.analyst_version === after.analyst_version) return;
  if (!after.analyst_done || !after.is_active) return;

  const db    = getFirestore();
  const users = await db.collection('users').get();

  const batch = db.batch();

  users.forEach(userDoc => {
    const prefs = userDoc.data().prefs || {};
    const score = scoreMatch(after, prefs);
    if (score === 0) return; // no match at all, don't notify

    // Write match score into a sub-collection for efficient per-user queries
    const matchRef = db
      .collection('users').doc(userDoc.id)
      .collection('matches').doc(event.params.oppId);

    batch.set(matchRef, {
      opp_id:       event.params.oppId,
      score,
      notified:     false,
      created_at:   new Date(),
    });
  });

  await batch.commit();
  console.log(`Matcher: scored "${after.title}" against ${users.size} users.`);
});

function scoreMatch(opp, prefs) {
  let score = 0;

  // Field/industry match
  const userFields  = (prefs.fields || []).map(f => f.toLowerCase());
  const oppIndustry = (opp.industry || []).map(i => i.toLowerCase());
  if (userFields.some(f => oppIndustry.some(i => i.includes(f) || f.includes(i)))) score += 40;

  // Region match
  const userLocs = (prefs.locations || ['Nigeria']).map(l => l.toLowerCase());
  const oppRegions = (opp.target_regions || ['Global']).map(r => r.toLowerCase());
  if (oppRegions.includes('global') || userLocs.some(l => oppRegions.includes(l))) score += 30;

  // Keyword match
  const kw = (prefs.keywords || []).map(k => k.toLowerCase());
  const haystack = `${opp.title} ${opp.about} ${opp.requirements}`.toLowerCase();
  if (kw.some(k => haystack.includes(k))) score += 20;

  // Funding type bonus — fully funded always surfaced
  if (opp.funding_type === 'fully_funded') score += 10;

  return score;
}
```

### 4f. `notifier.js` — The Nudge Engine

**Role:** Runs daily at 08:00 WAT. Sends push notifications for new matches and deadline alerts. Uses FCM (free). No third-party SMS/email needed for MVP — WhatsApp integration is a post-MVP add.

```javascript
const { onSchedule }   = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

exports.notifier = onSchedule({
  schedule:    'every day 07:00',   // 07:00 UTC = 08:00 WAT
  timeZone:    'Africa/Lagos',
  memory:      '256MiB',
  timeoutSeconds: 120,
}, async () => {
  const db  = getFirestore();
  const fcm = getMessaging();
  const now = Timestamp.now();

  // ── 1. New match notifications ────────────────────────────────────────────
  const users = await db.collection('users').get();

  for (const userDoc of users.docs) {
    const uid   = userDoc.id;
    const token = userDoc.data().fcm_token;
    if (!token) continue;

    // Get unnotified matches for this user
    const matches = await db.collection('users').doc(uid)
      .collection('matches')
      .where('notified', '==', false)
      .orderBy('score', 'desc')
      .limit(5)
      .get();

    if (matches.empty) continue;

    const count = matches.size;
    const top   = matches.docs[0].data();
    const opp   = await db.collection('opportunities').doc(top.opp_id).get();
    const oppData = opp.data() || {};

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
    } catch (e) {
      console.warn(`Notifier: FCM failed for ${uid}:`, e.message);
      // Token expired — clean it up
      if (e.code === 'messaging/registration-token-not-registered') {
        await db.collection('users').doc(uid).update({ fcm_token: null });
      }
    }

    // Mark all as notified
    const batch = db.batch();
    matches.docs.forEach(m => batch.update(m.ref, { notified: true }));
    await batch.commit();
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
      .where('is_active',        '==', true)
      .where('deadline_timestamp', '>=', dayStart)
      .where('deadline_timestamp', '<',  dayEnd)
      .get();

    for (const oppDoc of dueSoon.docs) {
      const oppData = oppDoc.data();
      // Find users tracking this opportunity
      const trackers = await db.collectionGroup('applications')
        .where('__name__', '>=', `users/`)
        .limit(500) // safety limit
        .get();

      // Filter to only users tracking this oppId
      const relevantTrackers = trackers.docs.filter(d =>
        d.ref.path.includes(`/applications/${oppDoc.id}`)
      );

      for (const appDoc of relevantTrackers) {
        const uid      = appDoc.ref.path.split('/')[1];
        const userDoc  = await db.collection('users').doc(uid).get();
        const token    = userDoc.data()?.fcm_token;
        if (!token) continue;

        // Check doc readiness for smart nudge
        const appData  = appDoc.data();
        const missing  = (appData.docs || []).filter(d => !d.checked).length;
        const nudge    = missing > 0
          ? `${missing} document${missing > 1 ? 's' : ''} still missing`
          : 'All documents ready — submit now';

        try {
          await fcm.send({
            token,
            notification: {
              title: `⏰ ${days} day${days > 1 ? 's' : ''} left — ${oppData.org}`,
              body:  `${oppData.title} · ${nudge}`,
            },
            data: { type: 'deadline_alert', opp_id: oppDoc.id, days: String(days) },
          });
        } catch (e) {
          console.warn(`Notifier: deadline alert failed for ${uid}:`, e.message);
        }
      }
    }
  }

  console.log('Notifier: run complete.');
});
```

---

## 5. Frontend (`public/index.html`)

### Design System

Preserve the existing design exactly:
- **Fonts:** Playfair Display (headings) + DM Sans (body)
- **Palette:** `--navy #0a1628`, `--gold #c9a84c`, `--white #f5f0e8`
- **Urgency colours:** `--red #e05c5c` (≤5 days), `--gold` (6–14 days), `--green #4caf7d` (15+ days)
- The splash screen, bottom nav, toast, and reminder modal are already complete — do not redesign them.

### Firebase Integration Points

Replace these specific parts of the existing prototype:

#### 1. Add Firebase SDK (in `<head>`, before closing `</head>`)
```html
<script type="module">
  import { initializeApp }       from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
  import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
  import { getFirestore, collection, query, where, orderBy, limit, onSnapshot,
           doc, setDoc, updateDoc, deleteDoc, getDoc, Timestamp, serverTimestamp }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
  import { getMessaging, getToken, onMessage }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
  import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

  const firebaseConfig = {
    // PASTE YOUR FIREBASE CONFIG HERE
    apiKey:            "...",
    authDomain:        "...",
    projectId:         "...",
    storageBucket:     "...",
    messagingSenderId: "...",
    appId:             "..."
  };

  const app       = initializeApp(firebaseConfig);
  const auth      = getAuth(app);
  const db        = getFirestore(app);
  const messaging = getMessaging(app);
  const functions = getFunctions(app, 'europe-west1');

  window._fb = { auth, db, messaging, functions, Timestamp, serverTimestamp,
    collection, query, where, orderBy, limit, onSnapshot, doc, setDoc,
    updateDoc, deleteDoc, getDoc, httpsCallable, signInWithPopup,
    GoogleAuthProvider, signOut, onAuthStateChanged, getToken, onMessage };
</script>
```

#### 2. Replace `renderHome()` data source

Remove the `const OPPS = [...]` mock array and replace the `renderHome()` function body:

```javascript
// Real-time listener — fires whenever Firestore data changes
function subscribeOpportunities(userPrefs) {
  const { db, collection, query, where, orderBy, limit, onSnapshot } = window._fb;
  const q = query(
    collection(db, 'opportunities'),
    where('is_active', '==', true),
    orderBy('deadline_timestamp', 'asc'),
    limit(50)
  );
  return onSnapshot(q, snapshot => {
    opportunities = snapshot.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => matchesPrefs(o, userPrefs)); // client-side filter for instant UX
    renderHome();
    renderRepo();
  });
}

function matchesPrefs(opp, prefs) {
  if (!prefs) return true; // no prefs = show all
  const fields   = (prefs.fields   || []).map(f => f.toLowerCase());
  const locs     = (prefs.locations || ['Nigeria']).map(l => l.toLowerCase());
  const regions  = (opp.target_regions || ['Global']).map(r => r.toLowerCase());
  const inds     = (opp.industry || []).map(i => i.toLowerCase());
  const regionOk = regions.includes('global') || locs.some(l => regions.includes(l));
  const fieldOk  = fields.length === 0 || fields.some(f => inds.some(i => i.includes(f)));
  return regionOk && fieldOk;
}
```

#### 3. Replace `toggleTrack()` — write to Firestore

```javascript
async function toggleTrack(oppId, btn) {
  const { auth, db, doc, setDoc, deleteDoc, serverTimestamp } = window._fb;
  const uid = auth.currentUser?.uid;
  if (!uid) { showAuth(); return; }

  const opp   = opportunities.find(o => o.id === oppId);
  if (!opp) return;
  const appRef = doc(db, 'users', uid, 'applications', oppId);

  if (tracked[oppId]) {
    await deleteDoc(appRef);
    delete tracked[oppId];
    showToast('Removed from tracker');
  } else {
    const appData = {
      status:        'saved',
      current_stage: -1,
      docs:          (opp.docs || []).map(d => ({ name: d, checked: false })),
      steps:         (opp.steps || []).map(s => ({ ...s, completed: false })),
      notes:         {},
      reminders_set: true,
      tracked_at:    serverTimestamp(),
      updated_at:    serverTimestamp(),
    };
    await setDoc(appRef, appData);
    tracked[oppId] = appData;
    showToast('Saved to tracker ✦ Reminders set');
  }

  document.getElementById('s-tracked').textContent = Object.keys(tracked).length;
  renderHome(); renderRepo(); renderTracker();
}
```

#### 4. Add Application Roadmap section to `openDetail()`

Inside `openDetail()`, after the "Required Documents" section, add:

```javascript
// Steps / Application Roadmap
const stepsHtml = (o.steps || []).map(s => `
  <div style="display:flex;gap:12px;margin-bottom:12px;align-items:flex-start">
    <div style="min-width:26px;height:26px;border-radius:50%;background:rgba(201,168,76,.15);
                border:1px solid rgba(201,168,76,.4);display:flex;align-items:center;
                justify-content:center;font-size:10px;font-weight:700;color:var(--gold);
                flex-shrink:0;margin-top:1px">${s.step}</div>
    <div>
      <div style="font-size:12px;font-weight:600;margin-bottom:2px">${s.title}</div>
      <div style="font-size:12px;color:var(--white-dim);line-height:1.6">${s.description}</div>
    </div>
  </div>
`).join('');

// Insert before the docs section in the detail sheet HTML
document.getElementById('d-steps').innerHTML = stepsHtml || '<div class="dpara">Steps not yet extracted.</div>';
```

Add this to the detail sheet HTML (after the About section):
```html
<div class="dsection">
  <div class="dsection-title">Application Roadmap</div>
  <div id="d-steps"></div>
</div>
```

#### 5. Upload flow — call Cloud Function instead of direct API

Replace the `parseOpp()` fetch call:

```javascript
async function parseOpp() {
  const { functions, httpsCallable } = window._fb;
  const parseUrl = httpsCallable(functions, 'parseUrl');
  const txt = document.getElementById('oppText').value;
  const url = document.getElementById('oppLink').value;
  // ... loading UI same as before ...
  const result = await parseUrl({ url, text: txt });
  window._p = result.data;
  // ... render result same as before ...
}
```

#### 6. Auth Gate

Add a simple auth screen shown to unauthenticated users. On sign-in, load user prefs and call `subscribeOpportunities(prefs)`.

```javascript
window._fb.onAuthStateChanged(window._fb.auth, async user => {
  if (user) {
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').classList.add('visible');
    // Load user prefs
    const { db, doc, getDoc } = window._fb;
    const userDoc = await getDoc(doc(db, 'users', user.uid));
    const prefs   = userDoc.exists() ? userDoc.data().prefs : null;
    if (!prefs) showOnboarding(); // first-time user
    else subscribeOpportunities(prefs);
    // Subscribe to their tracked applications
    subscribeTracked(user.uid);
    // Register FCM token
    registerPush(user.uid);
  } else {
    document.getElementById('app').classList.remove('visible');
    document.getElementById('auth-screen').style.display = 'flex';
  }
});
```

#### 7. Onboarding Screen (60-second setup)

Add this screen between `#splash` and `#app` in the HTML:

```html
<div id="onboarding" style="display:none; position:fixed; inset:0; z-index:500;
     background:var(--navy); overflow-y:auto; padding:24px 18px 44px">
  <div style="font-family:'Playfair Display',serif; font-size:26px; margin-bottom:6px">
    Welcome to OppTrack
  </div>
  <div style="font-size:13px; color:var(--white-dim); margin-bottom:28px">
    Tell us about yourself — takes 60 seconds
  </div>

  <!-- Level -->
  <div style="font-size:10px;color:var(--gold);letter-spacing:1px;margin-bottom:10px">
    CURRENT LEVEL
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px" id="ob-level">
    <button class="ob-chip" data-val="undergrad">Undergraduate</button>
    <button class="ob-chip" data-val="postgrad">Postgraduate</button>
    <button class="ob-chip" data-val="phd">PhD</button>
    <button class="ob-chip" data-val="any">Other / Any</button>
  </div>

  <!-- Fields -->
  <div style="font-size:10px;color:var(--gold);letter-spacing:1px;margin-bottom:10px">
    FIELDS OF INTEREST (select all that apply)
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px" id="ob-fields">
    <button class="ob-chip" data-val="STEM">STEM</button>
    <button class="ob-chip" data-val="Business">Business</button>
    <button class="ob-chip" data-val="Health">Health / Medicine</button>
    <button class="ob-chip" data-val="Education">Education</button>
    <button class="ob-chip" data-val="Arts">Arts / Humanities</button>
    <button class="ob-chip" data-val="Law">Law</button>
    <button class="ob-chip" data-val="Agriculture">Agriculture</button>
    <button class="ob-chip" data-val="Technology">Technology / ICT</button>
  </div>

  <!-- Scope -->
  <div style="font-size:10px;color:var(--gold);letter-spacing:1px;margin-bottom:10px">
    OPPORTUNITY SCOPE
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:32px" id="ob-locs">
    <button class="ob-chip selected" data-val="Nigeria">Nigeria only</button>
    <button class="ob-chip" data-val="Africa">Africa-wide</button>
    <button class="ob-chip" data-val="Global">International / Global</button>
  </div>

  <button onclick="saveOnboarding()"
    style="width:100%;padding:14px;background:var(--gold);color:var(--navy);
           border:none;border-radius:16px;font-family:'DM Sans',sans-serif;
           font-size:15px;font-weight:700;cursor:pointer">
    Show Me Opportunities →
  </button>
</div>
```

```css
.ob-chip {
  padding: 8px 14px;
  border-radius: 20px;
  border: 1px solid var(--white-faint);
  background: none;
  color: var(--white-dim);
  font-family: 'DM Sans', sans-serif;
  font-size: 12px;
  cursor: pointer;
  transition: all .2s;
}
.ob-chip.selected {
  background: var(--gold);
  color: var(--navy);
  border-color: var(--gold);
}
```

---

## 6. PWA Setup (`public/`)

### `manifest.json`
```json
{
  "name": "OppTrack",
  "short_name": "OppTrack",
  "description": "Never miss an opportunity",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0a1628",
  "theme_color": "#0a1628",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

### `sw.js` (Service Worker)
```javascript
const CACHE = 'opptrack-v1';
const SHELL = ['/', '/index.html'];

self.addEventListener('install', e =>
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)))
);

self.addEventListener('fetch', e => {
  // Cache-first for shell, network-first for Firestore/API
  if (e.request.url.includes('firestore') || e.request.url.includes('anthropic')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});

// Handle background push notifications
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'OppTrack', {
      body:  data.body  || 'You have a new notification',
      icon:  '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data:  data.data  || {},
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow('/'));
});
```

---

## 7. Deployment

```bash
# 1. Install Firebase CLI
npm install -g firebase-tools

# 2. Login and init (select Hosting + Functions + Firestore)
firebase login
firebase init

# 3. Install function dependencies
cd functions && npm install && cd ..

# 4. Set secret
firebase functions:secrets:set ANTHROPIC_API_KEY

# 5. Deploy everything
firebase deploy

# 6. Seed initial opportunities (run once to populate before first Scout run)
# In Firebase console → Functions → manually trigger 'scout'
# OR add a one-time seed script: functions/seed.js with 10 hand-picked opps
```

---

## 8. Cost Budget

| Service | Usage | Monthly Cost |
|---|---|---|
| Firebase Hosting | Static files, CDN | Free |
| Firestore reads | 50K reads/day (free tier: 50K/day) | **$0** |
| Firestore writes | ~1,200/day (40 opps × 30 days) | **$0** (free tier: 20K/day) |
| Cloud Functions | ~60 invocations/day | **$0** (free tier: 2M/month) |
| FCM Push | Unlimited | **$0** |
| Claude Haiku API | 40 opps/day × 2,600 tokens | **~$1.50/month** |
| **Total** | | **~$1.50/month** |

Switch to Claude Sonnet only if extraction quality needs improvement. Haiku is sufficient for structured JSON extraction with a strong prompt.

---

## 9. Post-MVP Roadmap (do not build on day one)

1. **WhatsApp digest** — Twilio WhatsApp API or WATI (free tier). Send weekly digest to opted-in users.
2. **Essay assistant** — In-tracker "Help me draft" button that calls Claude with the opportunity's `about` and `requirements` as context.
3. **Community moderation queue** — User-uploaded opportunities go to a simple `/admin` page for one-tap approve/reject before publishing.
4. **Collaborative tracker** — Share your tracker board with a mentor or parent via a read-only link.
5. **Analytics dashboard** — Track which opportunity types get the most traction (Firestore aggregation queries).

---

## 10. Key Decisions & Rationale

| Decision | Why |
|---|---|
| Vanilla JS, no framework | Zero build step, instant deploy, works offline. Firebase SDK is the only dependency. |
| Claude Haiku over GPT | Cheaper, faster for structured extraction. Same quality with a tight prompt. |
| RSS-first scraping | Zero ToS risk, no Puppeteer/Playwright needed, free, fast. |
| Process once, serve many | The "Master Blueprint" pattern: Analyst runs once per opp, all users share the result. Keeps costs flat regardless of user count. |
| Firestore free tier | At 40 new opps/day with 1,000 users, read/write counts stay well inside free limits. |
| Europe-west1 region | Lowest latency to Nigeria from available Firebase regions. |
| PWA over native app | Zero app store friction. "Add to Home Screen" works on all Nigerian Android devices. |

---

*Built with care for students who deserve better tools. Every line of this system exists to lower the barrier between a young person and their next opportunity.*
