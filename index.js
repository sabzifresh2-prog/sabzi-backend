const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// --- SECURE ENVIRONMENT VARIABLES ---
const OTP_SCRIPT_URL = (process.env.OTP_SCRIPT_URL || "").trim();
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();
const FIREBASE_SECRET = (process.env.FIREBASE_SECRET || "").trim(); // NAYI KEY YAHAN AAYEGI

// Aapke Firebase Database ka URL
const FIREBASE_DB_URL = "https://sabzifresh-d8742-default-rtdb.firebaseio.com";

// Helper Function: Firebase URL mein Admin Password (Secret) jodne ke liye
const getDbUrl = (path) => {
    return FIREBASE_SECRET ? `${FIREBASE_DB_URL}${path}?auth=${FIREBASE_SECRET}` : `${FIREBASE_DB_URL}${path}`;
};

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

// ==========================================
// 1. OTP BHEJNA
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: false, message: "Email required" });

        const url = `${OTP_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        
        try { 
            res.json(JSON.parse(text)); 
        } catch (e) { 
            res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); 
        }
    } catch (error) { 
        res.json({ success: false, message: "Server Error" }); 
    }
});

// ==========================================
// 2. OTP VERIFY KARNA
// ==========================================
app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.json({ success: false, message: "Email aur code zaroori hai" });

        const url = `${OTP_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        
        try { 
            res.json(JSON.parse(text)); 
        } catch (e) { 
            res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); 
        }
    } catch (error) { 
        res.json({ success: false, message: "Server Error" }); 
    }
});

// ==========================================
// 3. SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        const { cartItems } = req.body; 
        if (!cartItems || typeof cartItems !== 'object') {
            return res.json({ success: false, message: "Cart khali hai ya invalid hai." });
        }

        const [dbResponse, settingsResponse] = await Promise.all([
            fetch(getDbUrl('/products.json')),
            fetch(getDbUrl('/settings.json'))
        ]);

        if (!dbResponse.ok || !settingsResponse.ok) throw new Error("Firebase fetch failed");

        const productsDB = await dbResponse.json() || {};
        const settingsDB = await settingsResponse.json() || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

        let secureSubtotal = 0;
        let secureItemsList = [];

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

        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        res.json({
            success: true,
            asliSubtotal: secureSubtotal,
            asliDelivery: secureDeliveryCharge,
            asliTotal: secureFinalTotal,
            verifiedItems: secureItemsList
        });

    } catch (error) {
        console.error("Bill Calculation Error:", error);
        res.json({ success: false, message: "Bill calculate karne mein error aaya." });
    }
});

// ==========================================
// 4. SECURE ORDER MANAGER (Firebase Write + Telegram)
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails } = req.body;

        if (!cartItems || !customerDetails || !customerDetails.phone) {
            return res.json({ success: false, message: "Invalid order data" });
        }

        // Dobara bill calculate karna backend par
        const [dbResponse, settingsResponse] = await Promise.all([
            fetch(getDbUrl('/products.json')),
            fetch(getDbUrl('/settings.json'))
        ]);

        const productsDB = await dbResponse.json() || {};
        const settingsDB = await settingsResponse.json() || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

        let secureSubtotal = 0;
        let secureItemsList = [];
        let itemsObj = [];

        for (let itemId in cartItems) {
            let qty = parseFloat(cartItems[itemId]);
            let asliProduct = productsDB[itemId];

            if (asliProduct && !isNaN(qty) && qty > 0) {
                let itemTotal = asliProduct.price * qty;
                secureSubtotal += itemTotal;
                let itemName = asliProduct.nameEn || asliProduct.adminName || "Unknown Item";
                secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
                itemsObj.push({ name: itemName, price: itemTotal });
            }
        }

        if (secureSubtotal === 0) return res.json({ success: false, message: "Cart is empty" });

        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
        
        if (customerDetails.usedReward && secureSubtotal > 0) {
            secureDeliveryCharge = 0;
        }

        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        // Order ID aur Data Generate
        const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
        const orderTimestamp = Date.now();
        let orderDateObj = new Date(orderTimestamp);
        let formattedDate = orderDateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + " " + orderDateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        const orderData = {
            id: orderId,
            timestamp: orderTimestamp,
            date: formattedDate,
            time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            status: "Packing in Progress ⏳",
            total: secureFinalTotal,
            deliveryCharge: secureDeliveryCharge,
            customer: customerDetails.name,
            phone: customerDetails.phone,
            email: customerDetails.email || '',
            address: customerDetails.address,
            itemsList: secureItemsList.join(', '),
            items: itemsObj,
            usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && customerDetails.usedReward
        };

        // FIREBASE MEIN SECURE WRITE KARNA (Ab Admin Power ke sath)
        const firebaseWriteRes = await fetch(getDbUrl(`/orders/${orderId}.json`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });

        if (!firebaseWriteRes.ok) throw new Error("Firebase save failed - Check FIREBASE_SECRET");

        // TELEGRAM NOTIFICATION
        if(TELEGRAM_SCRIPT_URL) {
            const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
            
            fetch(TELEGRAM_SCRIPT_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ 'message': teleMessage })
            }).catch(e => console.log("Telegram send failed: ", e));
        }

        res.json({ success: true, orderId: orderId, orderTimestamp: orderTimestamp });

    } catch (error) {
        console.error("Order Manager Error:", error);
        res.json({ success: false, message: "Order place karne mein server error aaya" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
// ==========================================
// 5. SECURE REGISTRATION & ANTI-FRAUD (IP TRACKING)
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { phone, name, email, referCode } = req.body;
        if (!phone || !name) return res.json({ success: false, message: "Name aur phone zaroori hai" });

        // 1. IP Address nikalna (Railway/Render ke load balancer ke peechhe se)
        let clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || "UNKNOWN_IP";
        if (clientIp.includes(',')) clientIp = clientIp.split(',')[0].trim(); // Agar multiple IP hon

        // 2. Check karna ki is IP se kitne account ban chuke hain
        const usersRes = await fetch(getDbUrl('/users.json'));
        const allUsers = await usersRes.json() || {};
        
        let ipCount = 0;
        let isIpSpam = false;

        for (let key in allUsers) {
            if (allUsers[key].ip === clientIp) {
                ipCount++;
            }
        }

        // Agar ek hi IP se pehle hi 2 account ban chuke hain (yani ye 3rd+ account hai)
        if (ipCount >= 2) {
            isIpSpam = true; // Spam mark kar diya
        }

        // 3. Refer Code Check
        let referrerPhone = null;
        let referralStatus = null;

        if (referCode) {
            const referRes = await fetch(getDbUrl('/referCodes.json'));
            const allReferCodes = await referRes.json() || {};
            
            if (allReferCodes[referCode]) {
                referrerPhone = allReferCodes[referCode];
                if (referrerPhone === phone) {
                    return res.json({ success: false, message: "Bhai, khud ko hi refer nahi kar sakte!" });
                }
                
                // IP Spam mila toh reward block karo, warna pending rakho (1st order deliver hone tak)
                referralStatus = isIpSpam ? "rejected_ip_spam" : "pending";
            } else {
                return res.json({ success: false, message: "Referral code galat hai!" });
            }
        }

        // 4. Naya User aur uska naya Refer Code Banana
        const newCode = "SF" + Math.floor(1000 + Math.random() * 9000);
        const newUser = {
            name: name,
            email: email || "",
            phone: phone,
            savedVillage: "",
            savedStreet: "",
            referCode: newCode,
            freeDeliveries: 0,
            rewardExpiry: null,
            ip: clientIp, // IP Save kar rahe hain
            registeredAt: Date.now()
        };

        if (referrerPhone) {
            newUser.referredBy = referrerPhone;
            newUser.referralStatus = referralStatus;
        }

        // 5. Firebase mein secure write (Kyunki backend ke paas admin secret hai)
        await fetch(getDbUrl(`/users/${phone}.json`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newUser)
        });

        await fetch(getDbUrl(`/referCodes/${newCode}.json`), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(phone)
        });

        res.json({ success: true, user: newUser, isSpam: isIpSpam });

    } catch (error) {
        console.error("Registration Error:", error);
        res.json({ success: false, message: "Server error during registration" });
    }
});
