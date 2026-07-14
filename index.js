const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

const app = express();

// ==========================================
// 🛡️ FIX #7: CORS ab sirf whitelist domains ke liye khula hai
// (pehle app.use(cors()) sabke liye khula tha)
// ==========================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Server-to-server / curl requests (no origin) ko allow rakha hai;
    // agar chahen to isay bhi block kar sakte hain.
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
const OTP_MAX_VERIFY_ATTEMPTS = 5;   // 🛡️ FIX #1 ke liye naya
const OTP_BLOCK_HOURS = 24;
const APP_NAME = "Sabzi Fresh";

const SMTP_HOST = (process.env.SMTP_HOST || "").trim();
const SMTP_PORT = parseInt(process.env.SMTP_PORT || "465");
const SMTP_USER = (process.env.SMTP_USER || "").trim();
const SMTP_PASS = (process.env.SMTP_PASS || "").trim();
const SMTP_FROM = (process.env.SMTP_FROM || SMTP_USER).trim();

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
  console.error("🚨 ERROR: JSON Parse fail ho gaya.", error);
}

const db = admin.database();

// ==========================================
// 📧 MAIL TRANSPORTER (OTP email bhejne ke liye)
// ==========================================
let mailTransporter = null;
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
} else {
  console.warn("🚨 WARNING: SMTP env vars missing — OTP email nahi ja payegi!");
}

app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Sabzi Fresh API — Secure Backend Live Hai!' });
});

// ==========================================
// 🛡️ FIX #6: Rate limiters
// ==========================================
// OTP send: har IP se 15 minute mein max 6 request
const otpSendLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});
// OTP verify: har IP se 15 minute mein max 20 request (brute-force slow-down)
const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: "Bahut zyada attempts. Thodi der baad try karein." }
});
// General order-related endpoints ke liye halka limiter
const orderLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: { success: false, message: "Bahut zyada requests. Thodi der baad try karein." }
});

// ==========================================
// 🔑 OTP DATA HELPERS
// (Ye data 'otp_data/' node mein rehta hai — Firebase rules mein ye node
//  sirf admin ko hi client-side dikhta/likha ja sakta hai, lekin Admin SDK
//  rules ko bypass karta hai isliye backend yahan safely padh-likh sakta hai)
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

async function sendOtpEmail(email, otp) {
  if (!mailTransporter) return false;
  try {
    const otpDigitsHtml = otp.split("").map(d =>
      `<td style="padding:0 5px;"><div style="width:44px;height:52px;background:#f0faf0;border:2px solid #2e7d32;border-radius:10px;font-size:26px;font-weight:800;color:#1b5e20;text-align:center;line-height:52px;font-family:monospace;">${d}</div></td>`
    ).join("");

    const htmlBody = `
      <div style="background:#f4f7f4;padding:30px 0;font-family:Arial,sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
          <table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:16px;overflow:hidden;">
            <tr><td style="background:#1b5e20;padding:24px;text-align:center;color:#fff;">
              <h2 style="margin:0;">🥦 ${APP_NAME}</h2>
            </td></tr>
            <tr><td style="padding:28px;text-align:center;">
              <p style="color:#555;">Aapka OTP:</p>
              <table style="margin:0 auto;"><tr>${otpDigitsHtml}</tr></table>
              <p style="color:#888;font-size:13px;margin-top:16px;">⏰ Ye OTP sirf ${OTP_EXPIRE_MIN} minute tak valid hai. Kisi se share na karein.</p>
            </td></tr>
          </table>
        </td></tr></table>
      </div>`;

    await mailTransporter.sendMail({
      from: `"${APP_NAME}" <${SMTP_FROM}>`,
      to: email,
      subject: `🥦 ${APP_NAME} - Aapka Login OTP`,
      text: `Aapka OTP: ${otp} (${OTP_EXPIRE_MIN} min valid hai)`,
      html: htmlBody
    });
    return true;
  } catch (err) {
    console.error("Mail send error:", err);
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
    rec.verifyAttempts = 0; // 🛡️ naya OTP aaya to verify-counter reset
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
// 2. ✅ OTP VERIFY + VIP PASS (Custom Token) banana
// 🛡️ FIX #1: verify_otp par bhi ab attempt-limit + lockout hai
// (pehle sirf send par tha, verify pe brute-force khula tha)
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
      // 🛡️ FIX #1: galat guess par counter badhao, limit cross hone par block karo
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

    // ✅ Sahi OTP — sab reset karo
    rec.otp = ""; rec.otpTime = 0; rec.sendCount = 0; rec.verifyAttempts = 0;
    await setOtpRecord(cleanEmail, rec);

    // ==========================================
    // 🎫 VIP PASS — Firebase Admin SDK ka built-in
    // createCustomToken use kiya hai. Manual RSA-JWT
    // signing (jo GAS script mein tha) yahan zaroori
    // nahi — Admin SDK apne aap secure signing karta
    // hai apne service-account credentials se.
    // ==========================================
    const uid = emailToKey(cleanEmail); // stable uid, email-based
    const vipToken = await admin.auth().createCustomToken(uid, { email: cleanEmail });

    res.json({ success: true, message: "Email verify ho gaya! ✔️", token: vipToken });
  } catch (error) {
    console.error("OTP verify error:", error);
    res.json({ success: false, message: "Server Error" });
  }
});

// ==========================================
// 3. 🛡️ SECURE REGISTRATION
// (Purana logic same — sirf verifyIdToken.email comparison
//  ab custom-token claim se aata hai, jo humne khud set kiya)
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

    // ℹ️ NOTE: Phone number ka koi SMS/OTP verification nahi hai (jaisa
    // ki decide kiya gaya) — isliye phone sirf "contact info" hai,
    // verified identity nahi. Delivery ke time WhatsApp/call se confirm
    // karna recommended hai.

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
// (isko reuse karke order/place aur order/cancel
//  dono mein FIX #2 aur FIX #3 lagaye hain)
// ==========================================
async function verifyAndGetEmail(userToken) {
  const decoded = await admin.auth().verifyIdToken(userToken);
  return (decoded.email || "").toLowerCase().trim();
}

// ==========================================
// 4. 🛒 SECURE BILL CALCULATOR (same as before)
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
// 🛡️ FIX #2: ab token ka email 'users/{phone}/email' se match hona
// zaroori hai — koi bhi user kisi aur ke phone se order nahi rakh sakta
// ==========================================
app.post('/api/order/place', orderLimiter, async (req, res) => {
  try {
    const { cartItems, customerDetails, userToken } = req.body;

    if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
      return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
    }

    // 🛡️ FIX #2: token verify karke uska email nikala aur AAGE USE kiya
    const tokenEmail = await verifyAndGetEmail(userToken);

    const userData = (await db.ref(`/users/${customerDetails.phone}`).once('value')).val();

    if (!userData) {
      return res.json({ success: false, message: "User record nahi mila." });
    }
    // 🛡️ FIX #2: ownership check — token ka email aur is phone ka registered
    // email match hona hi chahiye, warna order place nahi hoga
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
// 6. 🛵 RIDER STATUS UPDATE (same logic, status-check ab exact whitelist se)
// 🛡️ FIX #14: '.includes()' substring match hataya, ab exact set check hai
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
// 7. 🎁 ADMIN: ORDER STATUS UPDATE (same, exact-status whitelist)
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
// 8. 🎁 ADMIN: MANUAL REWARD (same)
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
// 🛡️ FIX #3: ab decoded token ka email order.email se match kiya jata hai —
// pehle ye ownership-check bilkul missing tha (IDOR bug)
// ==========================================
app.post('/api/order/cancel', orderLimiter, async (req, res) => {
  try {
    const { orderId, cancelReason, userToken } = req.body;
    if (!orderId || !userToken) return res.json({ success: false, message: "Missing info" });

    // 🛡️ FIX #3: result ab use ho raha hai
    const tokenEmail = await verifyAndGetEmail(userToken);

    const orderData = (await db.ref(`/orders/${orderId}`).once('value')).val();
    if (!orderData) return res.json({ success: false, message: "Order nahi mila." });

    // 🛡️ FIX #3: ownership check — sirf apna order hi cancel ho sakta hai
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
// 10. 👨‍💼 ADMIN: CREATE RIDER (same)
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
// 11. 🔔 ADMIN: BROADCAST NOTIFICATION (same)
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
// 12. 🛵 RIDER DASHBOARD: Pending Orders (same)
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
