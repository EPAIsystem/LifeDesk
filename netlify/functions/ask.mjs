// ask.mjs — the modern Netlify Functions API (fetch-style handler), replacing
// the old exports.handler CommonJS format used in ask.js.
//
// WHY THIS CHANGED: the old format only supported buffered responses — the
// client waited in total silence until the ENTIRE answer was ready, and if
// that took too long, the whole request died with a timeout and nothing was
// shown. This format streams the answer back token-by-token as Claude
// generates it, so:
//   1. The user sees text appearing almost immediately (much lower perceived
//      wait time), instead of a blank "Thinking..." for 10-25+ seconds.
//   2. Streaming functions get a 60-second execution limit on Netlify
//      (vs. 26s for buffered functions) — a real increase in headroom.
//   3. Because data is actively flowing the whole time, there's no single
//      "everything or nothing" moment that can time out and lose the
//      response — even a long answer arrives progressively.
//
// IMPORTANT DEPLOYMENT NOTE: this file must be uploaded as ask.mjs, and the
// old ask.js must be DELETED from netlify/functions — having both would
// create two functions competing for the same /ask endpoint name.
//
// Protocol: newline-delimited JSON (NDJSON). Each line is one of:
//   {"delta":"..."}                  — a chunk of answer text to append
//   {"done":true,"stop_reason":"..."} — stream finished normally
//   {"error":{"type":"...","message":"..."}} — something went wrong

import Anthropic from "@anthropic-ai/sdk";
import admin from "firebase-admin";

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function ndjson(obj) {
  return new TextEncoder().encode(JSON.stringify(obj) + "\n");
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("", { status: 200, headers: CORS_HEADERS });
  }

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: "Invalid request body" } }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const mode = body.mode || "quick";
  const vertical = body.vertical || "";
  const userId = body.userId || null;

  // ── DAILY FREE-TIER LIMIT ────────────────────────────────
  // Replaces the old "30-day trial then blocked forever" model. Signups
  // showing a pricing screen before any value was demonstrated was causing
  // real signup abandonment (people saw plan cards and didn't even try to
  // log in). The new model: free forever, but paced — a daily question
  // count that resets each day, generous for a new account's first month
  // (10/day) to build trust and habit, then settles to a sustainable rate
  // (5/day). Paid and admin/whitelisted accounts are unlimited.
  const FIRST_MONTH_DAILY_LIMIT = 10;
  const STANDARD_DAILY_LIMIT = 5;
  const FIRST_MONTH_DAYS = 30;

  if (userId && admin.apps.length) {
    try {
      const db = admin.firestore();
      const userRef = db.collection("users").doc(userId);
      const userSnap = await userRef.get();
      if (userSnap.exists) {
        const u = userSnap.data();
        if (!u.isPaid && !u.adminRole) {
          const today = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" (UTC)
          const alreadyToday = u.dailyCountDate === today;
          const countSoFar = alreadyToday ? (u.dailyCount || 0) : 0;

          const accountAgeDays = (u.trialStart && u.trialStart.seconds)
            ? Math.floor((Date.now() / 1000 - u.trialStart.seconds) / 86400)
            : FIRST_MONTH_DAYS; // unknown account age — treat conservatively as past the first month
          const limit = accountAgeDays < FIRST_MONTH_DAYS ? FIRST_MONTH_DAILY_LIMIT : STANDARD_DAILY_LIMIT;

          if (countSoFar >= limit) {
            return new Response(
              JSON.stringify({
                error: {
                  type: "daily_limit_reached",
                  message: "You've used today's " + limit + " free questions. Come back tomorrow for more — or upgrade any time for unlimited access.",
                },
              }),
              { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }

          // Count this request now (not after success) so retries/failures
          // still count against the limit, same as a real usage cap should.
          userRef.update({ dailyCount: countSoFar + 1, dailyCountDate: today }).catch((e) => {
            console.error("ask.mjs: failed to update daily count:", e.message);
          });
        }
      }
    } catch (e) {
      // Transient Firestore hiccup — don't block a legitimate question over
      // our own error; log it and let the request proceed.
      console.error("ask.mjs: daily limit check failed, allowing request:", e.message);
    }
  }

  // ── MODEL SELECTION ────────────────────────────────────
  let model = "claude-haiku-4-5";
  if (vertical !== "kids" && mode === "deep") {
    model = "claude-sonnet-4-6";
  }
  if (body.model) model = body.model;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const stream = client.messages.stream({
          model,
          max_tokens: body.max_tokens || 1800,
          system: body.system || "You are LifeDesk, a helpful AI life advisor.",
          messages: body.messages || [],
          // Prompt caching: the system prompt (and the stable prefix of a
          // growing conversation history) gets reused across follow-up turns
          // instead of being billed fresh every time. Cache reads cost ~10%
          // of normal input price — this matters most exactly where LifeDesk
          // spends the most tokens: long follow-up chains (multi-part
          // business plans, tutoring sessions, etc.) where the system prompt
          // and earlier turns stay identical call after call.
          cache_control: { type: "ephemeral" },
          ...(body.tools && body.tools.length ? { tools: body.tools } : {}),
        });

        stream.on("text", (textDelta) => {
          controller.enqueue(ndjson({ delta: textDelta }));
        });

        const finalMessage = await stream.finalMessage();
        const u = finalMessage.usage || {};
        console.log(
          "ask.mjs usage — input:", u.input_tokens,
          "| cache_read:", u.cache_read_input_tokens || 0,
          "| cache_write:", u.cache_creation_input_tokens || 0,
          "| output:", u.output_tokens
        );
        controller.enqueue(ndjson({ done: true, stop_reason: finalMessage.stop_reason }));
        controller.close();
      } catch (err) {
        console.error("ask.mjs stream error:", err);
        controller.enqueue(ndjson({ error: { message: err.message || "Server error" } }));
        controller.close();
      }
    },
  });

  return new Response(readable, {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/x-ndjson" },
  });
};
