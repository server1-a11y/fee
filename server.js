// server.js

// --- Impor modul yang diperlukan ---
const http = require('http');
const https = require('https');
const path = require('path');
const { Server } = require("socket.io");
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const piBot = require('./run.js'); // Asumsi file ini ada dan diekspor

// --- KONFIGURASI PENTING ---
const TELEGRAM_TOKEN = '8312312035:AAHQF1p_IqgTQMfA1B-k_ls9NpOTGPzKysE';
const WEBHOOK_URL = 'https://raw.panelbot.cloud';
const PORT = process.env.PORT || 3000;
// ----------------------------

const CONFIG_FILE = './config.json';
let config = loadConfig();
let adminChatId = config.adminChatId || null;
let userState = {};

// Inisialisasi Bot Telegram
const bot = new TelegramBot(TELEGRAM_TOKEN);
const app = express();

// --- Rate Limit Telegram ---
let notificationQueue = [];
let isProcessingQueue = false;
const TELEGRAM_DELAY_MS = 1000;

// --- Socket.IO Logging ---
const server = http.createServer(app);
const io = new Server(server);

// Override console.log
const originalLog = console.log;
console.log = function (...args) {
    originalLog.apply(console, args);
    const logMessage = args.map(arg => {
        if (typeof arg === 'object' && arg !== null) {
            try {
                if (arg instanceof Error) return arg.stack || arg.message;
                return JSON.stringify(arg, null, 2);
            } catch { return '[Circular Object]'; }
        }
        return String(arg);
    }).join(' ');
    io.emit('log', logMessage);
};

app.use(bodyParser.json());

// Set Webhook
const webhookPath = `/webhook/${TELEGRAM_TOKEN}`;
bot.setWebHook(`${WEBHOOK_URL}${webhookPath}`);

// Endpoint Webhook
app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Endpoint Log
app.get('/log', (req, res) => {
    res.sendFile(path.join(__dirname, 'log.html'));
});

// Socket.IO
io.on('connection', (socket) => {
    console.log('Browser terhubung untuk melihat log.');
    socket.on('disconnect', () => {
        originalLog('Browser terputus.');
    });
});


// -------------------------
// LOAD & SAVE CONFIG
// -------------------------
function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            const loadedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE));
            // Perbaikan: Pastikan mnemonics diinisialisasi sebagai array
            loadedConfig.mnemonics = loadedConfig.mnemonics || [];
            return loadedConfig;
        }
    } catch (e) {
        console.error("Gagal memuat config:", e);
    }
    // Perbaikan: Pastikan mnemonics diinisialisasi sebagai array kosong saat awal
    return { mnemonics: [], recipient: '', memo: 'Pi Transfer', adminChatId: null };
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
        piBot.updateConfig(config);
    } catch (e) {
        console.error("Error save config:", e);
    }
}

// -------------------------
// 🔒 MIDDLEWARE ANTI ORANG LAIN
// -------------------------
function onlyAdmin(msg) {

    // Berikan hak admin pada /start pertama kali
    if (!adminChatId && msg.text && msg.text.startsWith('/start')) {

        adminChatId = msg.chat.id;
        config.adminChatId = adminChatId;
        saveConfig();

        console.log("Admin Chat ID ditetapkan:", adminChatId);
        return true;
    }

    // Jika bukan admin → blokir
    if (msg.chat.id !== adminChatId) {
        bot.sendMessage(msg.chat.id,
            "❌ *Bot ini privat.*\nHanya pemilik yang dapat menggunakan bot ini.",
            { parse_mode: "Markdown" }
        );
        return false;
    }

    return true;
}


// -------------------------
// TELEGRAM NOTIFICATION QUEUE
// -------------------------
async function processNotificationQueue() {
    if (isProcessingQueue || notificationQueue.length === 0) return;
    isProcessingQueue = true;

    const { chatId, message, options } = notificationQueue.shift();

    try {
        const apiUrl =
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${chatId}` +
            `&text=${encodeURIComponent(message)}` +
            `&parse_mode=${encodeURIComponent(options.parse_mode)}` +
            `&disable_web_page_preview=${options.disable_web_page_preview}`;

        https.get(apiUrl, (res) => {
            if (res.statusCode !== 200) {
                console.error("Gagal kirim notifikasi:", res.statusCode);
            }
        }).on('error', err => console.error("Telegram API Error:", err.message));

    } catch (e) {
        console.error("Queue Error:", e.message);
    }

    isProcessingQueue = false;
    if (notificationQueue.length > 0)
        setTimeout(processNotificationQueue, TELEGRAM_DELAY_MS);
}

function sendAdminNotification(message) {
    if (!adminChatId) return;
    
    // Perbaikan: Pastikan notificationQueue adalah array sebelum push
    if (!Array.isArray(notificationQueue)) {
        console.error("notificationQueue is not an array. Re-initializing.");
        notificationQueue = []; 
    }

    const options = { parse_mode: 'Markdown', disable_web_page_preview: true };
    notificationQueue.push({ chatId: adminChatId, message, options });
    if (!isProcessingQueue) processNotificationQueue();
}

piBot.setNotifier(sendAdminNotification);


// -------------------------
// TELEGRAM COMMAND HANDLERS
// -------------------------

bot.onText(/\/start|\/help/, (msg) => {
    if (!onlyAdmin(msg)) return;

    const helpText = `
🤖 *Selamat Datang di PiSweepBot* 🤖
Bot ini bersifat PRIVAT dan hanya dapat digunakan oleh pemilik resmi.

Perintah:
- /run — Menjalankan bot
- /stop — Menghentikan bot
- /status — Cek status bot
- /log — Link log real-time

Pengaturan:
- /setrecipient <address>
- /setmemo <memo>
- /addmnemonics
- /clearmnemonics
- /saveconfig
`;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
});

bot.onText(/\/log/, (msg) => {
    if (!onlyAdmin(msg)) return;
    bot.sendMessage(msg.chat.id, `${WEBHOOK_URL}/log`);
});

bot.onText(/\/run/, (msg) => {
    if (!onlyAdmin(msg)) return;

    if (!config.recipient || config.mnemonics.length === 0)
        return bot.sendMessage(msg.chat.id, "❌ Tidak bisa start. Atur recipient & mnemonics dulu.");

    if (piBot.startBot(config))
        bot.sendMessage(msg.chat.id, "✅ Bot Running.");
    else
        bot.sendMessage(msg.chat.id, "ℹ️ Bot sudah berjalan.");
});

bot.onText(/\/stop/, (msg) => {
    if (!onlyAdmin(msg)) return;
    if (piBot.stopBot())
        bot.sendMessage(msg.chat.id, "🛑 Bot dihentikan.");
    else
        bot.sendMessage(msg.chat.id, "ℹ️ Bot sudah berhenti.");
});

bot.onText(/\/status/, (msg) => {
    if (!onlyAdmin(msg)) return;

    const status = piBot.getStatus();
    const txt = `
*Status Bot:* ${status.isRunning ? 'Online ✅' : 'Offline ⏹️'}
*Wallet berikutnya:* ${status.currentIndex + 1}
*Recipient:* \`${config.recipient || 'Belum diatur'}\`
*Memo:* \`${config.memo}\`
*Total Mnemonics:* ${config.mnemonics.length}
    `;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
});

bot.onText(/\/setrecipient (.+)/, (msg, match) => {
    if (!onlyAdmin(msg)) return;

    const r = match[1];
    const validG = r.startsWith('G') && r.length === 56;
    const validM = r.startsWith('M') && r.length === 69;

    if (!validG && !validM)
        return bot.sendMessage(msg.chat.id, "❌ Alamat tidak valid.");

    config.recipient = r;
    saveConfig();

    bot.sendMessage(msg.chat.id, `Recipient diset ke:\n\`${r}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/setmemo (.+)/, (msg, match) => {
    if (!onlyAdmin(msg)) return;

    config.memo = match[1];
    saveConfig();

    bot.sendMessage(msg.chat.id, `Memo diset ke: \`${config.memo}\``, { parse_mode: 'Markdown' });
});

bot.onText(/\/addmnemonics/, (msg) => {
    if (!onlyAdmin(msg)) return;

    userState[msg.chat.id] = 'awaiting_mnemonics';
    bot.sendMessage(msg.chat.id, "Kirim frasa mnemonic (pisahkan dengan enter).");
});

bot.onText(/\/clearmnemonics/, (msg) => {
    if (!onlyAdmin(msg)) return;

    config.mnemonics = [];
    saveConfig();
    bot.sendMessage(msg.chat.id, "🗑 Semua mnemonic dihapus.");
});

bot.onText(/\/saveconfig/, (msg) => {
    if (!onlyAdmin(msg)) return;

    if (fs.existsSync(CONFIG_FILE))
        bot.sendDocument(msg.chat.id, CONFIG_FILE);
    else
        bot.sendMessage(msg.chat.id, "❌ config.json tidak ditemukan.");
});

// Pesan biasa
bot.on('message', (msg) => {
    if (!onlyAdmin(msg)) return;

    if (msg.text && msg.text.startsWith('/')) return;

    if (userState[msg.chat.id] === 'awaiting_mnemonics') {

        const incomingList = msg.text.split('\n').map(m => m.trim()).filter(m => m.length > 0);
        
        let newCount = 0;
        let duplicateCount = 0;

        // Perbaikan Error: Pastikan config.mnemonics adalah array
        if (!Array.isArray(config.mnemonics)) {
            console.error("CRITICAL ERROR: config.mnemonics is not an array! Re-initializing.");
            config.mnemonics = [];
        }

        // Logika Anti-Duplikasi: Gunakan Set untuk lookup cepat
        const existingMnemonics = new Set(config.mnemonics);
        const uniqueNewMnemonics = [];

        for (const m of incomingList) {
            if (!existingMnemonics.has(m)) {
                uniqueNewMnemonics.push(m);
                existingMnemonics.add(m); 
                newCount++;
            } else {
                duplicateCount++;
            }
        }

        // Tambahkan mnemonic yang unik ke config dan simpan
        if (uniqueNewMnemonics.length > 0) {
            config.mnemonics.push(...uniqueNewMnemonics);
            saveConfig();
        }

        // ----------------------------------------------------
        // ✅ PERBAIKAN: Pembentukan Pesan dengan Call-to-Action
        // ----------------------------------------------------
        let resultMessage = '';

        if (newCount > 0) {
            resultMessage += `✅ Menambahkan **${newCount}** mnemonic baru.`;
        }
        
        if (duplicateCount > 0) {
            // Tambahkan newline jika pesan sudah berisi konten (newCount > 0)
            resultMessage += (resultMessage ? '\n' : '') + `⚠️ Mengabaikan **${duplicateCount}** mnemonic yang sudah ada (duplikat).`;
        }
        
        if (newCount === 0 && duplicateCount === 0) {
             resultMessage = `ℹ️ Tidak ada mnemonic valid yang terdeteksi untuk ditambahkan.`;
        }

        // Tambahkan perintah /addmnemonics hanya jika ada mnemonic baru yang berhasil ditambahkan.
        if (newCount > 0) {
            resultMessage += `\n\nUntuk menambahkan mnemonic lagi, gunakan perintah:\n/addmnemonics`;
        }
        // ----------------------------------------------------

        bot.sendMessage(msg.chat.id, resultMessage, { parse_mode: 'Markdown' });
        delete userState[msg.chat.id];
    }
});


// Jalankan server
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
    console.log(`Webhook: ${WEBHOOK_URL}${webhookPath}`);
    console.log(`Log: ${WEBHOOK_URL}/log`);
});
