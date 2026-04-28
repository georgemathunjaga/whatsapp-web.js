require('dotenv').config();
const { Client, LocalAuth } = require('./index');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const bodyParser = require('body-parser');

const app = express();
const port = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL || null;

app.use(bodyParser.json());

// Helper function to beam out message to webhook
async function beamToWebhook(payload) {
    if (!WEBHOOK_URL) return;

    try {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            console.error(`Webhook failed with status: ${response.status}`);
        } else {
            console.log('Message beamed out to webhook successfully');
        }
    } catch (error) {
        console.error('Error beaming out message to webhook:', error.message);
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    webVersion: '2.3000.1037662086',
    webVersionCache: {
        type: 'remote',
        remotePath:
            'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1037662086.html',
    },
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
        ],
    },
});

let isReady = false;
let lastQr = null;

// Message listener for webhook and simple booking bot
client.on('message', async (msg) => {
    if (msg.from === 'status@broadcast') return; // Ignore status updates

    console.log(`New message from ${msg.from}: ${msg.body}`);

    // Beam out to webhook
    await beamToWebhook({
        id: msg.id._serialized,
        body: msg.body,
        from: msg.from,
        to: msg.to,
        timestamp: msg.timestamp,
        type: msg.type,
        hasMedia: msg.hasMedia,
        fromMe: msg.fromMe,
        source: 'incoming',
    });

    // Simple Booking Bot Logic
    const body = msg.body.toLowerCase();
    if (
        body.includes('book') ||
        body.includes('appointment') ||
        body.includes('schedule')
    ) {
        await msg.reply(
            'Thank you for reaching out to us! 🌸 To book your appointment, please reply with your preferred *Date*, *Time*, and the *Service* you are interested in (e.g., Haircut, Color, Manicure). Our team will confirm it for you shortly!',
        );
    } else if (body === 'hi' || body === 'hello') {
        await msg.reply(
            'Hello! Welcome to our salon. How can we help you today? You can ask about our services or say "book" to start an appointment request.',
        );
    }
});

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
        const qrBase64 = qrDataUrl.split(',')[1];
        res.json({
            ready: false,
            qr: lastQr,
            qrImage: qrDataUrl,
            qrBase64: qrBase64,
        });
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
        // Clean the number: remove all non-numeric characters except for @ and .
        let sanitized_number = number.toString().replace(/[^\d@.]/g, '');

        // If it doesn't have a domain, assume it's a contact number
        const final_number = sanitized_number.includes('@')
            ? sanitized_number
            : `${sanitized_number}@c.us`;

        console.log(`Attempting to send message to: ${final_number}`);

        // Verify if the number is registered on WhatsApp
        const numberId = await client.getNumberId(final_number);
        if (!numberId) {
            return res.status(404).json({
                success: false,
                error: 'Number not registered on WhatsApp',
                details: `The number ${final_number} could not be found.`,
            });
        }

        const sentMsg = await client.sendMessage(numberId._serialized, message);

        // Beam to webhook after successful send
        await beamToWebhook({
            id: sentMsg.id._serialized,
            body: sentMsg.body,
            from: sentMsg.from,
            to: sentMsg.to,
            timestamp: sentMsg.timestamp,
            type: sentMsg.type,
            hasMedia: sentMsg.hasMedia,
            fromMe: sentMsg.fromMe,
            source: 'outgoing',
        });

        res.json({
            success: true,
            message: 'Message sent successfully',
            messageId: sentMsg.id._serialized,
        });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.message || error,
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
