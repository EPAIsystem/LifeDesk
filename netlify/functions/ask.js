const Anthropic = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    const body   = JSON.parse(event.body || "{}");
    const mode   = body.mode     || "quick";
    const vertical = body.vertical || "";
    const userId = body.userId || null;

    // ── TRIAL / PLAN ENFORCEMENT ─────────────────────────────
    // Previously this endpoint checked nothing at all — any caller, logged in
    // or not, trial-expired or not, could hit the paid Anthropic API without
    // limit. This is a minimal but real check: a free-plan user whose 30-day
    // trial has passed is blocked and told to upgrade. It intentionally does
    // NOT try to re-implement the full per-plan daily question limits the
    // Terms of Service describes — those limits were never actually defined
    // anywhere (no numbers exist per plan tier), so inventing numbers here
    // would be a business decision, not a bug fix. Flagged separately.
    if (userId && admin.apps.length) {
      try {
        const db = admin.firestore();
        const userSnap = await db.collection("users").doc(userId).get();
        if (userSnap.exists) {
          const u = userSnap.data();
          if (u.plan === "free" && u.trialStart && u.trialStart.seconds) {
            const elapsedDays = Math.floor((Date.now() / 1000 - u.trialStart.seconds) / 86400);
            if (elapsedDays >= 30) {
              return {
                statusCode: 403,
                headers,
                body: JSON.stringify({
                  error: {
                    type: "trial_expired",
                    message: "Your 30-day free trial has ended. Upgrade to a paid plan to keep asking questions.",
                  },
                }),
              };
            }
          }
        }
      } catch (e) {
        // If the trial check itself fails (e.g. Firestore hiccup), don't
        // block a legitimate question over our own transient error —
        // log it and let the request proceed.
        console.error("ask.js: trial check failed, allowing request:", e.message);
      }
    }

    // ── MODEL SELECTION ────────────────────────────────────
    // Kids Desk → always Haiku
    // Free/Starter/Quick mode → Haiku
    // Standard and above / Deep mode → Sonnet
    let model = "claude-haiku-4-5";
    if (vertical !== "kids" && mode === "deep") {
      model = "claude-sonnet-4-6";
    }
    // Override with explicit model if provided
    if (body.model) model = body.model;

    // ── CALL ANTHROPIC ──────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      model,
      max_tokens: body.max_tokens || 1000,
      system:     body.system     || "You are LifeDesk, a helpful AI life advisor.",
      messages:   body.messages   || [],
      ...(body.tools ? { tools: body.tools } : {}),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response),
    };

  } catch (err) {
    console.error("ask.js error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: err.message || "Server error" } }),
    };
  }
};
