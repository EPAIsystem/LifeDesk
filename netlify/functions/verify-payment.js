const admin = require("firebase-admin");
const https = require("https");
const PLAN_PRICES = require("./plans-data.json"); // exact mirror of PLANS in index.html — USD prices

// ── FIREBASE ADMIN INIT (singleton across warm invocations) ─────────────────
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

function paystackVerify(reference) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path: "/transaction/verify/" + encodeURIComponent(reference),
        method: "GET",
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not set");
    }
    if (!process.env.PAYSTACK_SECRET_KEY) {
      throw new Error("Server misconfigured: PAYSTACK_SECRET_KEY is not set");
    }

    const body = JSON.parse(event.body || "{}");
    const { reference, planId, billingMode } = body;
    if (!reference || !planId || !billingMode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: { message: "Missing reference, planId or billingMode" } }),
      };
    }

    // ── 1. AUTHENTICATE THE CALLER ──────────────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!idToken) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: { message: "Missing auth token" } }) };
    }
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: { message: "Invalid auth token" } }) };
    }
    const uid = decoded.uid;

    // ── 2. IDEMPOTENCY — refuse to process the same reference twice ────────
    const db = admin.firestore();
    const paymentRef = db.collection("processedPayments").doc(reference);
    const existing = await paymentRef.get();
    if (existing.exists) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, alreadyProcessed: true, plan: existing.data().planId }),
      };
    }

    // ── 3. VERIFY THE TRANSACTION WITH PAYSTACK DIRECTLY ────────────────────
    const verification = await paystackVerify(reference);
    if (!verification || !verification.data) {
      throw new Error("Could not verify transaction with Paystack");
    }
    const tx = verification.data;
    if (tx.status !== "success") {
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({ error: { message: "Payment was not successful" } }),
      };
    }

    // ── 4. CHECK THE AMOUNT ACTUALLY PAID MATCHES THE PLAN (anti-tamper) ───
    const table = PLAN_PRICES[billingMode];
    const planInfo = table ? table[planId] : null;
    if (!planInfo) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: "Unknown plan" } }) };
    }
    if (tx.currency !== "GHS") {
      return { statusCode: 402, headers, body: JSON.stringify({ error: { message: "Unexpected payment currency" } }) };
    }
    // tx.amount is in pesewas. FX drifts between page-load and payment, so we
    // check against a conservative floor rather than an exact rate — this still
    // blocks someone paying a token amount for an expensive plan.
    const minGhsPerUsd = 8; // well below any realistic GHS/USD rate
    const minExpectedPesewas = Math.round(planInfo.price * minGhsPerUsd * 100);
    if (tx.amount < minExpectedPesewas) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: { message: "Payment amount too low for this plan" } }) };
    }

    // ── 5. UPGRADE THE PLAN SERVER-SIDE ─────────────────────────────────────
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + (billingMode === "annual" ? 12 : 1));

    // Capture the reusable card authorization (if Paystack granted one and the
    // card supports it — some cards/banks don't allow reusable charges).
    // Without this, auto-renewal is structurally impossible: there is no way
    // to charge the customer again without asking them to re-enter card
    // details each time.
    const auth = tx.authorization || {};
    const updateData = {
      plan: planId,
      planName: planInfo.name,
      planExpiry: admin.firestore.Timestamp.fromDate(expiry),
      billingMode,
      paystackRef: reference,
      paystackEmail: tx.customer && tx.customer.email ? tx.customer.email : null,
      lastChargedAmountPesewas: tx.amount,
      renewalFailed: false,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (auth.reusable && auth.authorization_code) {
      updateData.paystackAuth = {
        authorization_code: auth.authorization_code,
        last4: auth.last4 || null,
        bank: auth.bank || null,
        cardType: auth.card_type || null,
      };
    }

    await db.collection("users").doc(uid).update(updateData);

    await paymentRef.set({
      uid,
      planId,
      billingMode,
      amount: tx.amount,
      currency: tx.currency,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        plan: { id: planId, name: planInfo.name },
      }),
    };
  } catch (err) {
    console.error("verify-payment.js error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: { message: err.message || "Server error" } }),
    };
  }
};
