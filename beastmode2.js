const StellarSdk = require('stellar-sdk');

// === CONFIGURABLE PARAMETERS ===
const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';

const secretKey = 'SDYSGCJHZBVOR5SQTPILBQ55YQVTU5TBMJEZQ3BCDLKAWXTBO2AVK23S';
const destinationPublicKey = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';

const INTERVAL_MS = 300;          // Check balance every 250ms
const MINIMUM_PI = 3;             // Minimum Pi balance to trigger send
const TARGET_TIME = '19:51:34';   // Specific time to send (HH:MM:SS)
const AMOUNT_TO_SEND = '1040.1';     // Amount of Pi to send
const CUSTOM_FEE_PI = 0.03;       // Custom fee in Pi
const SEND_ATTEMPTS = 1000;       // How many attempts to flood
// ===============================

const CUSTOM_FEE_STROOPS = Math.floor(CUSTOM_FEE_PI * 10_000_000); // Convert Pi to stroops

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
        clearInterval(poll); // Stop polling once ready

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

    if (now >= targetTime) {
      console.log(`⏰ Target time ${TARGET_TIME} reached. Initiating send requests...`);
      await performSends(server, sourceKeypair);
    } else {
      const delay = targetTime.getTime() - now.getTime();
      console.log(`⏳ Waiting ${delay}ms until ${TARGET_TIME}...`);
      setTimeout(() => {
        performSends(server, sourceKeypair);
      }, delay);
    }
  }

  async function performSends(server, sourceKeypair) {
    let lastTxHash = null; // Track the last transaction hash for chaining

    for (let i = 0; i < SEND_ATTEMPTS; i++) {
      console.log(`🚀 Attempt #${i + 1}...`);
      try {
        const account = await server.loadAccount(sourceKeypair.publicKey());

        // Generate unique memo for each transaction
        const uniqueMemo = `tx_${Date.now()}_${Math.floor(Math.random() * 1000000)}`;

        const tx = new StellarSdk.TransactionBuilder(account, {
          fee: CUSTOM_FEE_STROOPS.toString(),
          networkPassphrase: PI_NETWORK,
        })
          .addOperation(StellarSdk.Operation.payment({
            destination: destinationPublicKey,
            asset: StellarSdk.Asset.native(),
            amount: AMOUNT_TO_SEND,
          }))
          .addMemo(StellarSdk.Memo.text(uniqueMemo)) // Unique memo to differentiate
          .setTimeout(30)
          .build();

        tx.sign(sourceKeypair);

        const result = await server.submitTransaction(tx);

        if (result && result.hash) {
          console.log(`✅ Real Success! Tx Hash: ${result.hash}`);
          console.log(`🔗 View: https://minepi.com/blockexplorer/tx/${result.hash}`);

          lastTxHash = result.hash; // Save the hash of the successful transaction
          break; // Stop if a real hash exists
        } else {
          console.error(`⚠️ Warning: Received success response but no valid hash. Continuing...`);
        }

      } catch (err) {
        console.error(`❌ Failed attempt #${i + 1}:`, err.response?.data || err.message || err);
      }

      // Chain the transaction with a delay or unique modification
      if (lastTxHash) {
        console.log(`🔗 Chaining to last transaction: ${lastTxHash}`);
        // Optionally, create a new transaction that references the previous one (or add variation)
      }
    }
  }
})();
