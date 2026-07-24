const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

// ==========================================
// 🛡️ CORS — sirf whitelist domains ke liye khula
// ==========================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(',').map(s => s.trim()).filter(Boolean);

if (ALLOWED_ORIGINS.length === 0) {
  console.warn("🚨 WARNING: ALLOWED_ORIGINS set nahi hai — CORS abhi SABHI origins ke liye khula hai. Production mein isse zaroor set karein!");
}

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS blocked: origin not allowed'));
  }
}));
app.use(express.json({ limit: '200kb' })); // 🛡️ FIX: body-size cap taaki koi bada payload bhej ke resource-abuse na kare

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES
// ==========================================
const OTP_EXPIRE_MIN = 10;
const OTP_MAX_SEND_PER_DAY = 4;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_BLOCK_HOURS = 24;
const APP_NAME = "Sabzi Fresh";

const MAIL_RELAY_URL = (process.env.MAIL_RELAY_URL || "").trim();
const MAIL_RELAY_SECRET = (process.env.MAIL_RELAY_SECRET || "").trim();

const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();

const ONESIGNAL_APP_ID = (process.env.ONESIGNAL_APP_ID || "").trim();
const ONESIGNAL_REST_KEY = (process.env.ONESIGNAL_REST_KEY || "").trim();
const ONESIGNAL_RIDER_APP_ID = (process.env.ONESIGNAL_RIDER_APP_ID || "").trim();
const ONESIGNAL_RIDER_REST_KEY = (process.env.ONESIGNAL_RIDER_REST_KEY || "").trim();

// 🛡️ FIX: admin email ab SIRF environment variable se aayega, source code mein
// hardcoded plaintext nahi rahega (phishing/targeting risk tha). Agar env var
// missing hai to server jaan-boojh kar start hi nahi hoga — taaki koi accidentally
// bina admin-email set kiye deploy na kar de.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
if (!ADMIN_EMAIL) {
  console.error("🚨 FATAL: ADMIN_EMAIL environment variable Render dashboard mein set karein. Server band ho raha hai.");
  process.exit(1);
}

const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

try {
  if (serviceAccountRaw) {
    const serviceAccount = JSON.parse(serviceAccountRaw);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: "https://sabzifresh-d8742-default-rtdb.firebaseio.com"
    });
    console.log("✅ Firebase Admin Variable se successfully start ho gaya!");
  } else {
    console.error("🚨 FATAL: FIREBASE_SERVICE_ACCOUNT_JSON variable missing hai!");
    process.exit(1);
  }
} catch (error) {
  console.error("🚨 FATAL: JSON Parse fail ho gaya. Variable theek se load nahi hua.", error);
  process.exit(1);
}

const db = admin.database();

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Sabzi Fresh API — Secure Backend Live Hai!' });
});

// ==========================================
// 🛡️ RATE LIMITERS
// NOTE: Render free-tier par service idle hone par restart hoti hai, jisse
// in-memory rate-limiters reset ho jaate hain. Isliye ye limiters "best-effort"
// hain — asli/persistent protection Firebase mein save hone wale counters
// (jaise OTP ka sendCount/blockedUntil neeche) se aati hai, jo restart ke
// baad bhi bane rehte hain.
// ==========================================
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 6,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  message: { success: false, message: "Bahut zyada attempts. Thodi der baad try karein." }
});
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 30,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
const generalLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 40,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
// 🛡️ NAYA FIX: rider aur admin endpoints par pehle koi rate-limit nahi tha
const riderActionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, max: 60,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
const adminActionLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, max: 50,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
const lookupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});

// ==========================================
// 🔑 HELPERS
// ==========================================
function emailToKey(email) {
  return Buffer.from(email).toString('hex');
}
async function getOtpRecord(email) {
  const key = emailToKey(email);
  const snap = await db.ref(`otp_data/${key}`).once('value');
  return snap.val() || { sendCount: 0, verifyAttempts: 0, date: "", blockedUntil: 0, otp: "", otpTime: 0 };
}
async function setOtpRecord(email, data) {
  const key = emailToKey(email);
  await db.ref(`otp_data/${key}`).set(data);
}

// 🛡️ FIX: Math.random() cryptographically secure nahi tha, ab crypto.randomInt() use ho raha hai
function generateOTP() {
  return crypto.randomInt(100000, 1000000).toString();
}

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || '')); }

// 🛡️ NAYA FIX: phone-number format validate karne ke liye — pehle sirf frontend
// check karta tha, backend kuch bhi accept kar leta tha.
function isValidPhone(p) { return /^[6-9][0-9]{9}$/.test(String(p || '').trim()); }

function todayIST() { return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }); }

// 🛡️ CRITICAL FIX (#1): pehle ye function HTML-escape (&,<,>,",') bhi
// karta tha aur DB mein PERMANENTLY escaped value save hota tha. Chunki
// customer.html bhi pehle se apne taraf se sanitize() karke bhejta tha,
// aur phir Admin/Rider apps render-time pe FIR se sanitize() karte the —
// ek naam/address teen baar escape ho jaata tha, aur DB mein hamesha ke
// liye corrupted (double-encoded) save ho jaata tha (sirf display-glitch
// nahi, asli data hi kharab ho jaata tha).
// Sahi pattern: RAW data store karo, sirf jab HTML mein RENDER karo tab
// escape karo (jo Admin/Rider/Customer apps already apne render-functions
// mein karte hain). Isliye ab ye function sirf trim + length-cap karta
// hai — HTML-escape bilkul nahi karta.
function cleanText(str, maxLen = 300) {
  if (str === null || str === undefined) return '';
  let s = String(str).trim();
  if (s.length > maxLen) s = s.substring(0, maxLen);
  return s;
}

// 🛡️ CRITICAL FIX: ye helper CHECK karta hai ki caller sach mein ek
// registered rider hai ya nahi. Pehle koi bhi rider-endpoint sirf ye dekhta
// tha ki token valid Firebase Auth token hai — matlab koi bhi logged-in
// CUSTOMER bhi khud ko "rider" bata ke duty-on kar sakta tha aur saare
// pending orders (naam/phone/address samet) apne paas assign karva sakta tha.
async function isRegisteredRider(uid) {
  const snap = await db.ref(`riders/${uid}`).once('value');
  return snap.exists();
}

// 🛡️ NAYA FIX (phone ko delivery-contact maana gaya, account-identity nahi):
// Amazon/Flipkart/Zomato ki tarah is app mein bhi asli account-identity
// EMAIL hai — phone sirf ek delivery-contact field hai jo order-order pe
// alag ho sakta hai. Isliye account lookup ab email se hota hai, phone se nahi.
// (users/ node abhi bhi phone-keyed hai backward-compatibility ke liye,
// lekin usko DHOONDHNE ka tarika ab email-query se hai.)
async function getUserAccountByEmail(email) {
  if (!email) return null;
  const snap = await db.ref('/users').orderByChild('email').equalTo(email).once('value');
  const val = snap.val();
  if (!val) return null;
  const accountPhone = Object.keys(val)[0];
  return { accountPhone, ...val[accountPhone] };
}

// 🛡️ FIX (#3): pehle refer-code sirf ek baar random generate hota tha, bina
// collision-check ke — sirf 9000 possible 4-digit codes hain, isliye
// collision hona practically possible tha. Jab collision hota, Firebase
// rule silently write reject kar deta (`!data.exists()` fail ho jaata),
// lekin user ka `referCode` field already us (kabhi-claim-na-hue) code par
// set ho chuka hota — us user ka refer-code hamesha ke liye broken rehta,
// bina kisi ko pata chale. Ab pehle code ko `referCodes/{code}` mein
// ATOMICALLY claim karte hain (Admin SDK transaction se), aur collision
// hone par naya code try karte hain, retry ke saath.
async function generateUniqueReferCode(phone, maxAttempts = 6) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = "SF" + Math.floor(1000 + Math.random() * 9000);
    const result = await db.ref(`/referCodes/${code}`).transaction((current) => {
      if (current) return; // already claimed by someone — abort, retry with new code
      return phone;
    });
    if (result.committed) return code;
  }
  // Extreme-unlikely fallback (6 collisions in a row) — timestamp-based, guaranteed unique
  const fallbackCode = "SF" + Date.now().toString().slice(-6);
  await db.ref(`/referCodes/${fallbackCode}`).set(phone);
  return fallbackCode;
}

// 🛡️ FIX (#19, best-effort): referral "one-device-one-use" protection
// client-side (localStorage) hai, jo incognito/clear-storage se trivially
// bypass ho jaata hai. Isse poori tarah rokna backend-only se possible
// nahi (IP shared/VPN ho sakta hai), lekin ek IP-based daily-throttle
// abuse ko kaafi mushkil bana deta hai — defense-in-depth ke roop mein.
async function checkReferralIpThrottle(ip) {
  if (!ip) return true; // IP na mile to throttle skip (fail-open, availability priority)
  const key = Buffer.from(String(ip)).toString('hex');
  const today = todayIST();
  const snap = await db.ref(`referral_ip_throttle/${key}`).once('value');
  let rec = snap.val() || { count: 0, date: '' };
  if (rec.date !== today) { rec.count = 0; rec.date = today; }
  if (rec.count >= 3) return false;
  rec.count += 1;
  await db.ref(`referral_ip_throttle/${key}`).set(rec);
  return true;
}

async function verifyAndGetEmail(userToken) {
  const decoded = await admin.auth().verifyIdToken(userToken);
  return (decoded.email || "").toLowerCase().trim();
}

// 🛡️ FIX: status-string mismatch — Admin panel dropdown kabhi bina-emoji
// wali value bhejta tha ("Packing in Progress") jabki DB mein emoji-wali
// value store hoti hai ("Packing in Progress ⏳"), jisse update silently
// reject ho jaata tha. Ab dono forms normalize ho ke sahi canonical value
// mein map hote hain.
const STATUS_CANONICAL_MAP = {
  'packing in progress': 'Packing in Progress ⏳',
  'confirmed': 'Confirmed',
  'out for delivery': 'Out for Delivery',
  'delivered': 'Delivered',
  'returned/rejected': 'Returned/Rejected',
  'cancelled by sabzifresh': 'Cancelled by SabziFresh',
  'cancelled by customer': 'Cancelled by Customer'
};
function normalizeStatus(input) {
  if (!input) return null;
  // eslint-disable-next-line no-control-regex
  const key = String(input).trim().toLowerCase().replace(/[^\x00-\x7F]/g, '').trim();
  return STATUS_CANONICAL_MAP[key] || null;
}
const ALLOWED_RIDER_STATUSES = [
  'Packing in Progress ⏳', 'Confirmed', 'Out for Delivery',
  'Delivered', 'Returned/Rejected', 'Cancelled by SabziFresh'
];
const ALLOWED_ADMIN_STATUSES = [...ALLOWED_RIDER_STATUSES, 'Cancelled by Customer'];

// ==========================================
// 📧 MAIL — PREMIUM OTP TEMPLATE (GAS Relay ke through)
// ==========================================
async function sendOtpEmail(email, otp) {
  if (!MAIL_RELAY_URL || !MAIL_RELAY_SECRET) {
    console.warn("🚨 MAIL_RELAY_URL/SECRET missing — email nahi ja sakti!");
    return { ok: false, reason: 'config_missing' };
  }
  try {
    const otpDigitsHtml = otp.split("").map(d =>
      `<td style="padding:0 5px;"><div style="width:40px;height:48px;background:#f0faf0;border:2px solid #2e7d32;border-radius:8px;font-size:24px;font-weight:bold;color:#1b5e20;text-align:center;line-height:48px;font-family:monospace;">${d}</div></td>`
    ).join("");

    const htmlBody = `
      <div style="background-color:#f4f7f4; padding:20px 0; font-family:Arial, sans-serif; color:#333;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
          <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
            <tr>
              <td style="background-color:#2e7d32; padding:30px; text-align:center; color:#ffffff;">
                <div style="font-size:40px; margin-bottom:10px;">🥦</div>
                <h1 style="margin:0; font-size:24px; font-weight:bold; letter-spacing:1px;">${APP_NAME}</h1>
                <p style="margin:5px 0 0 0; font-size:14px; opacity:0.9;">Taaza Sabzi, Seedha Aapke Ghar</p>
              </td>
            </tr>
            <tr>
              <td style="padding:30px;">
                <h2 style="color:#2e7d32; margin-top:0; font-size:20px;">Namaste! 👋</h2>
                <p style="font-size:15px; color:#555; line-height:1.5; margin-bottom:25px;">
                  Aapne <b>${APP_NAME}</b> mein login karne ki koshish ki hai. Neeche diya gaya OTP use karein:
                </p>
                <div style="background-color:#f9f9f9; border:1px solid #e0e0e0; border-radius:10px; padding:20px; text-align:center; margin-bottom:20px;">
                  <p style="font-size:12px; color:#888; font-weight:bold; letter-spacing:1px; margin-top:0; text-transform:uppercase;">Aapka One-Time Password</p>
                  <table style="margin:0 auto;"><tr>${otpDigitsHtml}</tr></table>
                  <p style="font-size:13px; color:#d32f2f; margin:15px 0 0 0;">⏰ Ye OTP sirf <b>${OTP_EXPIRE_MIN} minute</b> tak valid hai.</p>
                </div>
                <div style="background-color:#fff8e1; border-left:4px solid #ffb300; padding:15px; border-radius:4px; margin-bottom:25px;">
                  <p style="margin:0; font-size:13px; color:#665c00; line-height:1.5;">🔒 <b>Security Alert:</b> Ye OTP <b>kisi ke saath share na karein</b>.</p>
                </div>
                <p style="font-size:12px; color:#999; margin-top:30px; line-height:1.5; border-top:1px solid #eee; padding-top:20px;">
                  Agar aapne login ki koshish <b>nahi</b> ki, toh is email ko ignore karein.
                </p>
              </td>
            </tr>
          </table>
        </td></tr></table>
      </div>`;

    const resp = await fetch(MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: MAIL_RELAY_SECRET, to: email,
        subject: `🥦 ${APP_NAME} - Aapka Login OTP`,
        text: `Aapka OTP: ${otp} (${OTP_EXPIRE_MIN} min valid hai)`,
        html: htmlBody
      })
    });
    const data = await resp.json();
    // 🛡️ FIX: pehle sirf true/false return hota tha, GAS quota-exceeded ya
    // koi bhi specific relay-error silently "email nahi ja payi" ban jaata
    // tha — ab poora relay-response bhi log hota hai taaki peak-hour failure
    // turant pakड़ mein aaye.
    if (data.success !== true) {
      console.error("🚨 Mail relay ne fail bataya:", JSON.stringify(data));
      return { ok: false, reason: 'relay_rejected', detail: data };
    }
    return { ok: true };
  } catch (err) {
    console.error("🚨 Mail relay call error:", err);
    return { ok: false, reason: 'network_error' };
  }
}

// ==========================================
// 1. 📩 OTP BHEJNA
// ==========================================
app.post('/api/otp/send', otpSendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.json({ success: false, message: "Valid email daalen." });
    const cleanEmail = email.toLowerCase().trim();
    const now = Date.now();
    const today = todayIST();

    let rec = await getOtpRecord(cleanEmail);

    if (rec.blockedUntil > now) {
      const rem = Math.ceil((rec.blockedUntil - now) / 3600000);
      return res.json({ success: false, message: `Aap ${rem} ghante ke liye block hain.` });
    }
    if (rec.blockedUntil > 0 && rec.blockedUntil <= now) { rec.sendCount = 0; rec.blockedUntil = 0; }
    if (rec.date !== today) { rec.sendCount = 0; rec.date = today; }

    if (rec.sendCount >= OTP_MAX_SEND_PER_DAY) {
      rec.blockedUntil = now + (OTP_BLOCK_HOURS * 3600000);
      await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: `Zyada attempts! ${OTP_BLOCK_HOURS} ghante baad try karein.` });
    }

    // 🛡️ CRITICAL FIX (#16): pehle sendCount yahin turant DB mein save ho
    // jaata tha, EMAIL bhejne se PEHLE. Agar mail-relay (GAS, jo Render
    // free-tier ke saath kabhi-kabhi unreliable ho sakta hai) fail ho jaaye,
    // to bhi customer ka ek daily-attempt "consume" ho jaata — genuine user
    // baar-baar fail hone par bina kabhi OTP paaye 24-ghante ke liye block
    // ho sakta tha. Ab pehle EMAIL bhejte hain, aur sirf SUCCESS confirm
    // hone ke baad hi DB-record (sendCount) update hota hai.
    const otp = generateOTP();
    const sendResult = await sendOtpEmail(cleanEmail, otp);
    if (!sendResult.ok) return res.json({ success: false, message: "Email nahi ja payi. Dobara try karein." });

    rec.otp = otp; rec.otpTime = now; rec.sendCount += 1; rec.verifyAttempts = 0;
    await setOtpRecord(cleanEmail, rec);

    res.json({ success: true, message: `OTP bhej diya! ${OTP_EXPIRE_MIN} min mein use karein.` });
  } catch (error) {
    console.error("OTP send error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 2. ✅ OTP VERIFY + VIP PASS
// ==========================================
app.post('/api/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code || !isValidEmail(email)) return res.json({ success: false, message: "Email aur code zaroori hai" });
    const cleanEmail = email.toLowerCase().trim();
    const now = Date.now();

    let rec = await getOtpRecord(cleanEmail);

    if (rec.blockedUntil > now) {
      const rem = Math.ceil((rec.blockedUntil - now) / 3600000);
      return res.json({ success: false, message: `Aap ${rem} ghante ke liye block hain.` });
    }
    if (!rec.otp) return res.json({ success: false, message: "Pehle OTP mangaiye." });
    if (now - rec.otpTime > OTP_EXPIRE_MIN * 60000) {
      rec.otp = ""; await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: "OTP expire ho gaya! Naya mangaiye." });
    }

    // 🛡️ Constant-time compare — chhoti si extra hardening taaki OTP-string
    // ki length/timing se koi info leak na ho.
    const submitted = String(code).trim();
    const isMatch = submitted.length === rec.otp.length &&
      crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(rec.otp));

    if (!isMatch) {
      rec.verifyAttempts = (rec.verifyAttempts || 0) + 1;
      if (rec.verifyAttempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        rec.otp = ""; rec.blockedUntil = now + (OTP_BLOCK_HOURS * 3600000);
        await setOtpRecord(cleanEmail, rec);
        return res.json({ success: false, message: `Bahut zyada galat attempts! ${OTP_BLOCK_HOURS} ghante ke liye block ho gaye.` });
      }
      await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: `Galat OTP! (${OTP_MAX_VERIFY_ATTEMPTS - rec.verifyAttempts} attempts baaki)` });
    }

    rec.otp = ""; rec.otpTime = 0; rec.sendCount = 0; rec.verifyAttempts = 0;
    await setOtpRecord(cleanEmail, rec);

    const uid = emailToKey(cleanEmail);
    const vipToken = await admin.auth().createCustomToken(uid, { email: cleanEmail });

    // Agar is email ka account pehle se bana hua hai, uska account-phone
    // bhi saath mein bhej dete hain — isse frontend '/api/auth/lookup' ko
    // dobara call kiye bina hi seedha finalizeLogin kar sakta hai.
    const existingAccount = await getUserAccountByEmail(cleanEmail);

    res.json({
      success: true,
      message: "Email verify ho gaya! ✔️",
      token: vipToken,
      phone: existingAccount ? existingAccount.accountPhone : null
    });
  } catch (error) {
    console.error("OTP verify error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 2b. 🔎 EMAIL LOOKUP (frontend ye endpoint call karta tha, pehle exist hi
// nahi karta tha — har login pe ek extra failed request + latency lagti thi)
// ==========================================
app.post('/api/auth/lookup', lookupLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) return res.json({ success: false, message: "Valid email daalen." });
    const cleanEmail = email.toLowerCase().trim();
    const account = await getUserAccountByEmail(cleanEmail);
    if (account) return res.json({ success: true, phone: account.accountPhone });
    return res.json({ success: true, isNew: true });
  } catch (error) {
    console.error("Lookup error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 3. 🛡️ SECURE REGISTRATION
// (account ka DB-key abhi bhi phone hai — backward-compatible — lekin ab
//  phone format validate hota hai, naam sanitize hota hai, aur same email
//  se dusra account banna block hota hai)
// ==========================================
app.post('/api/auth/register', generalLimiter, async (req, res) => {
  try {
    const { phone, name, email, referCode, userToken } = req.body;
    const cleanEmail = email ? email.toLowerCase().trim() : "";
    const cleanName = cleanText(name, 60);

    if (!phone || !cleanName || !userToken || !cleanEmail) {
      return res.json({ success: false, message: "Details, Email aur Token zaroori hai!" });
    }
    // 🛡️ NAYA FIX: phone format ab backend par bhi validate hota hai
    if (!isValidPhone(phone)) {
      return res.json({ success: false, message: "Sahi 10-digit mobile number daalein!" });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.json({ success: false, message: "Sahi email daalein!" });
    }

    const decodedToken = await admin.auth().verifyIdToken(userToken);
    if ((decodedToken.email || "").toLowerCase() !== cleanEmail) {
      return res.json({ success: false, message: "Security Alert: Token aur Email match nahi ho rahe!" });
    }

    // 🛡️ NAYA FIX: pehle sirf phone-uniqueness check hota tha — koi user
    // same email se alag-alag phone ke saath multiple accounts bana sakta
    // tha (block-evasion / referral-farming ke liye). Ab email-uniqueness
    // bhi check hoti hai.
    const existingByEmail = await getUserAccountByEmail(cleanEmail);
    if (existingByEmail) {
      return res.json({ success: false, message: "Ye email pehle se ek account se judi hai. Kripya login karein." });
    }

    let referrerPhone = null;
    if (referCode) {
      // 🛡️ FIX (#19): referral-abuse ke against ek extra IP-based layer
      const ipOk = await checkReferralIpThrottle(req.ip);
      if (!ipOk) return res.json({ success: false, message: "Bahut zyada referral-registrations is network se. Thodi der baad try karein." });

      const referSnap = await db.ref('/referCodes').once('value');
      const allReferCodes = referSnap.val() || {};
      if (allReferCodes[referCode]) {
        referrerPhone = allReferCodes[referCode];
        if (referrerPhone === phone) return res.json({ success: false, message: "Khud ko refer nahi kar sakte!" });
      } else {
        return res.json({ success: false, message: "Referral code galat hai!" });
      }
    }

    // 🛡️ FIX (#3): ab collision-safe generation — retry ke saath
    const newCode = await generateUniqueReferCode(phone);
    const newUser = {
      name: cleanName, email: cleanEmail, phone, savedVillage: "", savedStreet: "", referCode: newCode,
      freeDeliveries: 0, rewardExpiry: null, registeredAt: Date.now(),
      referredBy: referrerPhone || null, referralStatus: referrerPhone ? "pending" : null
    };

    const userSnap = await db.ref(`/users/${phone}`).once('value');
    if (userSnap.exists()) {
      const myWhatsAppNumber = "+918409081468";
      const waMessage = encodeURIComponent(`Hi customer support, main Sabzi Fresh app par apna purana Gmail bhool gaya hoon.\n\nMera Mobile Number: ${phone}\n\nKripya is number ka fir se account banane ka permission de do.`);
      return res.json({
        success: false,
        message: "⚠️ Yeh Mobile Number pehle se registered hai! Kripya us Gmail se Login karein.\n\nAgar aap apna purana Gmail bhool gaye hain, toh Admin ko WhatsApp karein.",
        showWhatsAppSupport: true,
        whatsappLink: `https://wa.me/${myWhatsAppNumber}?text=${waMessage}`
      });
    }

    await db.ref(`/users/${phone}`).set(newUser);
    // Note: referCodes/{newCode} pehle hi generateUniqueReferCode() ke andar
    // transaction se claim ho chuka hai — dobara set() karne ki zaroorat nahi.

    res.json({ success: true, user: newUser });
  } catch (error) {
    console.error("Register Error:", error);
    res.json({ success: false, message: "Server Error ya Invalid Token." });
  }
});

// ==========================================
// 4. 🛒 SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', generalLimiter, async (req, res) => {
  try {
    const { cartItems } = req.body;
    if (!cartItems) return res.json({ success: false, message: "Cart khali hai" });

    const productsDB = (await db.ref('/products').once('value')).val() || {};
    const settingsDB = (await db.ref('/settings').once('value')).val() || {};

    let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 20; // 🛡️ FIX #17: default ab 20 hai, customer/admin app ke defaults se consistent (pehle 0 tha, jo mismatch create karta tha)
    let adminFreeLimit = parseInt(settingsDB.minFreeDeliveryThreshold) || 0;

    let secureSubtotal = 0; let secureItemsList = [];

    for (let itemId in cartItems) {
      let qty = parseFloat(cartItems[itemId]);
      let asliProduct = productsDB[itemId];
      if (asliProduct && !isNaN(qty) && qty > 0) {
        let itemTotal = asliProduct.price * qty;
        secureSubtotal += itemTotal;
        let itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
        secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
      }
    }

    let secureDeliveryCharge = 0;
    if (secureSubtotal > 0) {
      secureDeliveryCharge = (adminFreeLimit > 0 && secureSubtotal >= adminFreeLimit) ? 0 : adminDeliveryFee;
    }

    res.json({
      success: true, asliSubtotal: secureSubtotal, asliDelivery: secureDeliveryCharge,
      asliTotal: secureSubtotal + secureDeliveryCharge, verifiedItems: secureItemsList
    });
  } catch (error) {
    res.json({ success: false, message: "Bill calculation error" });
  }
});

// ==========================================
// 5. 🚀 SECURE ORDER MANAGER
// 🛡️ FIX: order ab EMAIL se account dhoondta hai, phone se nahi — isse
// customer checkout-form mein KISI BHI valid delivery-number ko istemal
// kar sakta hai (jaise Amazon/Flipkart/Zomato mein hota hai), apne account
// wale phone tak limited nahi rehta. Reward/cancelCount jaisi account-level
// cheezein hamesha real logged-in account (email se dhoondha gaya) par hi
// update hoti hain — delivery-phone chahe kuch bhi ho.
// ==========================================
app.post('/api/order/place', orderLimiter, async (req, res) => {
  try {
    const { cartItems, customerDetails, userToken } = req.body;
    if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
      return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
    }

    // 🛡️ Delivery-contact number sirf format-validate hota hai — account
    // ke phone se match karna zaroori NAHI hai (Amazon-style behaviour).
    if (!isValidPhone(customerDetails.phone)) {
      return res.json({ success: false, message: "Sahi delivery mobile number daalein!" });
    }
    const deliveryName = cleanText(customerDetails.name, 60);
    const deliveryAddress = cleanText(customerDetails.address, 300);
    if (!deliveryName || !deliveryAddress) {
      return res.json({ success: false, message: "Naam aur address zaroori hai!" });
    }

    const tokenEmail = await verifyAndGetEmail(userToken);
    const userAccount = await getUserAccountByEmail(tokenEmail);

    if (!userAccount) return res.json({ success: false, message: "User record nahi mila." });
    if (userAccount.blocked === true) return res.json({ success: false, message: "Aapka account block hai. Aap order nahi kar sakte." });

    const settingsDB = (await db.ref('/settings').once('value')).val() || {};
    if (settingsDB.isAppClosed === true) return res.json({ success: false, message: "Abhi dukan band hai." });

    const productsDB = (await db.ref('/products').once('value')).val() || {};
    let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 20; // 🛡️ FIX #17: default ab 20 hai, customer/admin app ke defaults se consistent (pehle 0 tha, jo mismatch create karta tha)
    let adminFreeLimit = parseInt(settingsDB.minFreeDeliveryThreshold) || 0;

    let secureSubtotal = 0; let secureItemsList = []; let itemsObj = [];

    for (let itemId in cartItems) {
      let qty = parseFloat(cartItems[itemId]);
      let asliProduct = productsDB[itemId];
      if (asliProduct && !isNaN(qty) && qty > 0) {
        let currentStock = parseFloat(asliProduct.stock) || 0;
        if (currentStock < qty) {
          return res.json({ success: false, message: `Sorry, '${asliProduct.nameEn || "Item"}' available nahi hai. Sirf ${currentStock} bache hain.` });
        }
        let itemTotal = asliProduct.price * qty;
        secureSubtotal += itemTotal;
        let itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
        let itemQtyText = asliProduct.qtyText || "1 Kg";
        secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
        itemsObj.push({ id: itemId, name: itemName, nameHi: asliProduct.nameHi || "", price: itemTotal, basePrice: asliProduct.price, qty, qtyText: itemQtyText });
      }
    }

    if (secureSubtotal === 0) return res.json({ success: false, message: "Cart is empty" });

    let stockDeducted = []; let transactionFailed = false; let failedItemName = "";

    for (let item of itemsObj) {
      const productRef = db.ref(`/products/${item.id}`);
      const result = await productRef.transaction((product) => {
        if (product) {
          let currentStock = parseFloat(product.stock) || 0;
          if (currentStock >= item.qty) { product.stock = currentStock - item.qty; return product; }
          return undefined;
        }
        return null;
      });
      if (result.committed) stockDeducted.push(item);
      else { transactionFailed = true; failedItemName = item.name; break; }
    }

    if (transactionFailed) {
      for (let dItem of stockDeducted) {
        await db.ref(`/products/${dItem.id}`).transaction((product) => {
          if (product) product.stock = (parseFloat(product.stock) || 0) + dItem.qty;
          return product;
        });
      }
      return res.json({ success: false, message: `Oops! Kisi aur ne '${failedItemName}' order kar liya. Please cart update karein.` });
    }

    let secureDeliveryCharge = (adminFreeLimit > 0 && secureSubtotal >= adminFreeLimit) ? 0 : adminDeliveryFee;

    // 🛡️ FIX: reward hamesha ACCOUNT node (email se mila accountPhone) par
    // update hota hai — customerDetails.phone (jo alag delivery-number ho
    // sakta hai) par nahi.
    // 🛡️ CRITICAL FIX (#5): pehle sirf `freeDeliveries > 0` check hota tha —
    // `rewardExpiry` bilkul check nahi hota tha! Agar client-side expiry-zeroing
    // (jo customer.html mein hai) abhi tak run nahi hui thi, ya koi direct-API
    // call kare, to EXPIRED reward bhi apply ho sakta tha. Ab expiry bhi
    // explicitly check hoti hai.
    const isRewardStillValid = !userAccount.rewardExpiry || userAccount.rewardExpiry > Date.now();
    if (customerDetails.usedReward && isRewardStillValid && secureSubtotal > 0 && parseInt(userAccount.freeDeliveries) > 0) {
      secureDeliveryCharge = 0;
      let newFreeDel = parseInt(userAccount.freeDeliveries) - 1;
      await db.ref(`/users/${userAccount.accountPhone}`).update({ freeDeliveries: newFreeDel });
    }

    let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

    let assignedRiderEmail = null;
    const ridersSnap = await db.ref('/riders').orderByChild('status').equalTo('online').once('value');
    if (ridersSnap.exists()) {
      const onlineRiders = Object.values(ridersSnap.val());
      const allOrders = (await db.ref('/orders').once('value')).val() || {};
      let activeCounts = {};
      onlineRiders.forEach(r => { activeCounts[r.email] = 0; });
      for (let key in allOrders) {
        let ord = allOrders[key];
        if (ord.assignedRider && activeCounts[ord.assignedRider] !== undefined) {
          if (['Packing in Progress ⏳', 'Confirmed', 'Out for Delivery'].includes(ord.status)) activeCounts[ord.assignedRider]++;
        }
      }
      let minCount = Infinity;
      for (let email in activeCounts) { if (activeCounts[email] < minCount) minCount = activeCounts[email]; }
      const bestRiders = onlineRiders.filter(r => activeCounts[r.email] === minCount);
      assignedRiderEmail = bestRiders[Math.floor(Math.random() * bestRiders.length)].email;
    }

    const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderTimestamp = Date.now();

    const orderData = {
      id: orderId, timestamp: orderTimestamp, status: "Packing in Progress ⏳", total: secureFinalTotal,
      deliveryCharge: secureDeliveryCharge, customer: deliveryName, phone: customerDetails.phone,
      email: userAccount.email || '', address: deliveryAddress, items: itemsObj, assignedRider: assignedRiderEmail,
      usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && !!customerDetails.usedReward
    };

    await db.ref(`/orders/${orderId}`).set(orderData);

    if (TELEGRAM_SCRIPT_URL) {
      const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${deliveryName}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${deliveryAddress}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}${!assignedRiderEmail ? '\n\n⚠️ *KOI RIDER ONLINE NAHI THA — auto-assign hoga jab koi duty ON karega.*' : ''}`;
      await fetch(TELEGRAM_SCRIPT_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ 'message': teleMessage })
      }).catch(e => console.log("Telegram error: ", e));
    }

    if (assignedRiderEmail && ONESIGNAL_RIDER_APP_ID && ONESIGNAL_RIDER_REST_KEY) {
      try {
        const payload = {
          app_id: ONESIGNAL_RIDER_APP_ID,
          filters: [{ field: "tag", key: "rider_email", relation: "=", value: assignedRiderEmail }],
          headings: { en: "🚨 Naya Order Aaya Hai!" },
          contents: { en: `Order #${orderId} - ₹${secureFinalTotal} ki delivery hai.` }
        };
        await fetch("https://onesignal.com/api/v1/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Basic ${ONESIGNAL_RIDER_REST_KEY}` },
          body: JSON.stringify(payload)
        });
      } catch (e) { console.error("🚨 OneSignal Request Failed:", e); }
    }

    res.json({ success: true, orderId, orderTimestamp });
  } catch (error) {
    console.error("Order Manager Error:", error);
    res.json({ success: false, message: "VIP Token Invalid ya Order Fail ho gaya" });
  }
});

// ==========================================
// 5b. Referral/return-count jaisi account-level cheezein ab hamesha
// order.email se account dhoondh ke update hoti hain (order.phone ek
// alag delivery-contact ho sakta hai, account-key nahi).
// ==========================================
async function processReferralOnDelivery(orderData) {
  if (!orderData.email) return;
  const account = await getUserAccountByEmail(orderData.email);
  if (!account || !account.referredBy || account.referralStatus !== "pending") return;
  const userRef = db.ref(`/users/${account.accountPhone}`);
  const { committed, snapshot } = await userRef.transaction((user) => {
    if (user && user.referredBy && user.referralStatus === "pending") { user.referralStatus = "completed_processing"; return user; }
    return undefined;
  });
  if (committed && snapshot.val()) {
    const userData = snapshot.val();
    await db.ref(`/users/${userData.referredBy}`).transaction((referrer) => {
      if (referrer) { referrer.freeDeliveries = (parseInt(referrer.freeDeliveries) || 0) + 3; referrer.rewardExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); }
      return referrer;
    });
    await userRef.update({ referralStatus: "completed" });
  }
}
async function restockCancelledItems(orderData) {
  if (!orderData.items) return;
  for (let item of orderData.items) {
    if (item.id) {
      await db.ref(`/products/${item.id}`).transaction((product) => {
        if (product) product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
        return product;
      });
    }
  }
}
async function incrementAccountCounter(email, field) {
  if (!email) return;
  const account = await getUserAccountByEmail(email);
  if (!account) return;
  await db.ref(`/users/${account.accountPhone}/${field}`).transaction(c => (c || 0) + 1);
}

// ==========================================
// 6. 🛵 RIDER: STATUS UPDATE
// 🛡️ CRITICAL FIX: ab caller ki rider-membership DB mein verify hoti hai.
// 🛡️ FIX: ab order-claiming (assignedRider null → set) transaction se hoti
// hai taaki do riders ek saath ek hi unclaimed order na claim kar sakein,
// aur koi bhi authenticated user (rider na hote hue bhi) unclaimed order
// status badal na sake.
// 🛡️ FIX: cancelReason ab backend mein save hota hai (pehle silently lost hota tha)
// ==========================================
app.post('/api/order/rider-update', riderActionLimiter, async (req, res) => {
  try {
    const { orderId, newStatus, riderToken, cancelReason } = req.body;
    if (!orderId || !newStatus || !riderToken) return res.json({ success: false, message: "Missing info" });

    const decodedRider = await admin.auth().verifyIdToken(riderToken);
    const riderEmail = decodedRider.email;
    const riderUid = decodedRider.uid;

    // 🛡️ CRITICAL: caller sach mein registered rider hai ya nahi
    if (!(await isRegisteredRider(riderUid))) {
      return res.json({ success: false, message: "Aap rider ke roop mein register nahi hain." });
    }

    const canonicalStatus = normalizeStatus(newStatus);
    if (!canonicalStatus || !ALLOWED_RIDER_STATUSES.includes(canonicalStatus)) {
      return res.json({ success: false, message: "Invalid status." });
    }

    const orderRef = db.ref(`/orders/${orderId}`);
    const orderSnap = await orderRef.once('value');
    const orderData = orderSnap.val();
    if (!orderData) return res.json({ success: false, message: "Order not found." });

    if (orderData.assignedRider) {
      // Already kisi rider ko assign ho chuka hai — sirf wahi rider isse touch kar sakta hai
      if (orderData.assignedRider !== riderEmail) {
        return res.json({ success: false, message: "Yeh order kisi aur rider ke paas hai." });
      }
    } else {
      // 🛡️ Unassigned/orphan order — sirf "Confirmed" (accept) transition se
      // hi claim ho sakta hai, koi bhi doosra status-jump allowed nahi.
      if (canonicalStatus !== 'Confirmed') {
        return res.json({ success: false, message: "Pehle order ko Accept karein." });
      }
      // 🛡️ Transaction-safe claim — race-condition proof taaki 2 riders
      // ek saath same order claim na kar payein.
      const claimResult = await orderRef.child('assignedRider').transaction((current) => {
        if (current) return; // koi aur pehle hi claim kar chuka — abort
        return riderEmail;
      });
      if (!claimResult.committed) {
        return res.json({ success: false, message: "Ye order abhi-abhi kisi aur rider ko assign ho gaya." });
      }
    }

    const wasActive = !['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(orderData.status);
    const isNowCancelled = ['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(canonicalStatus);

    if (wasActive && isNowCancelled) await restockCancelledItems(orderData);
    if (canonicalStatus === "Delivered" && orderData.status !== "Delivered") await processReferralOnDelivery(orderData);
    if (canonicalStatus === "Returned/Rejected") await incrementAccountCounter(orderData.email, 'returnCount');

    const updates = { status: canonicalStatus };
    if (isNowCancelled && cancelReason) updates.cancelReason = cleanText(cancelReason, 200);

    await orderRef.update(updates);
    res.json({ success: true, message: "Status Updated Successfully" });
  } catch (error) {
    console.error("Rider update error:", error);
    res.json({ success: false, message: "Update fail ho gaya." });
  }
});

// ==========================================
// 6b. 🛵🆕 RIDER: DUTY ON/OFF + AUTO-ASSIGN UNCLAIMED ORDERS
// 🛡️ CRITICAL FIX: pehle YE endpoint tha jahan koi bhi authenticated user
// (customer bhi) khud ko "online rider" bana ke saare pending orders apne
// paas assign karva sakta tha. Ab caller ki rider-membership verify hoti hai.
// ==========================================
app.post('/api/rider/set-duty', riderActionLimiter, async (req, res) => {
  try {
    const { riderToken, isOnline } = req.body;
    if (!riderToken || typeof isOnline !== 'boolean') {
      return res.json({ success: false, message: "Missing info" });
    }

    const decodedRider = await admin.auth().verifyIdToken(riderToken);
    const riderEmail = decodedRider.email;
    const riderUid = decodedRider.uid;

    // 🛡️ CRITICAL: sabse pehle verify karo ki ye asli registered rider hai
    if (!(await isRegisteredRider(riderUid))) {
      return res.json({ success: false, message: "Aap rider ke roop mein register nahi hain." });
    }

    await db.ref(`/riders/${riderUid}`).update({
      email: riderEmail,
      status: isOnline ? 'online' : 'offline',
      lastActive: Date.now()
    });

    let reassignedCount = 0;

    if (isOnline) {
      const ordersSnap = await db.ref('/orders')
        .orderByChild('status')
        .equalTo('Packing in Progress ⏳')
        .once('value');
      const allPending = ordersSnap.val() || {};

      const unassigned = Object.keys(allPending)
        .map(key => ({ key, ...allPending[key] }))
        .filter(o => !o.assignedRider)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      for (const order of unassigned) {
        const orderRef = db.ref(`/orders/${order.key}`);
        const result = await orderRef.transaction((current) => {
          if (current && !current.assignedRider) {
            current.assignedRider = riderEmail;
            return current;
          }
          return current;
        });

        if (result.committed && result.snapshot.val() && result.snapshot.val().assignedRider === riderEmail) {
          reassignedCount++;
          if (ONESIGNAL_RIDER_APP_ID && ONESIGNAL_RIDER_REST_KEY) {
            try {
              const payload = {
                app_id: ONESIGNAL_RIDER_APP_ID,
                filters: [{ field: "tag", key: "rider_email", relation: "=", value: riderEmail }],
                headings: { en: "📦 Purana Order Mila!" },
                contents: { en: `Order #${order.id || order.key} aapko assign ho gaya hai.` }
              };
              await fetch("https://onesignal.com/api/v1/notifications", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Basic ${ONESIGNAL_RIDER_REST_KEY}` },
                body: JSON.stringify(payload)
              });
            } catch (e) { console.error("OneSignal reassign push error:", e); }
          }
        }
      }
    }

    res.json({
      success: true,
      message: isOnline
        ? (reassignedCount > 0 ? `Duty ON! ${reassignedCount} purana order aapko mil gaya.` : "Duty ON ho gayi.")
        : "Duty OFF ho gayi.",
      reassignedCount
    });
  } catch (error) {
    console.error("Set duty error:", error);
    res.json({ success: false, message: "Duty update fail ho gayi." });
  }
});

// ==========================================
// 7. 🎁 ADMIN: ORDER STATUS UPDATE
// ==========================================
app.post('/api/order/update-status', adminActionLimiter, async (req, res) => {
  try {
    const { orderId, newStatus, adminToken, cancelReason } = req.body;
    if (!orderId || !newStatus || !adminToken) return res.json({ success: false, message: "Missing info" });

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) throw new Error("Aapko Admin access nahi hai!");

    // 🛡️ FIX: dropdown se aane wali bina-emoji value ab canonical form mein map ho jaati hai
    const canonicalStatus = normalizeStatus(newStatus);
    if (!canonicalStatus || !ALLOWED_ADMIN_STATUSES.includes(canonicalStatus)) {
      return res.json({ success: false, message: "Invalid status." });
    }

    const orderRef = db.ref(`/orders/${orderId}`);
    const orderSnap = await orderRef.once('value');
    const orderData = orderSnap.val();
    if (!orderData) return res.json({ success: false, message: "Order not found" });

    const wasActive = !['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(orderData.status);
    const isNowCancelled = ['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(canonicalStatus);

    if (wasActive && isNowCancelled) await restockCancelledItems(orderData);
    if (canonicalStatus === "Delivered" && orderData.status !== "Delivered") await processReferralOnDelivery(orderData);
    if (canonicalStatus === "Returned/Rejected") await incrementAccountCounter(orderData.email, 'returnCount');

    const updates = { status: canonicalStatus };
    if (isNowCancelled && cancelReason) updates.cancelReason = cleanText(cancelReason, 200);

    await orderRef.update(updates);
    res.json({ success: true, message: "Status updated securely" });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 8. 🎁 ADMIN: MANUAL REWARD DENA
// 🛡️ FIX: rewardCount par ab upper-bound sanity-check hai (galti se koi
// bahut bada number na de de), aur targetPhone format validate hota hai.
// ==========================================
app.post('/api/admin/give-reward', adminActionLimiter, async (req, res) => {
  try {
    const { targetPhone, rewardCount, adminToken } = req.body;
    if (!targetPhone || !rewardCount || !adminToken) return res.json({ success: false, message: "Missing info" });

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) throw new Error("Admin access denied");

    const parsedCount = parseInt(rewardCount);
    if (isNaN(parsedCount) || Math.abs(parsedCount) > 30) {
      return res.json({ success: false, message: "Reward count -30 se +30 ke beech hona chahiye." });
    }

    const userData = (await db.ref(`/users/${targetPhone}`).once('value')).val();
    if (!userData) return res.json({ success: false, message: "User nahi mila" });

    let currentFreeDel = parseInt(userData.freeDeliveries) || 0;
    let newFreeDel = currentFreeDel + parsedCount;
    let newExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000);

    await db.ref(`/users/${targetPhone}`).update({
      freeDeliveries: newFreeDel > 0 ? newFreeDel : 0,
      rewardExpiry: newFreeDel > 0 ? newExpiry : null
    });

    res.json({ success: true, message: `Reward manually added to ${targetPhone}` });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 9. 🚫 SECURE ORDER CANCEL
// 🛡️ FIX: ab email se account dhoondha jaata hai (order.email match check
// hamesha tha, wo sahi tha) — sirf cancelCount update ab account-node par
// jaata hai, order.phone (delivery-contact) par nahi.
// ==========================================
app.post('/api/order/cancel', orderLimiter, async (req, res) => {
  try {
    const { orderId, cancelReason, userToken } = req.body;
    if (!orderId || !userToken) return res.json({ success: false, message: "Missing info" });

    const tokenEmail = await verifyAndGetEmail(userToken);
    const orderData = (await db.ref(`/orders/${orderId}`).once('value')).val();
    if (!orderData) return res.json({ success: false, message: "Order nahi mila." });

    if ((orderData.email || "").toLowerCase() !== tokenEmail) {
      return res.json({ success: false, message: "Security Alert: Aap sirf apna order cancel kar sakte hain." });
    }

    if (orderData.status !== 'Packing in Progress ⏳' && orderData.status !== 'Confirmed') {
      return res.json({ success: false, message: "Order pack ho chuka hai, ab cancel nahi ho sakta." });
    }

    await restockCancelledItems(orderData);

    await db.ref(`/orders/${orderId}`).update({
      status: 'Cancelled by Customer',
      cancelReason: cleanText(cancelReason || 'No reason provided', 200)
    });

    await incrementAccountCounter(orderData.email, 'cancelCount');

    res.json({ success: true, message: "Order successfully cancel ho gaya." });
  } catch (error) { res.json({ success: false, message: "Server error" }); }
});

// ==========================================
// 10. 👨‍💼 ADMIN: CREATE RIDER ACCOUNT
// ==========================================
app.post('/api/admin/create-rider', adminActionLimiter, async (req, res) => {
  try {
    const { name, email, password, phone, adminToken } = req.body;
    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) return res.json({ success: false, message: "Access denied" });

    if (!name || !email || !password || !phone) return res.json({ success: false, message: "Saari details bharein!" });
    if (!isValidEmail(email)) return res.json({ success: false, message: "Sahi email daalein!" });
    if (!isValidPhone(phone)) return res.json({ success: false, message: "Sahi 10-digit phone daalein!" });
    if (String(password).length < 6) return res.json({ success: false, message: "Password kam se kam 6 character ka ho!" });

    const cleanName = cleanText(name, 60);
    const userRecord = await admin.auth().createUser({ email, password, displayName: cleanName });
    await db.ref(`/riders/${userRecord.uid}`).set({ name: cleanName, email, phone, status: 'offline', createdAt: Date.now() });

    res.json({ success: true, message: "Rider successfully ban gaya!" });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 10b. 🆕 ADMIN: DELETE RIDER (poora — Auth account samet)
// 🛡️ FIX: pehle admin-panel sirf `/riders/{uid}` DB-node delete karta tha,
// jisse rider ka Firebase Auth account (email+password) valid hi rehta
// tha — fired rider phir bhi login karke dobara apna rider-node bana sakta
// tha. Ab ye endpoint dono hataata hai: DB node aur Auth account.
// ==========================================
app.post('/api/admin/delete-rider', adminActionLimiter, async (req, res) => {
  try {
    const { riderUid, adminToken } = req.body;
    if (!riderUid || !adminToken) return res.json({ success: false, message: "Missing info" });

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) return res.json({ success: false, message: "Access denied" });

    await db.ref(`/riders/${riderUid}`).remove();
    try {
      await admin.auth().deleteUser(riderUid);
    } catch (authErr) {
      console.warn("Rider Auth account delete warning (DB node phir bhi hata diya gaya):", authErr.message);
    }

    res.json({ success: true, message: "Rider poori tarah hata diya gaya (DB + Login access)." });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 11. 🔔 ADMIN: SECURE BROADCAST NOTIFICATION
// ==========================================
app.post('/api/admin/send-notification', adminActionLimiter, async (req, res) => {
  try {
    const { title, message, adminToken } = req.body;

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) {
      return res.json({ success: false, message: "Aapko Admin access nahi hai!" });
    }

    console.log(`🔔 Notification Request Aayi! Title: ${title}`);

    if (!title || !message) {
      return res.json({ success: false, message: "Title aur message zaroori hai." });
    }
    if (String(title).length > 60) {
      return res.json({ success: false, message: "Title 60 characters se zyada nahi ho sakta." });
    }
    if (String(message).length > 200) {
      return res.json({ success: false, message: "Message 200 characters se zyada nahi ho sakta." });
    }

    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) {
      console.error("🚨 ERROR: OneSignal Keys Render mein missing hain!");
      return res.json({ success: false, message: "OneSignal Keys Missing!" });
    }

    const payload = {
      app_id: ONESIGNAL_APP_ID,
      included_segments: ["All"],
      headings: { en: cleanText(title, 60) },
      contents: { en: cleanText(message, 200) }
    };

    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (data.errors) {
      console.error("🚨 OneSignal Error:", data.errors);
      return res.json({ success: false, message: "OneSignal Error: " + JSON.stringify(data.errors) });
    }

    res.json({ success: true, message: "Notification sabko bhej di gayi hai! 🚀", response: data });
  } catch (error) {
    console.error("🚨 Notification Catch Error:", error);
    res.json({ success: false, message: "Server error, Render Logs check karein." });
  }
});

// ==========================================
// 12. 🛵 RIDER DASHBOARD: Pending Orders
// 🛡️ CRITICAL FIX: caller ki rider-membership ab verify hoti hai
// ==========================================
app.post('/api/rider/my-orders', riderActionLimiter, async (req, res) => {
  try {
    const { riderToken } = req.body;
    if (!riderToken) return res.json({ success: false, message: "Token missing" });

    const decodedRider = await admin.auth().verifyIdToken(riderToken);
    const riderEmail = decodedRider.email;
    const riderUid = decodedRider.uid;

    if (!(await isRegisteredRider(riderUid))) {
      return res.json({ success: false, message: "Aap rider ke roop mein register nahi hain." });
    }

    const ordersSnap = await db.ref('/orders').orderByChild('assignedRider').equalTo(riderEmail).once('value');
    const allOrders = ordersSnap.val() || {};

    let pendingOrders = []; let totalPendingCount = 0;
    for (let key in allOrders) {
      let order = allOrders[key];
      if (order.status !== 'Delivered' && order.status !== 'Cancelled by Customer' && order.status !== 'Cancelled by SabziFresh' && order.status !== 'Returned/Rejected') {
        pendingOrders.push(order); totalPendingCount++;
      }
    }
    res.json({ success: true, count: totalPendingCount, orders: pendingOrders });
  } catch (error) { res.json({ success: false, message: "Orders load nahi hue." }); }
});

// ==========================================
// 🧹 SCHEDULED CLEANUP JOBS
// Ye backend-side chalta hai — Admin panel khula ho ya nahi, dono mein
// kaam karta hai (pehle notification-cleanup sirf Admin panel ke client-
// side setInterval() se chalta tha, jo panel band hone par ruk jaata tha).
// NOTE: Render free-tier idle hone par sleep hota hai, isliye ye jobs
// "best-effort" hain — jab server active/awake hai tabhi chalenge. Ye
// vaisi hi limitation hai jo humne OTP rate-limiters ke liye pehle bhi
// discuss ki thi.
// ==========================================
const OTP_STALE_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;      // 2 din
const INBOX_RETENTION_MS = 24 * 60 * 60 * 1000;               // 24 ghante — jaisa maanga gaya
const NOTIF_HISTORY_RETENTION_MS = 24 * 60 * 60 * 1000;       // 24 ghante
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;               // har 6 ghante

// 🛡️ FIX (#11): otp_data/{hex} node har OTP-request pe banta hai lekin
// kabhi delete nahi hota tha — verify-success par sirf fields reset hote
// the (otp="", sendCount=0), node hamesha ke liye reh jaata tha. Bina
// bound-growth control ke, ye node hazaaron records jama kar leta.
async function cleanupStaleOtpRecords() {
  try {
    const snap = await db.ref('otp_data').once('value');
    const data = snap.val();
    if (!data) return;
    const now = Date.now();
    const updates = {};
    let count = 0;
    Object.keys(data).forEach(key => {
      const rec = data[key];
      const lastActivity = Math.max(rec.otpTime || 0, rec.blockedUntil || 0);
      const isStale = (now - lastActivity) > OTP_STALE_RETENTION_MS;
      const isUnblocked = !rec.blockedUntil || rec.blockedUntil <= now;
      if (isStale && isUnblocked) { updates[key] = null; count++; }
    });
    if (count > 0) {
      await db.ref('otp_data').update(updates);
      console.log(`🧹 Cleanup: ${count} stale otp_data records hataye`);
    }
  } catch (e) { console.error("OTP cleanup error:", e); }
}

// 🛡️ FIX (#12): users/{phone}/inbox/{id} sirf tab delete hoti thi jab
// customer khud "read" mark karta — agar kabhi na khole, notification
// hamesha ke liye DB mein padi rehti (unbounded growth). Customer app
// ka listener bhi 30-din se purani entries ko sirf "invisible" karta tha
// (query filter se), delete nahi karta tha.
async function cleanupOldUserInboxes() {
  try {
    const cutoff = Date.now() - INBOX_RETENTION_MS;
    const usersSnap = await db.ref('users').once('value');
    const usersData = usersSnap.val();
    if (!usersData) return;
    let totalDeleted = 0;
    for (const phone of Object.keys(usersData)) {
      const inbox = usersData[phone].inbox;
      if (!inbox) continue;
      const updates = {};
      let count = 0;
      Object.keys(inbox).forEach(notifId => {
        if ((inbox[notifId].timestamp || 0) < cutoff) { updates[notifId] = null; count++; }
      });
      if (count > 0) {
        await db.ref(`users/${phone}/inbox`).update(updates);
        totalDeleted += count;
      }
    }
    if (totalDeleted > 0) console.log(`🧹 Cleanup: ${totalDeleted} purani inbox-notifications hataye (${INBOX_RETENTION_MS / 86400000} din se purani)`);
  } catch (e) { console.error("Inbox cleanup error:", e); }
}

// 🛡️ FIX (#13): pehle ye sirf Admin panel ke client-side setInterval() se
// chalta tha — Admin panel band ho to cleanup ruk jaata. Ab backend-scheduled
// hai, isliye hamesha chalega (jab tak Render process awake hai).
async function cleanupNotificationsHistory() {
  try {
    const cutoff = Date.now() - NOTIF_HISTORY_RETENTION_MS;
    const snap = await db.ref('notifications').orderByChild('timestamp').endAt(cutoff).once('value');
    const data = snap.val();
    if (!data) return;
    const updates = {};
    Object.keys(data).forEach(k => { updates[k] = null; });
    await db.ref('notifications').update(updates);
    console.log(`🧹 Cleanup: ${Object.keys(updates).length} purani notification-history entries hataye`);
  } catch (e) { console.error("Notification-history cleanup error:", e); }
}

function runScheduledCleanup() {
  cleanupStaleOtpRecords();
  cleanupOldUserInboxes();
  cleanupNotificationsHistory();
}
runScheduledCleanup(); // startup par ek baar turant
setInterval(runScheduledCleanup, CLEANUP_INTERVAL_MS);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`Server port ${PORT} par chal raha hai`); });
