// ── index.js ─────────────────────────────────────────────────────────────────

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// your env-vars
const VERIFY_TOKEN   = process.env.WP_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_TOKEN;

// 1) Mini tarot deck for testing
const tarotDeck = [
  { name: "The Fool",           meaning: "New beginnings, spontaneity" },
  { name: "The Magician",       meaning: "Power, skill, concentration" },
  { name: "The High Priestess", meaning: "Mystery, intuition" },
  { name: "The Lovers",         meaning: "Love, harmony" },
  { name: "Death",              meaning: "Endings, transformation" },
  { name: "The Tower",          meaning: "Sudden change, upheaval" },
  { name: "The Sun",            meaning: "Success, vitality, joy" },
  { name: "The Moon",           meaning: "Illusion, fear, subconscious" },
  { name: "The Star",           meaning: "Hope, inspiration" }
];

// 2) Helper to send a WhatsApp text message
async function sendText(to, body) {
  return axios.post(
    `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// 3) Verification handshake for Facebook
app.get('/webhook', (req, res) => {
  console.log('🛠 GET /webhook', req.query);
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Verified webhook, sending challenge:', challenge);
    return res.status(200).send(challenge);
  }
  console.warn('❌ Failed verification:', token);
  res.sendStatus(403);
});

// 4) Incoming messages handler
app.post('/webhook', async (req, res) => {
  console.log('📥 Incoming webhook:', JSON.stringify(req.body, null, 2));
  // Immediately ack to Facebook
  res.sendStatus(200);

  const entry = req.body.entry?.[0];
  const msg   = entry?.changes?.[0]?.value?.messages?.[0];
  const from  = msg?.from;
  const text  = msg?.text?.body?.trim();

  if (!from || !text) return;

  // If they ask for a shuffle:
  if (text === '/shuffle') {
    // pick 3 random cards
    const picked = tarotDeck.sort(() => 0.5 - Math.random()).slice(0, 3);
    const reply  = picked
      .map(c => `🔮 *${c.name}*: ${c.meaning}`)
      .join('\n\n');

    try {
      await sendText(from, reply);
      console.log('🔮 Sent shuffle to', from);
    } catch (e) {
      console.error('⚠️ Shuffle send error:', e.response?.data || e.message);
    }

  } else {
    // remind them how to use it
    try {
      await sendText(from, 'Envie /shuffle para tirar suas cartas.');
    } catch (e) {
      console.error('⚠️ Hint send error:', e.response?.data || e.message);
    }
  }
});

// 5) Start the server
app.listen(3000, () => console.log('🗣️ Echo bot listening on port 3000'));
