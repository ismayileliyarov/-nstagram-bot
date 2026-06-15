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

// ======================== KONFİQURASİYA ========================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  PORT: process.env.PORT || 3000,
};

let genAI = null;
if (CONFIG.GEMINI_API_KEY) {
  genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);
}

// ======================== ANALİTİKA ============================
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

// ======================== TELEGRAM BİLDİRİŞİ ===================
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

// ======================== YADDAŞ ID VƏ VƏZİYYƏTLƏR ==============
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

// ======================== ƏTRAFLI XİDMƏT TƏSVİRLƏRİ (markdownsuz) =================
const SERVICE_DETAILS = {
  website: {
    az: `Vebsayt Hazirlanmasi

Xidmet növləri:
• Vizit kart / Landing page – 520-1300 AZN (7-14 gün)
• Korporativ sayt – 1300-4400 AZN (30-60 gün)
• E-ticarət sayti – 2600-13000 AZN (60-120 gün)

Xüsusiyyətlər:
• 100% mobil uygun (responsive)
• SEO hazirliği (Google-da yerleşmek üçün)
• İstenilen ödəniş sistemi inteqrasiyası
• Admin panel – sayti özünüz idarə edə bilərsiniz
• Layihə bitdikdən sonra 1 ay pulsuz texniki dəstək

Əlavə:
• Domain ve hosting qeydiyyatinda kömək
• Google Analytics ve Search Console qurulumu
• Sosial şəbəkə inteqrasiyasi

Dəqiq təklif üçün: https://01cs.site/teklif-al.html

0 Xidmətlərə qayit`,
    ru: `Разработка веб-сайтов

Типы услуг:
• Визитка / Landing page – 520-1300 AZN (7-14 дней)
• Корпоративный сайт – 1300-4400 AZN (30-60 дней)
• Интернет-магазин – 2600-13000 AZN (60-120 дней)

Особенности:
• Адаптивный дизайн
• SEO-подготовка
• Интеграция платёжных систем
• Админ-панель
• 1 месяц бесплатной техподдержки

Точная цена: https://01cs.site/teklif-al.html

0 Назад к услугам`,
    en: `Website Development

Service types:
• Business card / Landing page – 520-1300 AZN (7-14 days)
• Corporate website – 1300-4400 AZN (30-60 days)
• E-commerce website – 2600-13000 AZN (60-120 days)

Features:
• Responsive design
• SEO ready
• Payment system integration
• Admin panel
• 1 month free technical support

Detailed offer: https://01cs.site/teklif-al.html

0 Back to Services`
  },
  mobile: {
    az: `Mobil Tətbiq Hazirlanmasi

Səviyyələr:
• Sadə tətbiq (kataloq, informasiya) – 2600-6000 AZN (30-45 gün)
• Orta səviyyəli (sifariş, ödəniş) – 6000-15500 AZN (60-90 gün)
• Mürəkkəb tətbiq (real-time, GPS, chat) – 13000-43000 AZN (90-180 gün)

Xüsusiyyətlər:
• Native iOS ve Android (ve ya cross-platform)
• Push bildirişlər
• Ödəniş sistemləri (Apple Pay, Google Pay, kart)
• Chat, xəritə, GPS funksiyalari
• Admin panel (istifadəçilər, məzmun, statistikalar)
• Server ve API arxitekturası

Dəqiq təklif üçün: https://01cs.site/teklif-al.html

0 Xidmətlərə qayit`,
    ru: `Разработка мобильных приложений

Уровни:
• Простое приложение – 2600-6000 AZN (30-45 дней)
• Среднее (заказы, оплата) – 6000-15500 AZN (60-90 дней)
• Сложное (real-time, GPS, чат) – 13000-43000 AZN (90-180 дней)

Особенности:
• Нативные iOS и Android
• Push-уведомления
• Платёжные системы
• Чат, карты, GPS
• Админ-панель

Точная цена: https://01cs.site/teklif-al.html

0 Назад к услугам`,
    en: `Mobile App Development

Levels:
• Simple app (catalog, info) – 2600-6000 AZN (30-45 days)
• Medium (orders, payments) – 6000-15500 AZN (60-90 days)
• Complex (real-time, GPS, chat) – 13000-43000 AZN (90-180 days)

Features:
• Native iOS & Android
• Push notifications
• Payment systems
• Chat, maps, GPS
• Admin panel

Detailed offer: https://01cs.site/teklif-al.html

0 Back to Services`
  },
  erp: {
    az: `ERP / CRM / Avtomatlaşdirma

Modullar:
• Müştəri idarəsi (CRM)
• Anbar ve satiş idarəsi
• İşçi ve əmək haqqi
• Maliyyə ve mühasibat
• Hesabat analitikasi

Qiymət: 7000-43000 AZN (layihəyə görə)
Müddət: 3-8 həftə (tam fərdi)

Xüsusiyyətlər:
• İstənilən API ilə inteqrasiya (bank, ödəniş, kargolar)
• Real-time məlumat sinxronizasiyasi
• Çoxistifadəçili sistem, rol ve icazələr
• Bulud ve ya on-premise quraşdirma
• 1 ay pulsuz test dəstəyi

Dəqiq təklif: https://01cs.site/teklif-al.html

0 Xidmətlərə qayit`,
    ru: `ERP / CRM / Автоматизация

Цена: 7000-43000 AZN
Срок: 3-8 недель

Модули: управление клиентами, склад, продажи, сотрудники, финансы, отчёты.
https://01cs.site/teklif-al.html

0 Назад к услугам`,
    en: `ERP / CRM / Automation

Price: 7000-43000 AZN
Timeline: 3-8 weeks

Modules: customer management, warehouse, sales, employees, finance, reports.
https://01cs.site/teklif-al.html

0 Back to Services`
  },
  seo: {
    az: `SEO Optimizasiyasi

Xidmet daxildir:
• Açar söz araşdırması
• Texniki SEO audit (sayt sürəti, mobil uyğunluq, indeksləşmə)
• Daxili optimizasiya (meta teqlər, struktur, məzmun)
• Keyfiyyətli backlinklərin qurulması
• Aylıq hesabat (rank, trafik, conversion)

Qiymət: 450-1800 AZN/ay (layihənin həcminə görə)
Nəticə: 1-3 ay ərzində Google-da irəliləyiş

Əlavə: Rəqib təhlili, lokal SEO (Google Maps), e-ticarət SEO

Dəqiq təklif: https://01cs.site/teklif-al.html

0 Xidmətlərə qayit`,
    ru: `SEO оптимизация

Цена: 450-1800 AZN/мес
Результат: 1-3 месяца

Включено: анализ ключевых слов, тех. аудит, внутренняя оптимизация, ссылки, отчёты.
https://01cs.site/teklif-al.html

0 Назад к услугам`,
    en: `SEO Optimization

Price: 450-1800 AZN/month
Results: 1-3 months

Includes: keyword research, technical audit, on-page optimization, link building, monthly reports.
https://01cs.site/teklif-al.html

0 Back to Services`
  },
  support: {
    az: `Texniki Dəstək

Xidmet daxildir:
• Mövcud layihənin təhlükəsizlik yeniləmələri
• Sürət optimizasiyasi (sayt/tətbiq)
• Xəta düzəlişləri ve bug fix
• Yeni funksiyalarin əlavə edilməsi (saatliq)
• 7/24 onlayn dəstək (chat, email)

Qiymət: 250-1500 AZN/saat (ve ya aylıq abunə müqaviləsi)
Cavab müddəti: Kritik xətalar üçün 1-2 saat

Dəqiq təklif: https://01cs.site/teklif-al.html

0 Xidmətlərə qayit`,
    ru: `Техническая поддержка

Цена: 250-1500 AZN/час (или абонемент)
Обновления безопасности, оптимизация скорости, исправление ошибок, новые функции. 24/7.
https://01cs.site/teklif-al.html

0 Назад к услугам`,
    en: `Technical Support

Price: 250-1500 AZN/hour (or monthly subscription)
Security updates, speed optimization, bug fixes, new features. 24/7 support.
https://01cs.site/teklif-al.html

0 Back to Services`
  }
};

// ======================== SAYT SKRAPING =================
let siteCache = { data: null, timestamp: 0 };
async function scrape01csSite() {
  if (siteCache.data && Date.now() - siteCache.timestamp < 3600000) return siteCache.data;
  try {
    const { data } = await axios.get("https://01cs.site", { timeout: 8000 });
    const $ = cheerio.load(data);
    const fullText = $("body").text().substring(0, 2000);
    siteCache.data = { fullText };
    siteCache.timestamp = Date.now();
    return siteCache.data;
  } catch (e) { return null; }
}

// ======================== İNTERNET AXTARIŞ (Tavily) =================
async function webSearch(query) {
  if (CONFIG.TAVILY_API_KEY) {
    try {
      const res = await axios.post("https://api.tavily.com/search", {
        api_key: CONFIG.TAVILY_API_KEY,
        query: query + " Azerbaycan 2026",
        search_depth: "basic",
        max_results: 2
      });
      return res.data.results.map(r => ({ title: r.title, content: r.content }));
    } catch (e) {}
  }
  return [];
}

// ======================== AI SORĞUSU (Google Gemini) =================
async function askAI(prompt, contextService = null, language = "az") {
  if (!genAI) return null;
  const siteInfo = await scrape01csSite();
  const webResults = await webSearch(`${contextService || "ümuumi"} sorğu`);
  let marketData = "";
  if (webResults.length) {
    marketData = "\n\nBazar məlumatlari:\n" + webResults.map(r => `- ${r.title}: ${r.content.substring(0, 100)}`).join("\n");
  }
  const langInstruction = language === "az" ? "Cavabi Azərbaycan dilində, 4-5 cümlə ilə ver."
                          : language === "ru" ? "Ответ дай на русском языке, 4-5 предложений."
                          : "Answer in English, 4-5 sentences.";
  const systemPrompt = `Sən 01 Code Studio-nun rəsmi köməkçisisən. Məlumat: ${siteInfo?.fullText?.substring(0, 600) || "IT xidmətləri şirkəti"}
Cavab qaydalari: 4-5 cümlə, faydali, peşəkar. İstifadəçi istənilən təbii suali verə bilər, ona uyğun cavablandir.
Şirkətimiz vebsayt, mobil tətbiq, ERP, SEO, texniki dəstək xidmətləri göstərir.
Qiymət təkliflərində öz qiymət siyahimizdan (166tech.az-dan 10-15% aşaği) istifadə et.
Əgər sual şirkət işi ilə əlaqəli deyilsə, cavabinda "Sizi canli dəstəyə yönləndiririk..." yaz.
${contextService ? `İstifadəçi hazirda "${contextService}" xidmətinə baxir.` : ""}
${langInstruction}
${marketData}`;
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const chat = model.startChat({
      history: [
        { role: "user", parts: [{ text: systemPrompt }] },
        { role: "model", parts: [{ text: "Başa düşdüm. Mən köməkçiyəm." }] }
      ]
    });
    const result = await chat.sendMessage(prompt);
    const response = result.response.text().trim();
    if (response.length > 800) return response.substring(0, 800) + "...";
    return response;
  } catch (e) {
    console.error("Gemini xətası:", e.message);
    return null;
  }
}

// ======================== DETALLI INFO SƏVİYYƏLİ (əlavə, markdownsuz) =================
function getAdditionalDetail(service, lang, level) {
  const extra = {
    website: {
      2: " Əlavə olaraq: Vebsayt layihələrində eyni zamanda Google Maps inteqrasiyası, onlayn randevu sistemi, blog modulu, çoxdillilik dəstəyi təklif edirik. Bütün layihələr GDPR uyğundur.",
      3: " Daha ətrafli: Müştəri nümunələrimiz və portfolio üçün linkə keçin: https://01cs.site/portfolio"
    },
    mobile: {
      2: " Əlavə olaraq: Mobil tətbiqlərdə offline rejim, biometrik giriş (barmaq izi, FaceID), sosial media paylaşimi, analitik (Firebase, Mixpanel) dəstəklənir. Tətbiqi App Store və Google Play-ə yükləməkdə kömək edirik.",
      3: " Daha ətrafli: Xüsusi tələblərinizə uyğun fərdi təklif üçün linkə keçin: https://01cs.site/teklif-al.html"
    },
    erp: {
      2: " Əlavə olaraq: ERP sistemlərimizə mobil app (menecer üçün), təsdiq axınları (approval workflows), avtomatik email/sms bildirişlər, e-imza inteqrasiyası əlavə edilə bilər.",
      3: " Daha ətrafli: Sizin biznes proseslərinizə uyğun demo təşkil etmək üçün linkdən müraciət edin: https://01cs.site/teklif-al.html"
    },
    seo: {
      2: " Əlavə olaraq: SEO paketinə lokal SEO (Google My Business), voice search optimizasiyası, yükləmə sürəti optimizasiyası (Core Web Vitals), strukturlaşdırılmış məlumat (schema markup) daxildir.",
      3: " Daha ətrafli: Rəqibləriniz qarşısında önə keçmək üçün linkdən pulsuz SEO audit tələb edin: https://01cs.site/teklif-al.html"
    },
    support: {
      2: " Əlavə olaraq: Texniki dəstək üçün SLA müqaviləsi (24/7 və ya iş saatları), aylıq hesabat, prioritet dəstək xətti təklif olunur.",
      3: " Daha ətrafli: Xüsusi dəstək paketlərimiz haqqında məlumat üçün linkə keçin: https://01cs.site/teklif-al.html"
    }
  };
  if (level === 2) return extra[service]?.[2] || " Əlavə məlumat üçün linkə keçin: https://01cs.site/teklif-al.html";
  if (level >= 3) return extra[service]?.[3] || " Bütün detallar üçün linkdən təklif alın: https://01cs.site/teklif-al.html";
  return "";
}

// ======================== CANLI DƏSTƏK AÇAR SÖZLƏRİ =================
const LIVE_KEYWORDS = {
  az: ["canli dəstək", "operator çağir", "insan dəstək", "müştəri xidmətləri", "canli dəstəyə yönləndirin", "canli destek", "operator cagir", "canlı dəstək"],
  ru: ["живая поддержка", "оператор", "позвать оператора", "живой чат"],
  en: ["live support", "call operator", "human support", "talk to human"]
};
function isLiveRequest(text) {
  const lower = text.toLowerCase();
  for (const arr of Object.values(LIVE_KEYWORDS)) {
    if (arr.some(kw => lower.includes(kw))) return true;
  }
  return false;
}

// ======================== MENYULAR (markdownsuz) =================
const MENUS = {
  az: {
    main: "Salam, 01 Code Studio-ya xoş gəlmisiniz!\n\n1 Xidmətlərimiz\n2 Haqqimizda\n3 Əlaqə\nDil: az, ru, en",
    services: "1 Vebsayt\n2 Mobil Tətbiq\n3 ERP/CRM\n4 SEO\n5 Texniki Dəstək\n0 Ana menyu",
    about: "01 Code Studio — peşəkar proqram həlləri. 🌐 www.01cs.site | 📸 @01cs.az\n0 Ana menyu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\n0 Ana menyu",
    liveSupport: "Sizi canli dəstəyə yönləndiririk. Mütəxəssislər tezliklə əlaqə saxlayacaq."
  },
  ru: {
    main: "Добро пожаловать!\n1 Услуги\n2 О нас\n3 Контакты\nЯзык: az, ru, en",
    services: "1 Сайт\n2 Приложение\n3 ERP\n4 SEO\n5 Поддержка\n0 Главное меню",
    about: "01 Code Studio — IT-решения. 🌐 www.01cs.site\n0 Главное меню",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0 Главное меню",
    liveSupport: "Перенаправляем вас в службу поддержки. Специалисты свяжутся с вами."
  },
  en: {
    main: "Welcome to 01 Code Studio!\n\n1 Services\n2 About\n3 Contact\nLanguage: az, ru, en",
    services: "1 Website\n2 Mobile App\n3 ERP\n4 SEO\n5 Support\n0 Main menu",
    about: "01 Code Studio — professional software solutions. 🌐 www.01cs.site\n0 Main menu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0 Main menu",
    liveSupport: "Redirecting you to live support. Our experts will contact you shortly."
  }
};

// ======================== CAVAB FUNKSİYASI =================
async function getResponse(userId, text, username = "user") {
  const lower = text.trim().toLowerCase();
  let { state, lastService, language, blocked, detailLevel } = getUserState(userId);
  if (blocked) return null;

  if (lower === "az") { setUserState(userId, { language: "az", state: "main" }); return MENUS.az.main; }
  if (lower === "ru") { setUserState(userId, { language: "ru", state: "main" }); return MENUS.ru.main; }
  if (lower === "en") { setUserState(userId, { language: "en", state: "main" }); return MENUS.en.main; }

  if (isLiveRequest(text)) {
    await sendTelegramNotification(userId, text, username);
    setUserState(userId, { blocked: true });
    return MENUS[language].liveSupport;
  }

  if (["0", "menu", "salam", "start", "main"].includes(lower)) {
    setUserState(userId, { state: "main", detailLevel: 1 });
    return MENUS[language].main;
  }

  if (state === "main") {
    if (lower === "1") {
      setUserState(userId, { state: "services" });
      return MENUS[language].services;
    }
    if (lower === "2") {
      setUserState(userId, { state: "about" });
      return MENUS[language].about;
    }
    if (lower === "3") {
      setUserState(userId, { state: "contact" });
      return MENUS[language].contact;
    }
    const aiReply = await askAI(text, null, language);
    if (aiReply && (aiReply.includes("canli dəstəyə") || aiReply.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, text, username);
      setUserState(userId, { blocked: true });
      return aiReply;
    }
    return aiReply || MENUS[language].main;
  }

  if (state === "services") {
    if (lower === "1") {
      setUserState(userId, { state: "sub", lastService: "website", detailLevel: 1 });
      return SERVICE_DETAILS.website[language] || SERVICE_DETAILS.website.az;
    }
    if (lower === "2") {
      setUserState(userId, { state: "sub", lastService: "mobile", detailLevel: 1 });
      return SERVICE_DETAILS.mobile[language] || SERVICE_DETAILS.mobile.az;
    }
    if (lower === "3") {
      setUserState(userId, { state: "sub", lastService: "erp", detailLevel: 1 });
      return SERVICE_DETAILS.erp[language] || SERVICE_DETAILS.erp.az;
    }
    if (lower === "4") {
      setUserState(userId, { state: "sub", lastService: "seo", detailLevel: 1 });
      return SERVICE_DETAILS.seo[language] || SERVICE_DETAILS.seo.az;
    }
    if (lower === "5") {
      setUserState(userId, { state: "sub", lastService: "support", detailLevel: 1 });
      return SERVICE_DETAILS.support[language] || SERVICE_DETAILS.support.az;
    }
    if (lower === "0") {
      setUserState(userId, { state: "main" });
      return MENUS[language].main;
    }
    const aiReply = await askAI(text, null, language);
    if (aiReply && (aiReply.includes("canli dəstəyə") || aiReply.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, text, username);
      setUserState(userId, { blocked: true });
      return aiReply;
    }
    return aiReply || MENUS[language].services;
  }

  if (state === "sub") {
    if (lower === "0") {
      setUserState(userId, { state: "services", detailLevel: 1 });
      return MENUS[language].services;
    }
    const detailKeywords = ["ətrafli", "daha ətrafli", "etrafli", "daha etrafli", "more info", "подробнее", "əlavə məlumat"];
    if (detailKeywords.some(kw => lower.includes(kw)) && lastService) {
      let newLevel = detailLevel + 1;
      if (newLevel > 3) newLevel = 3;
      setUserState(userId, { detailLevel: newLevel });
      const extra = getAdditionalDetail(lastService, language, newLevel);
      if (extra) {
        return `Əlavə məlumat (${newLevel}/3):\n${extra}\n\n0 Xidmətlərə qayit`;
      } else {
        return "Başqa əlavə məlumat yoxdur. Dəqiq təklif üçün linkə keçin: https://01cs.site/teklif-al.html\n\n0 Xidmətlərə qayit";
      }
    }
    const aiReply = await askAI(text, lastService, language);
    if (aiReply && (aiReply.includes("canli dəstəyə") || aiReply.includes("yönləndiririk"))) {
      await sendTelegramNotification(userId, text, username);
      setUserState(userId, { blocked: true });
      return aiReply;
    }
    if (!aiReply) {
      return MENUS[language].services;
    }
    return aiReply;
  }

  setUserState(userId, { state: "main" });
  return MENUS[language].main;
}

// ======================== INSTAGRAM API FUNKSİYALARI =================
async function replyToDM(recipientId, message) {
  if (!message) return;
  await axios.post("https://graph.instagram.com/v21.0/me/messages", {
    recipient: { id: recipientId }, message: { text: message }
  }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
}
async function replyToComment(commentId, message) {
  await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, { message }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
}
async function sendDM(commentId, message) {
  await axios.post("https://graph.instagram.com/v21.0/me/messages", {
    recipient: { comment_id: commentId }, message: { text: message }
  }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
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
  } catch (e) { console.log("Media xətası:", e.message); }
}

// ======================== WEBHOOK ENDPOINTLƏRİ =================
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
        await replyToComment(commentId, "Salam, şərhinizə cavab DM-də göndərildi");
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
        if (text.toLowerCase().includes("şəkil")) {
          await sendMediaDM(senderId, "https://www.01cs.site/sample.jpg", "Nümunə layihə");
        }
      }
    }
  } catch (err) { console.error("Webhook xətası:", err.message); }
});

// ======================== ADMIN PANEL =================
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
      body{font-family:'Segoe UI',sans-serif;background:#e9ecef;margin:0;padding:20px}
      .container{max-width:1200px;margin:auto}
      h1{color:#1a1a2e}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:15px;margin-bottom:30px}
      .stat{background:white;border-radius:12px;padding:20px;text-align:center;box-shadow:0 2px 5px rgba(0,0,0,0.1)}
      .stat h3{margin:0;color:#666;font-size:14px}
      .stat .num{font-size:32px;font-weight:bold;margin:10px 0 0}
      .card{background:white;border-radius:12px;padding:20px;margin-bottom:30px;box-shadow:0 2px 5px rgba(0,0,0,0.1)}
      .card h2{margin-top:0;border-bottom:2px solid #eee;padding-bottom:10px}
      table{width:100%;border-collapse:collapse;font-size:14px}
      th,td{padding:10px;text-align:left;border-bottom:1px solid #eee}
      th{background:#f8f9fa}
      .unblock{background:#28a745;color:white;border:none;padding:5px 10px;border-radius:6px;cursor:pointer;text-decoration:none}
      .badge.blocked{background:#dc3545;color:white;padding:2px 8px;border-radius:20px;font-size:12px}
      .badge.open{background:#28a745;color:white;padding:2px 8px;border-radius:20px;font-size:12px}
    </style></head>
    <body>
    <div class="container">
      <h1>📊 01CS Bot Admin Paneli</h1>
      <div class="stats">
        <div class="stat"><h3>Ümumi Mesajlar</h3><div class="num">${total}</div></div>
        <div class="stat"><h3>Unikal İstifadəçi</h3><div class="num">${unique}</div></div>
        <div class="stat"><h3>Bloklanmış</h3><div class="num">${blocked}</div></div>
      </div>
      <div class="card">
        <h2>👥 İstifadəçi Sessiyaları</h2>
        <table>
          <thead><tr><th>ID</th><th>State</th><th>Son Xidmət</th><th>Dil</th><th>Blok</th><th>Son Aktivlik</th><th></th></tr></thead>
          <tbody>
            ${users.map(u => `
              <tr>
                <td>${u.id}</td><td>${u.state}</td><td>${u.lastService || '-'}</td><td>${u.language || 'az'}</td>
                <td>${u.blocked ? '<span class="badge blocked">Bloklu</span>' : '<span class="badge open">Açıq</span>'}</td>
                <td>${new Date(u.lastActive).toLocaleString()}</td>
                <td>${u.blocked ? `<a href="/admin/unblock/${u.id}" class="unblock">Bloku aç</a>` : ''}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
      <div class="card">
        <h2>📋 Son 20 Hadisə</h2>
        <table><thead><tr><th>Vaxt</th><th>İstifadəçi</th><th>Tip</th><th>Məzmun</th></tr></thead>
        <tbody>
          ${analytics.slice(-20).reverse().map(e => `<tr><td>${new Date(e.timestamp).toLocaleString()}</td><td>${e.userId}</td><td>${e.action}</td><td>${e.details?.substring(0,50)}</td></tr>`).join('')}
        </tbody>
        </table>
      </div>
    </div>
    </body>
    </html>
  `);
});

app.get("/admin/unblock/:userId", isAdmin, (req, res) => {
  const userId = req.params.userId;
  if (userStates.has(userId)) setUserState(userId, { blocked: false });
  res.redirect("/admin/dashboard");
});

app.get("/", (req, res) => res.send("01CS Bot Gemini AI ilə isləyir, təbii suallari anlayir ✅"));
app.listen(CONFIG.PORT, () => console.log(`🚀 Server ${CONFIG.PORT} portunda işləyir`));