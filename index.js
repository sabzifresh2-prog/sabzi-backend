const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- SECURE KEYS ---
const GOOGLE_SCRIPT_URL = (process.env.GOOGLE_SCRIPT_URL || "").trim(); // OTP Wala Link
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim(); // Telegram Wala Link
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();
const FIREBASE_DB_URL = "https://sabzifresh-d8742-default-rtdb.firebaseio.com";

app.get('/', (req, res) => { res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' }); });

// ==========================================
// 1. OTP BHEJNA & VERIFY KARNA
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: false, message: "Email required" });
        const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } catch (e) { res.json({ success: false, message: "Google Error" }); }
    } catch (error) { res.json({ success: false, message: "Server Error" }); }
});

app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.json({ success: false, message: "Email aur code zaroori hai" });
        const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } catch (e) { res.json({ success: false, message: "Google Error" }); }
    } catch (error) { res.json({ success: false, message: "Server Error" }); }
});

// ==========================================
// 2. ACCOUNT CREATOR
// ==========================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { phone, name, email } = req.body;
        if (!phone || phone.length !== 10) return res.json({ success: false, message: "Invalid phone" });

        const newCode = "SF" + Math.floor(1000 + Math.random() * 9000);
        const newUser = { name, email, savedVillage: "", savedStreet: "", referCode: newCode, freeDeliveries: 0, rewardExpiry: null };

        await fetch(`${FIREBASE_DB_URL}/users/${phone}.json`, { method: 'PUT', body: JSON.stringify(newUser) });
        await fetch(`${FIREBASE_DB_URL}/referCodes/${newCode}.json`, { method: 'PUT', body: JSON.stringify(phone) });

        res.json({ success: true, message: "Account Created!" });
    } catch (error) { res.json({ success: false, message: "Registration failed." }); }
});

// ==========================================
// 3. ORDER MANAGER (Bill Check + Save DB + Telegram)
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails } = req.body; 
        if (!cartItems || typeof cartItems !== 'object') return res.json({ success: false, message: "Cart invalid." });

        const [dbRes, setRes, userRes] = await Promise.all([
            fetch(`${FIREBASE_DB_URL}/products.json`),
            fetch(`${FIREBASE_DB_URL}/settings.json`),
            fetch(`${FIREBASE_DB_URL}/users/${customerDetails.phone}.json`)
        ]);

        const productsDB = await dbRes.json() || {};
        const settingsDB = await setRes.json() || {};
        const userData = await userRes.json() || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

        let secureSubtotal = 0;
        let secureItemsArr = [];
        let secureAdminItemsString = [];

        for (let itemId in cartItems) {
            let qty = parseFloat(cartItems[itemId]); 
            let asliProduct = productsDB[itemId]; 
            if (asliProduct && !isNaN(qty) && qty > 0) {
                let itemTotal = asliProduct.price * qty;
                secureSubtotal += itemTotal;
                let itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
                secureItemsArr.push({ name: `${itemName} x${qty}`, price: itemTotal });
                secureAdminItemsString.push(`${itemName} x${qty}`);
            }
        }

        if(secureSubtotal <= 0) return res.json({ success: false, message: "Cart total zero hai." });

        let isRewardUsed = false;
        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
        
        if (userData.freeDeliveries > 0 && (!userData.rewardExpiry || userData.rewardExpiry > Date.now())) {
            secureDeliveryCharge = 0;
            isRewardUsed = true;
        }

        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
        
        // TIME FIX: India ke time ke hisaab se date aur time banana
        const orderTimestamp = Date.now();
        const options = { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true };
        const formattedDate = new Date(orderTimestamp).toLocaleString('en-IN', options);

        const orderData = { 
            id: orderId, timestamp: orderTimestamp, date: formattedDate, status: "Packing in Progress ⏳", 
            total: secureFinalTotal, deliveryCharge: secureDeliveryCharge, customer: customerDetails.name, 
            phone: customerDetails.phone, email: customerDetails.email || '', address: customerDetails.address, 
            items: secureItemsArr, itemsList: secureAdminItemsString.join(', '), usedFreeDelivery: isRewardUsed 
        };

        await fetch(`${FIREBASE_DB_URL}/orders/${orderId}.json`, { method: 'PUT', body: JSON.stringify(orderData) });

        let userUpdates = { savedVillage: customerDetails.village, savedStreet: customerDetails.street };
        if(isRewardUsed) userUpdates.freeDeliveries = userData.freeDeliveries - 1;
        await fetch(`${FIREBASE_DB_URL}/users/${customerDetails.phone}.json`, { method: 'PATCH', body: JSON.stringify(userUpdates) });

        // TIME FIX: Telegram message mein wapas Time jod diya gaya hai!
        let teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureAdminItemsString.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n⏰*Time:* ${formattedDate}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
        await fetch(TELEGRAM_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'message': teleMessage }) });

        res.json({ success: true, orderTimestamp: orderTimestamp });

    } catch (error) {
        console.error("Order Place Error:", error);
        res.json({ success: false, message: "Order save karne mein error aaya." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Server port ${PORT} par chal raha hai`); });
