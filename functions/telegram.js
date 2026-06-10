const { onRequest }   = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');

// ── Telegram Bot API sender ───────────────────────────────────────────────────
/**
 * Send a plain-text message to a Telegram chat.
 * Uses the Bot API sendMessage endpoint — no npm package, pure fetch (~Node 18+).
 *
 * @param {string|number} chatId  Telegram chat_id stored on the user document.
 * @param {string}        text    Message body (supports basic Markdown v2 via parse_mode).
 * @returns {Promise<void>}
 */
async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('Telegram: TELEGRAM_BOT_TOKEN not set — skipping send.');
    return;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    signal:  AbortSignal.timeout(12000),
    body:    JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // 403 = bot blocked by user, 400 chat_id not found — both are dead connections
    if (res.status === 403 || res.status === 400) {
      const err = new Error(`Telegram API ${res.status}: ${body.slice(0, 160)}`);
      err.code  = 'telegram/dead-chat';
      throw err;
    }
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 160)}`);
  }
}

// ── Telegram Bot Webhook ──────────────────────────────────────────────────────
/**
 * Firebase HTTPS function that receives Telegram webhook POST requests.
 *
 * Registration (one-time, after deploy):
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<region>-<project>.cloudfunctions.net/telegramWebhook"
 *
 * Flow:
 *   1. User opens deep-link: t.me/<BOT_USERNAME>?start=<firebase_uid>
 *   2. Telegram sends update: { message: { text: '/start <uid>', chat: { id: <chat_id> } } }
 *   3. This handler writes telegram_chat_id → users/<uid> in Firestore.
 *   4. Replies with a confirmation so the user sees immediate feedback.
 */
exports.telegramWebhook = onRequest({
  secrets: ['TELEGRAM_BOT_TOKEN'],
}, async (req, res) => {
  // Only accept POST from Telegram
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const update = req.body;
  const message = update?.message;
  if (!message) {
    // Not a message update (could be edited_message etc.) — acknowledge silently
    res.sendStatus(200);
    return;
  }

  const chatId = message.chat?.id;
  const text   = (message.text || '').trim();

  // Only handle /start <uid> commands
  if (!text.startsWith('/start')) {
    res.sendStatus(200);
    return;
  }

  const uid = text.replace('/start', '').trim();
  if (!uid) {
    // No UID provided — generic welcome (manual start without deep link)
    await sendTelegram(chatId,
      '👋 <b>Welcome to OppTrack!</b>\n\nTo link your account, please use the "Connect Telegram" button inside the OppTrack app. It will generate a personal link for you.'
    ).catch(() => {});
    res.sendStatus(200);
    return;
  }

  const db = getFirestore();

  try {
    // Verify the uid corresponds to a real user document before storing
    const userRef = db.collection('users').doc(uid);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      console.warn(`Telegram webhook: unknown uid "${uid}" from chat ${chatId}`);
      await sendTelegram(chatId,
        '❌ Could not link your account. Please try again from the OppTrack app.'
      ).catch(() => {});
      res.sendStatus(200);
      return;
    }

    await userRef.update({ telegram_chat_id: String(chatId) });
    console.log(`Telegram: linked chat_id ${chatId} → uid ${uid}`);

    await sendTelegram(chatId,
      '✅ <b>Telegram connected!</b>\n\nYou\'ll now receive OppTrack reminders and match alerts here. You can manage your notification settings in the app at any time.'
    ).catch(() => {});

  } catch (e) {
    console.error('Telegram webhook error:', e.message);
  }

  // Always 200 — prevents Telegram from retrying
  res.sendStatus(200);
});

module.exports.sendTelegram = sendTelegram;
