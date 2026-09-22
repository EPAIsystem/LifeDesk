// grant-premium.js — batch-grants free Premium access to a list of emails,
// for a set number of months. Callable only by verified admins.
//
// Uses the SAME planExpiry field the real Paystack renewal system already
// checks daily (check-renewals.js) — so a manually-granted free period
// expires automatically and safely on its own, with no risk of an
// accidental charge attempt, exactly like check-renewals.js already
// handles an account with no saved payment authorization.

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
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: "POST only" } }) };
  }

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not set");
    }

    const authHeader = event.headers.authorization || event.headers.Authorization || "";
    const idToken = authHeader.replace(/^Bearer\s+/i, "");
    if (!idToken) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: { message: "Missing auth token" } }) };
    }

    const db = admin.firestore();
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: { message: "Invalid auth token" } }) };
    }

    // Same admin check as admin-stats.js — role must specifically be 'admin'.
    const adminDoc = await db.collection("admins").doc(decoded.email.toLowerCase()).get();
    if (!adminDoc.exists || adminDoc.data().role !== "admin") {
      return { statusCode: 403, headers, body: JSON.stringify({ error: { message: "Not authorized" } }) };
    }

    const body = JSON.parse(event.body || "{}");
    const emails = Array.isArray(body.emails) ? body.emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean) : [];
    const durationMonths = Number(body.durationMonths);
    const label = String(body.label || "Tester grant").slice(0, 100);

    if (!emails.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: "No emails provided" } }) };
    }
    if (!durationMonths || durationMonths <= 0 || durationMonths > 24) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: { message: "durationMonths must be between 1 and 24" } }) };
    }

    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + durationMonths);
    const expiryTimestamp = admin.firestore.Timestamp.fromDate(expiryDate);

    const granted = [];
    const notFound = [];
    const failed = [];

    for (const email of emails) {
      try {
        const snap = await db.collection("users").where("email", "==", email).limit(1).get();
        if (snap.empty) {
          notFound.push(email);
          continue;
        }
        const doc = snap.docs[0];
        await doc.ref.update({
          isPaid: true,
          planExpiry: expiryTimestamp,
          planName: label,
          renewalFailed: admin.firestore.FieldValue.delete(),
          renewalFailReason: admin.firestore.FieldValue.delete(),
        });
        granted.push(email);
      } catch (e) {
        console.error("grant-premium: failed for", email, e.message);
        failed.push(email);
      }
    }

    const result = {
      granted,
      notFound, // these emails have no account yet — they need to sign up first, then be granted again
      failed,
      expiresOn: expiryDate.toISOString().slice(0, 10),
    };
    console.log("grant-premium summary:", JSON.stringify(result));
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error("grant-premium error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
