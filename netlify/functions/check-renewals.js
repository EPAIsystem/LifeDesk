// check-renewals.js — runs daily (see netlify.toml schedule config).
//
// Finds users whose paid plan has expired and attempts to charge their saved
// card authorization for the same amount as last time. Before this function
// existed, NOTHING checked planExpiry after it was set — paid access simply
// never expired and never actually renewed, despite the Terms of Service
// promising auto-renewal.
//
// Outcomes per user:
//   - Has a saved reusable authorization + charge succeeds -> extend
//     planExpiry by one more cycle, keep their plan.
//   - Has a saved authorization but the charge fails (card declined,
//     expired, insufficient funds, etc.) -> downgrade to free, mark
//     renewalFailed:true so the app can prompt them to re-subscribe.
//   - Has no saved authorization at all (paid before this fix existed, or
//     their bank didn't allow a reusable charge) -> downgrade to free,
//     renewalFailed:true, reason 'no_saved_card'.
//
// NOTE: this has not been exercised against a live Paystack charge in this
// environment — test with a small real renewal before trusting it fully in
// production, and watch the Netlify function logs after the first few runs.

const admin = require("firebase-admin");
const https = require("https");

if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) {
    const svc = JSON.parse(raw);
    admin.initializeApp({ credential: admin.credential.cert(svc) });
  }
}

function chargeAuthorization(authorizationCode, email, amountPesewas) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      authorization_code: authorizationCode,
      email: email,
      amount: amountPesewas,
      currency: "GHS",
    });
    const req = https.request(
      {
        hostname: "api.paystack.co",
        path: "/transaction/charge_authorization",
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.PAYSTACK_SECRET_KEY,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
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
    req.write(payload);
    req.end();
  });
}

exports.handler = async () => {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT || !process.env.PAYSTACK_SECRET_KEY) {
    console.error("check-renewals: server misconfigured (missing env vars)");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  const db = admin.firestore();
  const now = admin.firestore.Timestamp.now();

  // Users whose paid plan has expired as of right now.
  const expiredSnap = await db
    .collection("users")
    .where("planExpiry", "<=", now)
    .where("plan", "!=", "free")
    .get();

  let renewed = 0, downgraded = 0, skipped = 0;

  for (const doc of expiredSnap.docs) {
    const u = doc.data();

    // Admins have planExpiry:null and are excluded by the <= now filter
    // already (null doesn't match a range query), but double-guard anyway.
    if (u.adminRole) { skipped++; continue; }

    if (!u.paystackAuth || !u.paystackAuth.authorization_code || !u.lastChargedAmountPesewas) {
      // No way to charge this person again — likely paid before this fix
      // existed, or their card didn't support reusable authorization.
      await doc.ref.update({
        plan: "free",
        planName: "Free",
        planExpiry: null,
        renewalFailed: true,
        renewalFailReason: "no_saved_card",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      downgraded++;
      continue;
    }

    try {
      const result = await chargeAuthorization(
        u.paystackAuth.authorization_code,
        u.paystackEmail || u.email,
        u.lastChargedAmountPesewas
      );

      if (result && result.data && result.data.status === "success") {
        const nextExpiry = new Date();
        nextExpiry.setMonth(nextExpiry.getMonth() + (u.billingMode === "annual" ? 12 : 1));
        await doc.ref.update({
          planExpiry: admin.firestore.Timestamp.fromDate(nextExpiry),
          paystackRef: result.data.reference,
          renewalFailed: false,
          lastRenewedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        renewed++;
      } else {
        await doc.ref.update({
          plan: "free",
          planName: "Free",
          planExpiry: null,
          renewalFailed: true,
          renewalFailReason: (result && result.data && result.data.gateway_response) || "charge_declined",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        downgraded++;
      }
    } catch (e) {
      console.error("check-renewals: charge error for", doc.id, e.message);
      // Don't downgrade on a network/API error — try again next run rather
      // than punishing the customer for our own transient failure.
      skipped++;
    }
  }

  const summary = { checked: expiredSnap.size, renewed, downgraded, skipped };
  console.log("check-renewals summary:", JSON.stringify(summary));
  return { statusCode: 200, body: JSON.stringify(summary) };
};
