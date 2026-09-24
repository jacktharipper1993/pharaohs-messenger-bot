# Pharaoh's Messenger Bot

Facebook Messenger webhook bot for **Pharaoh's Carpets & Floors LLC**. It answers
customer messages using **only** the 120 approved Q&As in `data/faq-bank.json` —
it never invents answers. Anything it can't match gets a handoff message so Jack
or Josh can follow up personally.

## How it works

- `GET /webhook` — Meta's verification handshake (checks `hub.verify_token`
  against your `VERIFY_TOKEN`, returns `hub.challenge`).
- `POST /webhook` — receives Messenger events, finds the best FAQ match, and
  replies through the Messenger Send API.
- **Matching:** the message is lowercased, punctuation is stripped, common
  stopwords are removed, and words are lightly stemmed. Each FAQ question is
  scored by keyword overlap: `matched keywords ÷ keywords in the FAQ question`.
  The best score **≥ 0.3** wins; otherwise the fallback handoff message is sent.
- **Greetings** ("hi", "hello", "hey", …) get the greeting message.
- Every incoming message is logged with the matched FAQ id (or `fallback`).

## Setup (already done)

1. Facebook app created at developers.facebook.com with the Messenger product.
2. GitHub repo `pharaohs-messenger-bot` holds this code.
3. Deployed on Render with `PAGE_ACCESS_TOKEN` and `VERIFY_TOKEN` env vars.
4. Webhook subscribed in the Messenger product settings (`messages` field).

## Before going live (done 2026-09-24)

- [x] Jack approved the greeting text in `server.js`
- [x] Jack approved the fallback text in `server.js`
- [x] Jack reviewed `data/faq-bank.json` — all 120 answers approved
