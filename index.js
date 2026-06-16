const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const session = require("express-session");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());
app.use(session({
  secret: "01cs_very_secret_key",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false, httpOnly: true, sameSite: 'lax' }
}));

const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GEMINI_MODEL: "gemini-3.5-flash", // Sizin istədiyiniz model, FALLBACK YOXDUR
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  PORT: process.env.PORT || 3000,
};

let genAI = null;
if (CONFIG.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
}

const ANALYTICS_FILE = "/tmp/analytics.json";
function logAnalytics(userId, action, details = "") {
  try {
    let data = [];
    if (fs.existsSync(ANALYTICS_FILE)) data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    data.push({ userId, action, details, timestamp: new Date().toISOString() });
    if (data.length > 1500) data = data.slice(-1200);
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

async function sendTelegramNotification(userId, userMessage, username = "istifadəçi") {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const text = `🆘 CANLI DƏSTƏK TƏLƏBİ\n\nİstifadəçi: @${username}\nID: ${userId}\nMesaj: ${userMessage.substring(0, 200)}`;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text,
    });
  } catch (e) { console.log("Telegram xətası:", e.message); }
}

const processedIds = new Map();
function isProcessed(id) {
  const now = Date.now();
  if (processedIds.has(id) && now - processedIds.get(id) < 600000) return true;
  processedIds.set(id, now);
  return false;
}

const userStates = new Map();
const STATE_TIMEOUT = 30 * 60 * 1000;

function getUserState(userId) {
  const now = Date.now();
  const record = userStates.get(userId);
  if (!record) return { state: "main", lastService: null, language: "az", blocked: false, detailLevel: 1 };
  if (now - record.lastActive > STATE_TIMEOUT) {
    userStates.delete(userId);
    return { state: "main", lastService: null, language: "az", blocked: false, detailLevel: 1 };
  }
  record.lastActive = now;
  userStates.set(userId, record);
  return { ...record };
}

function setUserState(userId, updates) {
  const existing = userStates.get(userId) || { lastActive: Date.now() };
  userStates.set(userId, { ...existing, ...updates, lastActive: Date.now() });
}

// Xidmət təsvirləri (emojili)
const SERVICE_DETAILS = {
  website: {
    az: `💻 **Vebsayt Hazırlanması**

📌 Xidmət növləri:
• Vizit kart / Landing page – 520-1300 AZN (7-14 gün)
• Korporativ sayt – 1300-4400 AZN (30-60 gün)
• E-ticarət saytı – 2600-13000 AZN (60-120 gün)

✨ Xüsusiyyətlər:
• 100% mobil uyğun (responsive)
• SEO hazırlığı
• İstənilən ödəniş sistemi inteqrasiyası
• Admin panel
• 1 ay pulsuz texniki dəstək

🔗 Dəqiq təklif: https://01cs.site/teklif-al.html

0️⃣ Xidmətlərə qayıt`,
    ru: `💻 **Разработка веб-сайтов**\n\n📌 Типы услуг:\n• Визитка / Landing page – 520-1300 AZN (7-14 дней)\n• Корпоративный сайт – 1300-4400 AZN (30-60 дней)\n• Интернет-магазин – 2600-13000 AZN (60-120 дней)\n\n✨ Особенности: адаптивный дизайн, SEO-подготовка, интеграция платёжных систем, админ-панель, 1 месяц бесплатной техподдержки.\n\n🔗 Точная цена: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    en: `💻 **Website Development**\n\n📌 Service types:\n• Business card / Landing page – 520-1300 AZN (7-14 days)\n• Corporate website – 1300-4400 AZN (30-60 days)\n• E-commerce website – 2600-13000 AZN (60-120 days)\n\n✨ Features: responsive design, SEO ready, payment system integration, admin panel, 1 month free support.\n\n🔗 Detailed offer: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`
  },
  mobile: {
    az: `📱 **Mobil Tətbiq Hazırlanması**\n\n📌 Səviyyələr:\n• Sadə – 2600-6000 AZN (30-45 gün)\n• Orta – 6000-15500 AZN (60-90 gün)\n• Mürəkkəb – 13000-43000 AZN (90-180 gün)\n\n✨ Xüsusiyyətlər: Native iOS/Android, push, ödəniş, chat, GPS, admin panel.\n\n🔗 Dəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    ru: `📱 **Разработка мобильных приложений**\n\n📌 Уровни:\n• Простое – 2600-6000 AZN (30-45 дней)\n• Среднее – 6000-15500 AZN (60-90 дней)\n• Сложное – 13000-43000 AZN (90-180 дней)\n\n✨ Особенности: нативные iOS/Android, push-уведомления, платёжные системы, чат, GPS, админ-панель.\n\n🔗 Точная цена: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    en: `📱 **Mobile App Development**\n\n📌 Levels:\n• Simple – 2600-6000 AZN (30-45 days)\n• Medium – 6000-15500 AZN (60-90 days)\n• Complex – 13000-43000 AZN (90-180 days)\n\n✨ Features: Native iOS/Android, push, payments, chat, GPS, admin panel.\n\n🔗 Detailed offer: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`
  },
  erp: {
    az: `⚙️ **ERP / CRM / Avtomatlaşdırma**\n\n📌 Modullar: Müştəri, anbar, satış, işçi, maliyyə, hesabat.\n💰 Qiymət: 7000-43000 AZN (layihəyə görə)\n⏱ Müddət: 3-8 həftə\n✨ Xüsusiyyətlər: API inteqrasiyası, real-time, çoxistifadəçili, 1 ay pulsuz test.\n\n🔗 Dəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    ru: `⚙️ **ERP / CRM / Автоматизация**\n\n📌 Модули: клиенты, склад, продажи, сотрудники, финансы, отчёты.\n💰 Цена: 7000-43000 AZN\n⏱ Срок: 3-8 недель\n\n🔗 Точная цена: https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    en: `⚙️ **ERP / CRM / Automation**\n\n📌 Modules: customers, warehouse, sales, employees, finance, reports.\n💰 Price: 7000-43000 AZN\n⏱ Timeline: 3-8 weeks\n\n🔗 Detailed offer: https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`
  },
  seo: {
    az: `🔍 **SEO Optimizasiyası**\n\n📌 Xidmət daxildir: açar söz araşdırması, texniki audit, optimizasiya, backlinklər, aylıq hesabat.\n💰 Qiymət: 450-1800 AZN/ay\n⏱ Nəticə: 1-3 ay\n\n🔗 Dəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    ru: `🔍 **SEO оптимизация**\n\n💰 Цена: 450-1800 AZN/мес\n⏱ Результат: 1-3 месяца\n📌 Включено: анализ, аудит, оптимизация, ссылки, отчёты.\n\n🔗 https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    en: `🔍 **SEO Optimization**\n\n💰 Price: 450-1800 AZN/month\n⏱ Results: 1-3 months\n📌 Includes: keyword research, audit, on-page, link building, reports.\n\n🔗 https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`
  },
  support: {
    az: `🛠️ **Texniki Dəstək**\n\n📌 Xidmət daxildir: təhlükəsizlik yeniləmələri, sürət optimizasiyası, xəta düzəlişləri, yeni funksiyalar, 24/7 dəstək.\n💰 Qiymət: 250-1500 AZN/saat (və ya abunə)\n⏱ Cavab müddəti: 1-2 saat\n\n🔗 Dəqiq təklif: https://01cs.site/teklif-al.html\n\n0️⃣ Xidmətlərə qayıt`,
    ru: `🛠️ **Техническая поддержка**\n\n💰 Цена: 250-1500 AZN/час (или абонемент)\n📌 Обновления безопасности, оптимизация скорости, исправление ошибок, новые функции. 24/7.\n\n🔗 https://01cs.site/teklif-al.html\n\n0️⃣ Назад к услугам`,
    en: `🛠️ **Technical Support**\n\n💰 Price: 250-1500 AZN/hour (or monthly subscription)\n📌 Security updates, speed optimization, bug fixes, new features. 24/7.\n\n🔗 https://01cs.site/teklif-al.html\n\n0️⃣ Back to Services`
  }
};

function getAdditionalDetail(service, lang, level) {
  const extra = {
    website: {
      2: "Əlavə olaraq: Google Maps inteqrasiyası, onlayn randevu sistemi, blog modulu, çoxdillilik dəstəyi. Bütün layihələr GDPR uyğundur. 🌐",
      3: "Daha ətraflı: Müştəri nümunələrimiz və portfolio üçün linkə keçin: https://01cs.site/portfolio"
    },
    mobile: {
      2: "Əlavə olaraq: Offline rejim, biometrik giriş, sosial media paylaşımı, analitik (Firebase, Mixpanel). App Store və Google Play-ə yükləmə köməyi. 📱",
      3: "Daha ətraflı: Xüsusi tələblərinizə uyğun fərdi təklif üçün linkə keçin: https://01cs.site/teklif-al.html"
    },
    erp: {
      2: "Əlavə olaraq: Mobil app (menecer üçün), təsdiq axınları, avtomatik email/sms bildirişlər, e-imza inteqrasiyası. ⚙️",
      3: "Daha ətraflı: Biznes proseslərinizə uyğun demo üçün linkdən müraciət edin: https://01cs.site/teklif-al.html"
    },
    seo: {
      2: "Əlavə olaraq: Lokal SEO (Google My Business), voice search optimizasiyası, Core Web Vitals, strukturlaşdırılmış məlumat. 🔍",
      3: "Daha ətraflı: Rəqibləriniz qarşısında önə keçmək üçün linkdən pulsuz SEO audit tələb edin: https://01cs.site/teklif-al.html"
    },
    support: {
      2: "Əlavə olaraq: SLA müqaviləsi (24/7 və ya iş saatları), aylıq hesabat, prioritet dəstək xətti. 🛠️",
      3: "Daha ətraflı: Xüsusi dəstək paketlərimiz üçün linkə keçin: https://01cs.site/teklif-al.html"
    }
  };
  if (level === 2) return extra[service]?.[2] || "Əlavə məlumat üçün linkə keçin: https://01cs.site/teklif-al.html";
  if (level >= 3) return extra[service]?.[3] || "Bütün detallar üçün linkdən təklif alın: https://01cs.site/teklif-al.html";
  return "";
}

async function scrape01csSite() {
  try {
    const { data } = await axios.get("https://01cs.site", { timeout: 5000 });
    const $ = cheerio.load(data);
    return { fullText: $("body").text().substring(0, 1500) };
  } catch (e) { return null; }
}

async function askGemini(prompt, contextService = null, language = "az") {
  if (!genAI) {
    return "Üzr istəyirik, hazırda AI xidməti işləmir. Zəhmət olmasa, sualınızı menyu vasitəsilə göndərin. 😊";
  }
  const siteInfo = await scrape01csSite();
  const companyInfo = siteInfo?.fullText ? siteInfo.fullText.substring(0, 800) : "01 Code Studio Azərbaycanda vebsayt, mobil tətbiq, ERP, SEO və texniki dəstək xidmətləri göstərən proqram şirkətidir.";

  const systemPrompt = `Sən 01 Code Studio-nun rəsmi, dostyana və mehriban köməkçisisən. 😊

Şirkət məlumatı: ${companyInfo}

Cavab qaydaları:
- Hər cavabında ən azı 1 emoji istifadə et. (😊, 🚀, 💡, 👋, ✨, 🎯, 💬, 📱, 💻, ⚙️, 🔍, 🛠️)
- Cavabların qısa, ancaq faydalı olsun. Maksimum 3-4 cümlə.
- İstifadəçi ilə söhbət etdiyini unutma: "Salam, necəsiniz?" kimi suallara da cavab ver.
- Əgər istifadəçi maraq göstərirsə, əlavə suallar təklif et (məsələn, "Daha ətraflı məlumat istəyirsiniz? 😊").
- Qiymət soruşduqda: "Bizim ${contextService || 'bu'} xidmətimiz üçün qiymətlər müxtəlifdir. Dəqiq təklif üçün linkə keçin: https://01cs.site/teklif-al.html 💰"
- Yalnız tamamilə əlaqəsiz suallarda (hava, futbol, siyasət) "Bu sual mənim ixtisasım xaricindədir. Zəhmət olmasa, 01 Code Studio xidmətləri ilə bağlı sualınızı yazın. 😊" cavabını ver.

Cavab dili: ${language === "az" ? "Azərbaycanca" : language === "ru" ? "Rusca" : "İngiliscə"}

İstifadəçinin sualı: ${prompt}
${contextService ? `İstifadəçi hazırda ${contextService} xidmətinə baxır.` : ""}`;

  try {
    // Yalnız sizin istədiyiniz model istifadə olunur - FALLBACK YOXDUR
    const modelName = CONFIG.GEMINI_MODEL;
    console.log(`🤖 İstifadə olunan model: ${modelName}`);
    const model = genAI.getGenerativeModel({ model: modelName });
    const result = await model.generateContent(systemPrompt);
    let reply = result.response.text().trim();
    if (reply.length > 800) reply = reply.substring(0, 800) + "...";
    if (!reply) throw new Error("Boş cavab");
    return reply;
  } catch (e) {
    console.error(`❌ Gemini xətası (${CONFIG.GEMINI_MODEL}):`, e.message);
    return "Üzr istəyirik, texniki problem səbəbindən cavab verə bilmirəm. Sualınızı bir az sonra təkrarlayın və ya bizimlə əlaqə saxlayın: https://01cs.site 😊";
  }
}

const LIVE_KEYWORDS = {
  az: ["canli dəstək", "operator çağir", "insan dəstək", "müştəri xidmətləri", "canli dəstəyə yönləndirin", "canlı dəstək", "operator cagir"],
  ru: ["живая поддержка", "оператор", "позвать оператора"],
  en: ["live support", "call operator", "human support"]
};
function isLiveRequest(text) {
  const lower = text.toLowerCase();
  for (const arr of Object.values(LIVE_KEYWORDS)) {
    if (arr.some(kw => lower.includes(kw))) return true;
  }
  return false;
}

const DETAIL_KEYWORDS = [
  "ətrafli", "daha ətrafli", "etrafli", "daha etrafli", "əlavə məlumat", "more info", "подробнее",
  "daha çox", "ətraflı məlumat", "etrafli melumat", "daha ətraflı məlumat verə bilərsiniz",
  "etrafli melumat ver", "daha ətraflı məlumat verin", "ətraflı məlumat verin", "daha ətraflı cavab",
  "daha ətraflı cavab verin"
];

const MENUS = {
  az: {
    main: "Salam! 👋 01 Code Studio-ya xoş gəlmisiniz! 😊\n\nSizə necə kömək edə bilərəm?\n\n1️⃣ Xidmətlərimiz\n2️⃣ Haqqımızda\n3️⃣ Əlaqə\n\nDil: az, ru, en",
    services: "1️⃣ Vebsayt\n2️⃣ Mobil Tətbiq\n3️⃣ ERP/CRM\n4️⃣ SEO\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyu",
    about: "01 Code Studio — peşəkar proqram həlləri. 🌐 www.01cs.site | 📸 @01cs.az\n0️⃣ Ana menyu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\n0️⃣ Ana menyu",
    liveSupport: "Sizi canlı dəstəyə yönləndiririk. Mütəxəssislər tezliklə əlaqə saxlayacaq. 😊"
  },
  ru: {
    main: "Добро пожаловать! 👋\n\n1️⃣ Услуги\n2️⃣ О нас\n3️⃣ Контакты\n\nЯзык: az, ru, en",
    services: "1️⃣ Сайт\n2️⃣ Приложение\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Поддержка\n0️⃣ Главное меню",
    about: "01 Code Studio — IT-решения. 🌐 www.01cs.site\n0️⃣ Главное меню",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0️⃣ Главное меню",
    liveSupport: "Перенаправляем вас в службу поддержки. 😊"
  },
  en: {
    main: "Welcome! 👋\n\n1️⃣ Services\n2️⃣ About\n3️⃣ Contact\n\nLanguage: az, ru, en",
    services: "1️⃣ Website\n2️⃣ Mobile App\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Support\n0️⃣ Main menu",
    about: "01 Code Studio — professional software solutions. 🌐 www.01cs.site\n0️⃣ Main menu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0️⃣ Main menu",
    liveSupport: "Redirecting you to live support. 😊"
  }
};

async function getResponse(userId, text, username = "user") {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  let { state, lastService, language, blocked, detailLevel } = getUserState(userId);
  if (blocked) return null;

  // Dil dəyərinin etibarlılığını yoxla
  if (!language || !["az", "ru", "en"].includes(language)) {
    language = "az";
    setUserState(userId, { language });
  }

  if (lower === "az") { setUserState(userId, { language: "az", state: "main" }); return MENUS.az.main; }
  if (lower === "ru") { setUserState(userId, { language: "ru", state: "main" }); return MENUS.ru.main; }
  if (lower === "en") { setUserState(userId, { language: "en", state: "main" }); return MENUS.en.main; }

  if (isLiveRequest(raw)) {
    await sendTelegramNotification(userId, raw, username);
    setUserState(userId, { blocked: true });
    return MENUS[language].liveSupport;
  }

  if (["0", "menu", "salam", "start", "main", "0."].includes(lower)) {
    setUserState(userId, { state: "main", detailLevel: 1 });
    return MENUS[language].main;
  }

  if (state === "main") {
    if (lower === "1" || lower === "1." || lower === "1️⃣") {
      setUserState(userId, { state: "services" });
      return MENUS[language].services;
    }
    if (lower === "2" || lower === "2." || lower === "2️⃣") {
      setUserState(userId, { state: "about" });
      return MENUS[language].about;
    }
    if (lower === "3" || lower === "3." || lower === "3️⃣") {
      setUserState(userId, { state: "contact" });
      return MENUS[language].contact;
    }
    const ai = await askGemini(raw, null, language);
    if (ai && (ai.includes("canli dəstəyə") || ai.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, raw, username);
      setUserState(userId, { blocked: true });
      return ai;
    }
    return ai || MENUS[language].main;
  }

  if (state === "services") {
    if (lower === "1" || lower === "1." || lower === "1️⃣") {
      setUserState(userId, { state: "sub", lastService: "website", detailLevel: 1 });
      return SERVICE_DETAILS.website[language] || SERVICE_DETAILS.website.az;
    }
    if (lower === "2" || lower === "2." || lower === "2️⃣") {
      setUserState(userId, { state: "sub", lastService: "mobile", detailLevel: 1 });
      return SERVICE_DETAILS.mobile[language] || SERVICE_DETAILS.mobile.az;
    }
    if (lower === "3" || lower === "3." || lower === "3️⃣") {
      setUserState(userId, { state: "sub", lastService: "erp", detailLevel: 1 });
      return SERVICE_DETAILS.erp[language] || SERVICE_DETAILS.erp.az;
    }
    if (lower === "4" || lower === "4." || lower === "4️⃣") {
      setUserState(userId, { state: "sub", lastService: "seo", detailLevel: 1 });
      return SERVICE_DETAILS.seo[language] || SERVICE_DETAILS.seo.az;
    }
    if (lower === "5" || lower === "5." || lower === "5️⃣") {
      setUserState(userId, { state: "sub", lastService: "support", detailLevel: 1 });
      return SERVICE_DETAILS.support[language] || SERVICE_DETAILS.support.az;
    }
    if (lower === "0" || lower === "0." || lower === "0️⃣") {
      setUserState(userId, { state: "main" });
      return MENUS[language].main;
    }
    const ai = await askGemini(raw, null, language);
    if (ai && (ai.includes("canli dəstəyə") || ai.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, raw, username);
      setUserState(userId, { blocked: true });
      return ai;
    }
    return ai || MENUS[language].services;
  }

  if (state === "sub") {
    if (lower === "0" || lower === "0." || lower === "0️⃣") {
      setUserState(userId, { state: "services", detailLevel: 1 });
      return MENUS[language].services;
    }
    if (DETAIL_KEYWORDS.some(kw => lower.includes(kw)) && lastService) {
      let newLevel = detailLevel + 1;
      if (newLevel > 3) newLevel = 3;
      setUserState(userId, { detailLevel: newLevel });
      const extra = getAdditionalDetail(lastService, language, newLevel);
      if (extra) {
        return `📌 **Əlavə məlumat (${newLevel}/3):**\n${extra}\n\n0️⃣ Xidmətlərə qayıt`;
      } else {
        return "Başqa əlavə məlumat yoxdur. Dəqiq təklif üçün linkə keçin: https://01cs.site/teklif-al.html 💰\n\n0️⃣ Xidmətlərə qayıt";
      }
    }
    const ai = await askGemini(raw, lastService, language);
    if (ai && (ai.includes("canli dəstəyə") || ai.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, raw, username);
      setUserState(userId, { blocked: true });
      return ai;
    }
    return ai || MENUS[language].services;
  }

  setUserState(userId, { state: "main" });
  return MENUS[language].main;
}

async function replyToDM(recipientId, message) {
  if (!message) return;
  try {
    await axios.post("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { id: recipientId }, message: { text: message }
    }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
  } catch (e) {
    console.error("replyToDM xətası:", e.response?.data?.error?.message || e.message);
  }
}
async function replyToComment(commentId, message) {
  try {
    await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, { message }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
  } catch (e) {
    console.error("replyToComment xətası:", e.response?.data?.error?.message || e.message);
  }
}
async function sendDM(commentId, message) {
  try {
    await axios.post("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { comment_id: commentId }, message: { text: message }
    }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
  } catch (e) {
    console.error("sendDM xətası:", e.response?.data?.error?.message || e.message);
  }
}
async function sendMediaDM(recipientId, imageUrl, caption = "") {
  try {
    await axios.post("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { id: recipientId },
      message: {
        attachment: { type: "image", payload: { url: imageUrl } },
        ...(caption && { text: caption })
      }
    }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
  } catch (e) {
    console.error("sendMediaDM xətası:", e.response?.data?.error?.message || e.message);
  }
}

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
        const commentText = comment.text || "";
        const fromUser = comment.from?.username || "istifadəçi";
        if (isProcessed(commentId)) continue;
        logAnalytics(fromUser, "comment", commentText);
        await replyToComment(commentId, "Salam, şərhinizə cavab DM-də göndərildi 😊");
        await sendDM(commentId, MENUS.az.main);
      }
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;
        if (!text || !senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isProcessed(msgId)) continue;
        logAnalytics(senderId, "dm", text);
        const username = msg.sender?.username || "user";
        const response = await getResponse(senderId, text, username);
        if (response) await replyToDM(senderId, response);
      }
    }
  } catch (err) { console.error("Webhook xətası:", err.message); }
});

function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect("/admin/login");
}
app.get("/admin/login", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;margin-top:50px"><h2>Admin Girişi</h2><form method="post" action="/admin/login"><input type="password" name="pwd" placeholder="İstənilən şifrə" /><button type="submit">Daxil ol</button></form></body></html>`);
});
app.post("/admin/login", (req, res) => {
  req.session.admin = true;
  res.redirect("/admin/dashboard");
});
app.get("/admin/dashboard", isAdmin, (req, res) => {
  let analytics = [];
  if (fs.existsSync(ANALYTICS_FILE)) analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
  const total = analytics.length;
  const unique = new Set(analytics.map(a => a.userId)).size;
  const blocked = [...userStates.values()].filter(s => s.blocked).length;
  const users = Array.from(userStates.entries()).map(([id, s]) => ({ id, ...s }));
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="UTF-8"><title>Admin Panel</title><style>
      body{font-family:sans-serif;background:#e9ecef;padding:20px}
      .stats{display:flex;gap:20px;flex-wrap:wrap}
      .stat{background:white;padding:15px;border-radius:8px;flex:1;text-align:center}
      .stat .num{font-size:28px;font-weight:bold}
      table{width:100%;border-collapse:collapse;background:white;margin-top:20px}
      th,td{padding:8px;text-align:left;border-bottom:1px solid #ddd}
    </style></head>
    <body>
      <h1>Admin Panel</h1>
      <div class="stats">
        <div class="stat"><div class="num">${total}</div><div>Ümumi mesajlar</div></div>
        <div class="stat"><div class="num">${unique}</div><div>Unikal istifadəçi</div></div>
        <div class="stat"><div class="num">${blocked}</div><div>Bloklanmış</div></div>
      </div>
      <h2>İstifadəçi sessiyaları</h2>
      <table><thead><tr><th>ID</th><th>State</th><th>Son xidmət</th><th>Dil</th><th>Blok</th><th>Son aktivlik</th><th></th></tr></thead>
      <tbody>${users.map(u => `<tr><td>${u.id}</td><td>${u.state}</td><td>${u.lastService || '-'}</td><td>${u.language}</td><td>${u.blocked ? 'Bloklu' : 'Açıq'}</td><td>${new Date(u.lastActive).toLocaleString()}</td><td>${u.blocked ? `<a href="/admin/unblock/${u.id}">Bloku aç</a>` : ''}</td></tr>`).join('')}</tbody>
      </table>
    </body></html>
  `);
});
app.get("/admin/unblock/:userId", isAdmin, (req, res) => {
  const userId = req.params.userId;
  if (userStates.has(userId)) setUserState(userId, { blocked: false });
  res.redirect("/admin/dashboard");
});
app.get("/", (req, res) => res.send("01CS Bot Gemini AI (gemini-3.5-flash) ilə isləyir ✅"));
app.listen(CONFIG.PORT, () => console.log(`🚀 Port ${CONFIG.PORT}`));