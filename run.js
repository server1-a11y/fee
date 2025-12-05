// run.js
const { Server, Keypair, TransactionBuilder, Operation, Asset, Memo } = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
let sendNotification = () => {};
let removeMnemonicCallback = () => false;

const PI_API_SERVERS = [
    'http://222.253.79.90:31401',
];

const PI_NETWORK_PASSPHRASE = 'Pi Network';

let currentServerIndex = 0;

function getPiServer() {
    const serverUrl = PI_API_SERVERS[currentServerIndex];
    console.log(`-> Menggunakan server node: ${serverUrl}`);
    currentServerIndex = (currentServerIndex + 1) % PI_API_SERVERS.length;
    return new Server(serverUrl, { allowHttp: true });
}

let botState = { isRunning: false, timeoutId: null, currentIndex: 0 };
let currentConfig = { mnemonics: [], recipient: '', memo: 'Pi Transfer' }; 

function setNotifier(notifierFunction) {
    sendNotification = notifierFunction;
}

function setMnemonicRemover(removerFunction) {
    removeMnemonicCallback = removerFunction;
}

function updateConfig(newConfig) {
    currentConfig = { ...newConfig };
    console.log(`[Config Updated] Total mnemonics: ${currentConfig.mnemonics.length}`);
}

async function getWalletFromMnemonic(mnemonic) {
    const trimmedMnemonic = mnemonic.trim();
    const seed = await bip39.mnemonicToSeed(trimmedMnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return Keypair.fromRawEd25519Seed(key);
}

async function processWallet(mnemonic, recipientAddress, walletIndex, memoText) {
    const trimmedMnemonic = mnemonic.trim();
    
    // 1. Validasi format mnemonic
    if (!bip39.validateMnemonic(trimmedMnemonic)) {
        const truncatedMnemonic = trimmedMnemonic.substring(0, 15);
        console.log(`[Hapus] Frasa tidak valid (BIP39): ${truncatedMnemonic}...`);
        removeMnemonicCallback(trimmedMnemonic); 
        return { mnemonicRemoved: true }; 
    }

    const server = getPiServer();
    let senderKeypair;
    try {
        senderKeypair = await getWalletFromMnemonic(trimmedMnemonic);
        const senderAddress = senderKeypair.publicKey();
        console.log(`Memproses Wallet #${walletIndex + 1}/${currentConfig.mnemonics.length}: ${senderAddress}`);
        
        // Cek status akun terlebih dahulu (Akun tidak aktif - 404)
        let account;
        try {
            account = await server.loadAccount(senderAddress);
        } catch (e) {
            if (e.response && e.response.status === 404) {
                console.log(`[Hapus] ${senderAddress}: Akun belum diaktifkan (404).`);
                removeMnemonicCallback(trimmedMnemonic); 
                return { mnemonicRemoved: true };
            }
            throw e; 
        }
        
        const baseFee = await server.fetchBaseFee();
        // Cek Claimable Balances hanya untuk info/log
        const claimables = await server.claimableBalances().claimant(senderAddress).limit(200).call();
        const nativeBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';
        const currentBalance = parseFloat(nativeBalance);
        console.log(`Saldo saat ini: ${currentBalance.toFixed(7)} π. Klaim tersedia (DIABAIKAN): ${claimables.records.length}`);
        const isMuxedAddress = recipientAddress.startsWith('M');

        // Bagian 1: Claim dan Transfer - DIHAPUS/DIABAIKAN SESUAI PERMINTAAN
        // ------------------------------------------------------------------
        
        // Bagian 2: Kirim Saldo yang ada (Hanya Kirim)
        const freshAccount = await server.loadAccount(senderAddress);
        const fee = baseFee / 1e12;
        
        // Saldo yang akan dikirim = Saldo saat ini - Base Reserve (1 Pi) - Biaya Transaksi
        const amountToSendExisting = parseFloat(freshAccount.balances.find(b => b.asset_type === 'native')?.balance || '0') - 1 - fee;

        if (amountToSendExisting > 0.0000001) {
            console.log(`[Transfer] Mengirim saldo yang ada: ${amountToSendExisting.toFixed(7)} π`);
            
            // Membuat transaksi hanya dengan operasi Payment
            const txBuilder = new TransactionBuilder(freshAccount, { fee: baseFee.toString(), networkPassphrase: PI_NETWORK_PASSPHRASE });
            if (!isMuxedAddress && memoText) txBuilder.addMemo(Memo.text(memoText));
            
            txBuilder.addOperation(Operation.payment({ 
                destination: recipientAddress, 
                asset: Asset.native(), 
                amount: amountToSendExisting.toFixed(7) 
            }));

            const tx = txBuilder.setTimeout(30).build();
            tx.sign(senderKeypair);
            const res = await server.submitTransaction(tx);

            // NOTIFIKASI BERHASIL (HANYA SEND)
            const timeString = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' });
            const successMsg = 
`✅ *Transfer Coin Berhasil!*
*Jumlah*: ${amountToSendExisting.toFixed(7)} π
*Dari*: \`${senderAddress}\`
*Hash*: [Lihat Transaksi](https://blockexplorer.minepi.com/mainnet/transactions/${res.hash})`;

            console.log(successMsg.replace(/[*`[\]()]/g, ''));
            sendNotification(successMsg);
        } else {
            console.log("Tidak ada tindakan yang bisa dilakukan (saldo tidak cukup untuk transfer).");
        }

    } catch (e) {
        // HANYA LOG ERROR KE CONSOLE
        const addr = senderKeypair?.publicKey() || `Wallet #${walletIndex + 1}`;
        let errorMessage = e.message;
        
        if (e.response && e.response.data && e.response.data.detail) {
            errorMessage = e.response.data.detail;
        } else if (e.response && e.response.status === 429) {
            errorMessage = "Terkena Rate Limit dari server Pi. Siklus berlanjut.";
        } else if (e.message.includes("op_underfunded")) {
            errorMessage = "Saldo tidak mencukupi untuk biaya transaksi.";
        }

        const errorMsg = `❌ [Error] ${addr}: ${errorMessage}`;
        console.log(errorMsg.replace(/[*`]/g, ''));
    }
    return { mnemonicRemoved: false };
}

function runBotCycle() {
    if (!botState.isRunning) return;
    
    const { mnemonics, recipient, memo } = currentConfig;

    if (mnemonics.length === 0) {
        console.log("Tidak ada mnemonic untuk diproses. Bot berhenti.");
        stopBot();
        return;
    }

    if (botState.currentIndex >= mnemonics.length) {
        botState.currentIndex = 0;
    }

    const currentMnemonic = mnemonics[botState.currentIndex];
    const walletIndexToProcess = botState.currentIndex; 

    console.log(`\n---------------------`);
    console.log(`Mulai siklus untuk Wallet #${walletIndexToProcess + 1}/${mnemonics.length}`);
    console.log(`---------------------`);

    processWallet(currentMnemonic, recipient, walletIndexToProcess, memo)
        .then(result => {
            if (!botState.isRunning) return;
            
            if (!result.mnemonicRemoved) {
                botState.currentIndex = (botState.currentIndex + 1);
            }

            if (botState.currentIndex >= currentConfig.mnemonics.length) {
                if (currentConfig.mnemonics.length > 0) {
                    console.log("\nSiklus penuh selesai, mengulang dari awal...");
                    botState.currentIndex = 0; 
                } else {
                    console.log("Semua mnemonic sudah habis setelah penghapusan. Bot berhenti.");
                    stopBot();
                    return;
                }
            }
        })
        .finally(() => {
            if (!botState.isRunning) return;
            // Jeda singkat antar wallet
            botState.timeoutId = setTimeout(() => runBotCycle(), 100); 
        });
}


function startBot(config) {
    if (botState.isRunning) return false;
    console.log("Memulai bot...");
    botState.isRunning = true;
    botState.currentIndex = 0;
    updateConfig(config); 
    runBotCycle();
    return true;
}

function stopBot() {
    if (!botState.isRunning) return false;
    console.log("Menghentikan bot...");
    botState.isRunning = false;
    if (botState.timeoutId) {
        clearTimeout(botState.timeoutId);
    }
    botState.timeoutId = null;
    return true;
}

function getStatus() {
    return { 
        isRunning: botState.isRunning,
        currentIndex: botState.currentIndex
    };
}

module.exports = { startBot, stopBot, getStatus, setNotifier, setMnemonicRemover, updateConfig };
