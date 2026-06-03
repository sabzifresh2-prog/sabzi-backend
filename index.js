const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// ⚙️ ENVIRONMENT VARIABLES (Server Settings)
// ==========================================
// Dhyan de: Yahan se FIREBASE_SECRET hata diya gaya hai!
const OTP_SCRIPT_URL = (process.env.OTP_SCRIPT_URL || "").trim();
const TELEGRAM_SCRIPT_URL = (process.env.TELEGRAM_SCRIPT_URL || "").trim();
const OTP_SECRET_KEY = (process.env.OTP_SECRET_KEY || "").trim();

// Aapke Firebase Database ka URL
const FIREBASE_DB_URL = "https://sabzifresh-d8742-default-rtdb.firebaseio.com";

// Helper Function: Agar request mein User Token hai, toh usko URL mein jod dega
const getDbUrl = (path, token = null) => {
    return token ? `${FIREBASE_DB_URL}${path}?auth=${token}` : `${FIREBASE_DB_URL}${path}`;
};

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

        // Refer Code Logic
        let referrerPhone = null;
        if (referCode) {
            // (Note: referCodes public hone chahiye aapke rules mein taaki ye read ho sake)
            const referRes = await fetch(getDbUrl('/referCodes.json'));
            const allReferCodes = (await referRes.json()) || {};
            
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

        // 🚨 FIREBASE WRITE: Hum direct save kar rahe hain, Firebase khud check karega!
        const saveUserRes = await fetch(getDbUrl(`/users/${phone}.json`, userToken), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newUser)
        });

        // Agar Firebase ne error diya, matlab Number ya Email purana hai!
        if (!saveUserRes.ok) {
            const myWhatsAppNumber = "8409081468"; // 👇 APNA WHATSAPP NUMBER YAHAN DAALEIN
            const waMessage = encodeURIComponent(`Hi Sabzi Fresh team, mera mobile number ${phone} already registered bata raha hai kyonki main apna purana Email bhool gaya hoon. Kripya is number ka data reset kar dein.`);
            
            return res.json({ 
                success: false, 
                message: "⚠️ Yeh Mobile Number pehle se registered hai! Agar aap apna Email bhool gaye hain, toh kripya WhatsApp par Admin ko message karein.",
                showWhatsAppSupport: true, 
                whatsappLink: `https://wa.me/${myWhatsAppNumber}?text=${waMessage}`
            });
        }

        // Refer code save karna (agar rule allow kare)
        await fetch(getDbUrl(`/referCodes/${newCode}.json`, userToken), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(phone)
        });

        res.json({ success: true, user: newUser });

    } catch (error) {
        console.error("Register Error:", error);
        res.json({ success: false, message: "Server Error: Kripya thodi der baad try karein." });
    }
});


// ==========================================
// 4. 🛒 SECURE BILL CALCULATOR (Bina Order Place kiye)
// ==========================================
app.post('/api/order/calculate', async (req, res) => {
    try {
        const { cartItems } = req.body; 
        if (!cartItems) return res.json({ success: false, message: "Cart khali hai" });

        const [dbResponse, settingsResponse] = await Promise.all([
            fetch(getDbUrl('/products.json')), fetch(getDbUrl('/settings.json'))
        ]);

        const productsDB = (await dbResponse.json()) || {};
        const settingsDB = (await settingsResponse.json()) || {};

        let adminDeliveryFee = settingsDB.deliveryCharge !== undefined ? parseInt(settingsDB.deliveryCharge) : 20;
        let adminFreeLimit = settingsDB.minFreeDeliveryThreshold !== undefined ? parseInt(settingsDB.minFreeDeliveryThreshold) : 100;
        let secureSubtotal = 0; let secureItemsList = [];

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
        res.json({
            success: true, asliSubtotal: secureSubtotal, asliDelivery: secureDeliveryCharge,
            asliTotal: secureSubtotal + secureDeliveryCharge, verifiedItems: secureItemsList
        });

    } catch (error) {
        res.json({ success: false, message: "Bill calculation error" });
    }
});

// ==========================================
// 5. 🚀 SECURE ORDER MANAGER (User Token ke sath)
// ==========================================
app.post('/api/order/place', async (req, res) => {
    try {
        // NAYA: Frontend se Customer ka VIP Pass (userToken) aayega
        const { cartItems, customerDetails, userToken } = req.body;

        if (!cartItems || !customerDetails || !customerDetails.phone || !userToken) {
            return res.json({ success: false, message: "Invalid order data ya Token missing hai" });
        }

        // Dobara bill calculate karna
        const [dbResponse, settingsResponse] = await Promise.all([
            fetch(getDbUrl('/products.json')), fetch(getDbUrl('/settings.json'))
        ]);
        const productsDB = (await dbResponse.json()) || {};
        const settingsDB = (await settingsResponse.json()) || {};

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
                secureItemsList.push(`${itemName} x${qty} (₹${itemTotal})`);
                itemsObj.push({ name: itemName, price: itemTotal });
            }
        }

        if (secureSubtotal === 0) return res.json({ success: false, message: "Cart is empty" });

    
let secureDeliveryCharge = (secureSubtotal > 0 && secureSubtotal < adminFreeLimit) ? adminDeliveryFee : 0;
let finalUsedReward = false;

if (customerDetails.usedReward && secureSubtotal > 0) {
    const userCheckRes = await fetch(getDbUrl(`/users/${customerDetails.phone}.json`, userToken));
    const userData = await userCheckRes.json();

    if (userData && parseInt(userData.freeDeliveries) > 0) {
        secureDeliveryCharge = 0; 
        finalUsedReward = true;

        let newFreeDel = parseInt(userData.freeDeliveries) - 1;
        await fetch(getDbUrl(`/users/${customerDetails.phone}.json`, userToken), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ freeDeliveries: newFreeDel })
        });
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

        // 🚨 FIREBASE WRITE: Yahan userToken ka use hua hai! 
        // Firebase ab check karega ki "auth.token.email == orderData.email" hai ya nahi.
        const firebaseWriteRes = await fetch(getDbUrl(`/orders/${orderId}.json`, userToken), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderData)
        });

        if (!firebaseWriteRes.ok) {
            throw new Error("Firebase Rules Block: Aapka token galat hai ya Order ka email match nahi kar raha!");
        }

        // TELEGRAM NOTIFICATION
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
        res.json({ success: false, message: error.message });
    }
});

// ==========================================
// 6. 🎁 ORDER DELIVER HONE PAR REWARD DENA (Admin Only)
// ==========================================
app.post('/api/order/update-status', async (req, res) => {
    try {
        // Yahan Admin Apna Token (neerajkumar00999666@gmail.com) bhejega
        const { orderId, newStatus, adminToken } = req.body;

        if (!orderId || !newStatus || !adminToken) {
            return res.json({ success: false, message: "Order ID, Status aur Admin Token zaroori hai" });
        }

        // Order status update karna (Admin Token ke sath)
        const statusRes = await fetch(getDbUrl(`/orders/${orderId}/status.json`, adminToken), {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newStatus)
        });

        if (!statusRes.ok) throw new Error("Aapko Admin access nahi hai!");

        // Reward Logic
        if (newStatus === "Delivered") {
            const orderRes = await fetch(getDbUrl(`/orders/${orderId}.json`, adminToken));
            const orderData = await orderRes.json();

            if (orderData && orderData.phone) {
                const customerPhone = orderData.phone;
                const userRes = await fetch(getDbUrl(`/users/${customerPhone}.json`, adminToken));
                const userData = await userRes.json();

                if (userData && userData.referredBy && userData.referralStatus === "pending") {
                    const referrerPhone = userData.referredBy;
                    const referrerRes = await fetch(getDbUrl(`/users/${referrerPhone}.json`, adminToken));
                    const referrerData = await referrerRes.json();

                    if (referrerData) {
                        let currentFreeDel = parseInt(referrerData.freeDeliveries) || 0;
                        let newExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); 

                        // Referrer ko 3 delivery dena
                        await fetch(getDbUrl(`/users/${referrerPhone}.json`, adminToken), {
                            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ freeDeliveries: currentFreeDel + 3, rewardExpiry: newExpiry })
                        });

                        // Customer ka status 'completed' karna
                        await fetch(getDbUrl(`/users/${customerPhone}.json`, adminToken), {
                            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ referralStatus: "completed" })
                        });
                    }
                }
            }
        }
        res.json({ success: true, message: "Status updated" });

    } catch (error) {
        console.error("Status Update Error:", error);
        res.json({ success: false, message: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
// ==========================================
// 7. 🎁 MANUAL REWARD DENA (Sirf Admin Ke Liye)
// ==========================================
app.post('/api/admin/give-reward', async (req, res) => {
    try {
        const { targetPhone, rewardCount, adminToken } = req.body;

        if (!targetPhone || !rewardCount || !adminToken) {
            return res.json({ success: false, message: "Target Phone, Reward Count aur Admin Token zaroori hai" });
        }

        // 1. User ka purana data nikalo (Admin Token se lock khol kar)
        const userRes = await fetch(getDbUrl(`/users/${targetPhone}.json`, adminToken));
        
        if (!userRes.ok) {
            return res.json({ success: false, message: "Aapko Admin access nahi hai!" });
        }
        
        const userData = await userRes.json();
        if (!userData) {
            return res.json({ success: false, message: "User nahi mila" });
        }

        // 2. Naya Reward set karo
        let currentFreeDel = parseInt(userData.freeDeliveries) || 0;
        let newFreeDel = currentFreeDel + parseInt(rewardCount);
        let newExpiry = Date.now() + (30 * 24 * 60 * 60 * 1000); // 30 din ki validity

        // 3. Database update karo
        await fetch(getDbUrl(`/users/${targetPhone}.json`, adminToken), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                freeDeliveries: newFreeDel > 0 ? newFreeDel : 0, // 0 se kam na ho
                rewardExpiry: newFreeDel > 0 ? newExpiry : null
            })
        });

        res.json({ success: true, message: `User ${targetPhone} ko ${rewardCount} reward manually de diya gaya.` });

    } catch (error) {
        console.error("Manual Reward Error:", error);
        res.json({ success: false, message: error.message });
    }
});
// ==========================================
// 8. 🚫 SECURE ORDER CANCEL (User Token Ke Sath)
// ==========================================
app.post('/api/order/cancel', async (req, res) => {
    try {
        const { orderId, cancelReason, userToken } = req.body;

        if (!orderId || !userToken) {
            return res.json({ success: false, message: "Order ID aur Token zaroori hai" });
        }

        // 1. Order ka existing data fetch karna (VIP Token se)
        // Firebase rules check karenge ki ye order sach mein isi user ka hai ya nahi
        const orderRes = await fetch(getDbUrl(`/orders/${orderId}.json`, userToken));
        
        if (!orderRes.ok) {
            return res.json({ success: false, message: "VIP Lock: Aapko ye order cancel karne ki permission nahi hai." });
        }

        const orderData = await orderRes.json();
        
        if (!orderData) {
            return res.json({ success: false, message: "Order nahi mila." });
        }

        // 2. Check karna ki order raste mein toh nahi nikal gaya
        if (orderData.status !== 'Packing in Progress ⏳' && orderData.status !== 'Confirmed') {
            return res.json({ success: false, message: "Order pack ho chuka hai ya raste mein hai, ab cancel nahi ho sakta." });
        }

        // 3. Status Update karna (Database mein)
        await fetch(getDbUrl(`/orders/${orderId}.json`, userToken), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                status: 'Cancelled by Customer', 
                cancelReason: cancelReason || 'No reason provided'
            })
        });

        // 4. User profile mein cancelCount badhana (Anti-spam ke liye)
        if (orderData.phone) {
            const userRes = await fetch(getDbUrl(`/users/${orderData.phone}.json`, userToken));
            if (userRes.ok) {
                const userData = await userRes.json();
                const newCancelCount = (parseInt(userData.cancelCount) || 0) + 1;
                
                await fetch(getDbUrl(`/users/${orderData.phone}.json`, userToken), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cancelCount: newCancelCount })
                });
            }
        }

        res.json({ success: true, message: "Order successfully cancel ho gaya." });

    } catch (error) {
        console.error("Cancel Order Error:", error);
        res.json({ success: false, message: "Server error" });
    }
});
