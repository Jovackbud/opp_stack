# OppTrack Free Deployment Guide

This guide deploys OppTrack with the lowest-cost path first, then shows how to enable the full automated backend when you are ready.

Important reality check: Firebase has a no-cost Spark plan for Hosting, Auth, Firestore, Storage, and Cloud Messaging. Cloud Functions deployment typically requires the Blaze pay-as-you-go plan, even when your usage remains inside free quotas. So there are two deployment modes:

1. **Free core launch:** Hosting + Auth + Firestore + Storage + FCM client setup. No scheduled crawler, analyst, matcher, notifier, essay assistance, admin callable, or WhatsApp digest.
2. **Full product launch:** Everything above plus Cloud Functions. This is still designed for near-zero spend at low usage, but it requires billing to be enabled.

Use the free core launch to get the public app online safely. Upgrade only when you are ready for automation.

---

## 1. What You Are Deploying

The repository contains:

- `public/`: vanilla HTML/CSS/JS frontend, service worker, manifest, icons, VAPID public key file.
- `functions/`: Firebase Cloud Functions for discovery, AI extraction, matching, notifications, admin review, essay assistance, and WhatsApp digest.
- `firestore.rules`: client data access rules.
- `storage.rules`: owner-only file access rules.
- `firestore.indexes.json`: required Firestore query indexes.
- `firebase.json`: deploy configuration.

The app is production-oriented but intentionally lean: no frontend framework, no server framework, no extra hosting layer.

---

## 2. Prerequisites

Install these locally:

1. Node.js 20 or newer.
2. npm.
3. Firebase CLI.
4. A Google account.

Install Firebase CLI:

```powershell
npm install -g firebase-tools
```

Confirm tools:

```powershell
node --version
npm --version
firebase --version
```

Expected:

- Node should be `20.x` or newer.
- Firebase CLI should print a version number.

---

## 3. Create The Firebase Project

1. Go to the Firebase Console.
2. Click **Add project**.
3. Name it, for example: `opptrack-prod`.
4. Disable Google Analytics unless you truly need it.
5. Create the project.

Keep the Firebase project ID. You will use it in CLI commands.

Privacy note: do not add secrets to frontend files. Firebase web config and the Web Push VAPID public key are safe to expose. API keys for LLMs, WhatsApp, and Google Search are not safe to expose.

---

## 4. Enable Firebase Services

In the Firebase Console, enable these services.

### 4.1 Authentication

1. Open **Build > Authentication**.
2. Click **Get started**.
3. Enable **Google** sign-in.
4. Add your support email.
5. Save.

Optional:

- Enable Email/Password later if you want non-Google login.

### 4.2 Firestore

1. Open **Build > Firestore Database**.
2. Click **Create database**.
3. Choose **Production mode**.
4. Select a region close to users. For Nigeria/Africa, use a Europe region if available for your project.
5. Create.

The repo rules will be deployed later, so production mode is correct.

### 4.3 Storage

1. Open **Build > Storage**.
2. Click **Get started**.
3. Choose production rules.
4. Use the same general region family as Firestore when possible.

The repo storage rules will be deployed later.

### 4.4 Cloud Messaging

1. Open **Project settings**.
2. Open the **Cloud Messaging** tab.
3. In **Web Push certificates**, generate a key pair if one does not exist.
4. Copy the public key.
5. Replace the placeholder in:

```text
public/vapid-key.txt
```

The file must contain only the public key text, for example:

```text
BKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Do not place private server keys in `public/`.

---

## 5. Connect The Local Repo To Firebase

Login:

```powershell
firebase login
```

From the repo root:

```powershell
firebase use --add
```

Choose the Firebase project you created.

Alias it:

```text
prod
```

After that, this repo should know which Firebase project to deploy to.

Check:

```powershell
firebase projects:list
firebase use
```

---

## 6. Install Function Dependencies

Even if you start with the free core launch, install and validate Functions now so mistakes are caught early.

```powershell
npm --prefix functions install
npm.cmd --prefix functions run lint
```

Expected:

```text
node -c index.js ...
```

No syntax errors should appear.

Compatibility notes:

- `functions/package.json` targets Node 20.
- The code uses native `fetch`, so Node 20 is required.
- No `node-fetch` or provider-specific LLM SDK is required.

---

## 7. Validate Static Files Locally

Run the preview server:

```powershell
node local-server.js
```

Open:

```text
http://127.0.0.1:4173/
```

Check:

1. The app loads.
2. `/manifest.json` loads.
3. `/sw.js` loads.
4. `/vapid-key.txt` loads and no longer contains `REPLACE_WITH_FIREBASE_WEB_PUSH_VAPID_KEY`.
5. `/icons/icon.svg` loads.
6. `/icons/badge.svg` loads.

Stop the server with `Ctrl+C`.

---

## 8. Free Core Launch

This deploys the frontend, Firestore rules, Firestore indexes, and Storage rules. It does not deploy Cloud Functions.

Use this when you want the app online without enabling billing.

```powershell
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage
```

Expected output:

- Firebase deploys Hosting.
- Firebase deploys Firestore rules.
- Firebase deploys Firestore indexes.
- Firebase deploys Storage rules.
- Firebase prints a Hosting URL.

Open the Hosting URL.

Smoke test:

1. Load the app.
2. Sign in with Google.
3. Open reminder settings.
4. Enable push notifications.
5. Save reminders.
6. Confirm the browser asks for notification permission.
7. Confirm no obvious frontend errors appear.

Limitations in free core launch:

- No scheduled opportunity discovery.
- No AI extraction.
- No matching cron.
- No scheduled push notifications.
- No essay assistance.
- No admin callable review actions.
- No WhatsApp digest.

The frontend can load approved data if data exists, but backend automation will not run until Functions are deployed.

---

## 9. Full Product Launch

Use this only when you are ready to enable billing.

### 9.1 Upgrade To Blaze With Guardrails

Firebase Functions generally require the Blaze plan. Blaze is pay-as-you-go, but this app is designed to stay tiny at early usage.

Before upgrading:

1. Set a Google Cloud budget alert.
2. Set alerts at small thresholds, for example 50%, 90%, and 100% of your monthly comfort limit.
3. Keep scheduled jobs conservative.
4. Do not enable expensive LLM providers without rate and cost awareness.

### 9.2 Configure Function Secrets And Environment

Do not commit `.env` files.

For local reference, use:

```text
functions/.env.example
```

Required for admin:

```text
ADMIN_EMAILS=you@example.com
```

Required for LLM features:

```text
LLM_PROVIDER=anthropic | openai | gemini | openai_compatible
LLM_API_KEY=...
LLM_MODEL=...
LLM_ANALYST_MODEL=...
LLM_ESSAY_MODEL=...
```

Provider-specific fallback keys are supported:

```text
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_API_KEY=...
LLM_BASE_URL=http://127.0.0.1:11434/v1
```

Required for Google Search scout, if using Google Custom Search:

```text
GOOGLE_SEARCH_API_KEY=...
GOOGLE_SEARCH_CX=...
```

Required for WhatsApp digest:

```text
WHATSAPP_TOKEN=...
WHATSAPP_PHONE_ID=...
```

Recommended Firebase secret setup:

```powershell
firebase functions:secrets:set LLM_API_KEY
firebase functions:secrets:set WHATSAPP_TOKEN
firebase functions:secrets:set WHATSAPP_PHONE_ID
```

For non-secret environment values, use Firebase environment configuration or your deployment environment. Keep private credentials out of `public/`.

### 9.3 Deploy Everything

```powershell
firebase deploy
```

Or deploy in safer stages:

```powershell
firebase deploy --only firestore:rules,firestore:indexes,storage
firebase deploy --only functions
firebase deploy --only hosting
```

If Functions fail, do not loosen rules to compensate. Fix the function configuration and redeploy.

---

## 10. Seed Or Create Initial Opportunities

The public client can only read opportunities where:

```text
is_approved == true
is_active == true
```

For the app to show real production data, opportunities must exist with those fields.

Options:

1. Use the admin review flow after Functions are deployed.
2. Manually create approved opportunities in Firestore for initial launch.
3. Let `scout` and `analyst` populate pending opportunities, then approve them.

Minimum opportunity fields:

```json
{
  "title": "Example Scholarship",
  "org": "Example Foundation",
  "category": "scholarship",
  "industry": ["STEM"],
  "target_regions": ["Nigeria"],
  "deadline": "2026-08-01",
  "deadline_timestamp": "Firestore Timestamp",
  "funding_type": "fully_funded",
  "link": "https://example.org/apply",
  "about": "Short summary.",
  "requirements": "Eligibility summary.",
  "docs": ["CV", "Transcript"],
  "steps": [{"step": 1, "title": "Apply online", "description": ""}],
  "is_approved": true,
  "is_active": true,
  "review_status": "approved",
  "created_at": "Firestore Timestamp",
  "updated_at": "Firestore Timestamp"
}
```

Do not add private/local links. The backend rejects private network URLs for safety.

---

## 11. Verify Push Notifications

Push has three required parts:

1. Browser permission.
2. FCM token stored on the user document.
3. Backend notifier sending to that token.

### 11.1 Browser Verification

In production Hosting:

1. Sign in.
2. Open reminder settings.
3. Enable push.
4. Save.
5. Accept browser permission.

Then check Firestore:

```text
users/{uid}.fcm_token
users/{uid}.fcm_token_updated_at
users/{uid}.fcm_token_provider
```

If `fcm_token` is missing:

- Confirm `public/vapid-key.txt` contains the real public key.
- Confirm the browser supports push.
- Confirm the app is served from HTTPS Firebase Hosting, not a plain HTTP domain.
- Confirm service worker registration is not blocked.

### 11.2 Backend Verification

The scheduled `notifier` sends:

- New match notifications.
- Deadline alerts for tracked applications.

To verify end to end:

1. Ensure Functions are deployed.
2. Ensure a user has `fcm_token`.
3. Ensure the user has tracked applications.
4. Ensure matching documents exist with `notified == false`, or an opportunity has a deadline in 1, 3, or 7 days.
5. Run or wait for the scheduled notifier.

The notifier removes expired/invalid tokens automatically.

---

## 12. Verify Admin

Admin access is not controlled by frontend code. It is controlled by the callable function checking `ADMIN_EMAILS`.

To verify:

1. Deploy Functions.
2. Set `ADMIN_EMAILS` to your Google account email.
3. Open `/admin.html`.
4. Sign in with that Google account.
5. Confirm pending and published lists load.
6. Test approve/reject on a non-critical test opportunity.

If unauthorized:

- Check exact email spelling.
- Check lowercase/uppercase is not the issue; the backend normalizes case.
- Confirm Functions are deployed to the same Firebase project as Hosting.

---

## 13. Verify LLM Features

There are two LLM call sites:

1. Analyst extraction.
2. Essay assistance.

Supported providers:

```text
anthropic
openai
gemini
openai_compatible
```

For lowest lock-in, start with the provider you trust and keep `LLM_PROVIDER` as the switch point.

Smoke test essay assistance:

1. Sign in.
2. Open an opportunity detail sheet.
3. Enter scratch notes.
4. Click **Generate outline**.
5. Confirm an outline appears.

If it fails:

- Check `LLM_PROVIDER`.
- Check `LLM_API_KEY` or provider-specific key.
- Check model name.
- Check Functions logs.

Privacy rule: do not send unnecessary personal data to hosted LLMs. Use local/openai-compatible mode if sovereignty matters more than convenience.

---

## 14. Verify WhatsApp Digest

WhatsApp digest should stay disabled unless you have real Meta Cloud API credentials and user opt-in.

Before launch:

1. Confirm `WHATSAPP_TOKEN`.
2. Confirm `WHATSAPP_PHONE_ID`.
3. Confirm users explicitly opted into WhatsApp.
4. Confirm phone numbers are valid for your target region.
5. Test with one internal account first.

The function now checks Meta API errors and timeouts. Do not silently assume delivery.

---

## 15. Production Smoke Checklist

Run this after every deployment.

### Frontend

1. Hosting URL opens.
2. App does not show Firebase placeholder mode.
3. Google sign-in works.
4. Main opportunity list loads.
5. Explore page loads.
6. Tracker page loads.
7. Profile save works.
8. Reminder modal opens.
9. Push permission prompt works.
10. Service worker registers.

### Firestore Rules

1. Signed-out users can only read approved active opportunities.
2. Users can read/write only their own profile and applications.
3. Users cannot write their own `role`, `admin`, `is_admin`, or `is_public` fields.
4. Users cannot write their own matches.
5. Public clients cannot create opportunities.

### Storage Rules

1. User can upload/read under `/users/{uid}/...`.
2. User cannot read/write another user's path.
3. All other paths are denied.

### Functions

1. `adminProcess` rejects non-admin.
2. `essayAssist` rejects signed-out users.
3. `analyst` rejects private/local URLs.
4. `matcher` completes without Firestore batch limit errors.
5. `notifier` sends only to users with push enabled and valid token.
6. `whatsappDigest` skips users without WhatsApp opt-in/number.

---

## 16. Useful Commands

Validate Functions syntax:

```powershell
npm.cmd --prefix functions run lint
```

Validate service worker:

```powershell
node -c public\sw.js
```

Validate local preview server:

```powershell
node -c local-server.js
```

Validate JSON:

```powershell
node -e "const fs=require('fs'); for (const f of ['functions/package.json','firestore.indexes.json','public/manifest.json']) { JSON.parse(fs.readFileSync(f,'utf8')); console.log(f + ' ok'); }"
```

Deploy free core:

```powershell
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage
```

Deploy full product:

```powershell
firebase deploy
```

Deploy only Functions:

```powershell
firebase deploy --only functions
```

View logs:

```powershell
firebase functions:log
```

---

## 17. Rollback

If Hosting breaks:

1. Open Firebase Console.
2. Go to **Hosting**.
3. Open release history.
4. Roll back to the previous working release.

If Firestore rules break clients:

1. Fix `firestore.rules`.
2. Deploy only rules:

```powershell
firebase deploy --only firestore:rules
```

If Functions break:

1. Check logs:

```powershell
firebase functions:log
```

2. Fix the function.
3. Redeploy only Functions:

```powershell
firebase deploy --only functions
```

Do not temporarily open Firestore writes to work around broken Functions. That trades a deployment bug for a data breach.

---

## 18. Cost Controls

To keep deployment free or near-free:

1. Start with the free core launch.
2. Keep Firestore reads low by limiting public query sizes.
3. Avoid broad unauthenticated reads.
4. Do not run scheduled functions too frequently.
5. Keep LLM calls only in analyst and essay assistance.
6. Use small/cheap models for extraction.
7. Avoid sending full user profiles to LLMs unless required.
8. Set budget alerts before enabling Blaze.
9. Keep WhatsApp digest opt-in only.
10. Watch Functions logs after every deploy.

Free is not just pricing. Free also means no surprise lock-in, no exposed secrets, and no expensive work happening invisibly.

---

## 19. Final Launch Gate

Do not call the deployment production-ready until all of these are true:

- `public/vapid-key.txt` contains the real Firebase Web Push public key.
- Firebase Auth provider is enabled.
- Firestore rules deployed.
- Storage rules deployed.
- Firestore indexes deployed.
- Hosting deployed.
- Google sign-in works.
- Push token is written to `users/{uid}.fcm_token`.
- Admin email is configured before using admin actions.
- LLM provider is configured before enabling AI features.
- WhatsApp credentials and consent flow are verified before enabling WhatsApp digest.
- Budget alerts exist before deploying Functions on Blaze.

If you follow the free core path, the app can go online without billing. If you need discovery, AI extraction, matching, scheduled reminders, admin callables, essay assistance, and WhatsApp digest, deploy the full product with billing enabled and strict budget alerts.

