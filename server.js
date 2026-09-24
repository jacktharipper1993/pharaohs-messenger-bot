const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const faqPath = path.join(__dirname, "data", "faq-bank.json");
let faqs = [];
try {
  const raw = fs.readFileSync(faqPath, "utf8");
  faqs = JSON.parse(raw);
  console.log(`Loaded ${faqs.length} FAQs`);
} catch (e) {
  console.error("Failed to load FAQ bank:", e.message);
}

const GREETING =
  "Hi! Thanks for reaching out to Pharaoh's Carpets & Floors. Ask me anything about flooring, estimates, scheduling, or financing — or call/text us at 269-409-1239.";

const FALLBACK =
  "Good question — to give you the right answer, could you share a few more details (or call/text us at 269-409-1239)?";

function findAnswer(message) {
  const norm = message.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = norm.split(" ").filter((w) => w.length > 2);

  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    const q = faq.question.toLowerCase();
    let score = 0;
    for (const w of words) if (q.includes(w)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = faq;
    }
  }
  return bestScore >= 2 ? best : null;
}

function pickReply(text) {
  const lower = text.toLowerCase().trim();
  if (/\b(hi|hello|hey|good morning|good afternoon)\b/.test(lower)) return GREETING;
  return (findAnswer(text) || {}).answer || FALLBACK;
}

app.get("/", (req, res) => res.send("Pharaoh's Messenger Bot is running."));

// Privacy policy — required by Meta for App Review.
const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Pharaoh's Carpets &amp; Floors Messenger Bot</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#222}</style>
</head><body>
<h1>Privacy Policy — Pharaoh's Carpets &amp; Floors Messenger Bot</h1>
<p><strong>Effective:</strong> September 24, 2026</p>
<h2>What this bot does</h2>
<p>This bot provides automated replies in Facebook Messenger conversations with the Pharaoh's Carpets &amp; Floors LLC Facebook Page. It answers common questions about flooring, estimates, scheduling, and financing using our own approved FAQ answers.</p>
<h2>Information we receive</h2>
<p>When you message our Page, Meta shares your message text and your Page-scoped user ID with our bot so it can reply. We do not ask for or collect names, email addresses, phone numbers, or payment details through the bot.</p>
<h2>How we use it</h2>
<p>Your message is used solely to generate an automated reply, or — when the bot can't answer — to flag your question so Jack or Josh can follow up personally.</p>
<h2>What we don't do</h2>
<ul>
<li>We do not sell or share your information with anyone.</li>
<li>We do not use your messages for advertising.</li>
<li>We do not keep conversations longer than needed to run the bot; server logs rotate automatically.</li>
</ul>
<h2>Your choices</h2>
<p>Prefer not to use automated replies? Call or text us directly at <a href="tel:+12694091239">269-409-1239</a> instead.</p>
<h2>Contact</h2>
<p>Pharaoh's Carpets &amp; Floors LLC<br>251 Hatfield Rd, Niles Charter, MI<br><a href="tel:+12694091239">269-409-1239</a></p>
</body></html>`;

app.get('/privacy-policy', (req, res) => {
  res.type('html').send(PRIVACY_HTML);
});

// Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Webhook event receiver
app.post("/webhook", async (req, res) => {
  // Log every event we receive (or "fallback")
  console.log("Webhook event received", JSON.stringify(req.body).slice(0, 500));
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "page") return;
    for (const entry of body.entry || []) {
      for (const event of entry.messaging || []) {
        const senderId = event.sender && event.sender.id;
        const message = event.message && event.message.text;
        if (!senderId || !message) continue;
        const replyText = pickReply(message);
        await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipient: { id: senderId },
            message: { text: replyText },
          }),
        });
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
