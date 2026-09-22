// admin-moderate.js — lets a verified admin view pending community reports
// and remove a reported post. Callable only by verified admins.
//
// Regular users can't remove someone else's post (Firestore rules only let
// the author edit their own, or others touch just the vote fields) — this
// uses the Admin SDK, which bypasses client rules entirely, same pattern as
// grant-premium.js and admin-stats.js.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

async function verifyAdmin(event, db) {
  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const idToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!idToken) return { ok: false, status: 401, message: "Missing auth token" };
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    return { ok: false, status: 401, message: "Invalid auth token" };
  }
  const adminDoc = await db.collection("admins").doc(decoded.email.toLowerCase()).get();
  if (!adminDoc.exists || adminDoc.data().role !== "admin") {
    return { ok: false, status: 403, message: "Not authorized" };
  }
  return { ok: true, email: decoded.email };
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      throw new Error("Server misconfigured: FIREBASE_SERVICE_ACCOUNT is not set");
    }
    const db = admin.firestore();
    const auth = await verifyAdmin(event, db);
    if (!auth.ok) {
      return { statusCode: auth.status, headers, body: JSON.stringify({ error: { message: auth.message } }) };
    }

    // GET = list pending reports, joined with the reported question's text
    // for context. POST = act on one (remove the post, or dismiss the report).
    if (event.httpMethod === "GET") {
      const reportsSnap = await db.collection("community_reports").where("status", "==", "pending").orderBy("timestamp", "desc").limit(50).get();
      const reports = [];
      for (const doc of reportsSnap.docs) {
        const r = doc.data();
        let questionText = "(post no longer exists)";
        try {
          const qDoc = await db.collection("community_questions").doc(r.questionId).get();
          if (qDoc.exists) questionText = qDoc.data().question || questionText;
        } catch (e) {}
        reports.push({
          id: doc.id,
          questionId: r.questionId,
          questionText: questionText,
          reason: r.reason,
          timestamp: r.timestamp ? r.timestamp.toDate().toISOString() : null,
        });
      }
      return { statusCode: 200, headers, body: JSON.stringify({ reports }) };
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const action = body.action; // 'remove_post' | 'dismiss'
      const reportId = body.reportId;
      const questionId = body.questionId;
      if (!reportId || !action) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: { message: "reportId and action required" } }) };
      }
      if (action === "remove_post" && questionId) {
        await db.collection("community_questions").doc(questionId).update({ status: "removed_by_admin" });
      }
      await db.collection("community_reports").doc(reportId).update({
        status: action === "remove_post" ? "resolved_removed" : "dismissed",
        resolvedBy: auth.email,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: { message: "Method not allowed" } }) };
  } catch (e) {
    console.error("admin-moderate error:", e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: { message: e.message } }) };
  }
};
