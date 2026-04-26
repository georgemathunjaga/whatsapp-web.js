const { Client, LocalAuth } = require('./index');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
        ],
    },
});

let isReady = false;
let lastQr = null;

client.on('qr', (qr) => {
    console.log('QR RECEIVED, SCAN WITH WHATSAPP:');
    lastQr = qr;
    qrcodeTerminal.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('WhatsApp Client is ready!');
    isReady = true;
    lastQr = null; // Clear QR once ready
});

client.on('authenticated', () => {
    console.log('AUTHENTICATED');
});

client.on('auth_failure', (msg) => {
    console.error('AUTHENTICATION FAILURE', msg);
});

client.on('disconnected', (reason) => {
    console.log('Client was logged out', reason);
    isReady = false;
    client.initialize();
});

// client.initialize(); // Moved to app.listen below

// API Endpoints

app.get('/status', (req, res) => {
    res.json({
        ready: isReady,
        message: isReady ? 'Client is ready' : 'Client is not ready',
    });
});

app.get('/connect', async (req, res) => {
    if (isReady) {
        return res.json({ ready: true, message: 'Already connected' });
    }
    if (!lastQr) {
        return res.json({
            ready: false,
            message: 'QR not generated yet. Please wait or check terminal.',
        });
    }

    try {
        const qrDataUrl = await QRCode.toDataURL(lastQr);
        res.json({ ready: false, qr: lastQr, qrImage: qrDataUrl });
    } catch {
        res.status(500).json({ error: 'Failed to generate QR image' });
    }
});

app.post('/send-message', async (req, res) => {
    const { number, message } = req.body;

    if (!isReady) {
        return res.status(503).json({ error: 'Client is not ready' });
    }

    if (!number || !message) {
        return res
            .status(400)
            .json({ error: 'Number and message are required' });
    }

    try {
        // Format number to WhatsApp ID (e.g. 254712345678@c.us)
        const sanitized_number = number.toString().replace(/[- )(]/g, '');
        const final_number = sanitized_number.includes('@c.us')
            ? sanitized_number
            : `${sanitized_number}@c.us`;

        await client.sendMessage(final_number, message);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message,
        });
    }
});

app.get('/messages', async (req, res) => {
    const { number, limit = 20 } = req.query;

    if (!isReady) {
        return res.status(503).json({ error: 'Client is not ready' });
    }

    try {
        let messages = [];

        if (number) {
            // Fetch messages for a specific number
            const sanitized_number = number.toString().replace(/[- )(]/g, '');
            const final_number = sanitized_number.includes('@c.us')
                ? sanitized_number
                : `${sanitized_number}@c.us`;

            const chat = await client.getChatById(final_number);
            messages = await chat.fetchMessages({ limit: parseInt(limit) });
        } else {
            // Fetch recent messages from all chats (this can be slow)
            const chats = await client.getChats();
            const messagePromises = chats
                .slice(0, 5)
                .map((chat) => chat.fetchMessages({ limit: 5 }));
            const nestedMessages = await Promise.all(messagePromises);
            messages = nestedMessages
                .flat()
                .sort((a, b) => b.timestamp - a.timestamp);
        }

        // Clean up message objects for response
        const formattedMessages = messages.map((msg) => ({
            id: msg.id._serialized,
            body: msg.body,
            from: msg.from,
            to: msg.to,
            timestamp: msg.timestamp,
            fromMe: msg.fromMe,
            hasMedia: msg.hasMedia,
            type: msg.type,
        }));

        res.json({ success: true, messages: formattedMessages });
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({
            error: 'Failed to fetch messages',
            details: error.message,
        });
    }
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Endpoint not found',
        path: req.path,
    });
});

// Global Error Handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({
        success: false,
        error: 'Internal Server Error',
        message: err.message,
    });
});

app.listen(port, () => {
    console.log(`✅ WhatsApp API Server running at http://localhost:${port}`);
    console.log('⏳ Initializing WhatsApp client...');
    client.initialize().catch((err) => {
        console.error('❌ Failed to initialize WhatsApp client:', err);
    });
});
