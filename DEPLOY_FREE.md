# OppTrack Deployment Guide

This is the first-time deployment path for OppTrack.

Start with **Path A** if you want the app online without billing. Move to **Path B** only when you are ready to deploy Cloud Functions for discovery, AI extraction, matching, notifications, admin review, essay assistance, Telegram, and WhatsApp.

Firebase reality check:

- Hosting, Auth, Firestore, Storage, and Cloud Messaging can run on the no-cost Spark plan.
- Deploying Cloud Functions requires the Blaze pay-as-you-go plan.
- The app code expects Cloud Functions in `europe-west1`.
- Firebase Hosting provides the frontend Firebase config through `/__/firebase/init.json`, so do not paste private keys into frontend files.

Official references:

- Firebase Functions deployment requires Blaze: https://firebase.google.com/docs/functions/get-started
- Firebase Functions environment variables and secrets: https://firebase.google.com/docs/functions/config-env
- Firebase Hosting reserved config URL: https://firebase.google.com/docs/hosting/reserved-urls

---

## 1. What You Are Deploying

Repo surface:

- `public/`: the web app, service worker, manifest, icons, and public VAPID key file.
- `functions/`: Firebase Cloud Functions running on Node 20.
- `firestore.rules`: Firestore client access rules.
- `storage.rules`: Storage owner-only file rules with upload limits.
- `firestore.indexes.json`: required Firestore indexes.
- `firebase.json`: Firebase deploy configuration.

Production posture:

- No frontend framework or build step.
- No secrets in `public/`.
- Public users can only read approved, active opportunities.
- Backend automation stays behind Cloud Functions and Admin SDK.

---

## 2. Install Local Tools

Install:

1. Node.js 20 or newer.
2. npm, bundled with Node.
3. Firebase CLI.
4. A Google account.

Install Firebase CLI:

```powershell
npm install -g firebase-tools
```

Check the tools:

```powershell
node --version
npm --version
firebase --version
```

Expected:

- `node --version` prints `v20.x` or newer.
- `firebase --version` prints a version number.

Windows note: if PowerShell blocks `npm`, use `npm.cmd` for local commands:

```powershell
npm.cmd --version
```

---

## 3. Create The Firebase Project

In the Firebase Console:

1. Click **Add project**.
2. Name it, for example `opptrack-prod`.
3. Disable Google Analytics unless you need it.
4. Create the project.
5. Copy the Firebase project ID. You will use it in the CLI.

Do not create or share service account keys for this deployment.

---

## 4. Enable Firebase Services

Enable these services in this order.

### 4.1 Authentication

1. Open **Build > Authentication**.
2. Click **Get started**.
3. Enable **Google** sign-in.
4. Add your support email.
5. Save.

### 4.2 Firestore

1. Open **Build > Firestore Database**.
2. Click **Create database**.
3. Choose **Production mode**.
4. Choose a Europe region if available for your project.
5. Create.

### 4.3 Storage

1. Open **Build > Storage**.
2. Click **Get started**.
3. Choose production rules.
4. Use the same general region family as Firestore when possible.

### 4.4 Cloud Messaging

1. Open **Project settings > Cloud Messaging**.
2. Under **Web Push certificates**, generate a key pair if one does not exist.
3. Copy only the public key.
4. Replace the contents of `public/vapid-key.txt` with that public key.

The VAPID public key is safe in `public/`. Private keys, LLM keys, WhatsApp tokens, Telegram bot tokens, and Google Search keys are not safe in `public/`.

---

## 5. Connect This Repo To Firebase

From the repo root:

```powershell
firebase login
firebase use --add
```

When prompted:

1. Choose the Firebase project you created.
2. Use alias `prod`.

Confirm the active project:

```powershell
firebase use
```

Expected: the active project points to your production Firebase project.

---

## 6. Validate Locally Before Deploying

Install Functions dependencies:

```powershell
npm.cmd --prefix functions install
```

Run code checks:

```powershell
npm.cmd --prefix functions run lint
node -c public\sw.js
node -c local-server.js
node -e "const fs=require('fs'); for (const f of ['functions/package.json','firestore.indexes.json','public/manifest.json','firebase.json']) { JSON.parse(fs.readFileSync(f,'utf8')); console.log(f + ' ok'); }"
```

Expected:

- No syntax errors.
- JSON files print `ok`.

Run the local preview:

```powershell
node local-server.js
```

Open:

```text
http://127.0.0.1:4173/
```

Check:

1. The app loads.
2. Cards render in local/demo mode.
3. Reminder settings open and save.
4. `/manifest.json` opens.
5. `/sw.js` opens.
6. `/vapid-key.txt` opens and contains your real public VAPID key.

Stop the preview server with `Ctrl+C`.

Do not deploy if any of these checks fail.

---

## 7. Path A: Free Core Launch

Use this path first if you want a safe public launch without billing.

Deploy Hosting, Firestore rules, Firestore indexes, and Storage rules:

```powershell
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage
```

Open the Hosting URL printed by Firebase.

Smoke test:

1. App opens on the Hosting URL.
2. Google sign-in works.
3. Reminder settings open.
4. Push permission prompt appears when push is enabled and saved.
5. Firestore creates or updates only your own `users/{uid}` document.
6. No obvious browser console errors.

Free core limitations:

- No scheduled opportunity discovery.
- No AI opportunity extraction.
- No admin callable actions.
- No essay assistance.
- No scheduled match/deadline notifications.
- No Telegram webhook.
- No WhatsApp digest.

The frontend can show approved opportunities if you add them manually in Firestore. Each visible opportunity must have:

```text
is_approved == true
is_active == true
```

Minimum Firestore opportunity document:

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

Use public HTTPS links only. The backend rejects local/private network URLs.

---

## 8. Path B: Full Product Launch

Use this path only after Path A works and you are ready to enable billing.

### 8.1 Enable Billing With Guardrails

1. Upgrade the Firebase project to Blaze.
2. In Google Cloud Billing, create a budget alert.
3. Set alerts at small thresholds you are comfortable with.
4. Keep scheduled jobs conservative.

Do not deploy Functions before budget alerts exist.

### 8.2 Configure Runtime Environment

Create `functions/.env` locally. This file is ignored by Git.

Required for admin:

```env
ADMIN_EMAILS=you@example.com
```

Required for LLM features:

```env
LLM_PROVIDER=anthropic
LLM_MODEL=
LLM_ANALYST_MODEL=
LLM_ESSAY_MODEL=
```

Supported `LLM_PROVIDER` values:

```text
anthropic
openai
gemini
openai_compatible
```

Use Firebase Secret Manager for secret values that are bound in code:

```powershell
firebase functions:secrets:set LLM_API_KEY
firebase functions:secrets:set GOOGLE_SEARCH_API_KEY
firebase functions:secrets:set GOOGLE_SEARCH_CX
firebase functions:secrets:set TELEGRAM_BOT_TOKEN
firebase functions:secrets:set WHATSAPP_TOKEN
firebase functions:secrets:set WHATSAPP_PHONE_ID
```

Only set secrets for features you will actually use. If you skip optional secrets, the related function should degrade gracefully or skip that channel.

Optional local-only/provider-specific values can go in `functions/.env`:

```env
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
LLM_BASE_URL=http://127.0.0.1:11434/v1
TELEGRAM_BOT_USERNAME=YourBotUsername
```

Privacy rule: never put any value from `functions/.env` into `public/`.

### 8.3 Deploy Functions First

Run:

```powershell
firebase deploy --only functions
```

Expected:

- Predeploy lint runs successfully.
- Functions deploy to `europe-west1`.
- Firebase reports successful deployment.

If this fails, fix Functions first. Do not loosen Firestore or Storage rules to work around a backend failure.

### 8.4 Deploy Everything

After Functions deploy successfully:

```powershell
firebase deploy --only firestore:rules,firestore:indexes,storage,hosting
```

Or deploy all configured targets:

```powershell
firebase deploy
```

---

## 9. Full Product Verification

Run this after Path B.

### 9.1 Admin

1. Open `/admin.html` on the Hosting URL.
2. Sign in with an email listed in `ADMIN_EMAILS`.
3. Confirm pending and published lists load.
4. Create one test opportunity.
5. Approve or reject one non-critical draft.

If unauthorized:

- Check exact email spelling in `ADMIN_EMAILS`.
- Confirm Functions and Hosting are deployed to the same Firebase project.

### 9.2 LLM

1. Open an approved opportunity.
2. Use **Generate outline** in the detail sheet.
3. Confirm an outline appears.
4. Check Functions logs if it fails:

```powershell
firebase functions:log
```

Do not paste private applicant data into LLM notes during testing.

### 9.3 Push Notifications

1. Sign in on the Hosting URL.
2. Open reminder settings.
3. Enable push.
4. Save.
5. Accept browser permission.
6. Confirm Firestore has:

```text
users/{uid}.fcm_token
users/{uid}.fcm_token_updated_at
users/{uid}.fcm_token_provider
```

If missing:

- Confirm `public/vapid-key.txt` contains the real public VAPID key.
- Confirm the app is served over HTTPS.
- Confirm the browser supports notifications.
- Confirm service worker registration is not blocked.

### 9.4 Telegram

Telegram requires two values:

- Secret: `TELEGRAM_BOT_TOKEN`
- Public bot username exposed to the frontend configuration if you want the Connect button to work.

After Functions deploy, register the webhook with Telegram:

```powershell
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://europe-west1-<PROJECT_ID>.cloudfunctions.net/telegramWebhook"
```

Then:

1. Open reminder settings.
2. Enable Telegram.
3. Click **Connect bot**.
4. Send the `/start` message in Telegram.
5. Confirm `users/{uid}.telegram_chat_id` is set.

### 9.5 WhatsApp

Only enable WhatsApp after you have real Meta Cloud API credentials and explicit user opt-in.

Verify:

1. `WHATSAPP_TOKEN` is set.
2. `WHATSAPP_PHONE_ID` is set.
3. A test user opted into WhatsApp.
4. The test user has a valid WhatsApp number.
5. The digest is tested on one internal account first.

Do not assume delivery without checking logs.

---

## 10. Production Launch Gate

Do not call the launch production-ready until every item below is true.

Core:

- Firebase project is selected with `firebase use`.
- Auth Google provider is enabled.
- Firestore database exists.
- Storage bucket exists.
- `public/vapid-key.txt` contains the real public VAPID key.
- Local checks in Section 6 pass.
- Hosting, Firestore rules, Firestore indexes, and Storage rules deploy successfully.
- Google sign-in works on the Hosting URL.
- Users can only read/write their own private data.
- Public clients cannot create opportunities.

Full backend:

- Blaze billing is enabled only after budget alerts are configured.
- Functions deploy to `europe-west1`.
- `ADMIN_EMAILS` is configured before admin use.
- LLM provider and `LLM_API_KEY` are configured before AI features are tested.
- Push token is written to Firestore.
- Telegram webhook is registered before Telegram is advertised.
- WhatsApp is tested with one internal opt-in user before wider use.
- `firebase functions:log` is checked after deploy.

---

## 11. Rollback

If Hosting breaks:

1. Open Firebase Console.
2. Go to **Hosting**.
3. Open release history.
4. Roll back to the previous working release.

If Firestore or Storage rules break clients:

```powershell
firebase deploy --only firestore:rules,storage
```

If Functions break:

```powershell
firebase functions:log
firebase deploy --only functions
```

Do not open client writes to compensate for broken Functions. That turns a deployment bug into a data breach.

---

## 12. Command Reference

Local validation:

```powershell
npm.cmd --prefix functions install
npm.cmd --prefix functions run lint
node -c public\sw.js
node -c local-server.js
```

Free core deploy:

```powershell
firebase deploy --only hosting,firestore:rules,firestore:indexes,storage
```

Full backend deploy:

```powershell
firebase deploy --only functions
firebase deploy
```

Logs:

```powershell
firebase functions:log
```

