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
// SABİTLƏR
// ════════════════════════════════════════════════════
const TIMEOUT_30MIN = 30 * 60 * 1000;
const TIMEOUT_10MIN = 10 * 60 * 1000;
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 dəqiqə
const MAX_USERS_IN_MEMORY = 1000;
const MAX_PROCESSED_IDS = 2000;
const IG_API_VERSION = "v21.0";

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
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY || "",
  ENABLE_VOICE_REPLIES: process.env.ENABLE_VOICE_REPLIES === "true",
};

// Kritik environment variables validation
function validateConfig() {
  const required = ['IG_ACCESS_TOKEN', 'GROQ_API_KEY'];
  const missing = required.filter(key => !CONFIG[key]);

  if (missing.length > 0) {
    console.error(`❌ KRİTİK XƏTA: Bu environment variables təyin edilməyib: ${missing.join(', ')}`);
    console.error('Bot işləməyəcək. Zəhmət olmasa render.com-da bu dəyişənləri təyin edin.');
    process.exit(1);
  }

  if (CONFIG.ADMIN_PASSWORD === "admin123") {
    console.warn('⚠️ XƏBƏRDARLIQ: Default admin şifrəsi istifadə olunur! Təhlükəsizlik riski!');
  }
}

validateConfig();

// Groq başlat
let groq = null;
if (CONFIG.GROQ_API_KEY) {
  groq = new Groq({ apiKey: CONFIG.GROQ_API_KEY });
  console.log("✅ Groq AI hazırdır");
} else {
  console.log("⚠️ GROQ_API_KEY tapılmadı");
}

// ElevenLabs TTS hazırlığı
if (CONFIG.ELEVENLABS_API_KEY) {
  console.log("✅ ElevenLabs TTS hazırdır");
} else {
  console.log("⚠️ ELEVENLABS_API_KEY tapılmadı - səsli cavablar deaktiv");
}

// ════════════════════════════════════════════════════
// ANALİTİKA
// ════════════════════════════════════════════════════
// Render.com persistent disk: /opt/render/project/data/analytics.json
// Default: /tmp/analytics.json (restart-da silinir)
const ANALYTICS_FILE = process.env.ANALYTICS_PATH || "/tmp/analytics.json";

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
  } catch (e) {
    console.error("❌ Analytics yazma xətası:", e.message);
  }
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
    console.error("❌ Telegram xətası:", e.response?.data || e.message);
  }
}

// ════════════════════════════════════════════════════
// TEKRARİ ÖNLƏMƏ
// ════════════════════════════════════════════════════
const processedIds = new Map();
const processingLocks = new Set();

function isProcessed(id) {
  const now = Date.now();
  // Cleanup köhnə qeydləri
  for (const [k, v] of processedIds.entries()) {
    if (now - v > TIMEOUT_10MIN) processedIds.delete(k);
  }

  // Limit kontrolu - yaddaş sızmasının qarşısını al
  if (processedIds.size > MAX_PROCESSED_IDS) {
    const sorted = Array.from(processedIds.entries()).sort((a, b) => a[1] - b[1]);
    const toDelete = sorted.slice(0, Math.floor(MAX_PROCESSED_IDS / 2));
    toDelete.forEach(([k]) => processedIds.delete(k));
    console.log(`🧹 processedIds cleanup: ${toDelete.length} köhnə qeyd silindi`);
  }

  if (processedIds.has(id)) return true;
  processedIds.set(id, now);
  return false;
}

function isLocked(id) { return processingLocks.has(id); }
function lock(id) { processingLocks.add(id); }
function unlock(id) { processingLocks.delete(id); }

// Periodic cleanup - hər 5 dəqiqə
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  // ProcessedIds cleanup
  for (const [k, v] of processedIds.entries()) {
    if (now - v > TIMEOUT_10MIN) {
      processedIds.delete(k);
      cleaned++;
    }
  }

  // ProcessingLocks - 5 dəqiqədən çox lock-da qalanları təmizlə (stuck locks)
  // Bu normal halda olmamalıdır, amma əmin olmaq üçün
  if (processingLocks.size > 100) {
    console.warn(`⚠️ ProcessingLocks çox böyükdür: ${processingLocks.size}, təmizlənir`);
    processingLocks.clear();
  }

  if (cleaned > 0) {
    console.log(`🧹 Periodic cleanup: ${cleaned} köhnə processedId silindi`);
  }
}, CLEANUP_INTERVAL);

// ════════════════════════════════════════════════════
// İSTİFADƏÇİ VƏZİYYƏTLƏRİ
// ════════════════════════════════════════════════════
const users = new Map();

function getUser(userId) {
  const id = String(userId);

  // Limit kontrolu - çox istifadəçi yaddaşda qalmasın
  if (!users.has(id) && users.size >= MAX_USERS_IN_MEMORY) {
    cleanupInactiveUsers();
  }

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
  if (Date.now() - u.lastActive > TIMEOUT_30MIN) {
    u.state = "main";
    u.history = [];
    u.blocked = false;
    u.blockedSince = null;
  }

  // Bloklama müddəti 30 dəqiqədirsə, avtomatik aç
  if (u.blocked && u.blockedSince && (Date.now() - u.blockedSince > TIMEOUT_30MIN)) {
    u.blocked = false;
    u.blockedSince = null;
    u.state = "main";
    console.log(`🔓 İstifadəçi ${id} blokdan avtomatik açıldı`);
  }

  u.lastActive = Date.now();
  u.messageCount++;
  return u;
}

// Qeyri-aktiv istifadəçiləri təmizlə
function cleanupInactiveUsers() {
  const now = Date.now();
  const inactiveThreshold = 2 * TIMEOUT_30MIN; // 1 saat
  let cleaned = 0;

  for (const [id, user] of users.entries()) {
    if (now - user.lastActive > inactiveThreshold && !user.blocked) {
      users.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(`🧹 Users cleanup: ${cleaned} qeyri-aktiv istifadəçi silindi`);
  }
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

SƏSLİ MESAJLAR:
- Səsli mesajları anlayır və cavablandıra bilirəm
- İstifadəçi səsli mesaj göndərə bilər, mən onu mətnə çevirib cavab verirəm
- "Səsli mesajları başa düşürsənmi?" sualına cavab: "Bəli, səsli mesajlarınızı anlayıram 🎤"

KRİTİK QAYDA - SALAMLAŞMA:
- "Salam" YALNIZ söhbətin ƏN ƏVVƏLINDƏ, ilk mesajda de
- Davamında "Salam" demə, birbaşa suala cavab ver
- Təkrar salamlaşma səhvdir!

DOĞRU MİSAL:
İstifadəçi: "Salam, xidmətlər haqqında məlumat"
Sən: "Salam! Hansı xidmət barədə ətraflı məlumat istəyirsiniz? 😊"
İstifadəçi: "Vebsayt qiymətləri"
Sən: "Vebsayt 3 kateqoriyada təklif edirik..." (SALAM YOX!)

YANLIŞ MİSAL:
İstifadəçi: "Vebsayt qiymətləri"
Sən: "Salam! Vebsayt..." ❌ (Artıq salamlaşmısan!)

QRAMMATKA VƏ DİL:
- Azərbaycan dilində HAL dəyişikliklərini düzgün işlət
- "Bizimlə" (with us), "Bizə" (to us), "Bizim" (our) - qarışdırma
- "Xoş gəldi" YOX, "Xoş oldu" de (sağollaşma zamanı)
- Cümlələr qısa və aydın olsun
- Təkrar söz işlətmə

ƏSAS QRAMMATK QAYDALARI:
1. HAL ŞƏKİLÇİLƏRİ (düzgün işlət):
   - YÖNLİK hal: "bizə yazın", "sayta daxil olun" (-ə/-a)
   - ÇIXIŞLIQ hal: "bizdən soruşun", "saytdan" (-dən/-dan)
   - YERLİK hal: "saytda", "şirkətdə" (-də/-da)
   - BİRGƏLİK hal: "bizimlə əlaqə", "komanda ilə" (-lə/-la / ilə)

2. FEL ZAMANLARI (düzgün qoşma):
   - "edəcəyik" (gələcək), "edirik" (indiki), "etdik" (keçmiş)
   - "saxlayacaq" (gələcək), "saxlayır" (indiki), "saxladı" (keçmiş)

3. TƏYİN / QEYRI-TƏYİN:
   - "bir layihə" (qeyri-təyin), "layihə" (təyin), "layihəni" (təyin+yönlük)

4. SUAL CÜMLƏ:
   - "maraqlanırsınızmı?" (birləşik), "edirsinizsə" (şərt)

5. ÇOX İŞLƏNƏN SƏHVLƏRDƏN QAÇIN:
   ❌ "bizim ilə" → ✅ "bizimlə"
   ❌ "xoş gəldi" → ✅ "xoş oldu"
   ❌ "əlaqə saxlamaq üçün" → ✅ "əlaqə saxlayın"
   ❌ "edirik görək" → ✅ "edək"
   ❌ "sizə kömək edirik" → ✅ "sizə kömək edərik"

6. TƏBİİ AXICI DANIŞIQ:
   - Robot kimi deyil, insan kimi yaz
   - "Əlbəttə!", "Bəli, mümkündür", "Məmnuniyyətlə" kimi təbii ifadələr
   - Çox rəsmi olma, amma peşəkar qal

NİTQ ÜSLUBU:
- Təbii və səmimi danış (robot kimi yox)
- Hər cavabda 1-2 emoji
- Qısa suala qısa cavab (1-2 cümlə)
- Ətraflı suala ətraflı cavab (3-5 cümlə)
- Müştəriyə "Siz" ilə müraciət et
- Uydurma məlumat vermə - yalnız məlum faktlar

KONTEKSTƏ DİQQƏT:
- Söhbət tarixçəsini nəzərə al
- Eyni məlumatı təkrar söyləmə
- Əgər artıq cavab veribsənsə, qısaca xatırlat

ƏLAQƏSİZ SUALLAR:
"Bu mənim ixtisasım xaricindədir. 01 Code Studio xidmətləri barədə kömək edə bilərəm 😊"

CANLI DƏSTƏK TƏLƏBİ:
"Sizi canlı dəstəyə yönləndirirəm. Mütəxəssisimiz tezliklə əlaqə saxlayacaq 🙏"`;

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
// SƏSLİ MESAJ TRANSKRİPSİYA (GROQ WHISPER)
// ════════════════════════════════════════════════════
async function transcribeAudio(audioUrl) {
  if (!groq) {
    console.error("❌ Groq mövcud deyil, səsli mesaj işlənə bilməz");
    return null;
  }

  try {
    // Instagram audio URL-dən faylı endiririk
    console.log("⬇️ Audio endirilir:", audioUrl);
    const response = await axios.get(audioUrl, {
      responseType: 'arraybuffer',
      params: { access_token: CONFIG.IG_ACCESS_TOKEN },
      timeout: 30000
    });

    // Groq Whisper API ilə transkript edirik
    const audioBuffer = Buffer.from(response.data);
    const audioFile = new File([audioBuffer], "audio.m4a", { type: "audio/m4a" });

    const transcription = await groq.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-large-v3",
      language: "az", // Azərbaycan dili (auto-detect üçün silin)
      response_format: "text"
    });

    console.log("✅ Transkript:", transcription.slice(0, 100));
    return transcription.trim();

  } catch (e) {
    console.error("❌ Audio transkript xətası:", e.response?.data || e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════
// MƏTN-SƏS ÇEVİRMƏ (ELEVENLABS TTS)
// ════════════════════════════════════════════════════
async function textToSpeechAudio(text, language = "az") {
  if (!CONFIG.ELEVENLABS_API_KEY) {
    console.error("❌ ElevenLabs API key mövcud deyil");
    return null;
  }

  try {
    // Dil üzrə səs seçimi
    const voices = {
      az: "pNInz6obpgDQGcFmaJgB", // Adam (multilingual)
      ru: "pNInz6obpgDQGcFmaJgB", // Adam (multilingual)
      en: "pNInz6obpgDQGcFmaJgB"  // Adam (multilingual)
    };

    const voiceId = voices[language] || voices.az;

    console.log(`🎤 ElevenLabs TTS başladı: "${text.slice(0, 50)}..." (${language})`);

    // ElevenLabs API çağırışı
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text: text,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': CONFIG.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = Buffer.from(response.data);
    console.log(`✅ Audio yaradıldı: ${audioBuffer.length} bytes`);
    return audioBuffer;

  } catch (e) {
    console.error("❌ ElevenLabs TTS xətası:", e.response?.data?.detail || e.message);
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

  // Fallback mesajları dillərə görə
  const fallbackMessages = {
    az: "Başa düşmədim, bir az daha aydın yaza bilərsiniz? 😊",
    ru: "Не понял, можете написать подробнее? 😊",
    en: "I didn't understand, could you clarify? 😊"
  };

  // ── ANA MENYU ──────────────────────────────────────
  if (u.state === "main") {
    if (lower === "1") { setState(userId, { state: "services" }); return m.services; }
    if (lower === "2") { setState(userId, { state: "about" }); return m.about; }
    if (lower === "3") { setState(userId, { state: "contact" }); return m.contact; }

    const ai = await askAI(userId, t, null);
    return ai || fallbackMessages[lang];
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
    return ai || fallbackMessages[lang];
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
    await igRequest(`https://graph.instagram.com/${IG_API_VERSION}/${commentId}/replies`, { message });
  } catch (e) {
    console.error("❌ Şərh cavabı xətası:", e.response?.data?.error?.message || e.message);
  }
}

async function sendDM(commentId, message) {
  try {
    await igRequest(`https://graph.instagram.com/${IG_API_VERSION}/me/messages`, {
      recipient: { comment_id: commentId },
      message: { text: message }
    });
  } catch (e) {
    console.error("❌ DM xətası:", e.response?.data?.error?.message || e.message);
    try {
      await igRequest(`https://graph.instagram.com/${IG_API_VERSION}/${commentId}/replies`, {
        message: "Sizə DM göndərmək mümkün olmadı. Bizimlə əlaqə saxlayın: +994 10 717 20 34"
      });
    } catch (fallbackErr) {
      console.error("❌ DM fallback xətası:", fallbackErr.message);
    }
  }
}

async function replyDM(recipientId, message) {
  try {
    await igRequest(`https://graph.instagram.com/${IG_API_VERSION}/me/messages`, {
      recipient: { id: recipientId },
      message: { text: message }
    });
  } catch (e) {
    console.error("❌ DM cavabı xətası:", e.response?.data?.error?.message || e.message);
  }
}

async function replyAudioDM(recipientId, audioBuffer) {
  try {
    // 1. Audio faylını müvəqqəti olaraq serverdə saxla
    const filename = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`;
    const filePath = `/tmp/${filename}`;
    fs.writeFileSync(filePath, audioBuffer);

    // 2. Public URL yarat (Render.com və ya hosting-ə uyğun)
    const baseUrl = process.env.PUBLIC_URL || `http://localhost:${CONFIG.PORT}`;
    const audioUrl = `${baseUrl}/tmp-audio/${filename}`;

    console.log(`🎵 Audio URL: ${audioUrl}`);

    await igRequest(`https://graph.instagram.com/${IG_API_VERSION}/me/messages`, {
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "audio",
          payload: {
            url: audioUrl,
            is_reusable: false
          }
        }
      }
    });

    // 3. Faylı təmizlə (10 saniyə sonra - Instagram götürənə qədər gözlə)
    setTimeout(() => {
      try { fs.unlinkSync(filePath); } catch {}
    }, 10000);

    console.log("✅ Audio DM göndərildi");
  } catch (e) {
    console.error("❌ Audio DM xətası:", e.response?.data?.error?.message || e.message);
    throw e;
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
        let text = msg.message?.text;
        const msgId = msg.message?.mid;
        const attachments = msg.message?.attachments || [];

        // Səsli mesaj yoxlaması
        const audioAttachment = attachments.find(a => a.type === 'audio' || a.type === 'voice');

        if (!text && !audioAttachment) continue;
        if (!senderId || !msgId) continue;
        if (senderId === myId) continue;
        if (isLocked(msgId) || isProcessed(msgId)) {
          console.log(`⏭️ DM keçildi: ${msgId}`);
          continue;
        }

        lock(msgId);
        try {
          const username = msg.sender?.username || "";

          // Səsli mesaj varsa, transcribe et
          if (audioAttachment && !text) {
            console.log(`🎤 Səsli mesaj @${username}`);
            const audioUrl = audioAttachment.payload?.url;

            if (audioUrl) {
              text = await transcribeAudio(audioUrl);

              if (!text) {
                await replyDM(senderId, "Üzr istəyirəm, səsli mesajınızı başa düşə bilmədim 😔 Zəhmət olmasa yazılı olaraq göndərin.");
                console.log("❌ Səsli mesaj transcribe edilə bilmədi");
                continue;
              }

              logEvent(senderId, "voice_message", text);
              console.log(`✅ Transcribe edildi: "${text.slice(0, 60)}"`);
              // Transkripti göstərmirik - birbaşa cavab veririk
            }
          } else if (text) {
            console.log(`💬 DM @${username}: "${text.slice(0, 60)}"`);
            logEvent(senderId, "dm", text);
          }

          // Mətn varsa (yazılı və ya transcribe edilmiş), cavab ver
          if (text) {
            const reply = await getReply(senderId, text, username);
            if (reply) {
              // Əgər istifadəçi səsli mesaj göndəribsə və TTS aktivdirsə, səslə cavab ver
              if (audioAttachment && CONFIG.ENABLE_VOICE_REPLIES && CONFIG.ELEVENLABS_API_KEY) {
                try {
                  const userLang = getUser(senderId).language || "az";
                  const audioBuffer = await textToSpeechAudio(reply, userLang);

                  if (audioBuffer) {
                    await replyAudioDM(senderId, audioBuffer);
                    console.log("✅ Səsli cavab göndərildi");
                  } else {
                    // Audio yaradıla bilməzsə, mətn göndər
                    await replyDM(senderId, reply);
                    console.log("⚠️ Audio yaradılmadı, mətn göndərildi");
                  }
                } catch (audioError) {
                  // Audio göndərmə xətası olarsa, mətn göndər
                  console.log("⚠️ Audio göndərmə xətası, mətnlə davam edilir");
                  await replyDM(senderId, reply);
                  console.log("✅ Fallback: Mətn cavabı göndərildi");
                }
              } else {
                // Normal mətn cavabı
                await replyDM(senderId, reply);
                console.log("✅ Cavablandı");
              }
            } else {
              console.log("⚠️ Cavab alınmadı, fallback göndərilir");
              const fallbackMsg = fallbackMessages[getUser(senderId).language] || fallbackMessages.az;
              await replyDM(senderId, fallbackMsg);
            }
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

// Audio fayllara müvəqqəti xidmət (Instagram üçün)
app.get("/tmp-audio/:filename", (req, res) => {
  const filePath = `/tmp/${req.params.filename}`;
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Audio tapılmadı");
  }
  res.setHeader("Content-Type", "audio/mpeg");
  res.sendFile(filePath);
});

// Health check endpoint - render.com üçün
app.get("/health", (req, res) => {
  const health = {
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      groq: groq ? "active" : "inactive",
      telegram: (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) ? "active" : "inactive",
      instagram: CONFIG.IG_ACCESS_TOKEN ? "active" : "inactive"
    },
    stats: {
      activeUsers: users.size,
      processedIds: processedIds.size,
      processingLocks: processingLocks.size
    }
  };
  res.status(200).json(health);
});

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 01CS Bot port ${CONFIG.PORT}-də başladı`);
  console.log(`📊 Admin: /admin (şifrə: ${CONFIG.ADMIN_PASSWORD})`);
  console.log(`🤖 Groq AI: ${groq ? "aktiv" : "deaktiv"}`);
  console.log(`📨 Telegram bildirişi: ${CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID ? "aktiv" : "deaktiv"}`);
});
