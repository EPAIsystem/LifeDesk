const Anthropic = require("@anthropic-ai/sdk");

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
