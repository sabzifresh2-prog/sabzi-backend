const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================================
//  FIREBASE ADMIN SDK INITIALIZE
//  (Service Account key environment variable se aayegi)
// ============================================================
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (e) {
  console.error('FIREBASE_SERVICE_ACCOUNT env variable missing or invalid JSON!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://sabzifresh-d8742-default-rtdb.firebaseio.com'
});

const db = admin.database();

// ============================================================
//  SECURE ENV VARIABLES
// ============================================================
const GOOGLE_SCRIPT_URL  = (process.env.GOOGLE_SCRIPT_URL  || '').trim();
const OTP_SECRET_KEY     = (process.env.OTP_SECRET_KEY     || '').trim();
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID   = (process.env.TELEGRAM_CHAT_ID   || '').trim();

// ============================================================
//  HELPER: Firebase token verify karo (middleware)
// ============================================================
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) return res.json({ success: false, message: 'Auth token nahi mila.' });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded; // { uid, email, ... }
    next();
  } catch (e) {
    return res.json({ success: false, message: 'Invalid auth token.' });
  }
}

// ============================================================
//  HELPER: Telegram message bhejna
// ============================================================
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'Markdown'
        })
      }
    );
  } catch (e) {
    console.error('Telegram error:', e.message);
  }
}

// ============================================================
//  HELPER: Sanitize string
// ============================================================
function sanitize(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ============================================================
//  ROOT
// ============================================================
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Sabzi Fresh Secure API Live Hai!' });
});

// ============================================================
//  1. OTP BHEJNA
// ============================================================
app.post('/api/otp/send', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.json({ success: false, message: 'Valid email chahiye.' });
    }
    const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    const response = await fetch(url);
    const text = await response.text();
    try { res.json(JSON.parse(text)); }
    catch (e) { res.json({ success: false, message: 'Google Script error: ' + text.substring(0, 60) }); }
  } catch (error) {
    res.json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ============================================================
//  2. OTP VERIFY KARNA + Firebase Custom Token banana
// ============================================================
app.post('/api/otp/verify', async (req, res) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) return res.json({ success: false, message: 'Email aur code zaroori hai.' });

    const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    const response = await fetch(url);
    const text = await response.text();

    let result;
    try { result = JSON.parse(text); }
    catch (e) { return res.json({ success: false, message: 'Google Script error.' }); }

    if (!result.success) return res.json(result);

    // Google Script ne verify kar diya — ab Firebase Custom Token banao
    // uid = email ko safe UID mein convert karo
    const uid = 'otp_' + Buffer.from(email).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 28);
    const customToken = await admin.auth().createCustomToken(uid, { email });
    res.json({ success: true, token: customToken });

  } catch (error) {
    res.json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ============================================================
//  3. SECURE ORDER PLACE KARNA
//     - Bill verify karega (price DB se)
//     - Free delivery reward atomic deduct karega
//     - Firebase Admin se order likhega (frontend direct write nahi karega)
//     - Telegram notification bhejoega
// ============================================================
app.post('/api/order/place', verifyToken, async (req, res) => {
  try {
    const { cartItems, customerName, customerPhone, village, streetAddress, mapLink, userLat, userLong } = req.body;
    const userEmail = req.user.email;

    // --- Basic validation ---
    if (!cartItems || typeof cartItems !== 'object' || Object.keys(cartItems).length === 0) {
      return res.json({ success: false, message: 'Cart khali hai.' });
    }
    if (!customerName || customerName.length > 80) return res.json({ success: false, message: 'Naam sahi nahi hai.' });
    if (!customerPhone || !/^[6-9][0-9]{9}$/.test(customerPhone)) return res.json({ success: false, message: 'Phone number sahi nahi hai.' });
    if (!village) return res.json({ success: false, message: 'Gaon chunein.' });
    if (!streetAddress || streetAddress.length > 300) return res.json({ success: false, message: 'Gali/address sahi nahi hai.' });

    // --- Rate limiting: 2 minute mein ek order ---
    const lastOrderSnap = await db.ref(`users/${customerPhone}/lastOrderTime`).once('value');
    const lastOrderTime = lastOrderSnap.val() || 0;
    const now = Date.now();
    if (now - lastOrderTime < 120000) {
      const waitSec = Math.ceil((120000 - (now - lastOrderTime)) / 1000);
      return res.json({ success: false, message: `${waitSec} second baad dobara try karein.` });
    }

    // --- User verify: email match hona chahiye ---
    const userSnap = await db.ref(`users/${customerPhone}`).once('value');
    const userData = userSnap.val();
    if (!userData) return res.json({ success: false, message: 'User nahi mila. Pehle register karein.' });
    if (userData.email !== userEmail) return res.json({ success: false, message: 'Account mismatch. Sahi account se login karein.' });
    if (userData.blocked === true) return res.json({ success: false, message: 'Aapka account block hai.' });

    // --- Products aur Settings DB se fetch karo ---
    const [productsSnap, settingsSnap] = await Promise.all([
      db.ref('products').once('value'),
      db.ref('settings').once('value')
    ]);
    const productsDB = productsSnap.val() || {};
    const settingsDB = settingsSnap.val() || {};

    const adminDeliveryFee = parseInt(settingsDB.deliveryCharge ?? 20);
    const adminFreeLimit   = parseInt(settingsDB.minFreeDeliveryThreshold ?? 100);

    // --- Secure bill calculate karo ---
    let secureSubtotal = 0;
    const verifiedItems = [];

    for (const itemId in cartItems) {
      const qty = parseFloat(cartItems[itemId]);
      const product = productsDB[itemId];
      if (!product) continue;
      if (isNaN(qty) || qty <= 0 || qty > 50) continue; // max 50 unit safety
      if (product.inStock === false) continue;

      const itemTotal = product.price * qty;
      secureSubtotal += itemTotal;
      const itemName = product.nameEn || product.adminName || 'Unknown';
      verifiedItems.push({
        id: itemId,
        name: itemName,
        qty,
        unitPrice: product.price,
        price: itemTotal
      });
    }

    if (verifiedItems.length === 0) return res.json({ success: false, message: 'Koi valid item nahi hai cart mein.' });

    // --- Free Delivery Reward check (ATOMIC — server pe) ---
    let deliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
    let usedFreeDelivery = false;

    const freeDeliveries   = parseInt(userData.freeDeliveries) || 0;
    const rewardExpiry     = userData.rewardExpiry || null;
    const isRewardActive   = freeDeliveries > 0 && (!rewardExpiry || now < rewardExpiry);

    if (isRewardActive && secureSubtotal > 0) {
      deliveryCharge = 0;
      usedFreeDelivery = true;
    }

    const secureFinalTotal = secureSubtotal + deliveryCharge;

    // --- Address build ---
    let finalAddress = `${sanitize(village)}, ${sanitize(streetAddress)}`;
    if (mapLink) {
      finalAddress += ` | 📍 Map: ${mapLink}`;
    } else if (userLat && userLong) {
      finalAddress += ` | 📍 GPS: https://maps.google.com/?q=${parseFloat(userLat).toFixed(6)},${parseFloat(userLong).toFixed(6)}`;
    }

    // --- Order ID + timestamp ---
    const orderId = 'SF' + now.toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
    const orderDate = new Date(now);
    const formattedDate = orderDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      + ' ' + orderDate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

    const itemsListStr = verifiedItems.map(i => `${i.name} x${i.qty} (₹${i.price})`).join(', ');

    const orderData = {
      id: orderId,
      timestamp: now,
      date: formattedDate,
      time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      status: 'Packing in Progress ⏳',
      total: secureFinalTotal,
      deliveryCharge: deliveryCharge,
      subtotal: secureSubtotal,
      customer: sanitize(customerName),
      phone: customerPhone,
      email: userEmail,
      address: finalAddress,
      itemsList: itemsListStr,
      items: verifiedItems,
      usedFreeDelivery
    };

    // --- ATOMIC WRITE: order + user update ek saath ---
    const updates = {};
    updates[`orders/${orderId}`] = orderData;
    updates[`users/${customerPhone}/savedVillage`]   = village;
    updates[`users/${customerPhone}/savedStreet`]    = streetAddress;
    updates[`users/${customerPhone}/lastOrderTime`]  = now;

    if (usedFreeDelivery) {
      updates[`users/${customerPhone}/freeDeliveries`] = freeDeliveries - 1;
    }

    await db.ref('/').update(updates);

    // --- Referral reward processing (agar pehla order hai) ---
    await processReferralReward(customerPhone, userData, now);

    // --- Telegram notification ---
    const nextDay = new Date(now);
    nextDay.setDate(nextDay.getDate() + 1);
    const deliveryStr = `${nextDay.getDate()} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][nextDay.getMonth()]} | Subah 7-10 baje`;

    const teleMsg = `🚨 *NAYA ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Naam:* ${sanitize(customerName)}\n📞 *Phone:* ${customerPhone}\n📍 *Pata:* ${finalAddress}\n\n🛒 *Saman:*\n${verifiedItems.map(i => `• ${i.name} x${i.qty} = ₹${i.price}`).join('\n')}\n\n${usedFreeDelivery ? '🎁 *Free Delivery Reward Laga!*\n' : ''}🚚 *Delivery Charge:* ₹${deliveryCharge}\n💰 *Total:* ₹${secureFinalTotal}\n⏰ *Expected:* ${deliveryStr}`;
    await sendTelegram(teleMsg);

    res.json({
      success: true,
      orderId,
      deliveryDate: deliveryStr,
      finalTotal: secureFinalTotal
    });

  } catch (error) {
    console.error('Order place error:', error);
    res.json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ============================================================
//  4. REFER & EARN — SECURE BACKEND CHECK
//     Frontend se refer code validate karo (device bypass band)
// ============================================================
app.post('/api/refer/validate', verifyToken, async (req, res) => {
  try {
    const { referCode, newUserPhone } = req.body;
    const newUserEmail = req.user.email;

    if (!referCode || !/^SF[A-Z0-9]{4,8}$/.test(referCode)) {
      return res.json({ success: false, message: 'Refer code format galat hai.' });
    }
    if (!newUserPhone || !/^[6-9][0-9]{9}$/.test(newUserPhone)) {
      return res.json({ success: false, message: 'Phone number sahi nahi hai.' });
    }

    // Check: Refer code exist karta hai?
    const codeSnap = await db.ref(`referCodes/${referCode}`).once('value');
    if (!codeSnap.exists()) {
      return res.json({ success: false, message: 'Yeh refer code galat hai.' });
    }
    const referrerPhone = codeSnap.val();

    // Check: Khud ko refer nahi kar sakta
    if (referrerPhone === newUserPhone) {
      return res.json({ success: false, message: 'Khud ko refer nahi kar sakte!' });
    }

    // Check: Kya yeh user pehle se register hai?
    const existingUserSnap = await db.ref(`users/${newUserPhone}`).once('value');
    if (existingUserSnap.exists()) {
      return res.json({ success: false, message: 'Yeh phone number pehle se registered hai. Refer code sirf naye users ke liye hai.' });
    }

    // Check: Kya referrer ka account exist karta hai?
    const referrerSnap = await db.ref(`users/${referrerPhone}`).once('value');
    if (!referrerSnap.exists()) {
      return res.json({ success: false, message: 'Refer code wale ka account nahi mila.' });
    }

    // Sab theek — validated
    res.json({ success: true, referrerPhone, message: 'Refer code valid hai!' });

  } catch (error) {
    res.json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ============================================================
//  5. NEW USER REGISTER KARNA (Secure — Backend se)
// ============================================================
app.post('/api/user/register', verifyToken, async (req, res) => {
  try {
    const { name, phone, referrerPhone } = req.body;
    const email = req.user.email;

    if (!name || name.trim().length < 2 || name.length > 80) {
      return res.json({ success: false, message: 'Naam 2 se 80 characters ka hona chahiye.' });
    }
    if (!phone || !/^[6-9][0-9]{9}$/.test(phone)) {
      return res.json({ success: false, message: 'Valid 10-digit phone number chahiye.' });
    }

    // Check: phone already registered?
    const existingSnap = await db.ref(`users/${phone}`).once('value');
    if (existingSnap.exists()) {
      // Phone registered hai — agar email match kare toh login karo
      const existingUser = existingSnap.val();
      if (existingUser.email === email) {
        return res.json({ success: true, alreadyExists: true, message: 'Account already exists.' });
      } else {
        return res.json({ success: false, message: 'Yeh phone number kisi aur account se registered hai.' });
      }
    }

    // Naya referral code generate karo
    const newCode = 'SF' + Math.floor(1000 + Math.random() * 9000);

    const newUser = {
      name: sanitize(name.trim()),
      email,
      savedVillage: '',
      savedStreet: '',
      referCode: newCode,
      freeDeliveries: 0,
      rewardExpiry: null,
      createdAt: Date.now()
    };

    if (referrerPhone) newUser.referredBy = referrerPhone;

    const updates = {};
    updates[`users/${phone}`]       = newUser;
    updates[`referCodes/${newCode}`] = phone;

    await db.ref('/').update(updates);

    res.json({ success: true, message: 'Account ban gaya!' });

  } catch (error) {
    res.json({ success: false, message: 'Server error: ' + error.message });
  }
});

// ============================================================
//  HELPER: Referral reward processing
//  Naye user ke pehle order ke baad referrer ko 3 free deliveries
// ============================================================
async function processReferralReward(newUserPhone, userData, now) {
  try {
    if (!userData.referredBy || userData.referralStatus === 'rewarded') return;

    const referrerPhone = userData.referredBy;
    const referrerSnap  = await db.ref(`users/${referrerPhone}`).once('value');
    if (!referrerSnap.exists()) return;

    const referrer = referrerSnap.val();
    const currentFree   = parseInt(referrer.freeDeliveries) || 0;
    const rewardExpiry  = now + (30 * 24 * 60 * 60 * 1000); // 30 din

    await db.ref(`users/${referrerPhone}`).update({
      freeDeliveries: currentFree + 3,
      rewardExpiry
    });

    // Mark as rewarded so duplicate nahi ho
    await db.ref(`users/${newUserPhone}`).update({ referralStatus: 'rewarded' });

    // Referrer ko notification bhejna
    await db.ref(`users/${referrerPhone}/inbox`).push({
      type: 'Offer',
      title: '🎁 Refer Reward Mila!',
      message: `Tumhare refer se kisi ne pehla order diya. 3 FREE Deliveries tumhare account mein add ho gayi!`,
      timestamp: now,
      read: false
    });

    console.log(`Referral reward processed: ${referrerPhone} got 3 free deliveries`);
  } catch (e) {
    console.error('Referral reward error:', e.message);
  }
}

// ============================================================
//  PORT
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Sabzi Fresh Secure Server port ${PORT} par chal raha hai`);
});
