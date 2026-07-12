const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES (Server Settings)
// ==========================================
const OTP_SCRIPT_URL = (process.env.OTP_SCRIPT_URL || "").trim();
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();

// 👨‍👩‍👧‍👦 Customer Ke Liye OneSignal Keys (Purani wali - Bulk message ke liye)
const ONESIGNAL_APP_ID = (process.env.ONESIGNAL_APP_ID || "").trim(); 
const ONESIGNAL_REST_KEY = (process.env.ONESIGNAL_REST_KEY || "").trim(); 

// 🛵 RIDER Ke Liye Nayi OneSignal Keys 
const ONESIGNAL_RIDER_APP_ID = "da51535a-56e2-424e-ac89-0fd96616679f"; 
const ONESIGNAL_RIDER_REST_KEY = "os_v2_app_3jivgwsw4jbe5lejb7mwmftht4dfnwl7lgfekpmeuinyex6wzbumxdq3eu6roivuwsggkwklvm3iabtqmw7f474alz56uy6guorcg3i".trim(); 

// ✅ FINAL: Render ke Environment Variable se JSON read karna
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

        const decodedToken = await admin.auth().verifyIdToken(userToken);
        
        if (decodedToken.email !== cleanEmail) {
            return res.json({ success: false, message: "Security Alert: Token aur Email match nahi ho rahe (Fake Identity)!" });
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
            const waMessage = encodeURIComponent(`Hi customer support, main Sabzi Fresh app par apna purana Gmail bhool gaya hoon aur naya account nahi bana pa raha.\n\nMera Mobile Number: ${phone}\n\nKripya is number ka fir se account banane ka permission de do taaki main naya account bana sakun.`);
            
            return res.json({ 
                success: false, 
                message: "⚠️ Yeh Mobile Number pehle se registered hai! Kripya us Gmail se Login karein jo aapne pehle use kiya tha.\n\nAgar aap apna purana Gmail bhool gaye hain ya email band ho gaya hai, toh kripya Admin ko WhatsApp karein.",
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
                
                itemsObj.push({ 
                    name: itemName, 
                    nameHi: asliProduct.nameHi || "", 
                    price: asliProduct.price,         
                    qty: qty,                         
                    qtyText: itemQtyText              
                });
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
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails, userToken } = req.body;

        if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
            return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
        }

        await admin.auth().verifyIdToken(userToken);

        const userData = (await db.ref(`/users/${customerDetails.phone}`).once('value')).val();
        if (userData && userData.blocked === true) return res.json({ success: false, message: "Aapka account block hai. Aap order nahi kar sakte." });

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
                itemsObj.push({ 
                    id: itemId, name: itemName, nameHi: asliProduct.nameHi || "", 
                    price: itemTotal, basePrice: asliProduct.price, qty: qty, qtyText: itemQtyText              
                });
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
                    if (currentStock >= item.qty) {
                        product.stock = currentStock - item.qty; 
                        return product;
                    } else {
                        return undefined;
                    }
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

        if (customerDetails.usedReward && secureSubtotal > 0 && userData && parseInt(userData.freeDeliveries) > 0) {
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
                    if (['Packing in Progress ⏳', 'Confirmed', 'Out for Delivery'].includes(ord.status)) {
                        activeCounts[ord.assignedRider]++;
                    }
                }
            }
            let minCount = Infinity;
            for (let email in activeCounts) { if (activeCounts[email] < minCount) minCount = activeCounts[email]; }
            const bestRiders = onlineRiders.filter(r => activeCounts[r.email] === minCount);
            assignedRiderEmail = bestRiders[Math.floor(Math.random() * bestRiders.length)].email;
        }

        const orderId = "SF" + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2,4).toUpperCase();
        const orderTimestamp = Date.now();

        const orderData = {
            id: orderId, 
            timestamp: orderTimestamp, 
            status: "Packing in Progress ⏳", 
            total: secureFinalTotal, 
            deliveryCharge: secureDeliveryCharge,
            customer: customerDetails.name, 
            phone: customerDetails.phone, 
            email: customerDetails.email || '',
            address: customerDetails.address, 
            items: itemsObj, 
            assignedRider: assignedRiderEmail,
            usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && customerDetails.usedReward
        };

        await db.ref(`/orders/${orderId}`).set(orderData);

        // Telegram Notification
        if(TELEGRAM_SCRIPT_URL) {
            const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
            await fetch(TELEGRAM_SCRIPT_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ 'message': teleMessage })
            }).catch(e => console.log("Telegram error: ", e));
        }

        // ✅ RIDER APP NOTIFICATION (Updated Authorization & URL)
        console.log(`🔍 Checking Notification: RiderEmail=${assignedRiderEmail}`);
        
        if (assignedRiderEmail && ONESIGNAL_RIDER_APP_ID && ONESIGNAL_RIDER_REST_KEY) {
            try {
                console.log(`🔔 Sending OneSignal Push to: ${assignedRiderEmail}`);
                const payload = {
                    app_id: ONESIGNAL_RIDER_APP_ID,
                    filters: [{ field: "tag", key: "rider_email", relation: "=", value: assignedRiderEmail }],
                    headings: { en: "🚨 Naya Order Aaya Hai!" },
                    contents: { en: `Order #${orderId} - ₹${secureFinalTotal} ki delivery hai.` }
                };
                
                // 🚨 NAYA API URL aur "Basic" Authorization 🚨
                const osResponse = await fetch("https://onesignal.com/api/v1/notifications", {
                    method: "POST", 
                    headers: { 
                        "Content-Type": "application/json", 
                        "Accept": "application/json",
                        "Authorization": `Basic ${ONESIGNAL_RIDER_REST_KEY}` 
                    }, 
                    body: JSON.stringify(payload)
                });
                
                const osData = await osResponse.json();
                console.log("✅ OneSignal Response Body:", osData); 
                
            } catch(e) {
                console.error("🚨 OneSignal Request Failed Completely:", e);
            }
        }

        res.json({ success: true, orderId: orderId, orderTimestamp: orderTimestamp });

    } catch (error) {
        console.error("Order Manager Error:", error);
        res.json({ success: false, message: "VIP Token Invalid ya Order Fail ho gaya" });
    }
});

// ==========================================
// 6. 🛵 RIDER API: STATUS UPDATE
// ==========================================
app.post('/api/order/rider-update', async (req, res) => {
    try {
        const { orderId, newStatus, riderToken } = req.body;
        if (!orderId || !newStatus || !riderToken) return res.json({ success: false, message: "Missing info" });

        const decodedRider = await admin.auth().verifyIdToken(riderToken);
        const riderEmail = decodedRider.email;

        const riderRecordSnap = await db.ref(`/riders/${decodedRider.uid}`).once('value');
        if (!riderRecordSnap.exists()) return res.json({ success: false, message: "Rider account not found." });

        const ALLOWED = ['Packing in Progress', 'Confirmed', 'Out for Delivery', 'Delivered', 'Returned/Rejected', 'Cancelled by SabziFresh'];
        if (!ALLOWED.some(a => newStatus.includes(a.split(' ')[0]))) return res.json({ success: false, message: "Invalid status." });

        const orderSnap = await db.ref(`/orders/${orderId}`).once('value');
        const orderData = orderSnap.val();
        if (!orderData) return res.json({ success: false, message: "Order not found." });

        if (orderData.assignedRider && orderData.assignedRider !== riderEmail) {
            return res.json({ success: false, message: "Yeh order kisi aur rider ke paas hai." });
        }

        const updates = { status: newStatus };
        if (newStatus === 'Confirmed') updates.assignedRider = riderEmail;

        await db.ref(`/orders/${orderId}`).update(updates);

        if (newStatus === "Delivered") {
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

        res.json({ success: true, message: "Status Updated Successfully" });
    } catch (error) { 
        res.json({ success: false, message: "Update fail ho gaya." }); 
    }
});

// ==========================================
// 7. 🎁 ADMIN: ORDER DELIVER HONE PAR REWARD
// ==========================================
app.post('/api/order/update-status', async (req, res) => {
    try {
        const { orderId, newStatus, adminToken } = req.body;
        if (!orderId || !newStatus || !adminToken) return res.json({ success: false, message: "Missing info" });

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

    } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 9. 🚫 SECURE ORDER CANCEL
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

        if (orderData.items && orderData.items.length > 0) {
            for (let item of orderData.items) {
                if (item.id) {
                    const productRef = db.ref(`/products/${item.id}`);
                    await productRef.transaction((product) => {
                        if (product) {
                            product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
                        }
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
        if (decodedAdmin.email !== 'neerajkumar00999666@gmail.com') return res.json({ success: false, message: "Access denied" });

        const userRecord = await admin.auth().createUser({ email, password, displayName: name });
        await db.ref(`/riders/${userRecord.uid}`).set({
            name, email, phone, status: 'offline', createdAt: Date.now()
        });

        res.json({ success: true, message: "Rider successfully ban gaya!" });
    } catch (error) { res.json({ success: false, message: error.message }); }
});

// ==========================================
// 11. 🔔 ADMIN: SECURE BROADCAST NOTIFICATION (Customer app - purani API)
// ==========================================
app.post('/api/admin/send-notification', async (req, res) => {
    try {
        const { title, message, adminToken } = req.body;
        const decodedAdmin = await admin.auth().verifyIdToken(adminToken);
        if (decodedAdmin.email !== 'neerajkumar00999666@gmail.com') return res.json({ success: false, message: "Access denied" });

        if (!ONESIGNAL_APP_ID || !ONESIGNAL_REST_KEY) return res.json({ success: false, message: "OneSignal Keys Missing" });

        const payload = {
            app_id: ONESIGNAL_APP_ID,
            included_segments: ["All"],
            headings: { en: title },
            contents: { en: message }
        };

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

        let pendingOrders = [];
        let totalPendingCount = 0;

        for (let key in allOrders) {
            let order = allOrders[key];
            if (order.status !== 'Delivered' && order.status !== 'Cancelled by Customer' && order.status !== 'Cancelled by SabziFresh' && order.status !== 'Returned/Rejected') {
                pendingOrders.push(order);
                totalPendingCount++;
            }
        }

        res.json({ success: true, count: totalPendingCount, orders: pendingOrders });
    } catch (error) { res.json({ success: false, message: "Orders load nahi hue." }); }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
