const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- SECURE KEYS ---
const GOOGLE_SCRIPT_URL = (process.env.GOOGLE_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();

// Aapke Firebase Database ka URL (Yahan se backend asli price padhega)
const FIREBASE_DB_URL = "https://sabzifresh-d8742-default-rtdb.firebaseio.com";

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

// ==========================================
// POINT 1: OTP SYSTEM (Pehle jaisa safe hai)
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); }
    } catch (error) { res.json({ success: false, message: "Server Error" }); }
});

app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); }
    } catch (error) { res.json({ success: false, message: "Server Error" }); }
});


// ==========================================
    // ==========================================
// POINT 2: SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        const { cartItems } = req.body; 
        
        // 1. Backend Firebase se Products aur Admin Settings dono padhega
        const dbResponse = await fetch(`${FIREBASE_DB_URL}/products.json`);
        const productsDB = await dbResponse.json();

        const settingsResponse = await fetch(`${FIREBASE_DB_URL}/settings.json`);
        const settingsDB = await settingsResponse.json();

        // Admin Panel wali values nikalna (Agar setting nahi hai toh default 20)
        let adminDeliveryFee = settingsDB && settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB && settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

        let secureSubtotal = 0;
        let secureItemsList = [];

        // 2. Fraud Check (Asli rate se guna karna)
        for (let itemId in cartItems) {
            let qty = cartItems[itemId];
            let asliProduct = productsDB[itemId]; 

            if (asliProduct && qty > 0) {
                let itemTotal = asliProduct.price * qty;
                secureSubtotal += itemTotal;
                
                let itemName = asliProduct.nameEn || asliProduct.adminName;
                secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
            }
        }

        // 3. Delivery Charge (Ab fix 20 nahi, Admin Panel wala charge lagega)
        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        // 4. Result wapas bhejna
        res.json({
            success: true,
            message: "Hacker-proof bill taiyaar hai!",
            asliSubtotal: secureSubtotal,
            asliDelivery: secureDeliveryCharge,
            asliTotal: secureFinalTotal,
            verifiedItems: secureItemsList
        });

    } catch (error) {
        res.json({ success: false, message: "Bill calculate karne mein error aaya." });
    }
});
