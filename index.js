const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);

// ==========================================
// 🛡️ CORS — sirf whitelist domains ke liye khula
// (pehle app.use(cors()) sabke liye khula tha — FIX)
// ==========================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('CORS blocked: origin not allowed'));
  }
}));
app.use(express.json());

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES
// ==========================================
const OTP_EXPIRE_MIN = 10;
const OTP_MAX_SEND_PER_DAY = 4;
const OTP_MAX_VERIFY_ATTEMPTS = 5;
const OTP_BLOCK_HOURS = 24;
const APP_NAME = "Sabzi Fresh";

// 📧 Mail Relay (Google Apps Script) — Render free tier SMTP ports block
// karta hai, isliye email HTTPS ke through ek GAS "relay" se bhejte hain.
// GAS sirf mail bhejta hai — koi OTP logic wahan nahi hai.
const MAIL_RELAY_URL = (process.env.MAIL_RELAY_URL || "").trim();
const MAIL_RELAY_SECRET = (process.env.MAIL_RELAY_SECRET || "").trim();

const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();

const ONESIGNAL_APP_ID = (process.env.ONESIGNAL_APP_ID || "").trim();
const ONESIGNAL_REST_KEY = (process.env.ONESIGNAL_REST_KEY || "").trim();
const ONESIGNAL_RIDER_APP_ID = (process.env.ONESIGNAL_RIDER_APP_ID || "").trim();
const ONESIGNAL_RIDER_REST_KEY = (process.env.ONESIGNAL_RIDER_REST_KEY || "").trim();

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "neerajkumar00999666@gmail.com").trim().toLowerCase();

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
    console.warn("🚨 WARNING: FIREBASE_SERVICE_ACCOUNT_JSON variable missing hai!");
  }
} catch (error) {
  console.error("🚨 ERROR: JSON Parse fail ho gaya. Variable theek se load nahi hua.", error);
}

const db = admin.database();

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Sabzi Fresh API — Secure Backend Live Hai!' });
});

// ==========================================
// 🛡️ RATE LIMITERS
// ==========================================
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Bahut zyada attempts. Thodi der baad try karein." }
});
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});

// ==========================================
// 🔑 OTP DATA HELPERS (Firebase 'otp_data/' node mein store hota hai)
// ==========================================
function emailToKey(email) {
  // Firebase key mein '.', '#', '$', '/', '[', ']' allowed nahi hain
  return Buffer.from(email).toString('hex');
}

async function getOtpRecord(email) {
  const key = emailToKey(email);
  const snap = await db.ref(`otp_data/${key}`).once('value');
  return snap.val() || {
    sendCount: 0,
    verifyAttempts: 0,
    date: "",
    blockedUntil: 0,
    otp: "",
    otpTime: 0
  };
}
async function setOtpRecord(email, data) {
  const key = emailToKey(email);
  await db.ref(`otp_data/${key}`).set(data);
}

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function isValidEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
function todayIST() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ==========================================
// ==========================================
// 📧 MAIL — PREMIUM OTP TEMPLATE (GAS Relay ke through)
// ==========================================
async function sendOtpEmail(email, otp) {
  if (!MAIL_RELAY_URL || !MAIL_RELAY_SECRET) {
    console.warn("🚨 MAIL_RELAY_URL/SECRET missing — email nahi ja sakti!");
    return false;
  }
  try {
    // OTP ke 6 dabbe (boxes) banane ka code
    const otpDigitsHtml = otp.split("").map(d =>
      `<td style="padding:0 5px;"><div style="width:40px;height:48px;background:#f0faf0;border:2px solid #2e7d32;border-radius:8px;font-size:24px;font-weight:bold;color:#1b5e20;text-align:center;line-height:48px;font-family:monospace;">${d}</div></td>`
    ).join("");

    // Wahi Purana aur Premium HTML Design
    const htmlBody = `
      <div style="background-color:#f4f7f4; padding:20px 0; font-family:Arial, sans-serif; color:#333;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
          <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:12px; overflow:hidden; box-shadow: 0 4px 10px rgba(0,0,0,0.1);">
            
            <!-- 🥦 Header Section -->
            <tr>
              <td style="background-color:#2e7d32; padding:30px; text-align:center; color:#ffffff;">
                <div style="font-size:40px; margin-bottom:10px;">🥦</div>
                <h1 style="margin:0; font-size:24px; font-weight:bold; letter-spacing:1px;">${APP_NAME}</h1>
                <p style="margin:5px 0 0 0; font-size:14px; opacity:0.9;">Taaza Sabzi, Seedha Aapke Ghar</p>
              </td>
            </tr>
            
            <!-- ✉️ Body Section -->
            <tr>
              <td style="padding:30px;">
                <h2 style="color:#2e7d32; margin-top:0; font-size:20px;">Namaste! 👋</h2>
                <p style="font-size:15px; color:#555; line-height:1.5; margin-bottom:25px;">
                  Aapne <b>${APP_NAME}</b> mein login karne ki koshish ki hai. Neeche diya gaya OTP use karein:
                </p>
                
                <!-- 🔢 OTP Box -->
                <div style="background-color:#f9f9f9; border:1px solid #e0e0e0; border-radius:10px; padding:20px; text-align:center; margin-bottom:20px;">
                  <p style="font-size:12px; color:#888; font-weight:bold; letter-spacing:1px; margin-top:0; text-transform:uppercase;">Aapka One-Time Password</p>
                  <table style="margin:0 auto;"><tr>${otpDigitsHtml}</tr></table>
                  <p style="font-size:13px; color:#d32f2f; margin:15px 0 0 0;">
                    ⏰ Ye OTP sirf <b>${OTP_EXPIRE_MIN} minute</b> tak valid hai.
                  </p>
                </div>
                
                <!-- 🔒 Security Alert Box -->
                <div style="background-color:#fff8e1; border-left:4px solid #ffb300; padding:15px; border-radius:4px; margin-bottom:25px;">
                  <p style="margin:0; font-size:13px; color:#665c00; line-height:1.5;">
                    🔒 <b>Security Alert:</b> Ye OTP <b>kisi ke saath share na karein</b> - Sabzi Fresh ka koi bhi employee aapse OTP kabhi nahi maangta.
                  </p>
                </div>
                
                <!-- 📝 Instructions -->
                <h3 style="font-size:15px; color:#333; margin-bottom:15px;">Kaise use karein:</h3>
                <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px; color:#555; line-height:1.6;">
                  <tr>
                    <td width="25" valign="top"><div style="background:#2e7d32; color:#fff; width:18px; height:18px; border-radius:50%; text-align:center; line-height:18px; font-size:12px; font-weight:bold;">1</div></td>
                    <td style="padding-bottom:10px;">Apni Sabzi Fresh app par wapas jaayein</td>
                  </tr>
                  <tr>
                    <td width="25" valign="top"><div style="background:#2e7d32; color:#fff; width:18px; height:18px; border-radius:50%; text-align:center; line-height:18px; font-size:12px; font-weight:bold;">2</div></td>
                    <td style="padding-bottom:10px;">Upar diya gaya OTP type karein</td>
                  </tr>
                  <tr>
                    <td width="25" valign="top"><div style="background:#2e7d32; color:#fff; width:18px; height:18px; border-radius:50%; text-align:center; line-height:18px; font-size:12px; font-weight:bold;">3</div></td>
                    <td>'Verify' button par click karein</td>
                  </tr>
                </table>
                
                <!-- 🛑 Footer -->
                <p style="font-size:12px; color:#999; margin-top:30px; line-height:1.5; border-top:1px solid #eee; padding-top:20px;">
                  Agar aapne login ki koshish <b>nahi</b> ki, toh is email ko ignore karein. Koi action lene ki zaroorat nahi hai.
                </p>
              </td>
            </tr>
          </table>
        </td></tr></table>
      </div>`;

    // Google Script (Dakiye) ko message bhejna
    const resp = await fetch(MAIL_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: MAIL_RELAY_SECRET,
        to: email,
        subject: `🥦 ${APP_NAME} - Aapka Login OTP`,
        text: `Aapka OTP: ${otp} (${OTP_EXPIRE_MIN} min valid hai)`,
        html: htmlBody
      })
    });

    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error("Mail relay call error:", err);
    return false;
  }
}

// ==========================================
// 1. 📩 OTP BHEJNA
// ==========================================
app.post('/api/otp/send', otpSendLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !isValidEmail(email)) {
      return res.json({ success: false, message: "Valid email daalen." });
    }
    const cleanEmail = email.toLowerCase().trim();
    const now = Date.now();
    const today = todayIST();

    let rec = await getOtpRecord(cleanEmail);

    if (rec.blockedUntil > now) {
      const rem = Math.ceil((rec.blockedUntil - now) / 3600000);
      return res.json({ success: false, message: `Aap ${rem} ghante ke liye block hain.` });
    }
    if (rec.blockedUntil > 0 && rec.blockedUntil <= now) {
      rec.sendCount = 0; rec.blockedUntil = 0;
    }
    if (rec.date !== today) {
      rec.sendCount = 0; rec.date = today;
    }

    if (rec.sendCount >= OTP_MAX_SEND_PER_DAY) {
      rec.blockedUntil = now + (OTP_BLOCK_HOURS * 3600000);
      await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: `Zyada attempts! ${OTP_BLOCK_HOURS} ghante baad try karein.` });
    }

    const otp = generateOTP();
    rec.otp = otp;
    rec.otpTime = now;
    rec.sendCount += 1;
    rec.verifyAttempts = 0;
    await setOtpRecord(cleanEmail, rec);

    const sent = await sendOtpEmail(cleanEmail, otp);
    if (!sent) {
      return res.json({ success: false, message: "Email nahi ja payi. Dobara try karein." });
    }

    res.json({ success: true, message: `OTP bhej diya! ${OTP_EXPIRE_MIN} min mein use karein.` });
  } catch (error) {
    console.error("OTP send error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 2. ✅ OTP VERIFY + VIP PASS (Custom Token)
// ==========================================
app.post('/api/otp/verify', otpVerifyLimiter, async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code || !isValidEmail(email)) {
      return res.json({ success: false, message: "Email aur code zaroori hai" });
    }
    const cleanEmail = email.toLowerCase().trim();
    const now = Date.now();

    let rec = await getOtpRecord(cleanEmail);

    if (rec.blockedUntil > now) {
      const rem = Math.ceil((rec.blockedUntil - now) / 3600000);
      return res.json({ success: false, message: `Aap ${rem} ghante ke liye block hain.` });
    }
    if (!rec.otp) {
      return res.json({ success: false, message: "Pehle OTP mangaiye." });
    }
    if (now - rec.otpTime > OTP_EXPIRE_MIN * 60000) {
      rec.otp = ""; await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: "OTP expire ho gaya! Naya mangaiye." });
    }

    if (rec.otp !== String(code).trim()) {
      rec.verifyAttempts = (rec.verifyAttempts || 0) + 1;
      if (rec.verifyAttempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        rec.otp = "";
        rec.blockedUntil = now + (OTP_BLOCK_HOURS * 3600000);
        await setOtpRecord(cleanEmail, rec);
        return res.json({ success: false, message: `Bahut zyada galat attempts! ${OTP_BLOCK_HOURS} ghante ke liye block ho gaye.` });
      }
      await setOtpRecord(cleanEmail, rec);
      return res.json({ success: false, message: `Galat OTP! (${OTP_MAX_VERIFY_ATTEMPTS - rec.verifyAttempts} attempts baaki)` });
    }

    // ✅ Sahi OTP
    rec.otp = ""; rec.otpTime = 0; rec.sendCount = 0; rec.verifyAttempts = 0;
    await setOtpRecord(cleanEmail, rec);

    // 🎫 VIP PASS — Firebase Admin SDK ka built-in secure custom token
    const uid = emailToKey(cleanEmail);
    const vipToken = await admin.auth().createCustomToken(uid, { email: cleanEmail });

    res.json({ success: true, message: "Email verify ho gaya! ✔️", token: vipToken });
  } catch (error) {
    console.error("OTP verify error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 3. 🛡️ SECURE REGISTRATION (phone verification NAHI hai — sirf email verified)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phone, name, email, referCode, userToken } = req.body;
    const cleanEmail = email ? email.toLowerCase().trim() : "";

    if (!phone || !name || !userToken || !cleanEmail) {
      return res.json({ success: false, message: "Details, Email aur Token zaroori hai!" });
    }

    const decodedToken = await admin.auth().verifyIdToken(userToken);

    if ((decodedToken.email || "").toLowerCase() !== cleanEmail) {
      return res.json({ success: false, message: "Security Alert: Token aur Email match nahi ho rahe!" });
    }

    let referrerPhone = null;
    if (referCode) {
      const referSnap = await db.ref('/referCodes').once('value');
      const allReferCodes = referSnap.val() || {};
      if (allReferCodes[referCode]) {
        referrerPhone = allReferCodes[referCode];
        if (referrerPhone === phone) {
          return res.json({ success: false, message: "Khud ko refer nahi kar sakte!" });
        }
      } else {
        return res.json({ success: false, message: "Referral code galat hai!" });
      }
    }

    const newCode = "SF" + Math.floor(1000 + Math.random() * 9000);
    const newUser = {
      name, email: cleanEmail, phone, savedVillage: "", savedStreet: "", referCode: newCode,
      freeDeliveries: 0, rewardExpiry: null, registeredAt: Date.now(),
      referredBy: referrerPhone || null, referralStatus: referrerPhone ? "pending" : null
    };

    const userSnap = await db.ref(`/users/${phone}`).once('value');
    if (userSnap.exists()) {
      const myWhatsAppNumber = "+918409081468";
      const waMessage = encodeURIComponent(`Hi customer support, main Sabzi Fresh app par apna purana Gmail bhool gaya hoon.\n\nMera Mobile Number: ${phone}\n\nKripya is number ka fir se account banane ka permission de do.`);
      return res.json({
        success: false,
        message: "⚠️ Yeh Mobile Number pehle se registered hai! Kripya us Gmail se Login karein jo aapne pehle use kiya tha.\n\nAgar aap apna purana Gmail bhool gaye hain, toh Admin ko WhatsApp karein.",
        showWhatsAppSupport: true,
        whatsappLink: `https://wa.me/${myWhatsAppNumber}?text=${waMessage}`
      });
    }

    await db.ref(`/users/${phone}`).set(newUser);
    await db.ref(`/referCodes/${newCode}`).set(phone);

    res.json({ success: true, user: newUser });
  } catch (error) {
    console.error("Register Error:", error);
    res.json({ success: false, message: "Server Error ya Invalid Token." });
  }
});

// ==========================================
// 🔧 HELPER: token verify karke email nikalna
// ==========================================
async function verifyAndGetEmail(userToken) {
  const decoded = await admin.auth().verifyIdToken(userToken);
  return (decoded.email || "").toLowerCase().trim();
}

// ==========================================
// 4. 🛒 SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
  try {
    const { cartItems } = req.body;
    if (!cartItems) return res.json({ success: false, message: "Cart khali hai" });

    const productsDB = (await db.ref('/products').once('value')).val() || {};
    const settingsDB = (await db.ref('/settings').once('value')).val() || {};

    let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 0;
    let adminFreeLimit = parseInt(settingsDB.minFreeDeliveryThreshold) || 0;

    let secureSubtotal = 0; let secureItemsList = []; let itemsObj = [];

    for (let itemId in cartItems) {
      let qty = parseFloat(cartItems[itemId]);
      let asliProduct = productsDB[itemId];
      if (asliProduct && !isNaN(qty) && qty > 0) {
        let itemTotal = asliProduct.price * qty;
        secureSubtotal += itemTotal;
        let itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
        let itemQtyText = asliProduct.qtyText || "1 Kg";
        secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
        itemsObj.push({ name: itemName, nameHi: asliProduct.nameHi || "", price: asliProduct.price, qty, qtyText: itemQtyText });
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
// 🛡️ Token ka email 'users/{phone}/email' se match hona zaroori hai
// ==========================================
app.post('/api/order/place', orderLimiter, async (req, res) => {
  try {
    const { cartItems, customerDetails, userToken } = req.body;

    if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
      return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
    }

    const tokenEmail = await verifyAndGetEmail(userToken);

    const userData = (await db.ref(`/users/${customerDetails.phone}`).once('value')).val();

    if (!userData) {
      return res.json({ success: false, message: "User record nahi mila." });
    }
    if ((userData.email || "").toLowerCase() !== tokenEmail) {
      return res.json({ success: false, message: "Security Alert: Aap sirf apne khud ke account se order kar sakte hain." });
    }
    if (userData.blocked === true) {
      return res.json({ success: false, message: "Aapka account block hai. Aap order nahi kar sakte." });
    }

    const settingsDB = (await db.ref('/settings').once('value')).val() || {};
    if (settingsDB.isAppClosed === true) return res.json({ success: false, message: "Abhi dukan band hai. Kripya khulne ke baad order karein." });

    const productsDB = (await db.ref('/products').once('value')).val() || {};
    let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 0;
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

    let stockDeducted = [];
    let transactionFailed = false;
    let failedItemName = "";

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

    if (customerDetails.usedReward && secureSubtotal > 0 && parseInt(userData.freeDeliveries) > 0) {
      secureDeliveryCharge = 0;
      let newFreeDel = parseInt(userData.freeDeliveries) - 1;
      await db.ref(`/users/${customerDetails.phone}`).update({ freeDeliveries: newFreeDel });
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

    const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
    const orderTimestamp = Date.now();

    const orderData = {
      id: orderId, timestamp: orderTimestamp, status: "Packing in Progress ⏳", total: secureFinalTotal,
      deliveryCharge: secureDeliveryCharge, customer: customerDetails.name, phone: customerDetails.phone,
      email: userData.email || '', address: customerDetails.address, items: itemsObj, assignedRider: assignedRiderEmail,
      usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && customerDetails.usedReward
    };

    await db.ref(`/orders/${orderId}`).set(orderData);

    if (TELEGRAM_SCRIPT_URL) {
      const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
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
// 6. 🛵 RIDER: STATUS UPDATE
// ==========================================
const ALLOWED_STATUSES = [
  'Packing in Progress ⏳', 'Confirmed', 'Out for Delivery',
  'Delivered', 'Returned/Rejected', 'Cancelled by SabziFresh'
];

app.post('/api/order/rider-update', async (req, res) => {
  try {
    const { orderId, newStatus, riderToken } = req.body;
    if (!orderId || !newStatus || !riderToken) return res.json({ success: false, message: "Missing info" });

    const decodedRider = await admin.auth().verifyIdToken(riderToken);
    const riderEmail = decodedRider.email;

    if (!ALLOWED_STATUSES.includes(newStatus)) return res.json({ success: false, message: "Invalid status." });

    const orderRef = db.ref(`/orders/${orderId}`);
    const orderSnap = await orderRef.once('value');
    const orderData = orderSnap.val();
    if (!orderData) return res.json({ success: false, message: "Order not found." });

    if (orderData.assignedRider && orderData.assignedRider !== riderEmail) {
      return res.json({ success: false, message: "Yeh order kisi aur rider ke paas hai." });
    }

    const wasActive = !['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(orderData.status);
    const isNowCancelled = ['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(newStatus);

    if (wasActive && isNowCancelled && orderData.items) {
      for (let item of orderData.items) {
        if (item.id) {
          await db.ref(`/products/${item.id}`).transaction((product) => {
            if (product) product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
            return product;
          });
        }
      }
    }

    if (newStatus === "Delivered" && orderData.status !== "Delivered" && orderData.phone) {
      const userRef = db.ref(`/users/${orderData.phone}`);
      const { committed, snapshot } = await userRef.transaction((user) => {
        if (user && user.referredBy && user.referralStatus === "pending") {
          user.referralStatus = "completed_processing";
          return user;
        }
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

    const updates = { status: newStatus };
    if (newStatus === 'Confirmed') updates.assignedRider = riderEmail;

    await orderRef.update(updates);
    res.json({ success: true, message: "Status Updated Successfully" });
  } catch (error) { res.json({ success: false, message: "Update fail ho gaya." }); }
});

// ==========================================
// 7. 🎁 ADMIN: ORDER STATUS UPDATE
// ==========================================
app.post('/api/order/update-status', async (req, res) => {
  try {
    const { orderId, newStatus, adminToken } = req.body;
    if (!orderId || !newStatus || !adminToken) return res.json({ success: false, message: "Missing info" });

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) throw new Error("Aapko Admin access nahi hai!");

    if (!ALLOWED_STATUSES.includes(newStatus) && newStatus !== 'Cancelled by Customer') {
      return res.json({ success: false, message: "Invalid status." });
    }

    const orderRef = db.ref(`/orders/${orderId}`);
    const orderSnap = await orderRef.once('value');
    const orderData = orderSnap.val();
    if (!orderData) return res.json({ success: false, message: "Order not found" });

    const wasActive = !['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(orderData.status);
    const isNowCancelled = ['Cancelled by Customer', 'Cancelled by SabziFresh', 'Returned/Rejected'].includes(newStatus);

    if (wasActive && isNowCancelled && orderData.items) {
      for (let item of orderData.items) {
        if (item.id) {
          await db.ref(`/products/${item.id}`).transaction((product) => {
            if (product) product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
            return product;
          });
        }
      }
    }

    if (newStatus === "Delivered" && orderData.status !== "Delivered" && orderData.phone) {
      const userRef = db.ref(`/users/${orderData.phone}`);
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

    if (newStatus === "Returned/Rejected" && orderData.phone) {
      await db.ref(`/users/${orderData.phone}/returnCount`).transaction(c => (c || 0) + 1);
    }

    await orderRef.update({ status: newStatus });
    res.json({ success: true, message: "Status updated securely" });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 8. 🎁 ADMIN: MANUAL REWARD DENA
// ==========================================
app.post('/api/admin/give-reward', async (req, res) => {
  try {
    const { targetPhone, rewardCount, adminToken } = req.body;
    if (!targetPhone || !rewardCount || !adminToken) return res.json({ success: false, message: "Missing info" });

    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) throw new Error("Admin access denied");

    const userData = (await db.ref(`/users/${targetPhone}`).once('value')).val();
    if (!userData) return res.json({ success: false, message: "User nahi mila" });

    let currentFreeDel = parseInt(userData.freeDeliveries) || 0;
    let newFreeDel = currentFreeDel + parseInt(rewardCount);
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
// 🛡️ Token ka email order.email se match kiya jata hai
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

    if (orderData.items && orderData.items.length > 0) {
      for (let item of orderData.items) {
        if (item.id) {
          const productRef = db.ref(`/products/${item.id}`);
          await productRef.transaction((product) => {
            if (product) product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
            return product;
          });
        }
      }
    }

    await db.ref(`/orders/${orderId}`).update({
      status: 'Cancelled by Customer',
      cancelReason: cancelReason || 'No reason provided'
    });

    if (orderData.phone) {
      const userData = (await db.ref(`/users/${orderData.phone}`).once('value')).val();
      if (userData) {
        const newCancelCount = (parseInt(userData.cancelCount) || 0) + 1;
        await db.ref(`/users/${orderData.phone}`).update({ cancelCount: newCancelCount });
      }
    }

    res.json({ success: true, message: "Order successfully cancel ho gaya." });
  } catch (error) { res.json({ success: false, message: "Server error" }); }
});

// ==========================================
// 10. 👨‍💼 ADMIN: CREATE RIDER ACCOUNT
// ==========================================
app.post('/api/admin/create-rider', async (req, res) => {
  try {
    const { name, email, password, phone, adminToken } = req.body;
    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) return res.json({ success: false, message: "Access denied" });

    const userRecord = await admin.auth().createUser({ email, password, displayName: name });
    await db.ref(`/riders/${userRecord.uid}`).set({ name, email, phone, status: 'offline', createdAt: Date.now() });

    res.json({ success: true, message: "Rider successfully ban gaya!" });
  } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 11. 🔔 ADMIN: SECURE BROADCAST NOTIFICATION
// ==========================================
app.post('/api/admin/send-notification', async (req, res) => {
  try {
    const { title, message, adminToken } = req.body;
    const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
    if ((decodedAdmin.email || "").toLowerCase() !== ADMIN_EMAIL) return res.json({ success: false, message: "Access denied" });

    if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) return res.json({ success: false, message: "OneSignal Keys Missing" });

    const payload = { app_id: ONESIGNAL_APP_ID, included_segments: ["All"], headings: { en: title }, contents: { en: message } };
    const response = await fetch("https://onesignal.com/api/v1/notifications", {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` }, body: JSON.stringify(payload)
    });
    const data = await response.json();
    res.json({ success: true, response: data });
  } catch (error) { res.json({ success: false, message: "Notification send fail." }); }
});

// ==========================================
// 12. 🛵 RIDER DASHBOARD: Pending Orders
// ==========================================
app.post('/api/rider/my-orders', async (req, res) => {
  try {
    const { riderToken } = req.body;
    if (!riderToken) return res.json({ success: false, message: "Token missing" });

    const decodedRider = await admin.auth().verifyIdToken(riderToken);
    const riderEmail = decodedRider.email;

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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => { console.log(`Server port ${PORT} par chal raha hai`); });
