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
  cookie: { secure: false }
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
    if (fs.existsSync(ANALYTICS_FILE)) data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
    data.push({ userId, action, details, timestamp: new Date().toISOString() });
    if (data.length > 1500) data = data.slice(-1200);
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

// ======================== QİYMƏT SİYAHISI (166tech.az əsaslı, 10-15% aşağı) =================
const PRICING = {
  website: {
    vizit: { min: 520, max: 1300, avg: 850, duration: "7-14 gün", desc: "Vizit kart / Landing page" },
    korporativ: { min: 1300, max: 4400, avg: 2800, duration: "30-60 gün", desc: "Korporativ sayt" },
    ecommerce: { min: 2600, max: 13000, avg: 7800, duration: "60-120 gün", desc: "E-ticarət saytı" }
  },
  mobile: {
    simple: { min: 2600, max: 6000, avg: 4300, duration: "30-45 gün", desc: "Sadə tətbiq (kataloq)" },
    medium: { min: 6000, max: 15500, avg: 10500, duration: "60-90 gün", desc: "Orta səviyyəli (ödəniş)" },
    complex: { min: 13000, max: 43000, avg: 28000, duration: "90-180 gün", desc: "Mürəkkəb tətbiq (real-time)" }
  },
  erp: { standard: { min: 7000, max: 43000, avg: 25000, duration: "Layihəyə görə", desc: "ERP/CRM" } },
  seo: { monthly: { min: 450, max: 1800, avg: 1100, duration: "Aylıq", desc: "SEO optimizasiyası" } },
  support: { hourly: { min: 250, max: 1500, avg: 800, duration: "Müqavilə əsasında", desc: "Texniki dəstək" } }
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

// ======================== SAYT SKRAPING (01cs.site) =================
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
  } catch (e) { console.log("Scrape xətası:", e.message); return null; }
}

// ======================== İNTERNET AXTARIŞ (Tavily + Fallback) =================
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
    } catch (e) { console.log("Tavily xətası:", e.message); }
  }
  // Fallback (sadə Google scraping)
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query + " qiymət Azərbaycan")}`;
    const { data } = await axios.get(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 5000 });
    const $ = cheerio.load(data);
    const results = [];
    $("div.g").slice(0, 2).each((i, el) => {
      const title = $(el).find("h3").text();
      const snippet = $(el).find(".VwiC3b").text();
      if (title) results.push({ title, content: snippet });
    });
    return results;
  } catch (e) { return []; }
}

// ======================== AI SORĞUSU (Groq + İnternet + Sayt) =================
async function askAI(prompt, contextService = null, language = "az") {
  if (!groq) return null;
  const siteInfo = await scrape01csSite();
  const webResults = await webSearch(`${contextService || "vebsayt"} qiymət`);
  let marketData = "";
  if (webResults.length) {
    marketData = "\n\n**Bazar məlumatları:**\n" + webResults.map(r => `- ${r.title}: ${r.content.substring(0, 100)}`).join("\n");
  }
  const langInstruction = language === "az" ? "Cavabı Azərbaycan dilində, 4-5 cümlə ilə ver."
                          : language === "ru" ? "Ответ дай на русском языке, 4-5 предложений."
                          : "Answer in English, 4-5 sentences.";
  const systemPrompt = `Sən 01 Code Studio-nun rəsmi köməkçisisən. Məlumat: ${siteInfo?.fullText?.substring(0, 600) || ""}
Cavab qaydaları: 4-5 cümlə, faydalı, peşəkar. Qiymət təkliflərində şirkətimizin öz qiymət siyahısından istifadə et (166tech.az-dan 10-15% aşağı).
Əgər sual şirkət işi ilə əlaqəli deyilsə, cavabında "Sizi canlı dəstəyə yönləndiririk..." yaz.
Daha ətraflı soruşulduqda əlavə izah ver.
${contextService ? `İstifadəçi hazırda "${contextService}" xidmətinə baxır.` : ""}
${langInstruction}
${marketData}`;
  try {
    const response = await groq.chat.completions.create({
      model: "llama3-70b-8192",
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 600,
    });
    return response.choices[0].message.content.trim();
  } catch (e) { console.log("AI xətası:", e.message); return null; }
}

// ======================== DETALLI INFO (səviyyəli) =================
function getDetailedInfo(service, lang, level) {
  const base = {
    website: "Vebsayt xidmətimiz vizit, korporativ və e-ticarət saytlarını əhatə edir. Hamısı mobil uyğun, SEO hazırlıqlıdır, ödəniş sistemləri inteqrasiya olunur.",
    mobile: "Mobil tətbiqlər native iOS/Android, push bildiriş, ödəniş, chat, xəritə funksiyaları ilə təchiz olunur. Admin panel daxildir.",
    erp: "ERP/CRM sistemləri tam fərdi, anbar, satış, müştəri, maliyyə modulları. İstənilən API ilə inteqrasiya.",
    seo: "SEO xidməti açar söz analizi, texniki audit, backlink, aylıq hesabat. 1-3 ayda nəticə.",
    support: "Texniki dəstək 7/24 online, təhlükəsizlik yeniləmələri, sürət optimizasiyası, xəta düzəlişləri."
  };
  let msg = base[service] || "";
  if (level >= 2) msg += " Əlavə olaraq, layihəniz üçün 1 ay pulsuz test dəstəyi təqdim edirik.";
  if (level >= 3) msg += " Dəqiq təklif üçün linkə keçin: https://01cs.site/teklif-al.html";
  return msg;
}

// ======================== CANLI DƏSTƏK AÇAR SÖZLƏR =================
const LIVE_KEYWORDS = {
  az: ["canlı dəstək", "operator çağır", "insan dəstək", "müştəri xidmətləri"],
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

// ======================== MENYULAR (çoxdilli) =================
const MENUS = {
  az: {
    main: "Salam, 01 Code Studio-ya xoş gəlmisiniz! 👋\n\n1️⃣ Xidmətlərimiz\n2️⃣ Haqqımızda\n3️⃣ Əlaqə\nDil: az, ru, en",
    services: "1️⃣ Vebsayt\n2️⃣ Mobil Tətbiq\n3️⃣ ERP/CRM\n4️⃣ SEO\n5️⃣ Texniki Dəstək\n0️⃣ Ana menyu",
    about: "01 Code Studio — peşəkar proqram həlləri. 🌐 www.01cs.site | 📸 @01cs.az\n0️⃣ Ana menyu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n📞 +994107172034\n0️⃣ Ana menyu",
    website: `💻 Vebsayt:\n${getPriceQuote("website","vizit").details}\n${getPriceQuote("website","korporativ").details}\n${getPriceQuote("website","ecommerce").details}\n0️⃣ Xidmətlərə qayıt`,
    mobile: `📱 Mobil:\n${getPriceQuote("mobile","simple").details}\n${getPriceQuote("mobile","medium").details}\n${getPriceQuote("mobile","complex").details}\n0️⃣ Xidmətlərə qayıt`,
    erp: `⚙️ ERP:\n${getPriceQuote("erp","standard").details}\n0️⃣ Xidmətlərə qayıt`,
    seo: `🔍 SEO:\n${getPriceQuote("seo","monthly").details}\n0️⃣ Xidmətlərə qayıt`,
    support: `🛠️ Dəstək:\n${getPriceQuote("support","hourly").details}\n0️⃣ Xidmətlərə qayıt`,
    liveSupport: "Sizi canlı dəstəyə yönləndiririk. Mütəxəssislər tezliklə əlaqə saxlayacaq. 😊"
  },
  ru: {
    main: "Добро пожаловать! 👋\n1️⃣ Услуги\n2️⃣ О нас\n3️⃣ Контакты\nЯзык: az, ru, en",
    services: "1️⃣ Сайт\n2️⃣ Моб. приложение\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Техподдержка\n0️⃣ Главное меню",
    about: "01 Code Studio — IT-решения. 🌐 www.01cs.site\n0️⃣ Главное меню",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0️⃣ Главное меню",
    website: `💻 Сайт:\n${getPriceQuote("website","vizit").details}\n${getPriceQuote("website","korporativ").details}\n${getPriceQuote("website","ecommerce").details}\n0️⃣ Назад`,
    mobile: `📱 Приложение:\n${getPriceQuote("mobile","simple").details}\n${getPriceQuote("mobile","medium").details}\n${getPriceQuote("mobile","complex").details}\n0️⃣ Назад`,
    erp: `⚙️ ERP:\n${getPriceQuote("erp","standard").details}\n0️⃣ Назад`,
    seo: `🔍 SEO:\n${getPriceQuote("seo","monthly").details}\n0️⃣ Назад`,
    support: `🛠️ Поддержка:\n${getPriceQuote("support","hourly").details}\n0️⃣ Назад`,
    liveSupport: "Перенаправляем вас в службу поддержки. Специалисты свяжутся с вами."
  },
  en: {
    main: "Welcome to 01 Code Studio! 👋\n\n1️⃣ Services\n2️⃣ About\n3️⃣ Contact\nLanguage: az, ru, en",
    services: "1️⃣ Website\n2️⃣ Mobile App\n3️⃣ ERP\n4️⃣ SEO\n5️⃣ Support\n0️⃣ Main menu",
    about: "01 Code Studio — professional software solutions. 🌐 www.01cs.site\n0️⃣ Main menu",
    contact: "📧 info@01cs.site\n💬 wa.me/994107172034\n0️⃣ Main menu",
    website: `💻 Website:\n${getPriceQuote("website","vizit").details}\n${getPriceQuote("website","korporativ").details}\n${getPriceQuote("website","ecommerce").details}\n0️⃣ Back`,
    mobile: `📱 Mobile App:\n${getPriceQuote("mobile","simple").details}\n${getPriceQuote("mobile","medium").details}\n${getPriceQuote("mobile","complex").details}\n0️⃣ Back`,
    erp: `⚙️ ERP:\n${getPriceQuote("erp","standard").details}\n0️⃣ Back`,
    seo: `🔍 SEO:\n${getPriceQuote("seo","monthly").details}\n0️⃣ Back`,
    support: `🛠️ Support:\n${getPriceQuote("support","hourly").details}\n0️⃣ Back`,
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

// ======================== INSTAGRAM API KÖMƏKÇİLƏRİ =================
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
        const username = msg.sender?.username || "user";
        const response = await getResponse(senderId, text, username);
        if (response) await replyToDM(senderId, response);
        if (text.toLowerCase().includes("şəkil")) await sendMediaDM(senderId, "https://www.01cs.site/sample.jpg", "Nümunə layihə");
      }
    }
  } catch (err) { console.error("Webhook xətası:", err.message); }
});

// ======================== ADMIN PANEL (təkmil) =================
function isAdmin(req, res, next) {
  if (req.session.admin) return next();
  res.redirect("/admin/login");
}

app.get("/admin/login", (req, res) => {
  res.send(`<html><body style="font-family:sans-serif;text-align:center;margin-top:50px"><h2>Admin Girişi</h2><form method="post" action="/admin/login"><input type="password" name="pwd" placeholder="Şifrə" /><button type="submit">Daxil ol</button></form></body></html>`);
});

app.post("/admin/login", (req, res) => {
  if (req.body.pwd === CONFIG.ADMIN_PASSWORD) {
    req.session.admin = true;
    res.redirect("/admin/dashboard");
  } else {
    res.send("Şifrə yanlış. <a href='/admin/login'>Geri</a>");
  }
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
        <table><th>Vaxt</th><th>İstifadəçi</th><th>Tip</th><th>Məzmun</th></tr>
        ${analytics.slice(-20).reverse().map(e => `<tr><td>${new Date(e.timestamp).toLocaleString()}</td><td>${e.userId}</td><td>${e.action}</td><td>${e.details?.substring(0,50)}</td></tr>`).join('')}
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

app.get("/analytics", isAdmin, (req, res) => {
  if (!fs.existsSync(ANALYTICS_FILE)) return res.json([]);
  const data = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
  res.json(data.slice(-200));
});

app.get("/", (req, res) => res.send("01CS Bot (tam funksiyalı) işləyir ✅"));
app.listen(CONFIG.PORT, () => console.log(`🚀 Server ${CONFIG.PORT} portunda işləyir`));