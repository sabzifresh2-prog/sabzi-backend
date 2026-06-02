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
// POINT 2: SECURE BILL CALCULATOR (Naya)
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        // Frontend sirf ye batayega ki kaunsa item kitna kilo chahiye
        const { cartItems } = req.body; 
        
        // 1. Backend chup-chaap Firebase se aaj ka ASLI RATE mangwayega
        const dbResponse = await fetch(`${FIREBASE_DB_URL}/products.json`);
        const productsDB = await dbResponse.json();

        let secureSubtotal = 0;
        let secureItemsList = [];

        // 2. Fraud Check (Backend khud multiply karke check karega)
        for (let itemId in cartItems) {
            let qty = cartItems[itemId];
            let asliProduct = productsDB[itemId]; // Hacker isko change nahi kar sakta

            if (asliProduct && qty > 0) {
                let itemTotal = asliProduct.price * qty;
                secureSubtotal += itemTotal;
                
                let itemName = asliProduct.nameEn || asliProduct.adminName;
                secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
            }
        }

        // 3. Delivery Charge (Agar 100 se kam ka order hai toh 20 rupaye)
        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < 100) ? 20 : 0;
        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        // 4. Result wapas bhejna
        res.json({
            success: true,
            message: "Hacker-proof bill taiyaar hai!",
            hackerKiNakal: "Zero", // Hacker ka total reject kar diya gaya
            asliSubtotal: secureSubtotal,
            asliDelivery: secureDeliveryCharge,
            asliTotal: secureFinalTotal,
            verifiedItems: secureItemsList
        });

    } catch (error) {
        res.json({ success: false, message: "Bill calculate karne mein error aaya." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
