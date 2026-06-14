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

// ─── Yaddaşda işlənmiş ID-lər ──────────────────────────────────
const processedIds = new Map();
function isProcessed(id) {
  const now = Date.now();
  if (processedIds.has(id)) {
    if (now - processedIds.get(id) < 600000) return true;
    else processedIds.delete(id);
  }
  processedIds.set(id, now);
  return false;
}

// ─── İstifadəçi vəziyyətləri ────────────────────────────────────
const userStates = new Map(); // userId -> { state, lastActive, lastService }
const STATE_TIMEOUT = 30 * 60 * 1000;

function getUserState(userId) {
  const now = Date.now();
  const record = userStates.get(userId);
  if (!record) return { state: "main", lastService: null };
  if (now - record.lastActive > STATE_TIMEOUT) {
    userStates.delete(userId);
    return { state: "main", lastService: null };
  }
  record.lastActive = now;
  userStates.set(userId, record);
  return { state: record.state, lastService: record.lastService };
}

function setUserState(userId, state, lastService = null) {
  const existing = userStates.get(userId) || {};
  userStates.set(userId, {
    state,
    lastActive: Date.now(),
    lastService: lastService !== undefined ? lastService : existing.lastService
  });
}

// ─── AI köməkçisi (axios ilə, SDK lazım deyil) ───────────────────
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

async function askGroq(userMessage, contextService = null) {
  if (!CONFIG.GROQ_API_KEY) {
    console.log("⚠️ GROQ_API_KEY təyin edilməyib, AI işləmir.");
    return null;
  }

  const systemPrompt = `Sən 01 Code Studio-nun rəsmi Instagram köməkçisisən. 
Şirkət Azərbaycanda vebsayt, mobil tətbiq, ERP/CRM, SEO və texniki dəstək xidmətləri göstərir.
- Cavabların maksimum 3 cümlə olsun, çox qısa və faydalı.
- Əgər sual şirkətin işi ilə əlaqəli deyilsə: "Üzr istəyirik, mən yalnız 01 Code Studio haqqında məlumat verə bilərəm. Zəhmət olmasa menyudan seçim edin."
- Qiymət soruşanda: "Təxmini qiymətlər üçün https://01cs.site/teklif-al.html linkinə keçin."
- "Daha ətraflı" yazılsa, cari xidmət haqqında əlavə məlumat ver: misal üçün, mobil app-də hansı xüsusiyyətlər, nümunə layihələr.
${contextService ? `İstifadəçi hazırda ${contextService} xidmətinə baxır. O, bu xidmət haqqında daha ətraflı istəyir.` : ""}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await axios.post(GROQ_API_URL, {
      model: "llama3-8b-8192",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.5,
      max_tokens: 200,
    }, {
      headers: {
        "Authorization": `Bearer ${CONFIG.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    let reply = response.data.choices[0].message.content.trim();
    if (reply.length > 400) reply = reply.substring(0, 400) + "...";
    return reply;
  } catch (err) {
    clearTimeout(timeoutId);
    console.log("AI xətası:", err.message);
    return null;
  }
}

// ─── Ağıllı fallback (AI olmadıqda işləyir) ──────────────────────
function smartFallback(message, lastService) {
  const m = message.toLowerCase();
  if (m.includes("qiymət") || m.includes("pul") || m.includes("neçə")) {
    return "Təxmini qiymətlər üçün zəhmət olmasa linkə keçin: https://01cs.site/teklif-al.html 😊";
  }
  if (m.includes("daha ətraflı") || m.includes("ətraflı məlumat")) {
    if (lastService === "website") return "Vebsayt xidmətimizə daxildir: tam responsiv dizayn, admin panel, ödəniş sistemi, SEO hazırlığı. İstənilən növ sayt hazırlayırıq.";
    if (lastService === "mobile") return "Mobil tətbiqlərimiz native (iOS/Android) və ya cross-platform ola bilər. Push notification, ödəniş, chat, xəritə kimi funksiyaları dəstəkləyirik.";
    if (lastService === "erp") return "ERP sistemlərimiz müştəri, anbar, satış, işçi və maliyyə idarəsi üçün fərdi hazırlanır. Tam avtomatlaşdırma təmin edirik.";
    if (lastService === "seo") return "SEO xidmətimiz açar söz analizi, texniki audit, backlink və aylıq hesabatı əhatə edir. Google-da ilk səhifə hədəfimizdir.";
    if (lastService === "support") return "Texniki dəstək: mövcud layihənizin təhlükəsizlik, sürət və funksionallıq baxımından yenilənməsi, 7/24 dəstək.";
    return "Hansı xidmət haqqında ətraflı bilmək istəyirsiniz? 1️⃣ Vebsayt 2️⃣ Mobil App 3️⃣ ERP 4️⃣ SEO 5️⃣ Texniki dəstək";
  }
  return null;
}

// ─── Menyular (əvvəlki kimi, qısaldılmış) ─────────────────────────
const MENUS = {
  main: `Salam, 01 Code Studio-ya xoş gəlmisiniz! 👋\n\nMüraciətiniz nə ilə bağlıdır? Zəhmət olmasa seçin:\n\n1️⃣ Xidmətlərimiz\n2️⃣ Haqqımızda\n3️⃣ Əlaqə`,
  services: `Hansı xidmətlə maraqlanırsınız?\n\n1️⃣ Vebsayt\n2️⃣ Mobil Tətbiq\n3️⃣ ERP / Avtomatlaşdırma\n4️⃣ SEO Optimizasiyası\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyuya qayıt`,
  about: `01 Code Studio — Azərbaycanda bizneslərin rəqəmsallaşması üçün peşəkar proqram həlləri. 🌐 www.01cs.site | 📸 @01cs.az\n\n0️⃣ Ana menyuya qayıt`,
  contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994 10 717 20 34\n7/24\n\n0️⃣ Ana menyuya qayıt`,
  website: `💻 Vebsayt: Vizit 250-700 AZN, E-ticarət 700-1800 AZN. Müddət 5-10 gün.\nDəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
  mobile: `📱 Mobil Tətbiq: 1800 AZN-dən başlayır. 4-10 həftə. Native iOS/Android.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
  erp: `⚙️ ERP/CRM: 1200 AZN-dən. 3-8 həftə. Fərdi avtomatlaşdırma.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
  seo: `🔍 SEO: Qiymət fərdi. 1-3 ayda nəticə.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
  support: `🛠️ Texniki Dəstək: Qiymət işin həcminə görə.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`
};

// ─── Cavab meneceri (AI + fallback) ──────────────────────────────
async function getResponse(userId, text) {
  const t = text.trim().toLowerCase();
  const { state, lastService } = getUserState(userId);

  // Ana menyu komandaları
  if (["0", "menu", "salam", "start", "hi", "main", "ana menyu"].includes(t)) {
    setUserState(userId, "main");
    return MENUS.main;
  }

  // State maşını (əvvəlki kimi)
  if (state === "main") {
    if (t === "1") { setUserState(userId, "services"); return MENUS.services; }
    if (t === "2") { setUserState(userId, "about"); return MENUS.about; }
    if (t === "3") { setUserState(userId, "contact"); return MENUS.contact; }
    // Menyu seçimi deyil, AI-ya soruş
    const aiReply = await askGroq(text, null);
    if (aiReply) return aiReply;
    const fallback = smartFallback(text, lastService);
    if (fallback) return fallback;
    return MENUS.main;
  }

  if (state === "services") {
    if (t === "1") { setUserState(userId, "services_sub", "website"); return MENUS.website; }
    if (t === "2") { setUserState(userId, "services_sub", "mobile"); return MENUS.mobile; }
    if (t === "3") { setUserState(userId, "services_sub", "erp"); return MENUS.erp; }
    if (t === "4") { setUserState(userId, "services_sub", "seo"); return MENUS.seo; }
    if (t === "5") { setUserState(userId, "services_sub", "support"); return MENUS.support; }
    if (t === "0") { setUserState(userId, "main"); return MENUS.main; }
    const aiReply = await askGroq(text, null);
    if (aiReply) return aiReply;
    return MENUS.services;
  }

  // services_sub və ya hər hansı dərin menyu
  if (t === "0") {
    setUserState(userId, "main");
    return MENUS.main;
  }

  // İstifadəçi "daha ətraflı" və ya digər sual yazıb – AI çağır, context olaraq lastService göndər
  const aiReply = await askGroq(text, lastService);
  if (aiReply) return aiReply;
  const fallback = smartFallback(text, lastService);
  if (fallback) return fallback;
  setUserState(userId, "main");
  return MENUS.main;
}

// ─── Instagram API ────────────────────────────────────────────────
async function replyToDM(recipientId, message) {
  await axios.post("https://graph.instagram.com/v21.0/me/messages",
    { recipient: { id: recipientId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}
async function replyToComment(commentId, message) {
  await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`,
    { message },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}
async function sendDM(commentId, message) {
  await axios.post("https://graph.instagram.com/v21.0/me/messages",
    { recipient: { comment_id: commentId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── Webhook ─────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      const myId = entry.id;
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;
        const comment = change.value;
        const commentId = comment.id;
        if (isProcessed(commentId)) continue;
        console.log(`📩 Şərh: ${comment.text}`);
        try {
          await replyToComment(commentId, "Salam, şərhinizə cavab DM-də göndərildi ✔️");
          await sendDM(commentId, MENUS.main);
        } catch (e) { console.log(e.message); }
      }
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;
        if (!text || !senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isProcessed(msgId)) continue;
        console.log(`💬 DM: "${text}"`);
        const response = await getResponse(senderId, text);
        await replyToDM(senderId, response);
      }
    }
  } catch (err) {
    console.error("❌ Xəta:", err.message);
  }
});

app.get("/", (req, res) => res.send("01CS Bot AI ilə işləyir ✅"));

app.listen(CONFIG.PORT, () => console.log(`🚀 Port ${CONFIG.PORT}`));