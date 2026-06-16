const express = require("express");
const axios = require("axios");
const session = require("express-session");
const fs = require("fs");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "01cs_session_2024",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true }
}));

// ════════════════════════════════════════════════════
// KONFİQURASİYA
// ════════════════════════════════════════════════════
const CONFIG = {
  VERIFY_TOKEN:       process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN:    process.env.IG_ACCESS_TOKEN || "",
  GROQ_API_KEY:       process.env.GROQ_API_KEY || "",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID || "",
  ADMIN_PASSWORD:     process.env.ADMIN_PASSWORD || "admin123",
  PORT:               process.env.PORT || 3000,
};

// Groq başlat
let groq = null;
if (CONFIG.GROQ_API_KEY) {
  groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
  console.log("✅ Groq AI hazırdır");
} else {
  console.log("⚠️ GROQ_API_KEY tapılmadı");
}

// ════════════════════════════════════════════════════
// ANALİTİKA
// ════════════════════════════════════════════════════
const ANALYTICS_FILE = "/tmp/analytics.json";

function logEvent(userId, action, details = "") {
  try {
    let data = [];
    if (fs.existsSync(ANALYTICS_FILE)) {
      data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    }
    data.push({
      userId: String(userId || "unknown").slice(-8),
      action,
      details: String(details || "").slice(0, 150),
      time: new Date().toISOString()
    });
    if (data.length > 2000) data = data.slice(-1500);
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data));
  } catch (e) {}
}

// ════════════════════════════════════════════════════
// TELEGRAM BİLDİRİŞ
// ════════════════════════════════════════════════════
async function notifyTelegram(userId, message, username = "") {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram bildirişi üçün token və ya chat ID təyin edilməyib.");
    return;
  }
  try {
    await axios.post(
      `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: `🔔 CANLI DƏSTƏK TƏLƏBİ\n\n👤 @${username || "istifadəçi"}\n🆔 ${String(userId).slice(-8)}\n💬 ${String(message).slice(0, 300)}`
      }
    );
    console.log("✅ Telegram bildirişi göndərildi");
  } catch (e) {
    console.log("❌ Telegram xətası:", e.message);
  }
}

// ════════════════════════════════════════════════════
// TEKRARİ ÖNLƏMƏ
// ════════════════════════════════════════════════════
const processedIds = new Map();
const processingLocks = new Set();

function isProcessed(id) {
  const now = Date.now();
  for (const [k, v] of processedIds.entries()) {
    if (now - v > 600000) processedIds.delete(k);
  }
  if (processedIds.has(id)) return true;
  processedIds.set(id, now);
  return false;
}

function isLocked(id) { return processingLocks.has(id); }
function lock(id) { processingLocks.add(id); }
function unlock(id) { processingLocks.delete(id); }

// ════════════════════════════════════════════════════
// İSTİFADƏÇİ VƏZİYYƏTLƏRİ
// ════════════════════════════════════════════════════
const users = new Map();

function getUser(userId) {
  const id = String(userId);
  if (!users.has(id)) {
    users.set(id, {
      state: "main",
      language: "az",
      lastService: null,
      blocked: false,
      blockedSince: null,
      lastActive: Date.now(),
      messageCount: 0,
      history: []
    });
  }
  const u = users.get(id);
  
  // 30 dəqiqə sessiya timeout – blocked flag-ı da sıfırla
  if (Date.now() - u.lastActive > 1800000) {
    u.state = "main";
    u.history = [];
    u.blocked = false;
    u.blockedSince = null;
  }
  
  // Bloklama müddəti 30 dəqiqədirsə, avtomatik aç
  if (u.blocked && u.blockedSince && (Date.now() - u.blockedSince > 1800000)) {
    u.blocked = false;
    u.blockedSince = null;
    u.state = "main";
    console.log(`🔓 İstifadəçi ${id} blokdan avtomatik açıldı`);
  }
  
  u.lastActive = Date.now();
  u.messageCount++;
  return u;
}

function setState(userId, updates) {
  const u = getUser(userId);
  Object.assign(u, updates);
}

function addHistory(userId, role, content) {
  const u = getUser(userId);
  u.history.push({ role, content });
  if (u.history.length > 10) u.history = u.history.slice(-10);
}

// ════════════════════════════════════════════════════
// GROQ AI - TƏKMİLLƏŞDİRİLMİŞ PROMPT
// ════════════════════════════════════════════════════
const SYSTEM_PROMPT = `Sən 01 Code Studio şirkətinin rəsmi Instagram köməkçisisən.

ŞİRKƏT HAQQINDA:
- Ad: 01 Code Studio
- Sayt: www.01cs.site | Instagram: @01cs.az
- WhatsApp: +994 10 717 20 34 | Email: info@01cs.site
- İş saatları: 7/24

XİDMƏTLƏR VƏ QİYMƏTLƏR:
1. Vebsayt: Vizit 520-1300 AZN, Korporativ 1300-4400 AZN, E-ticarət 2600-13000 AZN
2. Mobil tətbiq: Sadə 2600-6000 AZN, Orta 6000-15500 AZN, Mürəkkəb 13000-43000 AZN
3. ERP/CRM: 7000-43000 AZN (layihəyə görə)
4. SEO: 450-1800 AZN/ay
5. Texniki dəstək: 250-1500 AZN/saat (və ya abunə)

NİTQ ETİKETİ VƏ ÜSLUB:
- Salamlaşma: "Salam", "Hörmətli", "Siz" ilə müraciət
- Sağollaşma: "Sağ olun", "Sağ ol", "Xoş oldu" (səhvən "xoş gəldi" demə)
- Təşəkkürə cavab: "Buyurun", "Xahiş edirəm", "Bizim üçün şərəfdir"
- "Bizimlə" – birgəlik halı (məs: "bizimlə əlaqə saxlayın")
- "Bizə" – yönlük halı (məs: "bizə yazın")
- Cümlələrdə halları düzgün işlət

DAVRANIŞ:
- Təbii, peşəkar, mehriban danış
- Hər cavabda 1-2 emoji istifadə et
- Qısa suala qısa, ətraflı suala ətraflı cavab ver
- Eyni fikri təkrar etmə
- Uydurma məlumat vermə

ƏLAQƏSİZ SUALLAR: şirkətlə əlaqəsi olmayan mövzularda:
"Bu mövzu mənim ixtisasım xaricindədir. Sizə 01 Code Studio xidmətləri barədə kömək edə bilərəm 😊"

CANLI DƏSTƏK: istifadəçi "operator", "canlı dəstək", "insan" və s. yazdıqda cavab:
"Sizi dərhal canlı dəstəyə yönləndiririk. Mütəxəssisimiz ən qısa zamanda sizinlə əlaqə saxlayacaq 🙏"`;

async function askAI(userId, message, lastService) {
  if (!groq) return null;

  const u = getUser(userId);
  const lang = u.language || "az";

  const langNote = lang === "ru"
    ? "Müştəri Rusca yazıb. Cavabı Rusca ver."
    : lang === "en"
    ? "The user wrote in English. Reply in English."
    : "";

  const serviceNote = lastService
    ? `İstifadəçi hazırda "${lastService}" xidmətinə baxır. Sual bu xidmətlə bağlıdırsa, ətraflı cavabla.`
    : "";

  const systemWithContext = `${SYSTEM_PROMPT}${langNote ? "\n\n" + langNote : ""}${serviceNote ? "\n\n" + serviceNote : ""}`;

  const messages = [
    { role: "system", content: systemWithContext },
    ...u.history.slice(-6),
    { role: "user", content: message }
  ];

  try {
    const res = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages,
      temperature: 0.4,
      max_tokens: 500,
    });

    const reply = res.choices[0]?.message?.content?.trim();
    if (!reply) {
      console.log("Groq boş cavab qaytardı");
      return null;
    }

    addHistory(userId, "user", message);
    addHistory(userId, "assistant", reply);

    return reply;
  } catch (e) {
    console.log("Groq xətası:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════
// CANLI DƏSTƏK AÇAR SÖZLƏRİ (GENİŞLƏNDİRİLMİŞ)
// ════════════════════════════════════════════════════
const LIVE_WORDS = [
  "canlı dəstək", "canli destek", "canlı destek",
  "operator", "operatör",
  "insan dəstək", "insan destek",
  "müştəri xidmətləri", "musteri xidmetleri",
  "canlı yardım", "canli yardim",
  "canlı dəstəyə yönləndir", "canlı dəstəyə yonlendir",
  "canli destege yonlendir",
  "живая поддержка", "оператор", "живой чат",
  "live support", "live chat", "human support", "talk to human",
  "dəstək", "destek", "yardım", "yardim", "kömək", "komek"
];

function isLiveRequest(text) {
  const t = text.toLowerCase();
  return LIVE_WORDS.some(w => t.includes(w));
}

// ════════════════════════════════════════════════════
// MENYU MƏTNLƏRİ (az, ru, en)
// ════════════════════════════════════════════════════
const MENU = {
  az: {
    main: `Salam! 01 Code Studio-ya xoş gəlmisiniz 👋

Sizə necə kömək edə bilərəm?

1️⃣ Xidmətlərimiz
2️⃣ Haqqımızda
3️⃣ Əlaqə

İstənilən sualınızı da birbaşa yaza bilərsiniz.
Dil dəyişmək üçün: az / ru / en`,

    services: `Hansı xidmətlə maraqlanırsınız? 😊

1️⃣ Vebsayt hazırlanması
2️⃣ Mobil tətbiq
3️⃣ ERP / CRM / Avtomatlaşdırma
4️⃣ SEO optimizasiyası
5️⃣ Texniki dəstək

0️⃣ Ana menyuya qayıt`,

    about: `01 Code Studio haqqında 🏢

Biz Azərbaycanda bizneslərin rəqəmsal dünyada güclü şəkildə təmsil olunması üçün çalışan peşəkar IT şirkətiyik.

Vebsayt, mobil tətbiq, ERP sistemi, SEO və texniki dəstək xidmətləri göstəririk. Hər layihəyə fərdi yanaşır, müştərilərimizi layihə bitdikdən sonra da tək qoymuruq.

🌐 www.01cs.site
📸 @01cs.az
📞 +994 10 717 20 34

0️⃣ Ana menyuya qayıt`,

    contact: `Bizimlə əlaqə 📞

📞 Telefon / WhatsApp: +994 10 717 20 34
💬 WhatsApp linki: wa.me/994107172034
📧 Email: info@01cs.site

🕐 İş saatları: 7/24

0️⃣ Ana menyuya qayıt`,

    website: `💻 Vebsayt Hazırlanması

Xidmət növləri:
• Vizit / Landing page — 520–1300 AZN (7–14 gün)
• Korporativ sayt — 1300–4400 AZN (30–60 gün)
• E-ticarət saytı — 2600–13000 AZN (60–120 gün)

Hər layihəyə daxildir:
• 100% mobil uyğun dizayn
• SEO hazırlığı
• Admin panel
• Ödəniş sistemi inteqrasiyası
• 1 ay pulsuz texniki dəstək

👉 https://01cs.site/teklif-al.html
0️⃣ Xidmətlərə qayıt`,

    mobile: `📱 Mobil Tətbiq Hazırlanması

Səviyyələr:
• Sadə — 2600–6000 AZN (30–45 gün)
• Orta — 6000–15500 AZN (60–90 gün)
• Mürəkkəb — 13000–43000 AZN (90–180 gün)

Daxildir: iOS & Android, push, ödəniş, GPS, chat, admin panel.

👉 https://01cs.site/teklif-al.html
0️⃣ Xidmətlərə qayıt`,

    erp: `⚙️ ERP / CRM / Avtomatlaşdırma

Qiymət: 7000–43000 AZN
Müddət: 3–8 həftə
Modullar: müştəri, anbar, satış, maliyyə, hesabat.

👉 https://01cs.site/teklif-al.html
0️⃣ Xidmətlərə qayıt`,

    seo: `🔍 SEO Optimizasiyası

Qiymət: 450–1800 AZN/ay
Nəticə: 1–3 ay ərzində

Daxildir: açar söz, audit, optimizasiya, linklər, hesabat.

👉 https://01cs.site/teklif-al.html
0️⃣ Xidmətlərə qayıt`,

    support: `🛠️ Texniki Dəstək

Qiymət: 250–1500 AZN/saat (və ya abunə)
Cavab müddəti: 1–2 saat

Daxildir: təhlükəsizlik, sürət, xəta düzəlişi, yeni funksiyalar, 7/24.

👉 https://01cs.site/teklif-al.html
0️⃣ Xidmətlərə qayıt`,

    live: `Sizi dərhal canlı dəstəyə yönləndiririk 🙏

Mütəxəssisimiz ən qısa zamanda sizinlə əlaqə saxlayacaq.

📞 +994 10 717 20 34
💬 wa.me/994107172034`,
  },

  ru: {
    main: `Добро пожаловать в 01 Code Studio! 👋

Чем могу помочь?

1️⃣ Наши услуги
2️⃣ О нас
3️⃣ Контакты

Также можете написать вопрос напрямую.
Язык: az / ru / en`,

    services: `Какая услуга вас интересует? 😊

1️⃣ Разработка сайта
2️⃣ Мобильное приложение
3️⃣ ERP / CRM / Автоматизация
4️⃣ SEO оптимизация
5️⃣ Техническая поддержка

0️⃣ Главное меню`,

    about: `О компании 01 Code Studio 🏢

Мы — профессиональная IT-компания в Азербайджане. Разрабатываем сайты, мобильные приложения, ERP системы и предоставляем полную цифровую поддержку бизнесу.

🌐 www.01cs.site
📞 +994 10 717 20 34

0️⃣ Главное меню`,

    contact: `Контакты 📞

📞 Телефон / WhatsApp: +994 10 717 20 34
💬 wa.me/994107172034
📧 info@01cs.site
🕐 Работаем 7/24

0️⃣ Главное меню`,

    website: `💻 Разработка веб-сайтов

• Визитка: 520–1300 AZN (7–14 дней)
• Корпоративный: 1300–4400 AZN (30–60 дней)
• Интернет-магазин: 2600–13000 AZN (60–120 дней)

Включено: адаптив, SEO, админка, оплата, 1 месяц поддержки.

👉 https://01cs.site/teklif-al.html
0️⃣ Назад к услугам`,

    mobile: `📱 Мобильные приложения

• Простое: 2600–6000 AZN (30–45 дней)
• Среднее: 6000–15500 AZN (60–90 дней)
• Сложное: 13000–43000 AZN (90–180 дней)

iOS & Android, push, оплата, GPS, чат, админка.

👉 https://01cs.site/teklif-al.html
0️⃣ Назад к услугам`,

    erp: `⚙️ ERP / CRM / Автоматизация

Цена: 7000–43000 AZN (3–8 недель)
Модули: клиенты, склад, продажи, финансы, отчёты.

👉 https://01cs.site/teklif-al.html
0️⃣ Назад к услугам`,

    seo: `🔍 SEO оптимизация

450–1800 AZN/мес. Результат за 1–3 месяца.
Аудит, оптимизация, ссылки, ежемесячный отчёт.

👉 https://01cs.site/teklif-al.html
0️⃣ Назад к услугам`,

    support: `🛠️ Техническая поддержка

250–1500 AZN/час или абонемент. Ответ за 1–2 часа.
Безопасность, скорость, исправление ошибок, 7/24.

👉 https://01cs.site/teklif-al.html
0️⃣ Назад к услугам`,

    live: `Соединяем с оператором... 🙏

Наш специалист свяжется с вами в ближайшее время.
📞 +994 10 717 20 34`,
  },

  en: {
    main: `Welcome to 01 Code Studio! 👋

How can I help you?

1️⃣ Our Services
2️⃣ About Us
3️⃣ Contact

You can also ask any question directly.
Language: az / ru / en`,

    services: `Which service interests you? 😊

1️⃣ Website Development
2️⃣ Mobile App
3️⃣ ERP / CRM / Automation
4️⃣ SEO Optimization
5️⃣ Technical Support

0️⃣ Main Menu`,

    about: `About 01 Code Studio 🏢

We are a professional IT company in Azerbaijan. We develop websites, mobile apps, ERP systems and provide full digital support.

🌐 www.01cs.site
📞 +994 10 717 20 34

0️⃣ Main Menu`,

    contact: `Contact Us 📞

📞 Phone / WhatsApp: +994 10 717 20 34
💬 wa.me/994107172034
📧 info@01cs.site
🕐 Available 7/24

0️⃣ Main Menu`,

    website: `💻 Website Development

• Landing: 520–1300 AZN (7–14 days)
• Corporate: 1300–4400 AZN (30–60 days)
• E-commerce: 2600–13000 AZN (60–120 days)

Includes: responsive, SEO, admin, payments, 1 month support.

👉 https://01cs.site/teklif-al.html
0️⃣ Back to Services`,

    mobile: `📱 Mobile App Development

• Simple: 2600–6000 AZN (30–45 days)
• Medium: 6000–15500 AZN (60–90 days)
• Complex: 13000–43000 AZN (90–180 days)

iOS & Android, push, payments, GPS, chat, admin.

👉 https://01cs.site/teklif-al.html
0️⃣ Back to Services`,

    erp: `⚙️ ERP / CRM / Automation

Price: 7000–43000 AZN (3–8 weeks)
Modules: customers, warehouse, sales, finance, reports.

👉 https://01cs.site/teklif-al.html
0️⃣ Back to Services`,

    seo: `🔍 SEO Optimization

450–1800 AZN/month. Results in 1–3 months.
Keyword research, audit, on-page, links, monthly reports.

👉 https://01cs.site/teklif-al.html
0️⃣ Back to Services`,

    support: `🛠️ Technical Support

250–1500 AZN/hour or subscription. 1–2 hour response.
Security, speed, bug fixes, new features, 24/7.

👉 https://01cs.site/teklif-al.html
0️⃣ Back to Services`,

    live: `Connecting you to live support... 🙏

Our specialist will contact you shortly.
📞 +994 10 717 20 34`,
  }
};

// ════════════════════════════════════════════════════
// ƏSAS CAVAB MƏNTİQİ
// ════════════════════════════════════════════════════
async function getReply(userId, text, username = "") {
  const t = text.trim();
  const lower = t.toLowerCase();
  const u = getUser(userId);

  if (u.blocked) {
    console.log(`🚫 İstifadəçi ${userId} bloklanıb, cavab verilmir`);
    return null;
  }

  // Dil dəyişmə
  if (lower === "az") { setState(userId, { language: "az", state: "main", history: [] }); return MENU.az.main; }
  if (lower === "ru") { setState(userId, { language: "ru", state: "main", history: [] }); return MENU.ru.main; }
  if (lower === "en") { setState(userId, { language: "en", state: "main", history: [] }); return MENU.en.main; }

  const lang = u.language || "az";
  const m = MENU[lang];

  // Canlı dəstək
  if (isLiveRequest(t)) {
    logEvent(userId, "live_support", t);
    await notifyTelegram(userId, t, username);
    setState(userId, { blocked: true, blockedSince: Date.now() });
    console.log(`🔒 İstifadəçi ${userId} canlı dəstək üçün bloklandı`);
    return m.live;
  }

  // Ana menyuya qayıt
  const backWords = ["0", "menu", "salam", "start", "hi", "hello", "back", "назад", "geri"];
  if (backWords.includes(lower)) {
    setState(userId, { state: "main" });
    return m.main;
  }

  // ── ANA MENYU ──────────────────────────────────────
  if (u.state === "main") {
    if (lower === "1") { setState(userId, { state: "services" }); return m.services; }
    if (lower === "2") { setState(userId, { state: "about" }); return m.about; }
    if (lower === "3") { setState(userId, { state: "contact" }); return m.contact; }

    const ai = await askAI(userId, t, null);
    return ai || "Başa düşmədim, bir az daha aydın yaza bilərsiniz? 😊";
  }

  // ── XİDMƏTLƏR MENYUSU ─────────────────────────────
  if (u.state === "services") {
    if (lower === "1") { setState(userId, { state: "service_detail", lastService: "website" }); return m.website; }
    if (lower === "2") { setState(userId, { state: "service_detail", lastService: "mobile" }); return m.mobile; }
    if (lower === "3") { setState(userId, { state: "service_detail", lastService: "erp" }); return m.erp; }
    if (lower === "4") { setState(userId, { state: "service_detail", lastService: "seo" }); return m.seo; }
    if (lower === "5") { setState(userId, { state: "service_detail", lastService: "support" }); return m.support; }

    const ai = await askAI(userId, t, null);
    return ai || m.services;
  }

  // ── XİDMƏT DETALİ ──────────────────────────────────
  if (u.state === "service_detail") {
    const ai = await askAI(userId, t, u.lastService);
    return ai || "Başa düşmədim, bir az daha aydın yaza bilərsiniz? 😊";
  }

  // ── HAQQIMIZDA / ƏLAQƏ ────────────────────────────
  if (u.state === "about" || u.state === "contact") {
    const ai = await askAI(userId, t, null);
    return ai || m.main;
  }

  // Default
  setState(userId, { state: "main" });
  return m.main;
}

// ════════════════════════════════════════════════════
// INSTAGRAM API
// ════════════════════════════════════════════════════
async function igRequest(url, data) {
  return axios.post(url, data, {
    params: { access_token: CONFIG.IG_ACCESS_TOKEN }
  });
}

async function commentReply(commentId, message) {
  try {
    await igRequest(`https://graph.instagram.com/v21.0/${commentId}/replies`, { message });
  } catch (e) {
    console.log("Şərh cavabı xətası:", e.response?.data?.error?.message || e.message);
  }
}

async function sendDM(commentId, message) {
  try {
    await igRequest("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { comment_id: commentId },
      message: { text: message }
    });
  } catch (e) {
    console.log("DM xətası:", e.response?.data?.error?.message || e.message);
    try {
      await igRequest(`https://graph.instagram.com/v21.0/${commentId}/replies`, {
        message: "Sizə DM göndərmək mümkün olmadı. Bizimlə əlaqə saxlayın: +994 10 717 20 34"
      });
    } catch {}
  }
}

async function replyDM(recipientId, message) {
  try {
    await igRequest("https://graph.instagram.com/v21.0/me/messages", {
      recipient: { id: recipientId },
      message: { text: message }
    });
  } catch (e) {
    console.log("DM cavabı xətası:", e.response?.data?.error?.message || e.message);
  }
}

// ════════════════════════════════════════════════════
// WEBHOOK
// ════════════════════════════════════════════════════
app.get("/webhook", (req, res) => {
  const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
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

      // ── Şərhlər ───────────────────────────────────
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;
        const c = change.value;
        if (!c?.id) continue;

        if (isLocked(c.id) || isProcessed(c.id)) {
          console.log(`⏭️ Şərh keçildi: ${c.id}`);
          continue;
        }

        lock(c.id);
        try {
          const fromUser = c.from?.username || "";
          console.log(`📩 Şərh: @${fromUser}`);
          logEvent(c.from?.id || c.id, "comment", c.text || "");

          await commentReply(c.id, "Şərhiniz DM-də cavablandırıldı ✔️");
          await sendDM(c.id, MENU.az.main);
          console.log(`✉️ DM göndərildi → @${fromUser}`);
        } finally {
          unlock(c.id);
        }
      }

      // ── DM mesajları ───────────────────────────────
      for (const msg of entry.messaging || []) {
        const senderId = msg.sender?.id;
        const text = msg.message?.text;
        const msgId = msg.message?.mid;

        if (!text || !senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isLocked(msgId) || isProcessed(msgId)) {
          console.log(`⏭️ DM keçildi: ${msgId}`);
          continue;
        }

        lock(msgId);
        try {
          const username = msg.sender?.username || "";
          console.log(`💬 DM @${username}: "${text.slice(0, 60)}"`);
          logEvent(senderId, "dm", text);

          const reply = await getReply(senderId, text, username);
          if (reply) {
            await replyDM(senderId, reply);
            console.log("✅ Cavablandı");
          } else {
            console.log("⚠️ Cavab alınmadı, fallback göndərilir");
            await replyDM(senderId, "Başa düşmədim, bir az daha aydın yaza bilərsiniz? 😊");
          }
        } finally {
          unlock(msgId);
        }
      }
    }
  } catch (e) {
    console.error("❌ Webhook xətası:", e.message);
  }
});

// ════════════════════════════════════════════════════
// ADMİN PANELİ
// ════════════════════════════════════════════════════
function adminAuth(req, res, next) {
  if (req.session?.admin) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — 01CS Bot</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:Arial,sans-serif;background:#0a0a1a;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{background:#1a1a2e;padding:40px;border-radius:16px;width:320px;text-align:center}
  h2{color:#4f8ef7;margin-bottom:24px;font-size:20px}
  input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#0a0a1a;color:#fff;margin-bottom:16px;font-size:15px}
  button{width:100%;padding:12px;background:#4f8ef7;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}
  button:hover{background:#3a7de0}
  .logo{font-size:28px;margin-bottom:8px}
</style></head>
<body><div class="box">
  <div class="logo">🤖</div>
  <h2>01CS Bot Admin</h2>
  <form method="post" action="/admin/login">
    <input type="password" name="pwd" placeholder="Şifrə" required autofocus>
    <button type="submit">Daxil ol</button>
  </form>
</div></body></html>`);
});

app.post("/admin/login", express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.pwd === CONFIG.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.redirect("/admin");
  } else {
    res.send(`<script>alert("Yanlış şifrə!");history.back();</script>`);
  }
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/admin/login");
});

app.get("/admin", adminAuth, (req, res) => {
  let analytics = [];
  try {
    if (fs.existsSync(ANALYTICS_FILE)) {
      analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    }
  } catch {}

  const total = analytics.length;
  const unique = new Set(analytics.map(a => a.userId)).size;
  const comments = analytics.filter(a => a.action === "comment").length;
  const dms = analytics.filter(a => a.action === "dm").length;
  const liveReqs = analytics.filter(a => a.action === "live_support").length;
  const activeUsers = [...users.values()].filter(u => !u.blocked).length;
  const blockedUsers = [...users.values()].filter(u => u.blocked).length;
  const last30 = analytics.slice(-30).reverse();

  res.send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin Panel — 01CS Bot</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#0d0d1a;color:#e0e0e0;padding:16px}
  h1{color:#4f8ef7;font-size:20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:20px}
  .card{background:#1a1a2e;border-radius:10px;padding:14px;text-align:center}
  .card .n{font-size:28px;font-weight:700;color:#4f8ef7}
  .card .l{font-size:11px;color:#888;margin-top:4px}
  .section{background:#1a1a2e;border-radius:10px;padding:16px;margin-bottom:16px;overflow-x:auto}
  .section h2{font-size:14px;color:#aaa;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid #2a2a3e}
  table{width:100%;border-collapse:collapse;font-size:12px;min-width:500px}
  th{color:#4f8ef7;padding:8px 6px;text-align:left;font-weight:600;white-space:nowrap}
  td{padding:8px 6px;border-bottom:1px solid #1e1e2e;color:#ccc}
  .badge{padding:2px 7px;border-radius:20px;font-size:10px;font-weight:600}
  .badge.comment{background:#1e3a5f;color:#4f8ef7}
  .badge.dm{background:#1e4a2e;color:#4fc87f}
  .badge.live_support{background:#4a1e1e;color:#f74f4f}
  .btn{background:#4f8ef7;color:#fff;padding:5px 10px;border-radius:6px;text-decoration:none;font-size:11px;white-space:nowrap}
  .logout{background:#2a2a3e;color:#aaa;padding:6px 12px;border-radius:6px;text-decoration:none;font-size:13px}
</style></head>
<body>
<h1>🤖 01CS Bot Admin <a href="/admin/logout" class="logout">Çıxış</a></h1>

<div class="cards">
  <div class="card"><div class="n">${total}</div><div class="l">Ümumi hadisə</div></div>
  <div class="card"><div class="n">${unique}</div><div class="l">Unikal istifadəçi</div></div>
  <div class="card"><div class="n">${comments}</div><div class="l">Şərh</div></div>
  <div class="card"><div class="n">${dms}</div><div class="l">DM mesaj</div></div>
  <div class="card"><div class="n">${liveReqs}</div><div class="l">Canlı dəstək</div></div>
  <div class="card"><div class="n">${activeUsers}</div><div class="l">Aktiv sessiya</div></div>
  <div class="card"><div class="n">${blockedUsers}</div><div class="l">Canlı dəstəkdə</div></div>
</div>

<div class="section">
  <h2>Son 30 hadisə</h2>
  <table>
    <tr><th>Vaxt</th><th>İstifadəçi</th><th>Tip</th><th>Məzmun</th></tr>
    ${last30.map(e => `
    <tr>
      <td style="white-space:nowrap">${new Date(e.time).toLocaleString("az")}</td>
      <td>${e.userId}</td>
      <td><span class="badge ${e.action}">${e.action}</span></td>
      <td>${String(e.details || "").slice(0, 80)}</td>
    </tr>`).join("")}
  </table>
</div>

<div class="section">
  <h2>Aktiv sessiyalar</h2>
  <table>
    <tr><th>ID</th><th>Vəziyyət</th><th>Son xidmət</th><th>Dil</th><th>Mesaj</th><th>Status</th><th></th></tr>
    ${[...users.entries()].map(([id, u]) => `
    <tr>
      <td>${String(id).slice(-8)}</td>
      <td>${u.state}</td>
      <td>${u.lastService || "—"}</td>
      <td>${u.language}</td>
      <td>${u.messageCount}</td>
      <td>${u.blocked ? "🔴 Canlı dəstəkdə" : "🟢 Aktiv"}</td>
      <td>${u.blocked ? `<a href="/admin/unblock/${id}" class="btn">Bitir</a>` : ""}</td>
    </tr>`).join("")}
  </table>
</div>
</body></html>`);
});

app.get("/admin/unblock/:id", adminAuth, (req, res) => {
  const u = users.get(req.params.id);
  if (u) { u.blocked = false; u.blockedSince = null; u.state = "main"; }
  res.redirect("/admin");
});

// ════════════════════════════════════════════════════
// SERVER
// ════════════════════════════════════════════════════
app.get("/", (req, res) => res.send("01CS Instagram Bot ✅ işləyir"));

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 01CS Bot port ${CONFIG.PORT}-də başladı`);
  console.log(`📊 Admin: /admin (şifrə: ${CONFIG.ADMIN_PASSWORD})`);
  console.log(`🤖 Groq AI: ${groq ? "aktiv" : "deaktiv"}`);
  console.log(`📨 Telegram bildirişi: ${CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID ? "aktiv" : "deaktiv"}`);
});