const express = require("express");
const axios = require("axios");
const fs = require("fs");
const app = express();

app.use(express.json());

// ======================== KONFİQURASİYA ========================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PORT: process.env.PORT || 3000,
};

// ======================== ANALİTİKA ============================
const ANALYTICS_FILE = "/tmp/analytics.json";
function logAnalytics(userId, action, details = "") {
  try {
    let data = [];
    if (fs.existsSync(ANALYTICS_FILE)) {
      data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    }
    data.push({ userId, action, details, timestamp: new Date().toISOString() });
    if (data.length > 1000) data.shift();
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

// ======================== TELEGRAM BİLDİRİŞİ ===================
async function sendTelegramNotification(userId, userMessage) {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram bildirişi üçün token yoxdur.");
    return;
  }
  const text = `🆘 *CANLI DƏSTƏK TƏLƏBİ*\n\n👤 İstifadəçi ID: ${userId}\n💬 Mesaj: ${userMessage.substring(0, 200)}`;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    });
    console.log("📨 Telegram bildirişi göndərildi.");
  } catch (e) {
    console.error("Telegram xətası:", e.message);
  }
}

// ======================== YADDAŞ ID VƏ VƏZİYYƏTLƏR ==============
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

const userStates = new Map();
const STATE_TIMEOUT = 30 * 60 * 1000;

function getUserState(userId) {
  const now = Date.now();
  const record = userStates.get(userId);
  if (!record) return { state: "main", lastService: null, language: "az", blocked: false };
  if (now - record.lastActive > STATE_TIMEOUT) {
    userStates.delete(userId);
    return { state: "main", lastService: null, language: "az", blocked: false };
  }
  record.lastActive = now;
  userStates.set(userId, record);
  return {
    state: record.state,
    lastService: record.lastService,
    language: record.language || "az",
    blocked: record.blocked || false,
  };
}

function setUserState(userId, state, lastService = null, language = null, blocked = false) {
  const existing = userStates.get(userId) || {};
  userStates.set(userId, {
    state,
    lastActive: Date.now(),
    lastService: lastService !== undefined ? lastService : existing.lastService,
    language: language !== null ? language : (existing.language || "az"),
    blocked: blocked !== undefined ? blocked : (existing.blocked || false),
  });
}

// ======================== ÇOXDİLLİ MENYULAR ====================
const MENUS = {
  az: {
    main: `Salam, 01 Code Studio-ya xoş gəlmisiniz! 👋\n\nMüraciətiniz nə ilə bağlıdır?\n1️⃣ Xidmətlərimiz\n2️⃣ Haqqımızda\n3️⃣ Əlaqə\n\nDil seçimi: az, ru, en`,
    services: `Hansı xidmətlə maraqlanırsınız?\n1️⃣ Vebsayt\n2️⃣ Mobil Tətbiq\n3️⃣ ERP / Avtomatlaşdırma\n4️⃣ SEO\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyu`,
    about: `01 Code Studio — Azərbaycanda bizneslərin rəqəmsallaşması üçün peşəkar proqram həlləri.\n🌐 www.01cs.site | 📸 @01cs.az\n0️⃣ Ana menyu`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\n7/24\n0️⃣ Ana menyu`,
    website: `💻 Vebsayt Hazırlanması\n📌 Vizit sayt: 250-700 AZN (5-10 gün)\n📌 E-ticarət: 700-1800 AZN (3-6 həftə)\n✅ Responsiv, admin panel, ödəniş sistemi\nDəqiq təklif: https://01cs.site/teklif-al.html\n0️⃣ Xidmətlərə qayıt`,
    mobile: `📱 Mobil Tətbiq Hazırlanması\n💰 1800 AZN-dən başlayır\n⏱ 4-10 həftə\n✅ iOS & Android, push notification, ödəniş\nLink: https://01cs.site/teklif-al.html\n0️⃣ Xidmətlərə qayıt`,
    erp: `⚙️ ERP / CRM Sistemləri\n💰 1200 AZN-dən başlayır\n⏱ 3-8 həftə\n✅ Anbar, satış, müştəri, avtomatlaşdırma\nLink: https://01cs.site/teklif-al.html\n0️⃣ Xidmətlərə qayıt`,
    seo: `🔍 SEO Optimizasiyası\n💰 Qiymət fərdi\n⏱ Nəticə 1-3 ay\n✅ Açar söz, texniki audit, link building\nLink: https://01cs.site/teklif-al.html\n0️⃣ Xidmətlərə qayıt`,
    support: `🛠️ Texniki Dəstək\n💰 Qiymət işin həcminə görə\n✅ Mövcud layihələrin yenilənməsi, təhlükəsizlik, sürət\nLink: https://01cs.site/teklif-al.html\n0️⃣ Xidmətlərə qayıt`,
    unknown: `Başa düşmədim. Zəhmət olmasa menyudan seçin (1,2,3) və ya dili dəyişin (az, ru, en).`,
    languageSet: `Dil Azərbaycanca seçildi. 🇦🇿`,
    liveSupport: `Sizi canlı dəstəyə yönləndiririk. Bizim mütəxəssislər tezliklə sizinlə əlaqə saxlayacaqlar. 😊`,
  },
  ru: {
    main: `Добро пожаловать в 01 Code Studio! 👋\n\nВыберите тему:\n1️⃣ Услуги\n2️⃣ О нас\n3️⃣ Контакты\n\nВыбор языка: az, ru, en`,
    services: `Какие услуги вас интересуют?\n1️⃣ Сайт\n2️⃣ Моб. приложение\n3️⃣ ERP/CRM\n4️⃣ SEO\n5️⃣ Техподдержка\n0️⃣ Главное меню`,
    about: `01 Code Studio — профессиональные IT-решения для бизнеса в Азербайджане.\n🌐 www.01cs.site | 📸 @01cs.az\n0️⃣ Главное меню`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\nКруглосуточно\n0️⃣ Главное меню`,
    website: `💻 Сайт\n📌 Визитка: 250-700 AZN (5-10 дней)\n📌 Интернет-магазин: 700-1800 AZN (3-6 недель)\nТочная цена: https://01cs.site/teklif-al.html\n0️⃣ Назад к услугам`,
    mobile: `📱 Мобильное приложение\n💰 от 1800 AZN\n⏱ 4-10 недель\nСсылка: https://01cs.site/teklif-al.html\n0️⃣ Назад к услугам`,
    erp: `⚙️ ERP/CRM системы\n💰 от 1200 AZN\n⏱ 3-8 недель\nСсылка: https://01cs.site/teklif-al.html\n0️⃣ Назад к услугам`,
    seo: `🔍 SEO оптимизация\n💰 Индивидуально\n⏱ Результат 1-3 месяца\nСсылка: https://01cs.site/teklif-al.html\n0️⃣ Назад к услугам`,
    support: `🛠️ Техподдержка\n💰 По договорённости\nСсылка: https://01cs.site/teklif-al.html\n0️⃣ Назад к услугам`,
    unknown: `Не понял. Пожалуйста, выберите из меню (1,2,3) или смените язык (az, ru, en).`,
    languageSet: `Язык выбран: Русский. 🇷🇺`,
    liveSupport: `Перенаправляем вас в службу поддержки. Наши специалисты свяжутся с вами. 😊`,
  },
  en: {
    main: `Welcome to 01 Code Studio! 👋\n\nWhat is your inquiry?\n1️⃣ Our Services\n2️⃣ About Us\n3️⃣ Contact\n\nLanguage: az, ru, en`,
    services: `Which service?\n1️⃣ Website\n2️⃣ Mobile App\n3️⃣ ERP/CRM\n4️⃣ SEO\n5️⃣ Technical Support\n0️⃣ Main Menu`,
    about: `01 Code Studio — professional software solutions for businesses in Azerbaijan.\n🌐 www.01cs.site | 📸 @01cs.az\n0️⃣ Main Menu`,
    contact: `📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\n24/7\n0️⃣ Main Menu`,
    website: `💻 Website\n📌 Landing: 250-700 AZN (5-10 days)\n📌 E-commerce: 700-1800 AZN (3-6 weeks)\nDetailed offer: https://01cs.site/teklif-al.html\n0️⃣ Back to Services`,
    mobile: `📱 Mobile App\n💰 from 1800 AZN\n⏱ 4-10 weeks\nLink: https://01cs.site/teklif-al.html\n0️⃣ Back to Services`,
    erp: `⚙️ ERP/CRM Systems\n💰 from 1200 AZN\n⏱ 3-8 weeks\nLink: https://01cs.site/teklif-al.html\n0️⃣ Back to Services`,
    seo: `🔍 SEO Optimization\n💰 Custom pricing\n⏱ Results in 1-3 months\nLink: https://01cs.site/teklif-al.html\n0️⃣ Back to Services`,
    support: `🛠️ Technical Support\n💰 Based on scope\nLink: https://01cs.site/teklif-al.html\n0️⃣ Back to Services`,
    unknown: `Sorry, I didn't understand. Please choose from menu (1,2,3) or change language (az, ru, en).`,
    languageSet: `Language set to English. 🇬🇧`,
    liveSupport: `Redirecting you to live support. Our experts will contact you shortly. 😊`,
  },
};

// ======================== GROQ AI (GENİŞ CAVABLAR) ==============
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

async function askGroq(userMessage, contextService = null, language = "az") {
  if (!CONFIG.GROQ_API_KEY) {
    console.log("⚠️ GROQ_API_KEY yoxdur.");
    return null;
  }

  const langInstruction =
    language === "az" ? "Cavabını Azərbaycan dilində, 4-5 cümlə ilə ver."
    : language === "ru" ? "Ответ дай на русском языке, 4-5 предложений."
    : "Answer in English, 4-5 sentences.";

  let systemPrompt = `Sən 01 Code Studio-nun rəsmi Instagram köməkçisisən. 
Şirkət Azərbaycanda vebsayt, mobil tətbiq, ERP/CRM, SEO və texniki dəstək xidmətləri göstərir.
- Cavabların 4-5 cümlə olsun, ətraflı və faydalı.
- "Daha ətraflı" sorğusunda cari xidmət haqqında geniş məlumat ver (qiymət, müddət, xüsusiyyətlər).
- Qiymət soruşduqda təxmini qiymətləri yaz və dəqiq təklif üçün https://01cs.site/teklif-al.html linkinə yönləndir.
- Əgər sual şirkətin fəaliyyəti ilə əlaqəli deyilsə (hava, siyasət, futbol, şəxsi suallar), heç bir cavab vermə, sadəcə aşağıdakı tam mesajı qaytar:
"Sizi canlı dəstəyə yönləndiririk. Bizim mütəxəssislər tezliklə sizinlə əlaqə saxlayacaqlar. 😊"
- Heç vaxt uydurma məlumat vermə.
${contextService ? `İstifadəçi hazırda "${contextService}" xidmətinə baxır. O, bu xidmət haqqında ətraflı istəyir.` : ""}
${langInstruction}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 7000); // 7 saniyə

  try {
    const response = await axios.post(
      GROQ_API_URL,
      {
        model: "llama3-8b-8192",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.7,
        max_tokens: 400,
      },
      {
        headers: {
          Authorization: `Bearer ${CONFIG.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      }
    );
    clearTimeout(timeoutId);
    let reply = response.data.choices[0].message.content.trim();
    if (reply.length > 1000) reply = reply.substring(0, 1000) + "...";
    return reply;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error("AI xətası:", err.message);
    return null;
  }
}

// ======================== CANLI DƏSTƏK AÇAR SÖZLƏRİ ============
const LIVE_SUPPORT_KEYWORDS = {
  az: ["canlı dəstək", "operator çağır", "operatör çağır", "canli destek", "real dəstək", "insan dəstək", "müştəri xidmətləri", "yardım çağır", "dəstək çağır"],
  ru: ["живая поддержка", "оператор", "позвать оператора", "живой чат", "человек", "поддержка"],
  en: ["live support", "call operator", "human support", "talk to human", "customer service", "support agent", "real person"],
};

function isLiveSupportRequest(text, language) {
  const lower = text.toLowerCase();
  // Əvvəlcə istifadəçinin hazırkı dilində yoxla
  if (LIVE_SUPPORT_KEYWORDS[language] && LIVE_SUPPORT_KEYWORDS[language].some(kw => lower.includes(kw))) {
    return true;
  }
  // Bütün dillərdə yoxla (istifadəçi fərqli dildə yaza bilər)
  for (const lang in LIVE_SUPPORT_KEYWORDS) {
    if (LIVE_SUPPORT_KEYWORDS[lang].some(kw => lower.includes(kw))) {
      return true;
    }
  }
  return false;
}

// ======================== FALLBACK: ƏTRAFLI MƏLUMAT =============
function getDetailedInfo(service, language) {
  const lang = language || "az";
  const details = {
    website: {
      az: "Vebsayt xidmətimizə vizit kartı, korporativ sayt, e-ticarət, restoran portalı və idarəetmə panelləri daxildir. Bütün layihələr mobil uyğun (responsive) hazırlanır, SEO hazırlığı edilir və istənilən ödəniş sistemi inteqrasiya olunur. Layihə bitdikdən sonra 1 ay pulsuz texniki dəstək veririk.",
      ru: "Наши услуги по созданию сайтов включают визитки, корпоративные сайты, интернет-магазины, порталы ресторанов и панели управления. Все проекты адаптивны, SEO-готовы, с интеграцией любых платёжных систем. После завершения проекта предоставляем 1 месяц бесплатной техподдержки.",
      en: "Our website services include business cards, corporate sites, e-commerce, restaurant portals, and dashboards. All projects are fully responsive, SEO-ready, and integrate any payment system. We provide 1 month of free technical support after project completion.",
    },
    mobile: {
      az: "Mobil tətbiqlərimiz həm iOS, həm Android üçün native olaraq hazırlanır. Push bildirişləri, ödəniş sistemləri (Apple Pay, Google Pay, kart), chat, xəritə və digər funksiyaları dəstəkləyirik. Admin panel vasitəsilə tətbiqi idarə etmək mümkündür. Qiymət 1800 AZN-dən başlayır, müddət 4-10 həftədir.",
      ru: "Наши мобильные приложения разрабатываются нативно для iOS и Android. Поддерживаем push-уведомления, платёжные системы, чат, карты и другие функции. Через админ-панель можно управлять приложением. Цена от 1800 AZN, срок 4-10 недель.",
      en: "Our mobile apps are natively developed for both iOS and Android. We support push notifications, payment systems, chat, maps, and other features. An admin panel allows you to manage the app. Price starts from 1800 AZN, timeline 4-10 weeks.",
    },
    erp: {
      az: "ERP/CRM sistemlərimiz tamamilə fərdi hazırlanır. Müştəri idarəsi, anbar, satış, işçi, maliyyə, hesabat modulları daxildir. İstənilən xarici API ilə inteqrasiya edə bilərik. Qiymət 1200 AZN-dən başlayır, müddət 3-8 həftədir.",
      ru: "Наши ERP/CRM системы разрабатываются индивидуально. Включают модули управления клиентами, складом, продажами, сотрудниками, финансами, отчётами. Интегрируем с любыми внешними API. Цена от 1200 AZN, срок 3-8 недель.",
      en: "Our ERP/CRM systems are fully customized. Includes customer management, warehouse, sales, employees, finance, reports modules. We can integrate with any external API. Price starts from 1200 AZN, timeline 3-8 weeks.",
    },
    seo: {
      az: "SEO xidmətimiz açar söz analizi, texniki audit, daxili optimizasiya, link qurma və aylıq hesabatı əhatə edir. Hədəfimiz saytınızı Google-da 1-ci səhifəyə çıxarmaqdır. Qiymət layihəyə görə fərdi, nəticə 1-3 ay ərzində görünür.",
      ru: "Наш SEO-сервис включает анализ ключевых слов, технический аудит, внутреннюю оптимизацию, построение ссылок и ежемесячные отчёты. Наша цель — вывести ваш сайт на первую страницу Google. Цена индивидуальна, результат виден через 1-3 месяца.",
      en: "Our SEO service includes keyword analysis, technical audit, on-page optimization, link building, and monthly reports. Our goal is to bring your site to Google's first page. Price is custom, results visible in 1-3 months.",
    },
    support: {
      az: "Texniki dəstək xidmətimizə mövcud layihələrin təhlükəsizlik yeniləmələri, sürət optimizasiyası, xəta düzəlişləri və yeni funksiyaların əlavə edilməsi daxildir. 7/24 onlayn dəstək veririk. Qiymət işin həcminə görə hesablanır.",
      ru: "Наша техническая поддержка включает обновления безопасности, оптимизацию скорости, исправление ошибок и добавление новых функций в существующие проекты. Мы предоставляем круглосуточную онлайн-поддержку. Цена рассчитывается исходя из объёма работ.",
      en: "Our technical support includes security updates, speed optimization, bug fixes, and adding new features to existing projects. We provide 24/7 online support. Price is calculated based on the scope of work.",
    },
  };
  return details[service]?.[lang] || (language === "az" ? "Bu xidmət haqqında ətraflı məlumat üçün linkə keçin: https://01cs.site/teklif-al.html" : (language === "ru" ? "Подробнее об этой услуге: https://01cs.site/teklif-al.html" : "More details: https://01cs.site/teklif-al.html"));
}

// ======================== ƏSAS CAVAB FUNKSİYASI =================
async function getResponse(userId, text) {
  const originalText = text.trim();
  const lowerText = originalText.toLowerCase();
  const { state, lastService, language, blocked } = getUserState(userId);

  // Əgər istifadəçi bloklanıbsa (canlı dəstəyə yönləndirilib) – cavab vermə
  if (blocked) {
    console.log(`🚫 ${userId} bloklanmışdır, cavab verilmir.`);
    return null;
  }

  // Dil dəyişdirmə
  if (lowerText === "az") {
    setUserState(userId, state, lastService, "az", false);
    return MENUS.az.languageSet + "\n\n" + MENUS.az.main;
  }
  if (lowerText === "ru") {
    setUserState(userId, state, lastService, "ru", false);
    return MENUS.ru.languageSet + "\n\n" + MENUS.ru.main;
  }
  if (lowerText === "en") {
    setUserState(userId, state, lastService, "en", false);
    return MENUS.en.languageSet + "\n\n" + MENUS.en.main;
  }

  // CANLI DƏSTƏK AÇAR SÖZLƏRİ – birbaşa yönləndir
  if (isLiveSupportRequest(originalText, language)) {
    await sendTelegramNotification(userId, originalText);
    setUserState(userId, "blocked", null, language, true); // blokla
    return MENUS[language].liveSupport;
  }

  // Menyu komandaları
  const mainCommands = ["0", "menu", "salam", "start", "hi", "main", "ana menyu", "главное меню", "main menu"];
  if (mainCommands.includes(lowerText)) {
    setUserState(userId, "main", null, language, false);
    return MENUS[language].main;
  }

  // State maşını
  if (state === "main") {
    if (lowerText === "1") { setUserState(userId, "services", null, language, false); return MENUS[language].services; }
    if (lowerText === "2") { setUserState(userId, "about", null, language, false); return MENUS[language].about; }
    if (lowerText === "3") { setUserState(userId, "contact", null, language, false); return MENUS[language].contact; }
    // AI
    const aiReply = await askGroq(originalText, null, language);
    if (aiReply && aiReply.includes("canlı dəstəyə yönləndiririk")) {
      await sendTelegramNotification(userId, originalText);
      setUserState(userId, "blocked", null, language, true);
      return aiReply;
    }
    if (aiReply) return aiReply;
    return MENUS[language].unknown;
  }

  if (state === "services") {
    if (lowerText === "1") { setUserState(userId, "services_sub", "website", language, false); return MENUS[language].website; }
    if (lowerText === "2") { setUserState(userId, "services_sub", "mobile", language, false); return MENUS[language].mobile; }
    if (lowerText === "3") { setUserState(userId, "services_sub", "erp", language, false); return MENUS[language].erp; }
    if (lowerText === "4") { setUserState(userId, "services_sub", "seo", language, false); return MENUS[language].seo; }
    if (lowerText === "5") { setUserState(userId, "services_sub", "support", language, false); return MENUS[language].support; }
    if (lowerText === "0") { setUserState(userId, "main", null, language, false); return MENUS[language].main; }
    // AI
    const aiReply = await askGroq(originalText, null, language);
    if (aiReply && aiReply.includes("canlı dəstəyə yönləndiririk")) {
      await sendTelegramNotification(userId, originalText);
      setUserState(userId, "blocked", null, language, true);
      return aiReply;
    }
    if (aiReply) return aiReply;
    return MENUS[language].services;
  }

  // Əgər services_sub və ya hər hansı dərin menyudadırsa
  if (lowerText === "0") {
    setUserState(userId, "main", null, language, false);
    return MENUS[language].main;
  }

  // Xüsusi olaraq "ətraflı", "daha ətraflı" sorğuları
  const detailedKeywords = ["ətraflı", "daha ətraflı", "ətraflı məlumat", "more info", "подробнее", "more information"];
  if (detailedKeywords.some(kw => lowerText.includes(kw)) && lastService) {
    return getDetailedInfo(lastService, language);
  }

  // Ümumi AI sorğusu
  const aiReply = await askGroq(originalText, lastService, language);
  if (aiReply && aiReply.includes("canlı dəstəyə yönləndiririk")) {
    await sendTelegramNotification(userId, originalText);
    setUserState(userId, "blocked", null, language, true);
    return aiReply;
  }
  if (aiReply) return aiReply;

  // Əgər AI işləmirsə və lastService varsa, yenə də ətraflı məlumat təklif et
  if (lastService && (lowerText.includes("ətraflı") || lowerText.includes("detay") || lowerText.includes("detail"))) {
    return getDetailedInfo(lastService, language);
  }

  setUserState(userId, "main", null, language, false);
  return MENUS[language].main;
}

// ======================== MEDIA GÖNDƏRMƏ ========================
async function sendMediaDM(recipientId, imageUrl, caption = "") {
  try {
    await axios.post(
      "https://graph.instagram.com/v21.0/me/messages",
      {
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl },
          },
          ...(caption && { text: caption }),
        },
      },
      { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
    );
    console.log("🖼️ Media göndərildi.");
  } catch (e) {
    console.error("Media xətası:", e.response?.data?.error?.message || e.message);
  }
}

// ======================== INSTAGRAM API FUNKSİYALARI ============
async function replyToDM(recipientId, message) {
  if (!message) return;
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

async function sendDM(commentId, message) {
  await axios.post(
    "https://graph.instagram.com/v21.0/me/messages",
    { recipient: { comment_id: commentId }, message: { text: message } },
    { params: { access_token: CONFIG.IG_ACCESS_TOKEN } }
  );
}

// ======================== WEBHOOK ===============================
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
        } catch (e) {
          console.log(e.message);
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
        logAnalytics(senderId, "dm", text);

        console.log(`💬 DM: "${text}"`);
        const response = await getResponse(senderId, text);
        if (response) {
          await replyToDM(senderId, response);
        }

        // Media göndərmə nümunəsi (istəsəniz aktiv edin)
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
  res.json(data.slice(-100));
});

app.get("/", (req, res) => res.send("01CS Bot AI + Multilingual + Live Support ✅"));

app.listen(CONFIG.PORT, () => console.log(`🚀 Port ${CONFIG.PORT}`));