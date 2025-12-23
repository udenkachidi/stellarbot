const StellarSdk = require('stellar-sdk');

// === CONFIGURABLE PARAMETERS ===
const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';

const secretKey = 'ADD_SKEY';
const destinationPublicKey = 'ADD_PKEY';

const INTERVAL_MS = 250;
const MINIMUM_PI = 3;
const TARGET_TIME = '21:14:00';
const AMOUNT_TO_SEND = '639.10';
const CUSTOM_FEE_PI = 0.01;
const SEND_ATTEMPTS = 1000;
// ===============================

const CUSTOM_FEE_STROOPS = Math.floor(CUSTOM_FEE_PI * 10_000_000);

(async () => {
  const server = new StellarSdk.Server(PI_HORIZON);
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log(`🔍 Monitoring balance for: ${sourcePublicKey}`);
  console.log(`⏱️ Started at: ${new Date().toLocaleTimeString()}`);
  console.log(`📡 Checking every ${INTERVAL_MS}ms...`);

  const poll = setInterval(async () => {
    try {
      const account = await server.loadAccount(sourcePublicKey);
      const nativeBalance = parseFloat(
        account.balances.find(b => b.asset_type === 'native')?.balance || '0'
      );

      console.log(`💰 Current Balance: ${nativeBalance} Pi`);

      if (nativeBalance > MINIMUM_PI) {
        console.log(`🚀 Balance exceeds ${MINIMUM_PI} Pi. Preparing to send...`);
        clearInterval(poll);
        await sendAtSpecificTime(server, sourceKeypair);
      }
    } catch (err) {
      console.error('❌ Error while checking/sending:', err.response?.data || err.message || err);
    }
  }, INTERVAL_MS);

  async function sendAtSpecificTime(server, sourceKeypair) {
    const now = new Date();
    const targetTime = new Date();
    const [hours, minutes, seconds] = TARGET_TIME.split(':').map(Number);
    targetTime.setHours(hours, minutes, seconds, 0);

    const delay = targetTime.getTime() - now.getTime();

    if (delay <= 0) {
      console.log(`⏰ Target time ${TARGET_TIME} already reached. Sending now...`);
      await performSends(server, sourceKeypair);
    } else {
      console.log(`⏳ Waiting ${delay}ms until ${TARGET_TIME}...`);
      setTimeout(() => performSends(server, sourceKeypair), delay);
    }
  }

  async function performSends(server, sourceKeypair) {
    const variants = [];

    const baseAccount = await server.loadAccount(sourceKeypair.publicKey());

    // Generate multiple unique XDRs
    for (let i = 0; i < 20; i++) {
      const randomMemo = Math.random().toString(36).substring(2, 10);

      const txBuilder = new StellarSdk.TransactionBuilder(baseAccount, {
        fee: CUSTOM_FEE_STROOPS.toString(),
        networkPassphrase: PI_NETWORK,
      })
        .addOperation(StellarSdk.Operation.payment({
          destination: sourcePublicKey,
          asset: StellarSdk.Asset.native(),
          amount: '0.000001',
        }))
        .addOperation(StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: AMOUNT_TO_SEND,
        }))
        .addOperation(StellarSdk.Operation.payment({
          destination: sourcePublicKey,
          asset: StellarSdk.Asset.native(),
          amount: '0.000001',
        }))
        .addMemo(StellarSdk.Memo.text(randomMemo))
        .setTimeout(30)
        .build();

      txBuilder.sign(sourceKeypair);
      variants.push(txBuilder.toXDR());
    }

    // Begin flooding attempts
    for (let i = 0; i < SEND_ATTEMPTS; i++) {
      const xdr = variants[i % variants.length];
      const tx = new StellarSdk.Transaction(xdr, PI_NETWORK);

      try {
        const result = await server.submitTransaction(tx);
        if (result && result.hash) {
          console.log(`✅ SUCCESSFUL TRANSACTION`);
          console.log(`🔗 HASH: ${result.hash}`);
          console.log(`🔗 View: https://minepi.com/blockexplorer/tx/${result.hash}`);
          break;
        }
      } catch (err) {
        const msg = err.response?.data?.extras?.result_codes?.transaction || err.message;
        console.error(`❌ Attempt ${i + 1} failed: ${msg}`);
      }
    }
  }
})();

