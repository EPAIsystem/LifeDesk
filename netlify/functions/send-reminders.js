// send-reminders.js — runs daily (see netlify.toml schedule config).
//
// Sends a gentle re-engagement push notification to users who have:
//   - a saved FCM token (meaning they enabled notifications), and
//   - not asked a question in the last 24+ hours
//
// Rotates through a pool of vertical-varied messages so the same reminder
// doesn't repeat every day — directly addresses "with so many verticals,
// people need reminding what's actually available."
//
// If a token turns out to be invalid/expired (uninstalled app, revoked
// permission, etc.), it's cleared from that user's record so future runs
// don't keep trying to send to a dead token.

const admin = require("firebase-admin");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

const REMINDER_POOL = [
  { title: "🌾 Farming season check-in", body: "Get live crop and market price advice, tailored to your region." },
  { title: "💼 Your career, one question away", body: "Build a CV or prep for an interview with your AI career coach." },
  { title: "🍲 Stuck on what to cook?", body: "Tell the Recipe Creator what's in your kitchen — get a meal plan in seconds." },
  { title: "📈 Business idea on your mind?", body: "Your AI Business Plan Writer is ready whenever you are." },
  { title: "🙏 A moment for you", body: "Your daily devotional and prayer guide are waiting in the Faith area." },
  { title: "🩺 Health questions, answered", body: "Ask LifeDesk about symptoms, remedies, or wellness — free and private." },
  { title: "📚 Study help is here", body: "Your AI Private Tutor can help with any subject, any level." },
  { title: "⚖️ Know your rights", body: "Get clear legal guidance, adapted to wherever you are." },
];

exports.handler = async () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    console.error("send-reminders: server misconfigured (missing FIREBASE_SERVICE_ACCOUNT)");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  const db = admin.firestore();
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);

  // Users with a saved token who haven't been active in 24+ hours.
  const snap = await db
    .collection("users")
    .where("fcmToken", "!=", null)
    .get();

  let sent = 0, skippedRecent = 0, cleared = 0, failed = 0;

  for (const doc of snap.docs) {
    const u = doc.data();
    if (!u.fcmToken) continue;

    // Skip anyone active within the last 24 hours.
    if (u.lastActiveAt && u.lastActiveAt.toMillis && u.lastActiveAt.toMillis() > cutoff.toMillis()) {
      skippedRecent++;
      continue;
    }

    const msg = REMINDER_POOL[Math.floor(Math.random() * REMINDER_POOL.length)];

    try {
      await admin.messaging().send({
        token: u.fcmToken,
        notification: { title: msg.title, body: msg.body },
        webpush: {
          notification: { icon: "/icon-192.png" },
          fcmOptions: { link: "https://livedesk-ai.netlify.app/" },
        },
      });
      sent++;
    } catch (e) {
      // Common Firebase error codes for a dead token — clear it so we stop
      // retrying a device that will never receive it again.
      if (e.code === "messaging/registration-token-not-registered" || e.code === "messaging/invalid-registration-token") {
        await doc.ref.update({ fcmToken: admin.firestore.FieldValue.delete() });
        cleared++;
      } else {
        console.error("send-reminders: failed for", doc.id, e.message);
        failed++;
      }
    }
  }

  const summary = { checked: snap.size, sent, skippedRecent, cleared, failed };
  console.log("send-reminders summary:", JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
