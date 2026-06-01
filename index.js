const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Yeh bata raha hai ki server zinda hai
app.get('/', (req, res) => {
    res.json({ status: 'OK', message: 'Sabzi Fresh Backend Makkhan Ki Tarah Chal Raha Hai!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server port ${PORT} par chal raha hai`);
});
