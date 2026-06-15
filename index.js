const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const session = require("express-session");
const fs = require("fs");
const Groq = require("groq-sdk");

const app = express();
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "01cs_secret_key",
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // HTTPS varsa true edin
}));

// ======================== KONFİQURASİYA ========================
const CONFIG = {
  VERIFY_TOKEN: process.env.VERIFY_TOKEN || "01csigbot_secret",
  IG_ACCESS_TOKEN: process.env.IG_ACCESS_TOKEN,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "admin123",
  PORT: process.env.PORT || 3000,
};

let groq = null;
if (CONFIG.GROQ_API_KEY) groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });

// ======================== ANALİTİKA ============================
const ANALYTICS_FILE = "/tmp/analytics.json";
function logAnalytics(userId, action, details = "") {
  try {
    let data = [];
    if (fs.existsSync(ANALYTICS_FILE)) {
      data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    }
    data.push({ userId, action, details, timestamp: new Date().toISOString() });
    if (data.length > 2000) data = data.slice(-1500);
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

// ======================== TELEGRAM BİLDİRİŞİ ===================
async function sendTelegramNotification(userId, userMessage, username = "istifadəçi") {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return;
  const text = `🆘 *CANLI DƏSTƏK TƏLƏBİ*\n\n👤 İstifadəçi: @${username}\n🆔 ID: ${userId}\n💬 Mesaj: ${userMessage.substring(0, 200)}`;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
    });
  } catch (e) {}
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
  const updated = { ...existing, ...updates, lastActive: Date.now() };
  userStates.set(userId, updated);
}

// ======================== QİYMƏT SİYAHISI =================
const PRICING = {
  website: {
    vizit: { min: 520, max: 1300, avg: 850, duration: "7-14 gün", desc: "Vizit kart / Landing" },
    korporativ: { min: 1300, max: 4400, avg: 2800, duration: "30-60 gün", desc: "Korporativ sayt" },
    ecommerce: { min: 2600, max: 13000, avg: 7800, duration: "60-120 gün", desc: "E-ticarət" }
  },
  mobile: {
    simple: { min: 2600, max: 6000, avg: 4300, duration: "30-45 gün", desc: "Sadə app" },
    medium: { min: 6000, max: 15500, avg: 10500, duration: "60-90 gün", desc: "Orta app" },
    complex: { min: 13000, max: 43000, avg: 28000, duration: "90-180 gün", desc: "Mürəkkəb app" }
  },
  erp: { standard: { min: 7000, max: 43000, avg: 25000, duration: "Layihəyə görə", desc: "ERP/CRM" } },
  seo: { monthly: { min: 450, max: 1800, avg: 1100, duration: "Aylıq", desc: "SEO" } },
  support: { hourly: { min: 250, max: 1500, avg: 800, duration: "Müqavilə", desc: "Texniki dəstək" } }
};
function getPriceQuote(service, type = "medium") {
  let data = null;
  if (service === "website") data = PRICING.website[type] || PRICING.website.vizit;
  else if (service === "mobile") data = PRICING.mobile[type] || PRICING.mobile.simple;
  else if (service === "erp") data = PRICING.erp.standard;
  else if (service === "seo") data = PRICING.seo.monthly;
  else if (service === "support") data = PRICING.support.hourly;
  if (!data) return null;
  return { ...data, details: `💰 ${data.min}-${data.max} AZN (ort. ${data.avg}) | ⏱ ${data.duration}` };
}

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

// ======================== İNTERNET AXTARIŞ =================
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

// ======================== AI SORĞUSU =================
async function askAI(prompt, contextService = null, language = "az") {
  if (!groq) return null;
  const siteInfo = await scrape01csSite();
  const webResults = await webSearch(`${contextService || "vebsayt"} qiymət`);
  let market = "";
  if (webResults.length) market = "\n\nBazar məlumatları:\n" + webResults.map(r => `- ${r.title}`).join("\n");
  const system = `Sən 01 Code Studio-nun köməkçisisən. Məlumat: ${siteInfo?.fullText?.substring(0,500) || ""}
Cavab qaydaları: 4-5 cümlə, faydalı. Qiymət təkliflərində öz siyahımızdan istifadə et. Əlaqəsiz suallarda "Sizi canlı dəstəyə yönləndiririk..." yaz.
${contextService ? `İstifadəçi ${contextService} xidmətinə baxır.` : ""}
Dil: ${language === "az" ? "Azərbaycanca" : language === "ru" ? "Rusca" : "İngiliscə"}${market}`;
  try {
    const response = await groq.chat.completions.create({
      model: "llama3-70b-8192",
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 500,
    });
    return response.choices[0].message.content.trim();
  } catch (e) { return null; }
}

// ======================== DETALLI INFO =================
function getDetailedInfo(service, lang, level) {
  const base = {
    website: "Vebsayt xidmətimiz vizit, korporativ və e-ticarət saytlarını əhatə edir. Hamısı mobil uyğun, SEO hazırlıqlıdır.",
    mobile: "Mobil tətbiqlər native iOS/Android, push bildiriş, ödəniş, chat funksiyaları ilə təchiz olunur.",
    erp: "ERP/CRM sistemləri tam fərdi, anbar, satış, müştəri, maliyyə modulları.",
    seo: "SEO xidməti açar söz analizi, texniki audit, backlink, aylıq hesabat.",
    support: "Texniki dəstək 7/24 online, təhlükəsizlik yeniləmələri, sürət optimizasiyası."
  };
  let msg = base[service] || "";
  if (level >= 2) msg += " Əlavə olaraq, layihəniz üçün 1 ay pulsuz test dəstəyi.";
  if (level >= 3) msg += " Dəqiq təklif üçün linkə keçin: https://01cs.site/teklif-al.html";
  return msg;
}

// ======================== CANLI DƏSTƏK KEYWORDS =================
const LIVE_KEYWORDS = {
  az: ["canlı dəstək", "operator çağır", "insan dəstək"],
  ru: ["живая поддержка", "оператор"],
  en: ["live support", "call operator"]
};
function isLiveRequest(text) {
  const lower = text.toLowerCase();
  for (const arr of Object.values(LIVE_KEYWORDS)) {
    if (arr.some(kw => lower.includes(kw))) return true;
  }
  return false;
}

// ======================== MENYULAR =================
const MENUS = {
  az: {
    main: "Salam! 👋\n1️⃣ Xidmətlər\n2️⃣ Haqqımızda\n3️⃣ Əlaqə\nDil: az, ru, en",
    services: "1️⃣ Vebsayt\n2️⃣ Mobil App\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyu",
    about: "01 Code Studio — proqram həlləri. 🌐 www.01cs.site\n0️⃣ Ana menyu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0️⃣ Ana menyu",
    website: `💻 Vebsayt:\n${getPriceQuote("website","vizit").details}\n${getPriceQuote("website","korporativ").details}\n${getPriceQuote("website","ecommerce").details}\n0️⃣ Xidmətlərə qayıt`,
    mobile: `📱 Mobil:\n${getPriceQuote("mobile","simple").details}\n${getPriceQuote("mobile","medium").details}\n${getPriceQuote("mobile","complex").details}\n0️⃣ Xidmətlərə qayıt`,
    erp: `⚙️ ERP:\n${getPriceQuote("erp","standard").details}\n0️⃣ Xidmətlərə qayıt`,
    seo: `🔍 SEO:\n${getPriceQuote("seo","monthly").details}\n0️⃣ Xidmətlərə qayıt`,
    support: `🛠️ Dəstək:\n${getPriceQuote("support","hourly").details}\n0️⃣ Xidmətlərə qayıt`,
    liveSupport: "Sizi canlı dəstəyə yönləndiririk. 😊"
  },
  ru: { main: "Добро пожаловать!\n1️⃣ Услуги\n2️⃣ О нас\n3️⃣ Контакты\nЯзык: az, ru, en", services: "1️⃣ Сайт\n2️⃣ Приложение\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Поддержка\n0️⃣ Главное меню", about: "01 Code Studio — IT-решения.\n0️⃣ Главное меню", contact: "📧 info@01cs.site\n💬 wa.me/994107172034", website: "💻 Сайт: от 520 AZN\n0️⃣ Назад", mobile: "📱 Приложение: от 2600 AZN", erp: "⚙️ ERP: от 7000 AZN", seo: "🔍 SEO: от 450 AZN/мес", support: "🛠️ Поддержка: от 250 AZN", liveSupport: "Перенаправляем в поддержку." },
  en: { main: "Welcome!\n1️⃣ Services\n2️⃣ About\n3️⃣ Contact\nLanguage: az, ru, en", services: "1️⃣ Website\n2️⃣ App\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Support\n0️⃣ Main menu", about: "01 Code Studio — software solutions.\n0️⃣ Main menu", contact: "📧 info@01cs.site\n💬 wa.me/994107172034", website: "💻 Website: from 520 AZN\n0️⃣ Back", mobile: "📱 App: from 2600 AZN", erp: "⚙️ ERP: from 7000 AZN", seo: "🔍 SEO: from 450 AZN/mo", support: "🛠️ Support: from 250 AZN", liveSupport: "Redirecting to live support." }
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
    if (lower === "1") { setUserState(userId, { state: "services" }); return MENUS[language].services; }
    if (lower === "2") { setUserState(userId, { state: "about" }); return MENUS[language].about; }
    if (lower === "3") { setUserState(userId, { state: "contact" }); return MENUS[language].contact; }
    const ai = await askAI(text, null, language);
    if (ai && ai.includes("canlı dəstəyə")) { await sendTelegramNotification(userId, text, username); setUserState(userId, { blocked: true }); return ai; }
    return ai || MENUS[language].main;
  }

  if (state === "services") {
    if (lower === "1") { setUserState(userId, { state: "services_sub", lastService: "website" }); return MENUS[language].website; }
    if (lower === "2") { setUserState(userId, { state: "services_sub", lastService: "mobile" }); return MENUS[language].mobile; }
    if (lower === "3") { setUserState(userId, { state: "services_sub", lastService: "erp" }); return MENUS[language].erp; }
    if (lower === "4") { setUserState(userId, { state: "services_sub", lastService: "seo" }); return MENUS[language].seo; }
    if (lower === "5") { setUserState(userId, { state: "services_sub", lastService: "support" }); return MENUS[language].support; }
    if (lower === "0") { setUserState(userId, { state: "main" }); return MENUS[language].main; }
    const ai = await askAI(text, null, language);
    if (ai && ai.includes("canlı dəstəyə")) { await sendTelegramNotification(userId, text, username); setUserState(userId, { blocked: true }); return ai; }
    return ai || MENUS[language].services;
  }

  if (lower === "0") {
    setUserState(userId, { state: "services", detailLevel: 1 });
    return MENUS[language].services;
  }

  const detailKeywords = ["ətraflı", "daha ətraflı", "more info", "подробнее"];
  if (detailKeywords.some(kw => lower.includes(kw)) && lastService) {
    let newLevel = detailLevel + 1;
    if (newLevel > 3) newLevel = 1;
    setUserState(userId, { detailLevel: newLevel });
    return getDetailedInfo(lastService, language, newLevel);
  }

  const ai = await askAI(text, lastService, language);
  if (ai && ai.includes("canlı dəstəyə")) { await sendTelegramNotification(userId, text, username); setUserState(userId, { blocked: true }); return ai; }
  return ai || MENUS[language].main;
}

// ======================== INSTAGRAM API =================
async function replyToDM(recipientId, message) {
  if (!message) return;
  await axios.post("https://graph.instagram.com/v21.0/me/messages", { recipient: { id: recipientId }, message: { text: message } }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
}
async function replyToComment(commentId, message) {
  await axios.post(`https://graph.instagram.com/v21.0/${commentId}/replies`, { message }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
}
async function sendDM(commentId, message) {
  await axios.post("https://graph.instagram.com/v21.0/me/messages", { recipient: { comment_id: commentId }, message: { text: message } }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
}
async function sendMediaDM(recipientId, imageUrl, caption = "") {
  try {
    await axios.post("https://graph.instagram.com/v21.0/me/messages", { recipient: { id: recipientId }, message: { attachment: { type: "image", payload: { url: imageUrl } }, ...(caption && { text: caption }) } }, { params: { access_token: CONFIG.IG_ACCESS_TOKEN } });
  } catch (e) {}
}

// ======================== WEBHOOK =================
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
        await replyToComment(commentId, "Salam, şərhinizə cavab DM-də göndərildi ✔️");
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
        const username = msg.sender?.username || "istifadəçi";
        const response = await getResponse(senderId, text, username);
        if (response) await replyToDM(senderId, response);
        if (text.toLowerCase().includes("şəkil")) await sendMediaDM(senderId, "https://www.01cs.site/sample.jpg", "Nümunə layihə");
      }
    }
  } catch (err) {}
});

// ======================== TƏKMİL ADMİN PANEL =================
function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect("/admin/login");
}

// Login səhifəsi
app.get("/admin/login", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title><style>
      body{font-family:sans-serif;background:#f0f2f5;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}
      .card{background:white;padding:2rem;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);width:300px}
      input{width:100%;padding:10px;margin:10px 0;border:1px solid #ccc;border-radius:6px}
      button{background:#1877f2;color:white;border:none;padding:10px;border-radius:6px;width:100%;cursor:pointer}
    </style></head>
    <body><div class="card"><h2>Admin Girişi</h2><form method="post" action="/admin/login"><input type="password" name="password" placeholder="Şifrə" required /><button type="submit">Daxil ol</button></form></div></body>
    </html>
  `);
});
app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.redirect("/admin/dashboard");
  } else {
    res.send("Şifrə yanlışdır. <a href='/admin/login'>Geri</a>");
  }
});

// Dashboard HTML
app.get("/admin/dashboard", isAdmin, (req, res) => {
  // Məlumatları topla
  let analytics = [];
  if (fs.existsSync(ANALYTICS_FILE)) analytics = JSON.parse(fs.readFileSync(ANALYTICS_FILE));
  const totalMessages = analytics.length;
  const uniqueUsers = new Set(analytics.map(a => a.userId)).size;
  const blockedUsers = [...userStates.entries()].filter(([_,v]) => v.blocked).length;
  const activeUsers = userStates.size;
  // Son 10 hadisə
  const lastEvents = analytics.slice(-10).reverse();
  // Bütün istifadəçi vəziyyətləri
  const userStateList = Array.from(userStates.entries()).map(([id, st]) => ({ id, ...st }));

  res.send(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Panel</title><style>
      *{box-sizing:border-box}
      body{font-family:'Segoe UI',sans-serif;background:#e9ecef;margin:0;padding:20px}
      .container{max-width:1400px;margin:auto}
      h1{color:#1a1a2e}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:30px}
      .card{background:white;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,0.1);text-align:center}
      .card h3{margin:0;color:#555;font-size:14px}
      .card .value{font-size:32px;font-weight:bold;margin:10px 0 0}
      .section{background:white;border-radius:12px;padding:20px;margin-bottom:30px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
      .section h2{margin-top:0;border-bottom:2px solid #eee;padding-bottom:10px}
      table{width:100%;border-collapse:collapse;font-size:14px}
      th,td{padding:10px;text-align:left;border-bottom:1px solid #eee}
      th{background:#f8f9fa}
      .unblock-btn{background:#dc3545;color:white;border:none;padding:5px 10px;border-radius:6px;cursor:pointer}
      .unblock-btn:hover{background:#c82333}
      .badge{background:#28a745;color:white;padding:2px 8px;border-radius:20px;font-size:12px}
      .badge.blocked{background:#dc3545}
      input[type="text"]{padding:8px;border:1px solid #ccc;border-radius:6px;width:250px;margin-bottom:20px}
      .flex{display:flex;gap:10px;flex-wrap:wrap;justify-content:space-between;align-items:center}
      @media (max-width:600px){th,td{font-size:12px;padding:6px}}
    </style></head>
    <body>
    <div class="container">
      <h1>📊 01CS Bot Admin Paneli</h1>
      <div class="stats">
        <div class="card"><h3>Ümumi Mesajlar</h3><div class="value">${totalMessages}</div></div>
        <div class="card"><h3>Unikal İstifadəçilər</h3><div class="value">${uniqueUsers}</div></div>
        <div class="card"><h3>Bloklanmışlar</h3><div class="value">${blockedUsers}</div></div>
        <div class="card"><h3>Aktiv Sessiyalar</h3><div class="value">${activeUsers}</div></div>
      </div>

      <div class="section">
        <h2>🚫 Bloklanmış İstifadəçilər</h2>
        <table>
          <thead><tr><th>ID</th><th>Vəziyyət</th><th>Son Aktivlik</th><th>Əməliyyat</th></tr></thead>
          <tbody>
            ${userStateList.filter(u => u.blocked).map(u => `
              <tr>
                <td>${u.id}</td>
                <td><span class="badge blocked">Bloklu</span></td>
                <td>${new Date(u.lastActive).toLocaleString()}</td>
                <td><a href="/admin/unblock/${u.id}" class="unblock-btn" style="text-decoration:none;color:white;background:#28a745;padding:4px 8px;border-radius:4px">Bloku aç</a></td>
              </tr>
            `).join('') || '<tr><td colspan="4">Bloklanmış istifadəçi yoxdur.</td></tr>'}
          </tbody>
        </table>
      </div>

      <div class="section">
        <h2>👥 Bütün Aktiv İstifadəçilər (Sessiya)</h2>
        <div class="flex"><input type="text" id="searchInput" placeholder="ID və ya state ilə axtar..." onkeyup="filterTable()"></div>
        <table id="userTable">
          <thead><tr><th>ID</th><th>State</th><th>Son Xidmət</th><th>Dil</th><th>Blok</th><th>Son aktivlik</th></tr></thead>
          <tbody>
            ${userStateList.map(u => `
              <tr>
                <td>${u.id}</td>
                <td>${u.state}</td>
                <td>${u.lastService || '-'}</td>
                <td>${u.language}</td>
                <td>${u.blocked ? '✅ Bloklu' : '❌ Açıq'}</td>
                <td>${new Date(u.lastActive).toLocaleString()}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <div class="section">
        <h2>📋 Son Hadisələr (Analitika)</h2>
        <table>
          <thead><tr><th>Vaxt</th><th>İstifadəçi</th><th>Tip</th><th>Məzmun</th></tr></thead>
          <tbody>
            ${lastEvents.map(e => `
              <tr>
                <td>${new Date(e.timestamp).toLocaleString()}</td>
                <td>${e.userId}</td>
                <td>${e.action}</td>
                <td>${e.details.substring(0,50)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <script>
      function filterTable() {
        const input = document.getElementById('searchInput').value.toLowerCase();
        const rows = document.querySelectorAll('#userTable tbody tr');
        rows.forEach(row => {
          const text = row.innerText.toLowerCase();
          row.style.display = text.includes(input) ? '' : 'none';
        });
      }
    </script>
    </body>
    </html>
  `);
});

// Bloku açma
app.get("/admin/unblock/:userId", isAdmin, (req, res) => {
  const userId = req.params.userId;
  if (userStates.has(userId)) {
    setUserState(userId, { blocked: false });
  }
  res.redirect("/admin/dashboard");
});

// JSON analitika endpointi (admin tələb olunur)
app.get("/admin/analytics", isAdmin, (req, res) => {
  if (!fs.existsSync(ANALYTICS_FILE)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(ANALYTICS_FILE));
  res.json(data.slice(-200));
});

app.get("/", (req, res) => res.send("01CS Bot işləyir ✅"));
app.listen(CONFIG.PORT, () => console.log(`🚀 Server port ${CONFIG.PORT}`));