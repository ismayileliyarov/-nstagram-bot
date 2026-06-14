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

// ─── Şərhin cavablanmalı olub olmadığını yoxla ───────────────────
function shouldReply(text) {
  if (!text) return false;
  const t = text.toLowerCase().trim();

  // Yalnız emoji və ya işarə olan şərhlər — keç
  const emojiOnly = /^[\p{Emoji}\s!?.❤️👍🔥💯✅⭐]+$/u.test(t);
  if (emojiOnly) return false;

  // Çox qısa (3 hərfdən az) — keç
  if (t.replace(/\s/g, "").length < 3) return false;

  // Cavab verilməli açar sözlər
  const triggers = [
    "salam", "hello", "hi", "hey",
    "məlumat", "melumat", "bilgi", "info",
    "qiymət", "qiymet", "nədir", "nedir",
    "necə", "nece", "nə vaxt", "ne vaxt",
    "sifariş", "siparis", "sifaris",
    "hazırlayırsınız", "hazırlayırsıniz",
    "xidmət", "xidmet", "sayt", "vebsayt", "website",
    "tətbiq", "tetbiq", "mobil", "app",
    "erp", "crm", "sistem", "avtomatlaşdırma",
    "seo", "nömrə", "nomre", "əlaqə", "elaqe",
    "müddət", "muddet", "nə qədər", "ne qeder",
    "ödəniş", "odenis", "kömək", "komek",
    "maraqlanıram", "maraqlanırsınız", "maraqlıdır",
    "bəli", "beli", "istəyirəm", "isteyirem",
    "?", "yardım", "yardim", "dəstək", "destek"
  ];

  return triggers.some(kw => t.includes(kw));
}

// ─── System prompt ───────────────────────────────────────────────
const SYSTEM_PROMPT = `Sən 01 Code Studio şirkətinin Instagram köməkçi botusun. Adın "01 Bot"-dur.

Şirkət haqqında:
- Ad: 01 Code Studio
- Vebsayt: www.01cs.site
- Instagram: @01cs.az
- WhatsApp / Telefon: +994 10 717 20 34
- Email: info@01cs.site | help@01cs.site
- İş saatları: 7/24 (rəqəmsal müraciətlər)

Xidmətlər və təxmini qiymətlər:
1. Vizit / Korporativ Vebsayt — 250-700 AZN (rəqabətçi bazarda ucuz)
2. E-ticarət / Online Mağaza (ödəniş sistemli) — 700-1800 AZN
3. Fərdi ERP / CRM / Avtomatlaşdırma — 1200 AZN-dən
4. Mobil Tətbiq (iOS / Android) — 1800 AZN-dən
5. SEO Optimizasiyası — layihəyə görə fərdi
6. Texniki Dəstək və İnteqrasiya — fərdi

Vacib: Qiymətlər müştərinin tələbinə, funksionallığa və mürəkkəbliyə görə dəyişir. Dəqiq qiymət üçün müştəriləri mütləq WhatsApp-a yönləndir.

Tez-tez soruşulan suallar:
- Müddət? → Sadə sayt 5-10 iş günü, e-ticarət / ERP 3-6 həftə
- Telefonlarda görünür? → Bəli, bütün layihələr 100% responsivdir
- Ödəniş sistemi qoşmaq olar? → Bəli, yerli və beynəlxalq ödəniş sistemləri
- Sonradan dəstək var? → Bəli, müqaviləyə görə pulsuz texniki dəstək
- Köhnə saytı yeniləyə bilərsiniz? → Bəli, tam yeniləmə xidməti var

Üslub qaydaları:
- Azərbaycan dilində yaz, təbii və dostcasına ol
- Bürokratik deyil, insan kimi danış
- Cavablar qısa olsun — 2-3 cümlə (DM-də uzun cavab veriləcək)
- Emoji az istifadə et, ancaq yerli olsun
- Müştərini mütləq DM-ə dəvət et
- Hər cavabın sonunda WhatsApp nömrəsini təklif et: +994 10 717 20 34

Nə etmə:
- Qiyməti dəqiq söyləmə, "layihəyə görə dəyişir" de
- "Bizim şirkət", "biz" kimi formal ifadələrdən çox istifadə etmə
- Eyni cümləni iki dəfə yazma`;

// ─── Groq ilə cavab yarat ────────────────────────────────────────
async function generateReply(userMessage, context = "comment") {
  const contextNote = context === "dm"
    ? "Bu müştərinin DM mesajıdır. Ətraflı cavab ver, kömək et, lazım olsa WhatsApp-a yönləndir."
    : "Bu Instagram şərhidir. Qısa, dəvətkar cavab ver, ətraflı məlumat üçün DM-ə çağır.";

  const response = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: "llama-3.1-8b-instant",
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `${contextNote}\n\nMüştəri mesajı: "${userMessage}"` },
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

// ─── Şərhə cavab yaz (public comment reply) ─────────────────────
async function replyToComment(commentId, message) {
  await axios.post(
    `https://graph.instagram.com/v21.0/${commentId}/replies`,
    { message },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── DM göndər (private reply) ──────────────────────────────────
async function sendDM(commentId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    {
      recipient: { comment_id: commentId },
      message: { text: message },
    },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── DM cavabı göndər (conversation reply) ──────────────────────
async function replyToDM(recipientId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    {
      recipient: { id: recipientId },
      message: { text: message },
    },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
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
      // ── Şərh hadisəsi ──
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;

        const comment = change.value;
        const commentId = comment.id;
        const commentText = comment.text || "";
        const fromUser = comment.from?.username || "istifadəçi";

        console.log(`📩 Şərh: @${fromUser} → "${commentText}"`);

        if (!shouldReply(commentText)) {
          console.log(`⏭️ Keçildi (cavab verilməyəcək): "${commentText}"`);
          continue;
        }

        const reply = await generateReply(commentText, "comment");
        console.log(`🤖 Cavab: ${reply}`);

        // Şərhə cavab yaz
        try {
          await replyToComment(commentId, reply);
          console.log(`💬 Şərhə cavab yazıldı → @${fromUser}`);
        } catch (e) {
          console.log("⚠️ Şərh cavabı yazılmadı:", e.response?.data?.error?.message);
        }

        // DM göndər
        try {
          const dmText = `Salam! 👋 Şərhinizi gördük. Sizə ətraflı məlumat vermək üçün buradayıq — nə bilmək istəyirsiniz? Həmçinin birbaşa WhatsApp-dan da əlaqə saxlaya bilərsiniz: +994 10 717 20 34`;
          await sendDM(commentId, dmText);
          console.log(`✉️ DM göndərildi → @${fromUser}`);
        } catch (e) {
          console.log("⚠️ DM göndərilmədi:", e.response?.data?.error?.message);
        }
      }

      // ── DM hadisəsi (müştəri DM-ə cavab yazanda) ──
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;

        if (!text || !senderId) continue;

        // Öz mesajlarımızı keç
        const myId = entry.id;
        if (senderId === myId) continue;

        console.log(`💬 DM alındı: "${text}"`);

        const reply = await generateReply(text, "dm");
        console.log(`🤖 DM cavabı: ${reply}`);

        // İlişdiyini hiss etsə WhatsApp yönləndirmə əlavə et
        const confused = ["bilmirəm", "anlayammadım", "dəqiq deyə bilmərəm", "ətraflı"].some(w =>
          reply.toLowerCase().includes(w)
        );

        const finalReply = confused
          ? `${reply}\n\n📲 Daha sürətli kömək üçün WhatsApp: +994 10 717 20 34`
          : reply;

        await replyToDM(senderId, finalReply);
        console.log(`✅ DM cavablandı`);
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
