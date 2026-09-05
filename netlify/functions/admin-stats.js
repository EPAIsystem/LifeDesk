// admin-stats.js — returns subscriber counts, callable only by verified admins.
// Re-checks admin status server-side against the 'admins' collection rather
// than trusting any client-side flag, since this returns data about every
// user on the platform.

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
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

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

    // Re-verify admin status server-side — never trust a client-supplied flag here.
    const adminDoc = await db.collection("admins").doc(decoded.email.toLowerCase()).get();
    if (!adminDoc.exists) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: { message: "Not authorized" } }) };
    }

    // Aggregate counts. Firestore's count() aggregation avoids pulling every
    // document just to count them.
    const usersRef = db.collection("users");
    const [totalSnap, freeSnap, paidSnap, failedSnap] = await Promise.all([
      usersRef.count().get(),
      usersRef.where("plan", "==", "free").count().get(),
      usersRef.where("plan", "!=", "free").count().get(),
      usersRef.where("renewalFailed", "==", true).count().get(),
    ]);

    // Per-plan breakdown needs actual docs since count() can't group-by.
    const paidDocsSnap = await usersRef.where("plan", "!=", "free").get();
    const byPlan = {};
    paidDocsSnap.forEach((doc) => {
      const p = doc.data().planName || doc.data().plan || "Unknown";
      byPlan[p] = (byPlan[p] || 0) + 1;
    });

    const result = {
      total: totalSnap.data().count,
      free: freeSnap.data().count,
      paid: paidSnap.data().count,
      renewalFailed: failedSnap.data().count,
      byPlan,
    };

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error("admin-stats error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
