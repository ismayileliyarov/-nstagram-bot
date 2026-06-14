const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json());

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  PORT: process.env.PORT || 3000,
};

// ─── Təkrar cavabı önləmək üçün işlənmiş ID-lər ─────────────────
const processed = new Set();

// ─── Şərhin cavablanmalı olub olmadığını yoxla ───────────────────
function shouldReply(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();
  if (t.replace(/\s/g, "").length < 3) return false;
  const emojiOnly = /^[\p{Emoji}\s!?.❤️👍🔥💯✅⭐🙏]+$/u.test(t);
  if (emojiOnly) return false;

  const triggers = [
    "salam", "hello", "hi", "hey",
    "məlumat", "melumat", "bilgi", "info",
    "qiymət", "qiymet", "nədir", "nedir",
    "necə", "nece", "nə vaxt", "ne vaxt",
    "sifariş", "siparis", "sifaris",
    "sayt", "vebsayt", "website", "web",
    "tətbiq", "tetbiq", "mobil", "app",
    "erp", "crm", "sistem", "avtomatlaşdırma",
    "seo", "nömrə", "nomre", "əlaqə", "elaqe",
    "müddət", "muddet", "nə qədər", "ne qeder",
    "ödəniş", "odenis", "kömək", "komek",
    "maraqlanıram", "maraqlıdır",
    "istəyirəm", "isteyirem",
    "bəli", "beli", "yardım", "yardim",
    "dəstək", "destek", "xidmət", "xidmet",
    "hazırlayın", "hazırlayırsınız", "?",
  ];

  return triggers.some(kw => t.includes(kw));
}

// ─── System prompt ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Sən 01 Code Studio-nun Instagram mesaj botusun. Adın "01 Bot"-dur.

ŞİRKƏT MƏLUMATI:
- Ad: 01 Code Studio
- Vebsayt: www.01cs.site | Instagram: @01cs.az
- WhatsApp: +994 10 717 20 34
- Email: info@01cs.site
- Dəstək: 7/24

XİDMƏTLƏR VƏ QİYMƏTLƏR:
- Vizit/Korporativ Sayt: 250-700 AZN
- E-ticarət/Online Mağaza: 700-1800 AZN
- ERP/CRM/Avtomatlaşdırma: 1200 AZN-dən
- Mobil Tətbiq (iOS/Android): 1800 AZN-dən
- SEO Optimizasiyası: fərdi qiymət
- Texniki Dəstək/İnteqrasiya: fərdi qiymət

Qiymətlər tələbə görə dəyişir. Dəqiq qiymət üçün mütləq WhatsApp-a yönləndir.

TƏZ-TEZ SUALLAR:
- Müddət? → Sadə sayt 5-10 iş günü, böyük layihə 3-6 həftə
- Telefonlarda görünür? → Bəli, 100% responsiv
- Ödəniş sistemi? → Bəli, yerli və beynəlxalq sistemlər qoşulur
- Sonradan dəstək? → Bəli, müqaviləyə görə pulsuz texniki dəstək
- Köhnə sayt yenilənir? → Bəli, tam yeniləmə xidməti var

ÜSLUB QAYDALARI:
- Azərbaycan dilində, təbii və qısa cavab ver (2-3 cümlə)
- Heç vaxt uydurma məlumat yazma, bilmirsənsə WhatsApp-a yönləndir
- "Çox sevdiyimiz", "hörmətli" kimi qəliz ifadələr işlətmə
- Sadə, dostcasına danış
- Hər cavabın sonunda müştərini ya DM-ə, ya WhatsApp-a yönləndir
- Emoji çox az işlət`;

// ─── Groq ilə cavab yarat ────────────────────────────────────────
async function generateReply(userMessage, context = "comment") {
  const note = context === "dm"
    ? "Müştəri DM-dən yazıb. Ətraflı cavab ver, lazım olsa WhatsApp-a yönləndir."
    : "Müştəri şərh yazıb. Qısa, dəvətkar cavab ver, ətraflı məlumat üçün DM-ə çağır.";

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.1-8b-instant",
      max_tokens: 180,
      temperature: 0.5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${note}\n\nMesaj: "${userMessage}"` },
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

// ─── Şərhə cavab yaz ─────────────────────────────────────────────
async function replyToComment(commentId, message) {
  await axios.post(
    `https://graph.instagram.com/v21.0/${commentId}/replies`,
    { message },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── DM göndər (şərhdən) ─────────────────────────────────────────
async function sendDM(commentId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    { recipient: { comment_id: commentId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── DM cavabı göndər ────────────────────────────────────────────
async function replyToDM(recipientId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    { recipient: { id: recipientId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── Webhook Verification ─────────────────────────────────────────
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

// ─── Webhook Events ───────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {

      // ── Şərh hadisəsi ──────────────────────────────────────────
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const comment = change.value;
        const commentId = comment.id;
        const commentText = comment.text || "";
        const fromUser = comment.from?.username || "istifadəçi";

        // Təkrar işləməyi önlə
        if (processed.has(commentId)) {
          console.log(`⏭️ Artıq işlənib: ${commentId}`);
          continue;
        }
        processed.add(commentId);
        setTimeout(() => processed.delete(commentId), 60000);

        console.log(`📩 Şərh: @${fromUser} → "${commentText}"`);

        if (!shouldReply(commentText)) {
          console.log(`⏭️ Filtr: cavab verilmədi`);
          continue;
        }

        // Şərhə cavab yaz
        try {
          const commentReply = await generateReply(commentText, "comment");
          await replyToComment(commentId, commentReply);
          console.log(`💬 Şərhə cavab: ${commentReply}`);
        } catch (e) {
          console.log("⚠️ Şərh cavabı xətası:", e.response?.data?.error?.message);
        }

        // DM göndər
        try {
          const dmText = `Salam! 👋 Şərhinizi gördük — sizi DM-də qarşılamaqdan məmnunuq. Nə bilmək istəyirsiniz? Ətraflı məlumat, qiymət və ya digər suallar üçün buradayıq.\n\n📲 Tez cavab üçün WhatsApp: +994 10 717 20 34`;
          await sendDM(commentId, dmText);
          console.log(`✉️ DM göndərildi → @${fromUser}`);
        } catch (e) {
          console.log("⚠️ DM xətası:", e.response?.data?.error?.message);
        }
      }

      // ── DM söhbəti ─────────────────────────────────────────────
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;

        if (!text || !senderId || !msgId) continue;
        if (senderId === entry.id) continue; // öz mesajımız

        if (processed.has(msgId)) {
          console.log(`⏭️ DM artıq işlənib: ${msgId}`);
          continue;
        }
        processed.add(msgId);
        setTimeout(() => processed.delete(msgId), 60000);

        console.log(`💬 DM: "${text}"`);

        const reply = await generateReply(text, "dm");

        // İlişdisə WhatsApp əlavə et
        const needsHuman = ["bilmirəm", "dəqiq deyə", "ətraflı məlumat"].some(w =>
          reply.toLowerCase().includes(w)
        );
        const finalReply = needsHuman
          ? `${reply}\n\n📲 Canlı dəstək üçün WhatsApp: +994 10 717 20 34`
          : reply;

        await replyToDM(senderId, finalReply);
        console.log(`✅ DM cavablandı`);
      }
    }
  } catch (err) {
    console.error("❌ Xəta:", err.response?.data || err.message);
  }
});

// ─── Health check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.send("01CS Instagram Bot işləyir ✅"));

app.listen(CONFIG.PORT, () => console.log(`🚀 Server port ${CONFIG.PORT}-də başladı`));
