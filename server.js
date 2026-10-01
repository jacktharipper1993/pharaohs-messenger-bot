const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Conversational filler with no matching value. None of these appear as
// significant words in any FAQ question or variant (verified), so dropping
// them keeps "awesome, so I have a question: do you offer financing?" matching.
const FILLER = new Set(
  "awesome please hey hello thanks thank question questions quick wondering wonder kinda sorta stuff things maybe basically very".split(" ")
);

// Acronym expansion so "lvp" counts as "luxury vinyl plank" everywhere.
// (LVP only ever appears in LVP-related FAQs, so this can't misroute.)
const ALIASES = { lvp: "luxury vinyl plank" };

const faqPath = path.join(__dirname, "data", "faq-bank.json");
let faqs = [];
try {
  const raw = fs.readFileSync(faqPath, "utf8");
  faqs = JSON.parse(raw);
  console.log(`Loaded ${faqs.length} FAQs`);
} catch (e) {
  console.error("Failed to load FAQ bank:", e.message);
}

// Optional variant phrasings per FAQ (data/faq-variants.json maps faq id -> [variant, ...]).
// Lets reworded customer questions match the right FAQ instead of falling back.
const variantsPath = path.join(__dirname, "data", "faq-variants.json");
try {
  const faqVariants = JSON.parse(fs.readFileSync(variantsPath, "utf8"));
  let n = 0;
  for (const faq of faqs) {
    const v = faqVariants[String(faq.id)] || [];
    n += v.length;
    faq.texts = [faq.question].concat(v);
    // Word sets for whole-word matching ("downstairs" must not match "stairs").
    faq.wordSets = faq.texts.map((t) => new Set(significantWords(t)));
  }
  console.log(`Loaded ${n} FAQ variants`);
} catch (e) {
  for (const faq of faqs) {
    faq.texts = [faq.question];
    faq.wordSets = [new Set(significantWords(faq.question))];
  }
  console.log("No FAQ variants file found, matching on questions only");
}

const GREETING =
  "Hi! I'm JJ, the Pharaoh's Carpets & Floors agent. Ask me anything about flooring, estimates, scheduling, or financing \u2014 or call/text us at 269-409-1239.";

const FALLBACK =
  "Good question — I want to make sure you get the right answer, so I've flagged this for Jack or Josh. They'll follow up shortly, or you can reach us now at 269-409-1239.";

// Deduplicate webhook redeliveries: Meta occasionally delivers the same
// message event more than once. Track recent message ids so we only
// answer each inbound message a single time.
const seenMids = new Map(); // mid -> timestamp (ms)
const DEDUP_WINDOW_MS = 10 * 60 * 1000;
function alreadyAnswered(mid) {
  if (!mid) return false;
  const now = Date.now();
  if (seenMids.has(mid)) return true;
  seenMids.set(mid, now);
  if (seenMids.size > 500) {
    for (const [k, t] of seenMids) {
      if (now - t > DEDUP_WINDOW_MS) seenMids.delete(k);
      if (seenMids.size <= 400) break;
    }
  }
  return false;
}

function significantWords(text) {
  let t = text.toLowerCase();
  for (const [k, v] of Object.entries(ALIASES)) {
    t = t.replace(new RegExp("\\b" + k + "\\b", "g"), v);
  }
  return t
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2 && !FILLER.has(w));
}

// Word rarity across every FAQ text (question + variants), so distinctive
// words ("lvp", "acorn") outvote filler-y ones ("you", "can", "flooring").
const docFreq = {};
let textCount = 0;
for (const faq of faqs) {
  for (const ws of faq.wordSets) {
    textCount++;
    for (const w of ws) docFreq[w] = (docFreq[w] || 0) + 1;
  }
}
function idfOf(w) {
  return Math.log(1 + textCount / (docFreq[w] || 1));
}

function findAnswer(message) {
  const words = [...new Set(significantWords(message))];
  if (!words.length) return null;

  let best = null;
  let bestScore = 0;
  for (const faq of faqs) {
    for (const ws of faq.wordSets) {
      let matched = 0;
      let weight = 0;
      let total = 0;
      for (const w of ws) total += idfOf(w);
      for (const w of words) {
        if (ws.has(w)) {
          matched++;
          weight += idfOf(w);
        }
      }
      // Needs at least 2 word hits and a good share of the text's signal.
      // Rare, distinctive words ("lvp", "acorn") outvote common ones 
      // ("you", "can", "flooring"), so rewordings land right and
      // near-misses fall through to the fallback instead of a wrong answer.
      const coverage = total > 0 ? weight / total : 0;
      const score = matched >= 2 && coverage >= 0.55 ? weight : 0;
      if (score > bestScore) {
        bestScore = score;
        best = faq;
      }
    }
  }
  return best;
}

// Words that can make up a greeting and nothing else ("hi", "hey there", "good morning").
const GREET_WORDS = new Set(["hi", "hello", "hey", "good", "morning", "afternoon", "there", "yo"]);

// Greeting only when the message is basically just a greeting.
// "hey, can I pay over time?" has a real question in it, so it goes to the matcher.
function isGreetingOnly(text) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  return words.length > 0 && words.every((w) => GREET_WORDS.has(w));}

}

}

function pickReply(text) {
  if (isGreetingOnly(text)) return GREETING;
  return (findAnswer(text) || {}).answer || FALLBACK;}
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
        const mid = event.message && event.message.mid;
        if (!senderId || !message) continue;
        if (alreadyAnswered(mid)) {
          console.log("Skipping duplicate delivery of", mid);
          continue;
        }
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
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on ${PORT}`));
}
module.exports = { significantWords, findAnswer, pickReply, faqs, GREETING, FALLBACK };
