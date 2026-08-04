const Anthropic = require("@anthropic-ai/sdk");
const admin = require("firebase-admin");

// ── FIREBASE ADMIN ────────────────────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

// ── MODEL SELECTION ───────────────────────────────────────────────────────────
const MODELS = {
  haiku:    'claude-haiku-4-5',
  sonnet:   'claude-sonnet-4-6',
  opus:     'claude-opus-4-7',
};

// ── PLAN LIMITS ───────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  'free':                  { quick:5,    deep:0,   model:'haiku'  },
  'starter':               { quick:20,   deep:0,   model:'haiku'  },
  'standard':              { quick:60,   deep:20,  model:'sonnet' },
  'premium':               { quick:100,  deep:35,  model:'sonnet' },
  'premium-pro':           { quick:200,  deep:80,  model:'sonnet' },
  'family-starter':        { quick:80,   deep:0,   model:'haiku'  },
  'family-standard':       { quick:200,  deep:60,  model:'sonnet' },
  'family-premium':        { quick:350,  deep:100, model:'sonnet' },
  'family-premium-pro':    { quick:600,  deep:200, model:'sonnet' },
  'workplace-standard':    { quick:500,  deep:120, model:'sonnet' },
  'workplace-premium':     { quick:800,  deep:200, model:'sonnet' },
  'workplace-premium-pro': { quick:2000, deep:500, model:'sonnet' },
  'admin':                 { quick:9999, deep:9999,model:'sonnet' },
};

function getPlanLimits(plan) {
  if (!plan) return PLAN_LIMITS['free'];
  const base = plan.replace(/-yr$/, '');
  return PLAN_LIMITS[base] || PLAN_LIMITS['free'];
}

function selectModel(plan, mode, vertical) {
  // Kids Desk → always Haiku regardless of plan
  if (vertical === 'kids') return MODELS.haiku;
  // Deep Research → Opus
  if (mode === 'research') return MODELS.opus;
  // Free + Starter → always Haiku
  const haiku_plans = ['free', 'starter', 'family-starter'];
  const base = (plan || 'free').replace(/-yr$/, '');
  if (haiku_plans.includes(base)) return MODELS.haiku;
  // Quick mode → Haiku
  if (mode === 'quick') return MODELS.haiku;
  // Deep mode → Sonnet
  return MODELS.sonnet;
}

// ── DATE KEY ──────────────────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

// ── USAGE ENFORCEMENT ─────────────────────────────────────────────────────────
async function checkAndIncrementUsage(userId, mode) {
  const today = todayKey();
  const usageRef = db.collection('users').doc(userId)
                     .collection('usage').doc(today);

  return db.runTransaction(async (tx) => {
    const userSnap  = await tx.get(db.collection('users').doc(userId));
    const usageSnap = await tx.get(usageRef);

    const userData  = userSnap.exists ? userSnap.data() : {};
    const isAdmin   = !!userData.adminRole;
    const plan      = isAdmin ? 'admin' : (userData.plan || 'free');
    const limits    = getPlanLimits(plan);

    const usage     = usageSnap.exists ? usageSnap.data() : { quick: 0, deep: 0 };
    const quickUsed = usage.quick || 0;
    const deepUsed  = usage.deep  || 0;

    // Check limit
    if (mode === 'deep' || mode === 'research') {
      if (!isAdmin && deepUsed >= limits.deep) {
        return { allowed: false, type: 'deep', used: deepUsed, limit: limits.deep, plan };
      }
    } else {
      if (!isAdmin && quickUsed >= limits.quick) {
        return { allowed: false, type: 'quick', used: quickUsed, limit: limits.quick, plan };
      }
    }

    // Increment
    const update = { date: today };
    if (mode === 'deep' || mode === 'research') {
      update.deep = admin.firestore.FieldValue.increment(1);
    } else {
      update.quick = admin.firestore.FieldValue.increment(1);
    }
    tx.set(usageRef, update, { merge: true });

    return { allowed: true, plan };
  });
}

// ── MAIN HANDLER ──────────────────────────────────────────────────────────────
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
    const body     = JSON.parse(event.body || "{}");
    const userId   = body.userId   || null;
    const mode     = body.mode     || 'quick';   // 'quick' | 'deep' | 'research'
    const vertical = body.vertical || '';

    // ── ENFORCE USAGE LIMITS ────────────────────────────────────────────────
    if (userId) {
      const usage = await checkAndIncrementUsage(userId, mode);
      if (!usage.allowed) {
        const isDeep  = usage.type === 'deep';
        const planName = usage.plan.split('-').map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
        const msg = isDeep
          ? `You have used all ${usage.limit} Deep mode questions today on your ${planName} plan. Switch to Quick mode or upgrade your plan.`
          : `You have reached your ${usage.limit} question daily limit on your ${planName} plan. Upgrade your plan or come back tomorrow.`;
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({
            error: {
              type:    isDeep ? 'deep_limit_reached' : 'daily_limit_reached',
              message: msg,
              limit:   usage.limit,
              plan:    usage.plan,
            }
          }),
        };
      }
    }

    // ── SELECT MODEL ────────────────────────────────────────────────────────
    const userPlan   = userId ? null : 'free'; // plan resolved inside checkAndIncrementUsage
    const modelId    = body.model || selectModel(body.plan || 'free', mode, vertical);

    // ── CALL ANTHROPIC ──────────────────────────────────────────────────────
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      modelId,
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
