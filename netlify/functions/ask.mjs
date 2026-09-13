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

  // ── TRIAL / PLAN ENFORCEMENT ─────────────────────────────
  // Same check as before: a free-plan user whose 30-day trial has passed is
  // blocked and told to upgrade. Admins/whitelisted users (adminRole) and
  // anyone with isPaid:true are exempt. This does NOT implement full
  // per-plan daily question limits — those numbers were never defined
  // anywhere and inventing them here would be a business decision, not a
  // bug fix.
  if (userId && admin.apps.length) {
    try {
      const db = admin.firestore();
      const userSnap = await db.collection("users").doc(userId).get();
      if (userSnap.exists) {
        const u = userSnap.data();
        if (!u.isPaid && !u.adminRole && u.trialStart && u.trialStart.seconds) {
          const elapsedDays = Math.floor((Date.now() / 1000 - u.trialStart.seconds) / 86400);
          if (elapsedDays >= 30) {
            return new Response(
              JSON.stringify({
                error: {
                  type: "trial_expired",
                  message: "Your 30-day free trial has ended. Upgrade to a paid plan to keep asking questions.",
                },
              }),
              { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
          }
        }
      }
    } catch (e) {
      // Transient Firestore hiccup — don't block a legitimate question over
      // our own error; log it and let the request proceed.
      console.error("ask.mjs: trial check failed, allowing request:", e.message);
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
          ...(body.tools && body.tools.length ? { tools: body.tools } : {}),
        });

        stream.on("text", (textDelta) => {
          controller.enqueue(ndjson({ delta: textDelta }));
        });

        const finalMessage = await stream.finalMessage();
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
