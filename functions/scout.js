const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const Parser = require('rss-parser');
const fetch = require('node-fetch');

// ── 1. Static Sources (RSS) ────────────────────────────────────────────────
// Priority order: RSS feeds are zero-cost and ToS-safe.
const RSS_SOURCES = [
  { name: 'OpportunitiesForAfricans', url: 'https://www.opportunitiesforafricans.com/feed/' },
  { name: 'OpportunityDesk',          url: 'https://opportunitydesk.org/feed/' },
  { name: 'ScholarshipAir',           url: 'https://scholarshipair.com/feed/' },
  { name: 'ScholarshipsHall',         url: 'https://scholarshipshall.com/feed/' },
  { name: 'AfterSchoolAfrica',        url: 'https://www.afterschoolafrica.com/feed/' },
];

// ── 2. Dynamic Sources (Boolean Search) ────────────────────────────────────
// Hardcoded, brutalist boolean queries to yield high-intent URLs directly
const BOOLEAN_QUERIES = [
  '("scholarship" OR "fellowship") AND ("African students" OR "Nigerian students") AND (2025 OR 2026)',
  '("graduate trainee" OR "internship") AND "Nigeria" AND "apply now" AND (2025 OR 2026 -past)'
];

// Daily cap: keeps Claude API costs predictable.
const DAILY_NEW_OPP_CAP = 40;

exports.scout = onSchedule({
  schedule: 'every day 06:00',    // 06:00 UTC = 07:00 WAT
  timeZone: 'Africa/Lagos',
  memory: '256MiB',
  timeoutSeconds: 300,
  secrets: ['GOOGLE_SEARCH_API_KEY', 'GOOGLE_SEARCH_CX'] // Fetched if defined
}, async () => {
  const db = getFirestore();
  let newCount = 0;
  let discoveredLinks = []; 

  // --- A. RSS FEEDS PROCESSING ---
  const parser = new Parser({ timeout: 10000 });
  for (const source of RSS_SOURCES) {
    try {
      const feed = await parser.parseURL(source.url);
      for (const item of (feed.items || [])) {
        if (item.link) {
          discoveredLinks.push({ 
            link: item.link.trim(), 
            title: item.title?.trim() || 'Untitled', 
            source: source.url, 
            source_name: source.name 
          });
        }
      }
    } catch (err) {
      console.warn(`Scout: failed to fetch RSS [${source.name}]:`, err.message);
    }
  }

  // --- B. GOOGLE CUSTOM SEARCH API PROCESSING ---
  // Graceful degradation: skips if secrets aren't set
  const googleApiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const googleCx = process.env.GOOGLE_SEARCH_CX;

  if (googleApiKey && googleCx) {
    for (const query of BOOLEAN_QUERIES) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${googleApiKey}&cx=${googleCx}&q=${encodeURIComponent(query)}&num=5`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        
        if (data.items) {
          for (const item of data.items) {
            if (item.link) {
              discoveredLinks.push({ 
                link: item.link.trim(), 
                title: item.title?.trim() || 'Untitled', 
                source: 'Google Custom Search', 
                source_name: 'Boolean Search Engine' 
              });
            }
          }
        }
      } catch (err) {
        console.warn(`Scout: failed to search query [${query}]:`, err.message);
      }
    }
  } else {
    console.log("Scout: Skipping boolean search - missing GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX configs.");
  }

  // --- C. DEDUPLICATION & WRITING STUBS ---
  for (const opp of discoveredLinks) {
    if (newCount >= DAILY_NEW_OPP_CAP) break;

    // Fast deduplication: skip if we've already seen this exact link today in memory
    if (discoveredLinks.indexOf(opp) !== discoveredLinks.findIndex(o => o.link === opp.link)) {
      continue;
    }

    const existing = await db.collection('opportunities')
      .where('link', '==', opp.link).limit(1).get();
      
    if (!existing.empty) continue;

    await db.collection('opportunities').add({
      title:           opp.title,
      link:            opp.link,
      source:          opp.source,
      source_name:     opp.source_name,
      is_active:       false,
      is_approved:     false,
      review_status:   'pending',
      source_type:     'ai_scout',
      analyst_done:    false,
      discovered_at:   Timestamp.now(),
      analyst_version: 0,
    });
    newCount++;
  }

  console.log(`Scout: discovered ${newCount} new opportunity stubs.`);
});
