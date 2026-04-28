/**
 * n8n Integration Example
 *
 * This example shows how to send incoming WhatsApp messages to an n8n webhook.
 *
 * To use this:
 * 1. Create a Webhook node in n8n.
 * 2. Set the HTTP Method to POST.
 * 3. Copy the Production URL and replace 'YOUR_N8N_WEBHOOK_URL' below.
 * 4. Activate your workflow in n8n.
 */

const { Client, LocalAuth } = require('./index');
const fetch = require('node-fetch');

// Replace with your actual n8n webhook URL
const N8N_WEBHOOK_URL =
    process.env.N8N_WEBHOOK_URL ||
    'https://primary-production-d73b9.up.railway.app/webhook/5a78874c-4c8f-4314-a524-59443dd5d9dc';

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true, // Set to false if you want to see the browser
    },
});

client.on('qr', (qr) => {
    // Generate and scan this QR code in WhatsApp
    console.log('QR RECEIVED', qr);
});

client.on('ready', () => {
    console.log('WhatsApp is ready!');
});

/**
 * Trigger n8n webhook with retry logic
 */
async function triggerN8n(msg, retries = 3) {
    const payload = {
        from: msg.from,
        body: msg.body,
        type: msg.type,
        timestamp: msg.timestamp,
        pushname: msg._data.notifyName, // Name of the sender
        isGroup: msg.isGroupMsg,
    };

    try {
        const response = await fetch(N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error(
                `n8n responded with ${response.status}: ${response.statusText}`,
            );
        }

        console.log(`Successfully sent message from ${msg.from} to n8n`);
    } catch (err) {
        console.error(
            `Error sending to n8n (Retries left: ${retries}):`,
            err.message,
        );
        if (retries > 0) {
            setTimeout(() => triggerN8n(msg, retries - 1), 2000);
        } else {
            console.error('Failed to send message to n8n after all retries.');
        }
    }
}

client.on('message', async (msg) => {
    // We only process incoming chat messages (text) in this example
    // You can remove this check to send all types (images, etc.) to n8n
    if (msg.type === 'chat') {
        console.log(`Incoming message from ${msg.from}: ${msg.body}`);
        triggerN8n(msg);
    }
});

client.initialize();
