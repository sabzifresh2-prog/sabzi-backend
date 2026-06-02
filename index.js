const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- SECURE KEYS --- (.env file se aayenge)
const GOOGLE_SCRIPT_URL   = (process.env.GOOGLE_SCRIPT_URL   || "").trim();
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY      = (process.env.OTP_SECRET_KEY      || "").trim();
const FIREBASE_DB_URL     = (process.env.FIREBASE_DB_URL     || "https://sabzifresh-d8742-default-rtdb.firebaseio.com").trim();

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

// ==========================================
// POINT 1: OTP BHEJNA
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.json({ success: false, message: "Sahi email daalo." });
        }
        const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } catch (e) { res.json({ success: false, message: "Google Script Error" }); }
    } catch (error) { res.json({ success: false, message: "Server Error: " + error.message }); }
});

// ==========================================
// POINT 1: OTP VERIFY KARNA
// ==========================================
app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.json({ success: false, message: "Email aur OTP code zaroori hai." });
        
        const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } catch (e) { res.json({ success: false, message: "Google Script Error" }); }
    } catch (error) { res.json({ success: false, message: "Server Error: " + error.message }); }
});

// ==========================================
// POINT 4: NAYA USER REGISTER
// ==========================================
app.post('/api/user/register', async (req, res) => {
    try {
        const { phone, name, email, referCode } = req.body;

        if (!phone || phone.length !== 10 || !/^[6-9][0-9]{9}$/.test(phone)) return res.json({ success: false, message: "Sahi 10-digit phone number do." });
        if (!name || name.trim() === "") return res.json({ success: false, message: "Naam zaroori hai." });

        const existingRes = await fetch(`${FIREBASE_DB_URL}/users/${phone}.json`);
        const existingUser = await existingRes.json();

        if (existingUser) {
            await fetch(`${FIREBASE_DB_URL}/users/${phone}.json`, { method: 'PATCH', body: JSON.stringify({ email: email, name: name }) });
            return res.json({ success: true, message: "User updated." });
        }

        let referrerPhone = null;
        if (referCode && referCode.trim() !== "") {
            const refSnap = await fetch(`${FIREBASE_DB_URL}/referCodes/${referCode.toUpperCase()}.json`);
            const refData = await refSnap.json();
            if (!refData) return res.json({ success: false, message: "Refer code galat hai." });
            if (refData === phone) return res.json({ success: false, message: "Khud ko refer nahi kar sakte!" });
            referrerPhone = refData;
        }

        const newCode = "SF" + Math.floor(1000 + Math.random() * 9000);
        const newUser = { name: name.trim(), email: email || "", savedVillage: "", savedStreet: "", referCode: newCode, freeDeliveries: 0, rewardExpiry: null };
        if (referrerPhone) { newUser.referredBy = referrerPhone; newUser.referralStatus = "pending"; }

        await fetch(`${FIREBASE_DB_URL}/users/${phone}.json`, { method: 'PUT', body: JSON.stringify(newUser) });
        await fetch(`${FIREBASE_DB_URL}/referCodes/${newCode}.json`, { method: 'PUT', body: JSON.stringify(phone) });

        if (referrerPhone) {
            const refUserRes = await fetch(`${FIREBASE_DB_URL}/users/${referrerPhone}.json`);
            const refUserData = await refUserRes.json() || {};
            const currentDel = parseInt(refUserData.freeDeliveries) || 0;
            const expiryDate = Date.now() + (30 * 24 * 60 * 60 * 1000);
            await fetch(`${FIREBASE_DB_URL}/users/${referrerPhone}.json`, { method: 'PATCH', body: JSON.stringify({ freeDeliveries: currentDel + 3, rewardExpiry: expiryDate }) });
        }
        res.json({ success: true, message: "Account ban gaya!" });

    } catch (error) { res.json({ success: false, message: "Registration fail: " + error.message }); }
});

// ==========================================
// POINT 3 + 5 + 2: ORDER PLACE KARNA
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails, expectedTime } = req.body;

        if (!cartItems || typeof cartItems !== 'object' || Object.keys(cartItems).length === 0) return res.json({ success: false, message: "Cart khaali hai." });
        if (!customerDetails || !customerDetails.phone || !customerDetails.name) return res.json({ success: false, message: "Customer details missing." });

        const [dbRes, setRes, userRes] = await Promise.all([
            fetch(`${FIREBASE_DB_URL}/products.json`), fetch(`${FIREBASE_DB_URL}/settings.json`), fetch(`${FIREBASE_DB_URL}/users/${customerDetails.phone}.json`)
        ]);

        const productsDB = await dbRes.json() || {}; const settingsDB = await setRes.json() || {}; const userData = await userRes.json() || {};
        const adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        const adminFreeLimit   = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

        let secureSubtotal = 0; let secureItemsArr = []; let secureAdminItemsString = [];

        for (let itemId in cartItems) {
            const qty = parseFloat(cartItems[itemId]); const asliProduct = productsDB[itemId];
            if (asliProduct && !isNaN(qty) && qty > 0) {
                const itemTotal = asliProduct.price * qty; secureSubtotal += itemTotal;
                const itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
                secureItemsArr.push({ name: `${itemName} x${qty}`, price: itemTotal });
                secureAdminItemsString.push(`${itemName} x${qty}`);
            }
        }
        if (secureSubtotal <= 0) return res.json({ success: false, message: "Cart mein sahi items nahi hain." });

        let isRewardUsed = false; let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
        if (userData.freeDeliveries > 0 && (!userData.rewardExpiry || userData.rewardExpiry > Date.now())) { secureDeliveryCharge = 0; isRewardUsed = true; }

        const secureFinalTotal = secureSubtotal + secureDeliveryCharge;
        const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
        const orderTimestamp = Date.now();
        const formattedDate = new Date(orderTimestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
        const finalExpectedTime = expectedTime || "Kal subah 7-10 baje tak";

        const orderData = { id: orderId, timestamp: orderTimestamp, date: formattedDate, status: "Packing in Progress ⏳", total: secureFinalTotal, deliveryCharge: secureDeliveryCharge, customer: customerDetails.name, phone: customerDetails.phone, email: customerDetails.email || '', address: customerDetails.address, expectedDelivery: finalExpectedTime, items: secureItemsArr, itemsList: secureAdminItemsString.join(', '), usedFreeDelivery: isRewardUsed };

        await fetch(`${FIREBASE_DB_URL}/orders/${orderId}.json`, { method: 'PUT', body: JSON.stringify(orderData) });

        const userUpdates = { savedVillage: customerDetails.village || "", savedStreet: customerDetails.street || "" };
        if (isRewardUsed) userUpdates.freeDeliveries = (userData.freeDeliveries || 1) - 1;
        await fetch(`${FIREBASE_DB_URL}/users/${customerDetails.phone}.json`, { method: 'PATCH', body: JSON.stringify(userUpdates) });

        try {
            const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n⏰ *Time:* ${formattedDate}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureAdminItemsString.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Bill:* ₹${secureFinalTotal}\n⏰ *Expected:* ${finalExpectedTime}`;
            await fetch(TELEGRAM_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ 'message': teleMessage }) });
        } catch (teleErr) { console.error("Telegram error:", teleErr.message); }

        res.json({ success: true, orderTimestamp: orderTimestamp, expectedTime: finalExpectedTime });

    } catch (error) { res.json({ success: false, message: "Order save error: " + error.message }); }
});


// YAHI WO LINE HAI JO MISSING THI
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Sabzi Fresh Backend port ${PORT} par chal raha hai`); });
// ==========================================
// POINT 7: ORDER CANCEL (ONLY EMAIL VERIFICATION)
// ==========================================
app.post('/api/order/cancel', async (req, res) => {
    try {
        const { orderId, reason, email } = req.body;

        if (!orderId || !email) {
            return res.json({ success: false, message: "Order ID aur Email zaroori hai." });
        }

        const orderRes  = await fetch(`${FIREBASE_DB_URL}/orders/${orderId}.json`);
        const orderData = await orderRes.json();

        if (!orderData) return res.json({ success: false, message: "Order nahi mila." });

        const dbEmail = String(orderData.email || "").trim().toLowerCase();
        const reqEmail = String(email || "").trim().toLowerCase();

        // 100% Strict Check: Sirf Verified Email match hona chahiye
        if (dbEmail === "" || dbEmail !== reqEmail) {
            return res.json({ success: false, message: "Ye order aapke account se match nahi hua." });
        }

        const cancellableStatuses = ["Packing in Progress ⏳", "Confirmed"];
        const canCancel = cancellableStatuses.some(s => orderData.status.includes(s.replace(" ⏳", "")) || orderData.status === s);
        
        if (!canCancel) {
            return res.json({ success: false, message: "Ye order ab cancel nahi ho sakta." });
        }

        await fetch(`${FIREBASE_DB_URL}/orders/${orderId}.json`, {
            method: 'PATCH',
            body: JSON.stringify({ status: "Cancelled by Customer", cancelReason: reason || "No reason given" })
        });

        // Cancel count badhane ke liye phone check karenge agar database mein use hua ho
        if (orderData.phone) {
            const userRes  = await fetch(`${FIREBASE_DB_URL}/users/${orderData.phone}.json`);
            const userData = await userRes.json() || {};
            await fetch(`${FIREBASE_DB_URL}/users/${orderData.phone}.json`, {
                method: 'PATCH',
                body: JSON.stringify({ cancelCount: (parseInt(userData.cancelCount) || 0) + 1 })
            });
        }

        res.json({ success: true, message: "Order cancel ho gaya." });

    } catch (error) {
        res.json({ success: false, message: "Cancel error: " + error.message });
    }
});
