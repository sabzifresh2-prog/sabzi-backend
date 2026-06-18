const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES & FIREBASE ADMIN
// ==========================================
const OTP_SCRIPT_URL = (process.env.OTP_SCRIPT_URL || "").trim();
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();

// ✅ NAYA: Aapki upload ki hui JSON file ko link kiya gaya hai
// Dhyan rakhein: JSON file ka naam bilkul match karna chahiye, jaise ki 'serviceAccountKey.json'
try {
    const serviceAccount = require('./serviceAccountKey.json'); 
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://sabzifresh-d8742-default-rtdb.firebaseio.com"
    });
    console.log("Firebase Admin Started Successfully with JSON File!");
} catch (error) {
    console.error("🚨 ERROR: serviceAccountKey.json file nahi mili ya usme galti hai!", error);
}

const db = admin.database();

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API VIP Lock ke sath Live Hai!' });
});

// ==========================================
// 1. 📩 OTP BHEJNA (Google Script ke through)
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: false, message: "Email required" });

        const url = `${OTP_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); }
    } catch (error) { 
        res.json({ success: false, message: "Server Error" }); 
    }
});

// ==========================================
// 2. ✅ OTP VERIFY KARNA
// ==========================================
app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.json({ success: false, message: "Email aur code zaroori hai" });

        const url = `${OTP_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Google Error: " + text.substring(0, 40) }); }
    } catch (error) { 
        res.json({ success: false, message: "Server Error" }); 
    }
});

// ==========================================
// 3. 🛡️ SECURE REGISTRATION & WHATSAPP SUPPORT
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { phone, name, email, referCode, userToken } = req.body;
        const cleanEmail = email ? email.toLowerCase().trim() : "";

        if (!phone || !name || !userToken || !cleanEmail) {
            return res.json({ success: false, message: "Details, Email aur Token zaroori hai!" });
        }

        // ✅ TOKEN VERIFY: Taki koi fake token na bhej de
        await admin.auth().verifyIdToken(userToken);

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

        // ✅ FIREBASE CHECK: Kya user pehle se hai?
        const userSnap = await db.ref(`/users/${phone}`).once('value');
        if (userSnap.exists()) {
            const myWhatsAppNumber = "+918409081468"; 
            const waMessage = encodeURIComponent(`Hi Admin, main Sabzi Fresh app par apna purana Gmail bhool gaya hoon aur naya account nahi bana pa raha.\n\nMera Mobile Number: ${phone}\n\nKripya is number ka purana data delete/reset kar dijiye taaki main naya account bana sakun.`);
            
            return res.json({ 
                success: false, 
                message: "⚠️ Yeh Mobile Number pehle se registered hai! Kripya us Gmail se Login karein jo aapne pehle use kiya tha.\n\nAgar aap apna purana Gmail bhool gaye hain ya email band ho gaya hai, toh kripya Admin ko WhatsApp karein.",
                showWhatsAppSupport: true, 
                whatsappLink: `https://wa.me/${myWhatsAppNumber}?text=${waMessage}`
            });
        }

        // ✅ DATA SAVE KARNA (Direct Admin Power se)
        await db.ref(`/users/${phone}`).set(newUser);
        await db.ref(`/referCodes/${newCode}`).set(phone);

        res.json({ success: true, user: newUser });

    } catch (error) {
        console.error("Register Error:", error);
        res.json({ success: false, message: "Server Error ya Invalid Token." });
    }
});

// ==========================================
// 4. 🛒 SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        const { cartItems } = req.body; 
        if (!cartItems) return res.json({ success: false, message: "Cart khali hai" });

        // ✅ FETCH FROM DB
        const productsDB = (await db.ref('/products').once('value')).val() || {};
        const settingsDB = (await db.ref('/settings').once('value')).val() || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;
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
                
                itemsObj.push({ 
                    name: itemName, 
                    nameHi: asliProduct.nameHi || "", 
                    price: asliProduct.price,         
                    qty: qty,                         
                    qtyText: itemQtyText              
                });
            }
        }

        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
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
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails, userToken } = req.body;

        if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
            return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
        }

        // ✅ TOKEN VERIFY KARO
        await admin.auth().verifyIdToken(userToken);

        const productsDB = (await db.ref('/products').once('value')).val() || {};
        const settingsDB = (await db.ref('/settings').once('value')).val() || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;

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
                
                itemsObj.push({ 
                    name: itemName, 
                    nameHi: asliProduct.nameHi || "", 
                    price: itemTotal,   
                    basePrice: asliProduct.price, 
                    qty: qty,                         
                    qtyText: itemQtyText              
                });
            }
        }

        if (secureSubtotal === 0) return res.json({ success: false, message: "Cart is empty" });

        let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;

        // ✅ CHECK USER REWARDS
        if (customerDetails.usedReward && secureSubtotal > 0) {
            const userData = (await db.ref(`/users/${customerDetails.phone}`).once('value')).val();

            if (userData && parseInt(userData.freeDeliveries) > 0) {
                secureDeliveryCharge = 0; 
                let newFreeDel = parseInt(userData.freeDeliveries) - 1;
                await db.ref(`/users/${customerDetails.phone}`).update({ freeDeliveries: newFreeDel });
            }
        }
        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
        const orderTimestamp = Date.now();
        let orderDateObj = new Date(orderTimestamp);
        let formattedDate = orderDateObj.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) + " " + orderDateObj.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

        const orderData = {
            id: orderId, timestamp: orderTimestamp, date: formattedDate, 
            time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
            status: "Packing in Progress ⏳", total: secureFinalTotal, deliveryCharge: secureDeliveryCharge,
            customer: customerDetails.name, phone: customerDetails.phone, email: customerDetails.email || '',
            address: customerDetails.address, itemsList: secureItemsList.join(', '), items: itemsObj,
            usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && customerDetails.usedReward
        };

        // ✅ DIRECT ORDER SAVE (Bina Client Rules ke)
        await db.ref(`/orders/${orderId}`).set(orderData);

        if(TELEGRAM_SCRIPT_URL) {
            const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
            fetch(TELEGRAM_SCRIPT_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ 'message': teleMessage })
            }).catch(e => console.log("Telegram error: ", e));
        }

        res.json({ success: true, orderId: orderId, orderTimestamp: orderTimestamp });

    } catch (error) {
        console.error("Order Manager Error:", error);
        res.json({ success: false, message: "VIP Token Invalid ya Order Fail ho gaya" });
    }
});

// ==========================================
// 6. 🎁 ORDER DELIVER HONE PAR REWARD DENA
// ==========================================
app.post('/api/order/update-status', async (req, res) => {
    try {
        const { orderId, newStatus, adminToken } = req.body;
        if (!orderId || !newStatus || !adminToken) return res.json({ success: false, message: "Missing info" });

        // ✅ ADMIN CHECK
        const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
        if (decodedAdmin.email !== 'neerajkumar00999666@gmail.com') throw new Error("Aapko Admin access nahi hai!");

        await db.ref(`/orders/${orderId}`).update({ status: newStatus });

        if (newStatus === "Delivered") {
            const orderData = (await db.ref(`/orders/${orderId}`).once('value')).val();
            if (orderData && orderData.phone) {
                const customerPhone = orderData.phone;
                const userData = (await db.ref(`/users/${customerPhone}`).once('value')).val();

                if (userData && userData.referredBy && userData.referralStatus === "pending") {
                    const referrerPhone = userData.referredBy;
                    const referrerData = (await db.ref(`/users/${referrerPhone}`).once('value')).val();

                    if (referrerData) {
                        let currentFreeDel = parseInt(referrerData.freeDeliveries) || 0;
                        let newExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); 

                        await db.ref(`/users/${referrerPhone}`).update({ freeDeliveries: currentFreeDel + 3, rewardExpiry: newExpiry });
                        await db.ref(`/users/${customerPhone}`).update({ referralStatus: "completed" });
                    }
                }
            }
        }
        res.json({ success: true, message: "Status updated" });

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ==========================================
// 7. 🎁 MANUAL REWARD DENA
// ==========================================
app.post('/api/admin/give-reward', async (req, res) => {
    try {
        const { targetPhone, rewardCount, adminToken } = req.body;
        if (!targetPhone || !rewardCount || !adminToken) return res.json({ success: false, message: "Missing info" });

        const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
        if (decodedAdmin.email !== 'neerajkumar00999666@gmail.com') throw new Error("Admin access denied");

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

    } catch (error) {
        res.json({ success: false, message: error.message });
    }
});

// ==========================================
// 8. 🚫 SECURE ORDER CANCEL
// ==========================================
app.post('/api/order/cancel', async (req, res) => {
    try {
        const { orderId, cancelReason, userToken } = req.body;
        if (!orderId || !userToken) return res.json({ success: false, message: "Missing info" });

        await admin.auth().verifyIdToken(userToken);

        const orderData = (await db.ref(`/orders/${orderId}`).once('value')).val();
        if (!orderData) return res.json({ success: false, message: "Order nahi mila." });

        if (orderData.status !== 'Packing in Progress ⏳' && orderData.status !== 'Confirmed') {
            return res.json({ success: false, message: "Order pack ho chuka hai, ab cancel nahi ho sakta." });
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

    } catch (error) {
        res.json({ success: false, message: "Server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
