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
const ONESIGNAL_APP_ID = (process.env.ONESIGNAL_APP_ID || "").trim();
const ONESIGNAL_REST_KEY = (process.env.ONESIGNAL_REST_KEY || "").trim();

// ✅ FIREBASE ADMIN INITIALIZATION
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

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API VIP Lock ke sath Live Hai!' });
});

// ==========================================
// 1. 📩 OTP BHEJNA & VERIFY KARNA
// ==========================================
app.post('/api/otp/send', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.json({ success: false, message: "Email required" });
        const url = `${OTP_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Network Error 🌐: Google Server Busy. Retry karein." }); }
    } catch (error) { res.json({ success: false, message: "Network Error 🌐: Server Down." }); }
});

app.post('/api/otp/verify', async (req, res) => {
    try {
        const { email, code } = req.body;
        if (!email || !code) return res.json({ success: false, message: "Email aur code zaroori hai" });
        const url = `${OTP_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
        const response = await fetch(url);
        const text = await response.text();
        try { res.json(JSON.parse(text)); } 
        catch (e) { res.json({ success: false, message: "Network Error 🌐: Google Server Busy. Retry karein." }); }
    } catch (error) { res.json({ success: false, message: "Network Error 🌐: Server Down." }); }
});

// ==========================================
// 2. 🛡️ SECURE REGISTRATION & WHATSAPP SUPPORT
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { phone, name, email, referCode, userToken } = req.body;
        const cleanEmail = email ? email.toLowerCase().trim() : "";

        if (!phone || !name || !userToken || !cleanEmail) {
            return res.json({ success: false, message: "Details zaroori hai!" });
        }

        const decodedToken = await admin.auth().verifyIdToken(userToken);
        if (decodedToken.email !== cleanEmail) {
            return res.json({ success: false, message: "Fake Identity Alert!" });
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

        const userSnap = await db.ref(`/users/${phone}`).once('value');
        if (userSnap.exists()) {
            return res.json({ 
                success: false, 
                message: "⚠️ Yeh Number pehle se registered hai! Purane Gmail se login karein.",
                showWhatsAppSupport: true, 
                whatsappLink: `https://wa.me/+918409081468?text=Account%20Recovery%20Request`
            });
        }

        const newCode = "SF" + Math.floor(1000 + Math.random() * 9000);
        const newUser = {
            name, email: cleanEmail, phone, savedVillage: "", savedStreet: "", referCode: newCode,
            freeDeliveries: 0, rewardExpiry: null, registeredAt: Date.now(),
            referredBy: referrerPhone || null, referralStatus: referrerPhone ? "pending" : null
        };

        await db.ref(`/users/${phone}`).set(newUser);
        await db.ref(`/referCodes/${newCode}`).set(phone);
        res.json({ success: true, user: newUser });
    } catch (error) { res.json({ success: false, message: "Invalid Token." }); }
});

// ==========================================
// 3. 🛒 SECURE BILL CALCULATOR
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        const { cartItems } = req.body; 
        if (!cartItems) return res.json({ success: false, message: "Cart khali hai" });

        const productsDB = (await db.ref('/products').once('value')).val() || {};
        const settingsDB = (await db.ref('/settings').once('value')).val() || {};

        let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 0;
        let adminFreeLimit = parseInt(settingsDB.minFreeDeliveryThreshold) || 0;
        
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

        let secureDeliveryCharge = 0;
        if (secureSubtotal > 0) {
            if (adminFreeLimit > 0 && secureSubtotal >= adminFreeLimit) {
                secureDeliveryCharge = 0; 
            } else {
                secureDeliveryCharge = adminDeliveryFee;
            }
        }

        res.json({
            success: true, 
            asliSubtotal: secureSubtotal, 
            asliDelivery: secureDeliveryCharge,
            asliTotal: secureSubtotal + secureDeliveryCharge, 
            verifiedItems: secureItemsList
        });

    } catch (error) {
        res.json({ success: false, message: "Bill calculation error" });
    }
});

// ==========================================
// 4. 🚀 SECURE ORDER MANAGER (With Smart Rider Assign)
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        const { cartItems, customerDetails, userToken } = req.body;
        if (!cartItems || !customerDetails || !userToken) return res.json({ success: false, message: "Invalid data" });

        await admin.auth().verifyIdToken(userToken);

        const userData = (await db.ref(`/users/${customerDetails.phone}`).once('value')).val();
        if (userData && userData.blocked === true) return res.json({ success: false, message: "Account blocked." });

        const settingsDB = (await db.ref('/settings').once('value')).val() || {};
        if (settingsDB.isAppClosed === true) return res.json({ success: false, message: "Abhi dukan band hai." });

        const productsDB = (await db.ref('/products').once('value')).val() || {};
        
        let adminDeliveryFee = parseInt(settingsDB.deliveryCharge) || 0;
        let adminFreeLimit = parseInt(settingsDB.minFreeDeliveryThreshold) || 0;

        let secureSubtotal = 0; 
        let secureItemsList = []; 
        let itemsObj = [];
        let stockUpdates = {}; 

        for (let itemId in cartItems) {
            let qty = parseFloat(cartItems[itemId]);
            let asliProduct = productsDB[itemId];
            
            if (asliProduct && !isNaN(qty) && qty > 0) {
                let currentStock = parseFloat(asliProduct.stock) || 0;
                if (currentStock < qty) {
                    return res.json({ 
                        success: false, 
                        message: `Sorry, '${asliProduct.nameEn || "Item"}' available nahi hai ya stock kam hai. Sirf ${currentStock} bache hain.` 
                    });
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

                stockUpdates[`/products/${itemId}/stock`] = currentStock - qty;
            }
        }

        if (secureSubtotal === 0) return res.json({ success: false, message: "Cart empty" });

        let secureDeliveryCharge = 0;
        if (adminFreeLimit > 0 && secureSubtotal >= adminFreeLimit) {
            secureDeliveryCharge = 0; 
        } else {
            secureDeliveryCharge = adminDeliveryFee;
        }

        if (customerDetails.usedReward && secureSubtotal > 0 && userData && parseInt(userData.freeDeliveries) > 0) {
            secureDeliveryCharge = 0; 
            let newFreeDel = parseInt(userData.freeDeliveries) - 1;
            await db.ref(`/users/${customerDetails.phone}`).update({ freeDeliveries: newFreeDel });
        }
        
        let secureFinalTotal = secureSubtotal + secureDeliveryCharge;

        // ==========================================
        // 🧠 NAYA SMART RIDER ASSIGN LOGIC START
        // ==========================================
        let assignedRiderEmail = null;
        const ridersSnap = await db.ref('/riders').orderByChild('status').equalTo('online').once('value');
        
        if (ridersSnap.exists()) {
            const ridersData = ridersSnap.val();
            const onlineRiders = Object.values(ridersData);
            
            // Sabhi active orders uthao taaki pata chale kis rider par kitna load hai
            const ordersSnap = await db.ref('/orders').once('value');
            const allOrders = ordersSnap.val() || {};
            
            // Har online rider ka khata (count) 0 se shuru karo
            let activeCounts = {};
            onlineRiders.forEach(r => { activeCounts[r.email] = 0; });

            // Count karo kis rider ke paas kitne pending orders hain
            for (let key in allOrders) {
                let ord = allOrders[key];
                if (ord.assignedRider && activeCounts[ord.assignedRider] !== undefined) {
                    if (ord.status !== 'Delivered' && ord.status !== 'Cancelled by Customer' && ord.status !== 'Cancelled by SabziFresh' && ord.status !== 'Returned/Rejected') {
                        activeCounts[ord.assignedRider]++;
                    }
                }
            }

            // Sabse kam order wala number dhundho (Maan lo kisi ke paas 0 hai, kisi ke paas 2)
            let minCount = Infinity;
            for (let email in activeCounts) {
                if (activeCounts[email] < minCount) {
                    minCount = activeCounts[email];
                }
            }

            // Un riders ko alag nikalo jinke paas sabse kam (ya 0) order hain
            const bestRiders = onlineRiders.filter(r => activeCounts[r.email] === minCount);

            // Agar 2 riders khali hain, toh unme se randomly ek ko de do
            const selectedRider = bestRiders[Math.floor(Math.random() * bestRiders.length)];
            assignedRiderEmail = selectedRider.email;
        }
        // ==========================================
        // 🧠 SMART RIDER ASSIGN LOGIC END
        // ==========================================

        const orderId = "SF" + Date.now().toString(36).toUpperCase().substr(4,6);
        const orderTimestamp = Date.now();

        const orderData = {
            id: orderId, timestamp: orderTimestamp, status: "Packing in Progress ⏳", 
            total: secureFinalTotal, deliveryCharge: secureDeliveryCharge,
            customer: customerDetails.name, phone: customerDetails.phone, 
            email: (customerDetails.email || '').toLowerCase().trim(),
            address: customerDetails.address, items: itemsObj, 
            assignedRider: assignedRiderEmail,
            usedFreeDelivery: secureDeliveryCharge === 0 && secureSubtotal > 0 && customerDetails.usedReward
        };

        stockUpdates[`/orders/${orderId}`] = orderData;
        await db.ref().update(stockUpdates);

        if(TELEGRAM_SCRIPT_URL) {
            const teleMessage = `🚨 *NEW SECURE ORDER!* 🚨\n\n📦 *ID:* #${orderId}\n👤 *Name:* ${customerDetails.name}\n📞 *Phone:* ${customerDetails.phone}\n📍 *Address:* ${customerDetails.address}\n\n🛒 *Items:*\n${secureItemsList.join('\n')}\n\n🚚 *Delivery:* ₹${secureDeliveryCharge}\n💰 *Total Paid:* ₹${secureFinalTotal}`;
            fetch(TELEGRAM_SCRIPT_URL, {
                method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ 'message': teleMessage })
            }).catch(e => console.log("Telegram error: ", e));
        }

        if (assignedRiderEmail && ONESIGNAL_APP_ID && ONESIGNAL_REST_KEY) {
            try {
                const payload = {
                    app_id: ONESIGNAL_APP_ID,
                    filters: [{ field: "tag", key: "rider_email", relation: "=", value: assignedRiderEmail }],
                    headings: { en: "🚨 Naya Order Aaya Hai!" },
                    contents: { en: `Order #${orderId} - ₹${secureFinalTotal} ki delivery hai. App khol kar accept karein!` }
                };
                fetch("https://onesignal.com/api/v1/notifications", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` },
                    body: JSON.stringify(payload)
                }).catch(err => console.log("OneSignal Request failed"));
            } catch(e) { console.log("Rider Notification Error"); }
        }

        res.json({ success: true, orderId: orderId, orderTimestamp: orderTimestamp });
    } catch (error) { res.json({ success: false, message: "Order Fail." }); }
});

// ==========================================
// 5. 🛵 RIDER API: STATUS UPDATE
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
            return res.json({ success: false, message: "Yeh order pehle se kisi aur rider ke paas hai." });
        }

        const updates = { status: newStatus };
        if (newStatus === 'Confirmed') updates.assignedRider = riderEmail;

        await db.ref(`/orders/${orderId}`).update(updates);
        res.json({ success: true, message: "Status Updated Successfully" });
    } catch (error) {
        res.json({ success: false, message: "Network Error 🌐: Update fail ho gaya." });
    }
});

// ==========================================
// 6. 🎁 ADMIN: ORDER DELIVERED & REWARD PROCESSING
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
// 7. 🎁 ADMIN: MANUAL REWARD DENA
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
// 8. 🚫 SECURE ORDER CANCEL (With Stock Restore)
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
                const productRef = db.ref(`/products/${item.id}`);
                await productRef.transaction((product) => {
                    if (product) {
                        product.stock = (parseFloat(product.stock) || 0) + parseFloat(item.qty);
                    }
                    return product;
                });
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
        res.json({ success: true, message: "Order successfully cancel ho gaya aur stock wapas add ho gaya." });
    } catch (error) { res.json({ success: false, message: "Server error" }); }
});

// ==========================================
// 9. 👨‍💼 ADMIN: CREATE RIDER ACCOUNT
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
// 10. 🔔 ADMIN: SECURE BROADCAST NOTIFICATION
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
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Basic ${ONESIGNAL_REST_KEY}` },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        res.json({ success: true, response: data });
    } catch (error) { res.json({ success: false, message: "Notification send fail." }); }
});

// ==========================================
// 11. 🛵 RIDER DASHBOARD: Pending Orders
// ==========================================
app.post('/api/rider/my-orders', async (req, res) => {
    try {
        const { riderToken } = req.body;
        if (!riderToken) return res.json({ success: false, message: "Rider ka login token missing hai" });

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

        res.json({ 
            success: true, 
            message: `Aapke paas total ${totalPendingCount} pending orders hain. Fatafat deliver karein!`,
            count: totalPendingCount, 
            orders: pendingOrders 
        });

    } catch (error) {
        res.json({ success: false, message: "Network Error 🌐: Orders load nahi hue." });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par ekdum secure chal raha hai!`);
});
