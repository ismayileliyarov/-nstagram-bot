const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

// ─── Konfiqurasiya ───────────────────────────────────────────────
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ─── Groq ilə cavab yarat ───────────────────────────────────────
async function generateReply(commentText) {
  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama3-8b-8192",
      max_tokens: 150,
      messages: [
        {
          role: "system",
          content: `Sən 01 Code Studio-nun Instagram köməkçi botusun. 
01 Code Studio Azərbaycanda vebsayt, mobil tətbiq və AI həlləri hazırlayan şirkətdir.
Müştəri şərhlərinə qısa, mehriban və peşəkar Azərbaycan dilində cavab ver (1-2 cümlə).
Onları ətraflı məlumat üçün DM-ə dəvət et. Emoji az istifadə et.`,
        },
        {
          role: "user",
          content: `Müştəri şərhi: "${commentText}"`,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content.trim();
}

// ─── Instagram Private Reply (DM) göndər ────────────────────────
async function sendPrivateReply(commentId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    {
      recipient: { comment_id: commentId },
      message: { text: message },
    },
    {
      params: { access_token: CONFIG.IG_ACCESS_TOKEN },
    }
  );
}

// ─── Webhook Verification ────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified!");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Webhook Events ──────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const comment = change.value;
        const commentId = comment.id;
        const commentText = comment.text;
        const fromUser = comment.from?.username || "istifadəçi";

        console.log(`📩 Yeni şərh: @${fromUser} → "${commentText}"`);

        // Groq ilə cavab yarat
        const reply = await generateReply(commentText);
        console.log(`🤖 Bot cavabı: ${reply}`);

        // DM göndər
        await sendPrivateReply(commentId, reply);
        console.log(`✉️ DM göndərildi → @${fromUser}`);
      }
    }
  } catch (err) {
    console.error("❌ Xəta:", err.response?.data || err.message);
  }
});

// ─── Health check ────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("01CS Instagram Bot işləyir ✅");
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Server port ${CONFIG.PORT}-də başladı`);
});
