// Pharaoh's Carpets & Floors LLC — Messenger webhook bot
// Answers ONLY from data/faq-bank.json (120 approved Q&As). Nothing is invented.
// Anything it can't match gets the fallback handoff message.
//
// Customer-facing copy (GREETING / FALLBACK below) approved by Jack 2026-09-24.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 3000;
const GRAPH_URL = 'https://graph.facebook.com/v19.0/me/messages';

// ---------------------------------------------------------------------------
// Approved customer copy — signed off by Jack 2026-09-24.
// ---------------------------------------------------------------------------
const GREETING =
  "Hi! Thanks for reaching out to Pharaoh's Carpets & Floors. Ask me anything about flooring, estimates, scheduling, or financing — or call/text us at 269-409-1239.";

const FALLBACK =
  "Good question — I want to make sure you get the right answer, so I've flagged this for Jack or Josh. They'll follow up shortly, or you can reach us now at 269-409-1239.";

// ---------------------------------------------------------------------------
// FAQ bank (120 approved Q&As). The bot may only reply with text from here.
// ---------------------------------------------------------------------------
const FAQS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'data', 'faq-bank.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Matching: lowercase -> strip punctuation -> drop stopwords -> light stem,
// then score each FAQ question by keyword overlap:
//   score = matched keywords / keywords in the FAQ question
// Best score >= 0.3 wins; otherwise fall back to the human handoff.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'else', 'when',
  'while', 'of', 'at', 'by', 'for', 'with', 'about', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'to', 'from', 'up',
  'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further',
  'once', 'here', 'there', 'where', 'why', 'how', 'what', 'which', 'who',
  'whom', 'whose', 'that', 'these', 'those', 'this', 'am', 'is', 'are',
  'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having',
  'do', 'does', 'did', 'doing', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must', 'ought', 'i', 'me', 'my',
  'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours',
  'yourself', 'yourselves', 'he', 'him', 'his', 'himself', 'she', 'her',
  'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'as', 'so', 'than', 'too', 'very', 'just',
  'also', 'not', 'no', 'nor', 'only', 'own', 'same', 'such', 'any',
  'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'between', 'per', 'via', 'get', 'got', 'like', 'want', 'need', 'know',
  'us', 'much', 'many', 'best',
]);

const GREETING_WORDS = new Set([
  'hi', 'hello', 'hey', 'yo', 'howdy', 'hiya', 'greetings',
  'morning', 'afternoon', 'evening', 'good', 'there', 'sup',
]);

function stem(t) {
  if (t.length > 4 && t.endsWith('es')) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s')) return t.slice(0, -1);
  return t;
}

function rawTokens(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function tokenize(text) {
  return rawTokens(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem);
}

function isGreeting(text) {
  const toks = rawTokens(text);
  return toks.length > 0 && toks.every((t) => GREETING_WORDS.has(t));
}

function findBestMatch(text) {
  const msgTokens = new Set(tokenize(text));
  if (msgTokens.size === 0) return null;
  let best = null;
  for (const faq of FAQS) {
    const faqTokens = new Set(tokenize(faq.question));
    if (faqTokens.size === 0) continue;
    let matched = 0;
    for (const t of msgTokens) {
      if (faqTokens.has(t)) matched++;
    }
    const score = matched / faqTokens.size;
    if (!best || score > best.score) best = { faq, score };
  }
  return best && best.score >= 0.3 ? best : null;
}

// ---------------------------------------------------------------------------
// Messenger Send API
// ---------------------------------------------------------------------------
async function sendReply(recipientId, text) {
  const url = `${GRAPH_URL}?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: recipientId },
      messaging_type: 'RESPONSE',
      message: { text },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Send API ${res.status}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Webhook routes
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send("Pharaoh's Carpets & Floors Messenger bot is running.");
});

// Verification handshake — Meta calls this when you save the Callback URL.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
    console.log('Webhook verified by Meta.');
    return res.status(200).send(challenge);
  }
  console.warn('Webhook verification failed (bad or missing verify token).');
  return res.sendStatus(403);
});

// Incoming message events.
app.post('/webhook', (req, res) => {
  if (req.body.object !== 'page') return res.sendStatus(404);
  for (const entry of req.body.entry || []) {
    for (const event of entry.messaging || []) {
      handleEvent(event).catch((err) =>
        console.error('Event handler error:', err.message)
      );
    }
  }
  // Acknowledge immediately; replies go out async.
  res.status(200).send('EVENT_RECEIVED');
});

async function handleEvent(event) {
  const msg = event.message;
  // Ignore non-text events and echoes of our own outgoing messages.
  if (!msg || !msg.text || msg.is_echo) return;
  const senderId = event.sender && event.sender.id;
  if (!senderId) return;
  const text = msg.text;

  let reply;
  let tag;
  if (isGreeting(text)) {
    reply = GREETING;
    tag = 'greeting';
  } else {
    const match = findBestMatch(text);
    if (match) {
      reply = match.faq.answer;
      tag = `faq#${match.faq.id} (score ${match.score.toFixed(2)})`;
    } else {
      reply = FALLBACK;
      tag = 'fallback';
    }
  }

  // Log every incoming message + what it matched (or "fallback").
  console.log(
    `[${new Date().toISOString()}] from=${senderId} tag=${tag} msg=${JSON.stringify(text)}`
  );

  await sendReply(senderId, reply);
}

if (!PAGE_ACCESS_TOKEN) {
  console.warn('WARNING: PAGE_ACCESS_TOKEN is not set — replies will fail.');
}
if (!VERIFY_TOKEN) {
  console.warn('WARNING: VERIFY_TOKEN is not set — webhook verification will fail.');
}

app.listen(PORT, () => console.log(`Listening on port ${PORT}`));
