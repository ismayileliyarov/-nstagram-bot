const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const app = express();

app.use(express.json());

// ─────────────────────────────────────────────────────────────
//  KONFİQURASİYA
// ─────────────────────────────────────────────────────────────
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PORT: process.env.PORT || 3000,
};

// ─────────────────────────────────────────────────────────────
//  ANALİTİKA (sadə fayl bazalı)
// ─────────────────────────────────────────────────────────────
const ANALYTICS_FILE = "/tmp/analytics.json";

function logAnalytics(userId, action, details = "") {
  const entry = {
    userId,
    action,
    details,
    timestamp: new Date().toISOString(),
  };
  try {
    let data = [];
    if (fs.existsSync(ANALYTICS_FILE)) {
      data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    }
    data.push(entry);
    // son 1000 qeydi saxla
    if (data.length > 1000) data.shift();
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Analitik xətası:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  TELEGRAM BİLDİRİŞİ (canlı dəstək tələbi)
// ─────────────────────────────────────────────────────────────
async function sendTelegramNotification(userId, userMessage) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram bildirişi üçün token və chat ID təyin edilməyib.");
    return;
  }
  const text = `🆘 *Canlı dəstək tələbi!*\n\nİstifadəçi ID: ${userId}\nMesaj: ${userMessage.substring(0, 200)}`;
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: text,
      parse_mode: "Markdown",
    });
    console.log("📨 Telegram bildirişi göndərildi.");
  } catch (e) {
    console.error("Telegram xətası:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  YADDAŞ ID və İSTİFADƏÇİ VƏZİYYƏTLƏRİ
// ─────────────────────────────────────────────────────────────
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

const userStates = new Map(); // userId -> { state, lastActive, lastService, language }
const STATE_TIMEOUT = 30 * 60 * 1000;

function getUserState(userId) {
  const now = Date.now();
  const record = userStates.get(userId);
  if (!record) return { state: "main", lastService: null, language: "az" };
  if (now - record.lastActive > STATE_TIMEOUT) {
    userStates.delete(userId);
    return { state: "main", lastService: null, language: "az" };
  }
  record.lastActive = now;
  userStates.set(userId, record);
  return { state: record.state, lastService: record.lastService, language: record.language || "az" };
}

function setUserState(userId, state, lastService = null, language = null) {
  const existing = userStates.get(userId) || {};
  userStates.set(userId, {
    state,
    lastActive: Date.now(),
    lastService: lastService !== undefined ? lastService : existing.lastService,
    language: language !== null ? language : (existing.language || "az"),
  });
}

// ─────────────────────────────────────────────────────────────
//  ÇOXDİLLİ MENYULAR (AZ, RU, EN)
// ─────────────────────────────────────────────────────────────
const MENUS = {
  az: {
    main: `Salam, 01 Code Studio-ya xoş gəlmisiniz! 👋\n\nMüraciətiniz nə ilə bağlıdır? Zəhmət olmasa seçin:\n\n1️⃣ Xidmətlərimiz\n2️⃣ Haqqımızda\n3️⃣ Əlaqə\n\nDil seçimi / Выбор языка / Language: 🇦🇿 az, 🇷🇺 ru, 🇬🇧 en`,
    services: `Hansı xidmətlə maraqlanırsınız?\n\n1️⃣ Vebsayt\n2️⃣ Mobil Tətbiq\n3️⃣ ERP / Avtomatlaşdırma\n4️⃣ SEO Optimizasiyası\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyuya qayıt`,
    about: `01 Code Studio — Azərbaycanda bizneslərin rəqəmsallaşması üçün peşəkar proqram həlləri. 🌐 www.01cs.site | 📸 @01cs.az\n\n0️⃣ Ana menyuya qayıt`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994 10 717 20 34\n7/24\n\n0️⃣ Ana menyuya qayıt`,
    website: `💻 Vebsayt: Vizit 250-700 AZN, E-ticarət 700-1800 AZN. Müddət 5-10 gün.\nDəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    mobile: `📱 Mobil Tətbiq: 1800 AZN-dən başlayır. 4-10 həftə. Native iOS/Android.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    erp: `⚙️ ERP/CRM: 1200 AZN-dən. 3-8 həftə. Fərdi avtomatlaşdırma.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    seo: `🔍 SEO: Qiymət fərdi. 1-3 ayda nəticə.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    support: `🛠️ Texniki Dəstək: Qiymət işin həcminə görə.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    unknown: "Üzr istəyirik, bu seçimi anlamadım. Zəhmət olmasa menyudan seçim edin.",
    languageSet: "Dil 🇦🇿 Azərbaycanca olaraq təyin edildi.",
    liveSupport: "Sizi canlı dəstəyə yönləndiririk. Bizim mütəxəssislər tezliklə sizinlə əlaqə saxlayacaqlar. 😊",
  },
  ru: {
    main: `Добро пожаловать в 01 Code Studio! 👋\n\nВыберите тему обращения:\n\n1️⃣ Наши услуги\n2️⃣ О нас\n3️⃣ Контакты\n\nВыбор языка / Dil seçimi / Language: 🇦🇿 az, 🇷🇺 ru, 🇬🇧 en`,
    services: `Какие услуги вас интересуют?\n\n1️⃣ Сайт\n2️⃣ Мобильное приложение\n3️⃣ ERP / Автоматизация\n4️⃣ SEO оптимизация\n5️⃣ Техподдержка\n0️⃣ Главное меню`,
    about: `01 Code Studio — профессиональные IT-решения для бизнеса в Азербайджане. 🌐 www.01cs.site | 📸 @01cs.az\n\n0️⃣ Главное меню`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994 10 717 20 34\n7/24\n\n0️⃣ Главное меню`,
    website: `💻 Сайт: Визитка 250-700 AZN, Интернет-магазин 700-1800 AZN. Срок 5-10 дней.\nТочная цена: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    mobile: `📱 Мобильное приложение: от 1800 AZN. 4-10 недель. Native iOS/Android.\nСсылка: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    erp: `⚙️ ERP/CRM: от 1200 AZN. 3-8 недель. Индивидуальная автоматизация.\nСсылка: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    seo: `🔍 SEO: Цена индивидуально. Результат через 1-3 месяца.\nСсылка: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    support: `🛠️ Техподдержка: Цена от объема работы.\nСсылка: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    unknown: `Извините, я не понял этот выбор. Пожалуйста, выберите из меню.`,
    languageSet: `Язык установлен на 🇷🇺 Русский.`,
    liveSupport: `Мы перенаправляем вас в службу поддержки. Наши специалисты скоро свяжутся с вами. 😊`,
  },
  en: {
    main: `Welcome to 01 Code Studio! 👋\n\nWhat is your inquiry about?\n\n1️⃣ Our Services\n2️⃣ About Us\n3️⃣ Contact\n\nLanguage selection / Dil seçimi / Выбор языка: 🇦🇿 az, 🇷🇺 ru, 🇬🇧 en`,
    services: `Which service are you interested in?\n\n1️⃣ Website\n2️⃣ Mobile App\n3️⃣ ERP / Automation\n4️⃣ SEO Optimization\n5️⃣ Technical Support\n0️⃣ Main Menu`,
    about: `01 Code Studio — professional software solutions for businesses in Azerbaijan. 🌐 www.01cs.site | 📸 @01cs.az\n\n0️⃣ Main Menu`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994 10 717 20 34\n24/7\n\n0️⃣ Main Menu`,
    website: `💻 Website: Landing 250-700 AZN, E-commerce 700-1800 AZN. Duration 5-10 days.\nDetailed offer: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`,
    mobile: `📱 Mobile App: from 1800 AZN. 4-10 weeks. Native iOS/Android.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`,
    erp: `⚙️ ERP/CRM: from 1200 AZN. 3-8 weeks. Custom automation.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`,
    seo: `🔍 SEO: Price varies. Results in 1-3 months.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`,
    support: `🛠️ Technical Support: Price depends on the scope.\nLink: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`,
    unknown: `Sorry, I didn't understand that. Please choose from the menu.`,
    languageSet: `Language set to 🇬🇧 English.`,
    liveSupport: `Redirecting you to live support. Our experts will contact you shortly. 😊`,
  },
};

// ─────────────────────────────────────────────────────────────
//  AI SORĞUSU (GENİŞ cavablar, 4-5 cümlə)
// ─────────────────────────────────────────────────────────────
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

async function askGroq(userMessage, contextService = null, language = "az") {
  if (!CONFIG.GROQ_API_KEY) {
    console.log("⚠️ GROQ_API_KEY yoxdur, AI işləmir.");
    return null;
  }

  const langHint = language === "az" ? "Cavabını Azərbaycan dilində ver." : (language === "ru" ? "Отвечай на русском языке." : "Answer in English.");
  
  const systemPrompt = `Sən 01 Code Studio-nun rəqəmsal köməkçisisən. 
Şirkət Azərbaycanda vebsayt, mobil tətbiq, ERP/CRM, SEO və texniki dəstək xidmətləri göstərir.
- Cavabların 4-5 cümlə uzunluğunda olsun, ətraflı və faydalı.
- İstifadəçinin sualına tam cavab verməyə çalış. 
- Əgər sual şirkətin xidmətlərinə aid deyilsə, "Sizi canlı dəstəyə yönləndiririk..." mesajını qaytar (tam eyni ifadə).
- Qiymət soruşduqda təxmini qiymətləri ver və dəqiq təklif üçün linkə yönləndir.
- "Daha ətraflı" sorğusunda cari xidmət haqqında geniş məlumat ver.
- Heç vaxt uydurma məlumat vermə, şirkətin fəaliyyət dairəsindən kənara çıxma.
${contextService ? `İstifadəçi hazırda "${contextService}" xidmətinə baxır. O, bu xidmət haqqında ətraflı istəyir.` : ""}
${langHint}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000); // 6 saniyə

  try {
    const response = await axios.post(GROQ_API_URL, {
      model: "llama3-8b-8192",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage }
      ],
      temperature: 0.7,
      max_tokens: 300,
    }, {
      headers: {
        "Authorization": `Bearer ${CONFIG.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    let reply = response.data.choices[0].message.content.trim();
    if (reply.length > 800) reply = reply.substring(0, 800) + "...";
    return reply;
  } catch (err) {
    clearTimeout(timeoutId);
    console.log("AI xətası:", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  MEDIA GÖNDƏRMƏ (şəkil)
// ─────────────────────────────────────────────────────────────
async function sendMediaDM(recipientId, imageUrl, caption = "") {
  try {
    await axios.post("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "image",
          payload: { url: imageUrl }
        },
        ...(caption && { text: caption })
      }
    }, {
      params: { access_token: CONFIG.IG_ACCESS_TOKEN }
    });
    console.log("🖼️ Media DM göndərildi.");
  } catch (e) {
    console.error("Media göndərmə xətası:", e.response?.data?.error?.message || e.message);
  }
}

// ─────────────────────────────────────────────────────────────
//  CAVAB MENECERİ (dil, AI, fallback, canlı dəstək)
// ─────────────────────────────────────────────────────────────
async function getResponse(userId, text) {
  const t = text.trim();
  const lowerT = t.toLowerCase();
  const { state, lastService, language } = getUserState(userId);
  let currentLang = language || "az";

  // Dil seçimi (az, ru, en)
  if (lowerT === "az") {
    setUserState(userId, state, lastService, "az");
    return MENUS.az.languageSet + "\n\n" + MENUS.az.main;
  }
  if (lowerT === "ru") {
    setUserState(userId, state, lastService, "ru");
    return MENUS.ru.languageSet + "\n\n" + MENUS.ru.main;
  }
  if (lowerT === "en") {
    setUserState(userId, state, lastService, "en");
    return MENUS.en.languageSet + "\n\n" + MENUS.en.main;
  }

  // Menyu komandaları (0, menu, salam, start)
  if (["0", "menu", "salam", "start", "hi", "main", "ana menyu", "главное меню", "main menu"].includes(lowerT)) {
    setUserState(userId, "main");
    return MENUS[currentLang].main;
  }

  // State maşını (dilə uyğun)
  if (state === "main") {
    if (lowerT === "1") { setUserState(userId, "services"); return MENUS[currentLang].services; }
    if (lowerT === "2") { setUserState(userId, "about"); return MENUS[currentLang].about; }
    if (lowerT === "3") { setUserState(userId, "contact"); return MENUS[currentLang].contact; }
    // Menyu seçimi deyil - AI
    const aiReply = await askGroq(text, null, currentLang);
    if (aiReply && aiReply.includes("Sizi canlı dəstəyə yönləndiririk")) {
      await sendTelegramNotification(userId, text);
      setUserState(userId, "blocked_live"); // bu istifadəçi üçün bir daha cavab vermə (sessiyanı dondur)
      return aiReply;
    }
    if (aiReply) return aiReply;
    return MENUS[currentLang].unknown;
  }

  if (state === "services") {
    if (lowerT === "1") { setUserState(userId, "services_sub", "website"); return MENUS[currentLang].website; }
    if (lowerT === "2") { setUserState(userId, "services_sub", "mobile"); return MENUS[currentLang].mobile; }
    if (lowerT === "3") { setUserState(userId, "services_sub", "erp"); return MENUS[currentLang].erp; }
    if (lowerT === "4") { setUserState(userId, "services_sub", "seo"); return MENUS[currentLang].seo; }
    if (lowerT === "5") { setUserState(userId, "services_sub", "support"); return MENUS[currentLang].support; }
    if (lowerT === "0") { setUserState(userId, "main"); return MENUS[currentLang].main; }
    const aiReply = await askGroq(text, null, currentLang);
    if (aiReply && aiReply.includes("Sizi canlı dəstəyə yönləndiririk")) {
      await sendTelegramNotification(userId, text);
      setUserState(userId, "blocked_live");
      return aiReply;
    }
    if (aiReply) return aiReply;
    return MENUS[currentLang].services;
  }

  if (lowerT === "0") {
    setUserState(userId, "main");
    return MENUS[currentLang].main;
  }

  // Digər hallar (services_sub daxil)
  const aiReply = await askGroq(text, lastService, currentLang);
  if (aiReply && aiReply.includes("Sizi canlı dəstəyə yönləndiririk")) {
    await sendTelegramNotification(userId, text);
    setUserState(userId, "blocked_live");
    return aiReply;
  }
  if (aiReply) return aiReply;
  setUserState(userId, "main");
  return MENUS[currentLang].main;
}

// ─────────────────────────────────────────────────────────────
//  INSTAGRAM API KÖMƏKÇİLƏRİ
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
//  WEBHOOK
// ─────────────────────────────────────────────────────────────
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
        logAnalytics(fromUser, "comment", commentText);
        console.log(`📩 Şərh: @${fromUser} → "${commentText}"`);
        try {
          await replyToComment(commentId, "Salam, şərhinizə cavab DM-də göndərildi ✔️");
          await sendDM(commentId, MENUS.az.main);
        } catch (e) { console.log(e.message); }
      }

      // DM söhbəti
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;
        if (!text || !senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isProcessed(msgId)) continue;
        logAnalytics(senderId, "dm", text);
        
        // İstifadəçi "blocked_live" vəziyyətindədirsə, cavab vermə
        const stateRec = userStates.get(senderId);
        if (stateRec && stateRec.state === "blocked_live") {
          console.log(`🚫 İstifadəçi ${senderId} canlı dəstəyə yönləndirilib, cavab verilmir.`);
          continue;
        }

        console.log(`💬 DM: "${text}"`);
        const response = await getResponse(senderId, text);
        await replyToDM(senderId, response);
        
        // Media göndərmə nümunəsi: əgər istifadəçi "şəkil göndər" yazsa
        if (text.toLowerCase().includes("şəkil") || text.toLowerCase().includes("şəkil göndər")) {
          await sendMediaDM(senderId, "https://www.01cs.site/sample.jpg", "Budur nümunə layihəmizdən bir görüntü.");
        }
      }
    }
  } catch (err) {
    console.error("❌ Xəta:", err.message);
  }
});

app.get("/analytics", (req, res) => {
  if (!fs.existsSync(ANALYTICS_FILE)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
  res.json(data.slice(-100)); // son 100 qeyd
});

app.get("/", (req, res) => res.send("01CS Bot AI + Analitik + Media + Çoxdilli ✅"));

app.listen(CONFIG.PORT, () => console.log(`🚀 Port ${CONFIG.PORT}`));