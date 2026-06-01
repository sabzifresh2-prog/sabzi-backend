const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Render ki tijori se khufiya chabiyan nikalna
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const OTP_SECRET_KEY = process.env.OTP_SECRET_KEY;

// Test Route
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

// 2. OTP BHEJNE KA ROUTE (Frontend yahan request karega)
app.post('/api/otp/send', async (req, res) => {
    const { email } = req.body;
    
    // Backend chhupke se Google Script ko request bhej raha hai
    const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data); // Wapas frontend ko result dena
    } catch (error) {
        res.json({ success: false, message: "Backend server error" });
    }
});

// 3. OTP VERIFY KARNE KA ROUTE
app.post('/api/otp/verify', async (req, res) => {
    const { email, code } = req.body;
    
    const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data); // Isme Firebase ka Custom Token hoga!
    } catch (error) {
        res.json({ success: false, message: "Backend server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
