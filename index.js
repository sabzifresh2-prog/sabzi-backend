    const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh API Live Hai!' });
});

app.post('/api/otp/send', async (req, res) => {
    try {
        // .trim() aage-peeche ke faltu space hata dega
        const GOOGLE_URL = (process.env.GOOGLE_SCRIPT_URL || "").trim();
        const SECRET = (process.env.OTP_SECRET_KEY || "").trim();
        const { email } = req.body;
        
        const url = `${GOOGLE_URL}?action=send_otp&email=${encodeURIComponent(email)}&secret=${encodeURIComponent(SECRET)}`;
        
        const response = await fetch(url);
        const text = await response.text(); 
        
        try {
            res.json(JSON.parse(text));
        } catch (e) {
            res.json({ success: false, message: "Google Error: " + text.substring(0, 40) });
        }
    } catch (error) {
        res.json({ success: false, message: "Server Error: " + error.message });
    }
});

app.post('/api/otp/verify', async (req, res) => {
    try {
        const GOOGLE_URL = (process.env.GOOGLE_SCRIPT_URL || "").trim();
        const SECRET = (process.env.OTP_SECRET_KEY || "").trim();
        const { email, code } = req.body;
        
        const url = `${GOOGLE_URL}?action=verify_otp&email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}&secret=${encodeURIComponent(SECRET)}`;
        
        const response = await fetch(url);
        const text = await response.text();
        
        try {
            res.json(JSON.parse(text));
        } catch (e) {
            res.json({ success: false, message: "Google Error: " + text.substring(0, 40) });
        }
    } catch (error) {
        res.json({ success: false, message: "Server Error: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
