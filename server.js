const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
// Twilio delivers inbound SMS as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
// Render terminates TLS at its proxy; trust it so req.protocol is correct
// (needed for Twilio signature validation).
app.set("trust proxy", 1);

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
  return words.length > 0 && words.every((w) => GREET_WORDS.has(w));
}

function pickReply(text) {
  if (isGreetingOnly(text)) return GREETING;
  return (findAnswer(text) || {}).answer || FALLBACK;
}

// FAQ(s) whose reply carries an "Email us" button: a real tappable button on
// every Messenger client (including desktop, where plain emails don't linkify).
// The button opens Gmail compose addressed to the shop.
const EMAIL_BUTTON_FAQ_IDS = new Set([121]);
const GMAIL_COMPOSE_URL = "https://mail.google.com/mail/?view=cm&to=Jtfarrow@pharaohscarpetsfloors.com";

function replyPayload(text) {
  if (isGreetingOnly(text)) return { message: { text: GREETING } };
  const faq = findAnswer(text);
  const answer = (faq || {}).answer || FALLBACK;
  if (faq && EMAIL_BUTTON_FAQ_IDS.has(faq.id)) {
    return {
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: answer,
            buttons: [{ type: "web_url", url: GMAIL_COMPOSE_URL, title: "Email us" }],
          },
        },
      },
    };
  }
  return { message: { text: answer } };
}

app.get("/", (req, res) => res.send("Pharaoh's Messenger Bot is running."));

// Business logo — attached to Twilio MMS appointment reminders so customers
// can see the text is really from Pharaoh's Carpets & Floors.
app.get("/logo.jpg", (req, res) => res.sendFile(path.join(__dirname, "logo.jpg")));

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
        const payload = replyPayload(message);
        await fetch(`https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ recipient: { id: senderId } }, payload)),
        });
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err.message);
  }
});

// SMS webhook (Twilio) — appointment/quote reminder replies.
//
// Twilio is configured (in the Twilio console, Messaging > the business number)
// to POST inbound SMS here as form-encoded data: From, Body, MessageSid, ...
// We reply with TwiML; Twilio delivers it as the SMS response.
//
// Flow:
//   Y -> confirmation reply (+ calendar is tagged "Confirmed" by the sender
//        script's reconciler, which owns all Google Calendar writes)
//   N -> cancellation reply (+ tagged "Cancelled")
//   R -> "a rep will reach out" reply + instant SMS to Jack with the details
//        (+ tagged "Reschedule requested")
//   anything else -> FAQ-bank answer, or the SMS fallback ("flagged for
//        Jack or Josh") when nothing matches.
//
// Customer name/time details for replies come from the most recent reminder WE
// sent to that number (looked up via Twilio's API and parsed from our own
// reminder template) — no Google credentials needed on this service.
// ---------------------------------------------------------------------------
const SMS_FALLBACK =
  "Good question — I've flagged this for Jack or Josh, they'll follow up shortly.";

const REMINDER_MARKER = "with a reminder that you have";

// Deduplicate Twilio redeliveries (it retries the webhook if we are slow).
const seenSmsSids = new Map(); // MessageSid -> timestamp (ms)
function smsAlreadyHandled(sid) {
  if (!sid) return false;
  const now = Date.now();
  if (seenSmsSids.has(sid)) return true;
  seenSmsSids.set(sid, now);
  if (seenSmsSids.size > 500) {
    for (const [k, t] of seenSmsSids) {
      if (now - t > DEDUP_WINDOW_MS) seenSmsSids.delete(k);
      if (seenSmsSids.size <= 400) break;
    }
  }
  return false;
}

function smsIntent(text) {
  const t = (text || "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
  if (/^(y|yes|yeah|yep|confirm|confirmed)$/.test(t)) return "confirm";
  if (/^(n|no|nope|cancel|cancelled|canceled)$/.test(t)) return "cancel";
  if (/^(r|reschedule)$/.test(t)) return "reschedule";
  return null;
}

// Verify the request really came from Twilio (HMAC-SHA1 of the full URL +
// sorted POST params, per Twilio's docs). Returns false when the auth token
// isn't configured, so the route stays closed until credentials exist.
function twilioSignatureValid(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const signature = req.headers["x-twilio-signature"];
  if (!signature) return false;
  const url =
    process.env.SMS_WEBHOOK_URL ||
    `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const params = req.body || {};
  const data =
    url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", token).update(data, "utf8").digest("base64");
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function twilioRestAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  return { sid, auth: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

// Find the latest reminder WE sent to this number and pull the customer's
// first name, appointment type, and time out of our own template text.
async function lookupReminderContext(toPhone) {
  try {
    const creds = twilioRestAuth();
    const from = process.env.TWILIO_PHONE_NUMBER;
    if (!creds || !from) return null;
    const url =
      `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/Messages.json` +
      `?To=${encodeURIComponent(toPhone)}&From=${encodeURIComponent(from)}&PageSize=20`;
    const res = await fetch(url, { headers: { Authorization: creds.auth } });
    if (!res.ok) return null;
    const data = await res.json();
    const msg = (data.messages || []).find(
      (m) => m.direction === "outbound-api" && (m.body || "").includes(REMINDER_MARKER)
    );
    if (!msg) return null;
    const mt = (msg.body || "").match(
      /Hello ([^,]+), this is Pharaoh's Carpets & Floors with a reminder that you have (a quote|an appointment|an installation) today at ([\d:]+ [AP]\.M\.)/
    );
    if (!mt) return null;
    return {
      firstName: mt[1],
      typeNoun: mt[2].replace(/^(a|an) /, ""), // "a quote" -> "quote"
      time: mt[3],
    };
  } catch (e) {
    console.error("lookupReminderContext error:", e.message);
    return null;
  }
}

function smsConfirmReply(ctx) {
  if (ctx)
    return (
      `Awesome, ${ctx.firstName} — you're confirmed for today at ${ctx.time}. ` +
      `Thanks for your response 👍\n\nPharaoh's Carpets & Floors LLC`
    );
  return `Awesome — you're confirmed for today. Thanks for your response 👍\n\nPharaoh's Carpets & Floors LLC`;
}

function smsCancelReply(ctx) {
  const noun = (ctx && ctx.typeNoun) || "appointment";
  const when = ctx ? ` for today at ${ctx.time}` : "";
  return (
    `No problem — we've cancelled your ${noun}${when}. ` +
    `To reschedule, just reply R or call/text us at 269-409-1239.\n\n— Pharaoh's Carpets & Floors LLC`
  );
}

function smsRescheduleReply() {
  return `Thanks — we've flagged this for Jack or Josh, and a rep will reach out shortly to get you rescheduled.\n\n— Pharaoh's Carpets & Floors LLC`;
}

function smsPickReply(text) {
  const lower = (text || "").toLowerCase().trim();
  if (/\b(hi|hello|hey|good morning|good afternoon)\b/.test(lower)) return GREETING;
  return (findAnswer(text) || {}).answer || SMS_FALLBACK;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length > 4 ? `+${"*".repeat(d.length - 4)}${d.slice(-4)}` : "***";
}

// Instant SMS to Jack when a customer asks to reschedule.
async function notifyJackReschedule(customerPhone, ctx) {
  try {
    const creds = twilioRestAuth();
    const from = process.env.TWILIO_PHONE_NUMBER;
    const jackMobile = process.env.JACK_MOBILE || "+12694506295";
    if (!creds || !from) {
      console.error("notifyJackReschedule: Twilio not configured");
      return;
    }
    const who = ctx
      ? `${ctx.firstName} ${customerPhone} today at ${ctx.time}`
      : customerPhone;
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${creds.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: creds.auth,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ To: jackMobile, From: from, Body: `Reschedule requested: ${who}` }),
      }
    );
    if (!res.ok) console.error("notifyJackReschedule failed:", res.status);
    else console.log("Notified Jack of reschedule request from", maskPhone(customerPhone));
  } catch (e) {
    console.error("notifyJackReschedule error:", e.message);
  }
}

app.post("/sms-webhook", async (req, res) => {
  const twiml = (text) =>
    `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`;
  const sendTwiml = (text) => res.type("text/xml").send(twiml(text));

  if (!twilioSignatureValid(req)) {
    console.error("SMS webhook: invalid or missing Twilio signature");
    return res.status(403).send("forbidden");
  }
  const from = req.body.From || "";
  const bodyText = req.body.Body || "";
  const sid = req.body.MessageSid || "";
  if (sid && smsAlreadyHandled(sid)) {
    console.log("SMS webhook: skipping duplicate delivery", sid);
    return sendTwiml("");
  }
  console.log("SMS inbound", JSON.stringify({ from: maskPhone(from), body: bodyText.slice(0, 160) }));

  try {
    const intent = smsIntent(bodyText);
    let reply;
    if (intent === "confirm" || intent === "cancel" || intent === "reschedule") {
      const ctx = await lookupReminderContext(from);
      if (intent === "confirm") reply = smsConfirmReply(ctx);
      else if (intent === "cancel") reply = smsCancelReply(ctx);
      else {
        reply = smsRescheduleReply();
        await notifyJackReschedule(from, ctx);
      }
    } else {
      reply = smsPickReply(bodyText);
    }
    return sendTwiml(reply);
  } catch (err) {
    console.error("SMS webhook error:", err.message);
    return sendTwiml(SMS_FALLBACK);
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Listening on ${PORT}`));
}
module.exports = { significantWords, findAnswer, pickReply, replyPayload, faqs, GREETING, FALLBACK,
  app, smsIntent, smsConfirmReply, smsCancelReply, smsRescheduleReply, smsPickReply,
  twilioSignatureValid, smsAlreadyHandled, escapeXml, maskPhone, SMS_FALLBACK,
  _setFaqs: (list) => { faqs = list; } };
