const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Render ki tijori se tokens nikalna
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const OTP_SECRET_KEY = process.env.OTP_SECRET_KEY;

// Test Route
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

// OTP Bhejne ka Route
app.post('/api/otp/send', async (req, res) => {
    const { email } = req.body;
    const url = `${GOOGLE_SCRIPT_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.json({ success: false, message: "Backend server error" });
    }
});

// OTP Verify karne ka Route
app.post('/api/otp/verify', async (req, res) => {
    const { email, code } = req.body;
    const url = `${GOOGLE_SCRIPT_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(OTP_SECRET_KEY)}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.json({ success: false, message: "Backend server error" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
