


const StellarSdk = require('stellar-sdk');

// === CONFIGURABLE PARAMETERS ===
const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';

const secretKey = 'SBOGWM7YH5I3AQYDVKQDHXBAPMSJWDI73VHFUSLUSUEOEN2VX2XJ6CZ5';
const destinationPublicKey = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';

const INTERVAL_MS = 370;          // Check balance every 300ms
const MINIMUM_PI = 3;             // Minimum Pi balance to trigger send
const TARGET_TIME = '11:44:13';   // Specific time to send (HH:MM:SS)
const AMOUNT_TO_SEND = '153.10';  // Main amount to send
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

      process.stdout.write(`\r💰 Current Balance: ${nativeBalance} Pi`);
      console.log(`\r💰 Current Balance: ${nativeBalance} Pi`);
      
      if (nativeBalance > MINIMUM_PI) {
        console.log(`\n🚀 Balance exceeds ${MINIMUM_PI} Pi. Preparing to send...`);
        clearInterval(poll); // Stop polling once ready

        await sendAtSpecificTime(server, sourceKeypair);
      }
    } catch (err) {
      console.error('\n❌ Error while checking/sending:', err.response?.data || err.message || err);
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
    let baseAccount = await server.loadAccount(sourceKeypair.publicKey());
    let currentSeq = BigInt(baseAccount.sequence);
    let attemptCount = 0;

    while (attemptCount < SEND_ATTEMPTS) {
      attemptCount++;
      console.log(`🚀 Attempt #${attemptCount} (Seq: ${currentSeq + 1n})`);

      try {
        const txBuilder = new StellarSdk.TransactionBuilder(baseAccount, {
          fee: CUSTOM_FEE_STROOPS.toString(),
          networkPassphrase: PI_NETWORK,
        });

        // 1. Pre-decoy mini-transaction
        txBuilder.addOperation(StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: '0.00001',
        }));

        // 2. Main transaction
        txBuilder.addOperation(StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: AMOUNT_TO_SEND,
        }));

        // 3. Post-decoy mini-transaction
        txBuilder.addOperation(StellarSdk.Operation.payment({
          destination: destinationPublicKey,
          asset: StellarSdk.Asset.native(),
          amount: '0.00001',
        }));

        // Unique memo to help distinguish in ledger
        txBuilder.addMemo(StellarSdk.Memo.text(`tx_${Date.now()}_${Math.floor(Math.random() * 1000000)}`));

        const tx = txBuilder.setTimeout(30).build();
        tx.sign(sourceKeypair);

        const result = await server.submitTransaction(tx);

        if (result.hash) {
          console.log(`✅ SUCCESS! Tx Hash: ${result.hash}`);
          console.log(`🔗 View: https://minepi.com/blockexplorer/tx/${result.hash}`);
          break; // Stop if successful
        }

      } catch (err) {
        const errMsg = err.response?.data || err.message || err;
        console.error(`❌ Attempt #${attemptCount} Failed:`, errMsg);

        // Reload account to get latest sequence
        try {
          baseAccount = await server.loadAccount(sourceKeypair.publicKey());
          currentSeq = BigInt(baseAccount.sequence);
        } catch (refreshErr) {
          console.error("⚠️ Failed to refresh account state:", refreshErr.message || refreshErr);
        }
      }
    }
  }
})();
