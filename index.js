const express = require("express");
const axios = require("axios");
const Groq = require("groq-sdk");
const app = express();

app.use(express.json());

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  PORT: process.env.PORT || 3000,
};

// Groq müştəri
let groq = null;
if (CONFIG.GROQ_API_KEY) {
  groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
}

// AI sistemi mesajı
const AI_SYSTEM_PROMPT = `
Sən 01 Code Studio-nun rəsmi Instagram köməkçisisən. 
Şirkət Azərbaycanda vebsayt, mobil tətbiq, ERP/CRM, SEO və texniki dəstək xidmətləri göstərir.
- Yalnız bu xidmətlər haqqında suallara cavab ver.
- Cavabların maksimum 2 cümlədən ibarət olsun.
- Qısa, peşəkar və faydalı ol.
- Əgər sual şirkətin fəaliyyəti ilə əlaqəli deyilsə, yalnız "Üzr istəyirik, mən yalnız 01 Code Studio haqqında məlumat verə bilərəm. Zəhmət olmasa menyudan seçim edin." yaz.
- Heç vaxt şəxsi fikir bildirmə, təxmini qiymətləri linkə yönləndir: https://01cs.site/teklif-al.html
- Sualı başa düşmədisə, ana menyunu təklif et.
`;

// AI çağırışı (timeout ilə)
async function askGroq(userMessage) {
  if (!groq) return null;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 saniyə

  try {
    const response = await groq.chat.completions.create({
      model: "llama3-8b-8192",
      messages: [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ],
      temperature: 0.3,
      max_tokens: 100,
    }, { signal: controller.signal });
    
    clearTimeout(timeoutId);
    let reply = response.choices[0]?.message?.content?.trim();
    if (!reply) return null;
    // Çox uzun cavabı kəs
    if (reply.length > 300) reply = reply.substring(0, 300) + "...";
    return reply;
  } catch (err) {
    clearTimeout(timeoutId);
    console.log("AI xətası:", err.message);
    return null;
  }
}

// ─── Yaddaşda işlənmiş ID-lər (race condition yoxdur) ────────────
const processedIds = new Map();

function isProcessed(id) {
  const now = Date.now();
  if (processedIds.has(id)) {
    const ts = processedIds.get(id);
    if (now - ts < 600000) return true;
    else processedIds.delete(id);
  }
  processedIds.set(id, now);
  return false;
}

// ─── İstifadəçi vəziyyətləri (vaxtaşımı ilə) ────────────────────
const userStates = new Map();
const STATE_TIMEOUT = 30 * 60 * 1000;

function getUserState(userId) {
  const now = Date.now();
  const record = userStates.get(userId);
  if (!record) return "main";
  if (now - record.lastActive > STATE_TIMEOUT) {
    userStates.delete(userId);
    return "main";
  }
  record.lastActive = now;
  userStates.set(userId, record);
  return record.state;
}

function setUserState(userId, state) {
  userStates.set(userId, { state, lastActive: Date.now() });
}

// ─── Menyu məzmunu (orijinal) ────────────────────────────────────
const MENUS = {
  main: `Salam, 01 Code Studio-ya xoş gəlmisiniz! 👋

Müraciətiniz nə ilə bağlıdır? Zəhmət olmasa seçin:

1️⃣ Xidmətlərimiz
2️⃣ Haqqımızda
3️⃣ Əlaqə`,

  services: `Hansı xidmətlə maraqlanırsınız?

1️⃣ Vebsayt
2️⃣ Mobil Tətbiq
3️⃣ ERP / Avtomatlaşdırma
4️⃣ SEO Optimizasiyası
5️⃣ Texniki Dəstək
0️⃣ Ana menyuya qayıt`,

  about: `01 Code Studio — Azərbaycanda bizneslərin rəqəmsallaşması üçün peşəkar proqram həlləri təqdim edən şirkətdir. 🚀

Vebsayt, mobil tətbiq, ERP sistemi və AI həllərindən tutmuş SEO və texniki dəstəyə qədər — biznesinizin onlayn dünyada tam gücü ilə təmsil olunması üçün çalışırıq.

Hər layihəyə fərdi yanaşır, müştərilərimizi layihə bitdikdən sonra da tək qoymuruq. 💼

🌐 www.01cs.site | 📸 @01cs.az

0️⃣ Ana menyuya qayıt`,

  contact: `Bizimlə əlaqə saxlamaq üçün:

📧 Email: info@01cs.site
💬 WhatsApp: wa.me/994107172034
📞 Telefon: +994 10 717 20 34

İş saatları: 7/24 🕐

0️⃣ Ana menyuya qayıt`,

  website: `💻 Vebsayt Hazırlanması

Biznesiniz üçün modern, sürətli və mobil uyğun vebsaytlar hazırlayırıq.

📌 Xidmət növləri:
• Vizit / Korporativ sayt
• E-ticarət / Online mağaza
• Restoran menyu portalı
• İdarəetmə paneli (dashboard)

💰 Təxmini qiymətlər:
• Vizit / Korporativ sayt: 250-700 AZN
• E-ticarət / Online mağaza: 700-1800 AZN

⏱ Müddət: 5-10 iş günü (sadə), 3-6 həftə (böyük)
✅ 100% responsiv (mobil uyğun)
✅ Ödəniş sistemi inteqrasiyası
✅ Layihə sonrası pulsuz texniki dəstək

Daha dəqiq qiymət təklifi üçün:
👉 https://01cs.site/teklif-al.html

0️⃣ Xidmətlər menyusuna qayıt`,

  mobile: `📱 Mobil Tətbiq Hazırlanması

iOS və Android platformaları üçün funksional və istifadəçi yönümlü mobil tətbiqlər hazırlayırıq.

📌 Xüsusiyyətlər:
• iOS və Android üçün eyni vaxtda
• Sürətli və müasir UI/UX dizayn
• Bildiriş sistemi, ödəniş inteqrasiyası
• Admin idarəetmə paneli

💰 Təxmini qiymət: 1800 AZN-dən başlayaraq
⏱ Müddət: Layihəyə görə 4-10 həftə

Daha dəqiq qiymət təklifi üçün:
👉 https://01cs.site/teklif-al.html

0️⃣ Xidmətlər menyusuna qayıt`,

  erp: `⚙️ ERP / CRM / Avtomatlaşdırma

Müəssisə daxili prosesləri tam rəqəmsal idarə etmək üçün fərdi sistemlər hazırlayırıq.

📌 Həll növləri:
• Müştəri idarəetmə sistemi (CRM)
• Anbar və satış idarəetməsi (ERP)
• İş axını avtomatlaşdırması
• API inteqrasiyaları (ödəniş, xarici sistemlər)

💰 Təxmini qiymət: 1200 AZN-dən başlayaraq
⏱ Müddət: 3-8 həftə (həcmə görə)

Daha dəqiq qiymət təklifi üçün:
👉 https://01cs.site/teklif-al.html

0️⃣ Xidmətlər menyusuna qayıt`,

  seo: `🔍 SEO Optimizasiyası

Vebsaytınızın Google-da ön sıralara çıxması üçün kompleks SEO xidməti təqdim edirik.

📌 Xidmət daxildir:
• Açar söz analizi
• Daxili SEO (on-page) optimizasiya
• Texniki SEO audit
• Xarici SEO (link building)
• Aylıq hesabat

💰 Qiymət: Layihəyə görə fərdi hesablanır
⏱ Nəticə: 1-3 ay ərzində görünən irəliləyiş

Daha dəqiq qiymət təklifi üçün:
👉 https://01cs.site/teklif-al.html

0️⃣ Xidmətlər menyusuna qayıt`,

  support: `🛠️ Texniki Dəstək

Mövcud layihəniz üçün davamlı texniki dəstək və inteqrasiya xidməti təqdim edirik.

📌 Xidmət daxildir:
• Mövcud sayt/tətbiqin yenilənməsi
• Təhlükəsizlik yoxlaması
• Yavaş saytın sürətləndirilməsi
• Xarici API inteqrasiyası
• Köhnə saytın tam yenilənməsi

💰 Qiymət: İşin həcminə görə fərdi
⏱ Müddət: Tapşırığa görə dəyişir

Daha dəqiq qiymət təklifi üçün:
👉 https://01cs.site/teklif-al.html

0️⃣ Xidmətlər menyusuna qayıt`,
};

// ─── Menyu cavabı (AI dəstəkli) ─────────────────────────────────
async function getMenuResponse(userId, text) {
  const t = text.trim().toLowerCase();
  let state = getUserState(userId);

  // Ümumi ana menyu komandaları
  const mainKeywords = ["0", "menu", "salam", "start", "hi", "main", "ana menyu"];
  if (mainKeywords.includes(t)) {
    setUserState(userId, "main");
    return MENUS.main;
  }

  if (!state) state = "main";

  // Ana menyu
  if (state === "main") {
    if (t === "1") { setUserState(userId, "services"); return MENUS.services; }
    if (t === "2") { setUserState(userId, "about"); return MENUS.about; }
    if (t === "3") { setUserState(userId, "contact"); return MENUS.contact; }
    // Menyu seçimi deyilsə, AI-ya soruş
    const aiReply = await askGroq(text);
    if (aiReply) return aiReply;
    return MENUS.main;
  }

  // Xidmətlər menyusu
  if (state === "services") {
    if (t === "1") { setUserState(userId, "services_sub"); return MENUS.website; }
    if (t === "2") { setUserState(userId, "services_sub"); return MENUS.mobile; }
    if (t === "3") { setUserState(userId, "services_sub"); return MENUS.erp; }
    if (t === "4") { setUserState(userId, "services_sub"); return MENUS.seo; }
    if (t === "5") { setUserState(userId, "services_sub"); return MENUS.support; }
    if (t === "0") { setUserState(userId, "main"); return MENUS.main; }
    // Tanınmayan – AI
    const aiReply = await askGroq(text);
    if (aiReply) return aiReply;
    return MENUS.services;
  }

  // Dərin menyularda 0 ilə qayıt
  if (t === "0") {
    setUserState(userId, "main");
    return MENUS.main;
  }

  // Qalan hər şey üçün AI
  const aiReply = await askGroq(text);
  if (aiReply) return aiReply;
  setUserState(userId, "main");
  return MENUS.main;
}

// ─── Instagram API köməkçiləri ───────────────────────────────────
async function sendDM(commentId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    { recipient: { comment_id: commentId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

async function replyToDM(recipientId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    { recipient: { id: recipientId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

async function replyToComment(commentId, message) {
  await axios.post(
    `https://graph.instagram.com/v21.0/${commentId}/replies`,
    { message },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ─── Webhook ─────────────────────────────────────────────────────
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

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== "instagram") return;

    for (const entry of body.entry || []) {
      const myId = entry.id;

      // Şərh emalı
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;
        const comment = change.value;
        const commentId = comment.id;
        const commentText = comment.text || "";
        const fromUser = comment.from?.username || "istifadəçi";

        if (isProcessed(commentId)) continue;
        console.log(`📩 Şərh: @${fromUser} → "${commentText}"`);

        try {
          await replyToComment(commentId, "Salam, şərhin DM-də ətraflı cavablandırıldı ✔️");
          console.log(`💬 Şərhə cavab yazıldı`);
        } catch (e) {
          console.log("⚠️ Şərh cavabı xətası:", e.response?.data?.error?.message);
        }

        try {
          await sendDM(commentId, MENUS.main);
          console.log(`✉️ DM göndərildi → @${fromUser}`);
        } catch (e) {
          console.log("⚠️ DM xətası:", e.response?.data?.error?.message);
          try {
            await replyToComment(commentId, "Sizə DM göndərmək mümkün deyil, zəhmət olmasa bizi +994107172034 nömrəsindən əlaqələndirin.");
          } catch {}
        }
      }

      // DM söhbəti
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;
        if (!text || !senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isProcessed(msgId)) continue;

        console.log(`💬 DM: "${text}"`);
        const response = await getMenuResponse(senderId, text);
        await replyToDM(senderId, response);
        console.log(`✅ DM cavablandı`);
      }
    }
  } catch (err) {
    console.error("❌ Xəta:", err.response?.data || err.message);
  }
});

app.get("/", (req, res) => res.send("01CS Instagram Bot işləyir ✅"));

app.listen(CONFIG.PORT, () => console.log(`🚀 Server port ${CONFIG.PORT}-də başladı`));