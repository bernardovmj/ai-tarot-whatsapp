require('dotenv').config();

const { OpenAI } = require('openai');
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });
const express   = require('express');
const bodyParser= require('body-parser');
const axios     = require('axios');
const Database  = require('better-sqlite3');

// Initialize SQLite DB
const db = new Database('../data/tarot.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    question TEXT,
    cards TEXT,
    answer TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Create sessions table for chat history
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user TEXT,
    role TEXT,       -- 'user' or 'assistant'
    content TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Environment variables
const VERIFY_TOKEN    = process.env.WP_VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.WHATSAPP_TOKEN.trim();

// In-memory session store: last reading per user
const sessions = new Map();
// Store detected language per user (so we don’t re-detect each time)
const userLang = new Map();

// Sample tarot deck
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

// Helper to send WhatsApp text
async function sendText(to, body) {
  return axios.post(
    `https://graph.facebook.com/v16.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } }
  );
}

// Build AI prompt
function buildTarotPrompt(spread, question) {
  const cardsDesc = spread
    .map((c,i) => `Card ${i+1}: ${c.name} — ${c.meaning}`)
    .join('\n');
  return [
    { role: 'system', content: 'You are an expert tarot reader. Given a spread and a question, provide a concise, empathetic reading.' },
    { role: 'user', content: `Here is the spread:\n${cardsDesc}\n\nUser question: ${question}` }
  ];
}

// Start Express
const app = express();
app.use(bodyParser.json());

// Webhook GET (verification)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token= req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Webhook POST (messages)
app.post('/webhook', async (req, res) => {
  // Acknowledge immediately
  res.sendStatus(200);

  const change = req.body.entry?.[0]?.changes?.[0]?.value;
  const msg    = change?.messages?.[0];
  if (!msg) return;  // ignore status updates

  const from = msg.from;
  const text = msg.text?.body?.trim();
  if (!from || !text) return;

  // Language detection (accents + Portuguese keywords/greetings)
  const ptAccent = /[áàâãéêíóôõúçñ]/i;
  // Portuguese keywords and greetings
  const ptWords = /\b(eu|você|como|que|estou|sinto|preciso|gostaria|oi|olá|bom dia|boa tarde|tudo bem|tudo|bem|olá)\b/i;

  let lang = userLang.get(from);
  if (!lang) {
    if (ptAccent.test(text) || ptWords.test(text)) lang = 'pt';
    else lang = 'en';
    userLang.set(from, lang);
  }

  // Dynamic first greeting
  if (!sessions.has(from)) {
    let greet;
    if (lang === 'pt') greet = 'Olá! Sou seu Tarot AI. Como posso ajudar?';
    else if (lang === 'en') greet = 'Hello! I’m your AI Tarot reader. How can I help?';
    else greet = '🔮';
    await sendText(from, greet);
    db.prepare(
      'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
    ).run(from, 'assistant', greet);
    sessions.set(from, []);
    return;
  }

  // Persist user turn
  db.prepare(
    'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
  ).run(from, 'user', text);

  console.log(`📥 Incoming message from ${from}: ${text}`);

  // Handle commands
  if (text === '/shuffle') {
    const picked = tarotDeck.sort(() => 0.5 - Math.random()).slice(0,3);
    const reply  = picked.map(c => `🔮 *${c.name}*: ${c.meaning}`).join('\n\n');
    try {
      await sendText(from, reply);
      db.prepare(
        'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
      ).run(from, 'assistant', reply);
      sessions.set(from, picked.map(c => c.name));
      // Save to DB
      db.prepare('INSERT INTO readings (user, question, cards, answer) VALUES (?,?,?,?)')
        .run(from, text, JSON.stringify(picked.map(c => c.name)), reply);
      console.log(`Sent /shuffle to ${from}`);
    } catch (e) {
      console.error('Error on /shuffle:', e);
    }

  } else if (text === '/last') {
    const last = sessions.get(from);
    const reply = last
      ? last.map(n => `🔮 *${n}*`).join('\n\n')
      : 'No cards yet. Use /shuffle.';
    try {
      await sendText(from, reply);
      db.prepare(
        'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
      ).run(from, 'assistant', reply);
      console.log(`Sent /last to ${from}`);
    } catch (e) {
      console.error('Error on /last:', e);
    }

  } else if (text === '/history') {
    const rows = db.prepare('SELECT created_at, question, cards FROM readings WHERE user = ? ORDER BY id DESC LIMIT 5')
      .all(from);
    const summary = rows.length
      ? rows.map(r => `${r.created_at.slice(0,19)}\n• Q: ${r.question}\n• Cards: ${JSON.parse(r.cards).join(', ')}`).join('\n\n')
      : 'No past readings. Use /shuffle or ask a question.';
    await sendText(from, summary);
    db.prepare(
      'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
    ).run(from, 'assistant', summary);
    console.log(`Sent /history to ${from}`);

  } else {
    // AI fallback
    const spread = sessions.has(from)
      ? tarotDeck.filter(c => sessions.get(from).includes(c.name))
      : tarotDeck.sort(() => 0.5 - Math.random()).slice(0,3);
    // Fetch last 6 turns and build contextual chat
    const turns = db.prepare(
      'SELECT role, content FROM sessions WHERE user = ? ORDER BY id DESC LIMIT 6'
    ).all(from).reverse();
    const cardsDesc = spread.map((c,i) => `Card ${i+1}: ${c.name} — ${c.meaning}`).join('\n');
    const systemMsg = {
      role: 'system',
      content: `You are an expert tarot reader. Current spread:\n${cardsDesc}`
    };
    const messages = [systemMsg, ...turns, { role: 'user', content: text }];
    try {
      const resp = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 250
      });
      const aiReply = resp.choices[0].message.content;
      // Split AI reply into separate messages
      const parts = aiReply.split(/\n{2,}/);
      for (const part of parts) {
        await sendText(from, part);
        db.prepare(
          'INSERT INTO sessions (user, role, content) VALUES (?,?,?)'
        ).run(from, 'assistant', part);
      }
      // Save AI reading
      db.prepare('INSERT INTO readings (user, question, cards, answer) VALUES (?,?,?,?)')
        .run(from, text, JSON.stringify(spread.map(c=>c.name)), aiReply);
      console.log(`Sent AI reading to ${from}`);
    } catch (e) {
      console.error('AI error:', e);
      await sendText(from, "Sorry, I couldn't generate a reading right now.");
    }
  }
});

// Start server
app.listen(3000, () => console.log('Tarot bot listening on port 3000'));
