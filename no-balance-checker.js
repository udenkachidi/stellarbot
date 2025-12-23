const StellarSdk = require('stellar-sdk');
const axios = require('axios');

// === CONFIGURATION ===
const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';

const secretKey = 'ADD_SKEY';
const destinationPublicKey = 'ADD_PKEY';

const TARGET_TIME = '02:38:11';       // HH:MM:SS in Africa/Lagos
const CUSTOM_FEE_PI = 0.03;           // 0.015 per op × 2
const SEND_ATTEMPTS = 1000;
const FLOOD_OFFSET_MS = 500;
const FLOOD_INTERVAL_MS = 12;
const BACKOFF_MS = 200;
const BATCH_SIZE = 5;                 // Number of TXs per parallel batch
// ======================

const CUSTOM_FEE_STROOPS = Math.floor(CUSTOM_FEE_PI * 10_000_000);
const sleep = ms => new Promise(res => setTimeout(res, ms));

(async () => {
  const server = new StellarSdk.Server(PI_HORIZON);
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log(`🔍 Fetching claimable balance for ${sourcePublicKey}...`);
  let claimable;
  try {
    const { data } = await axios.get(`${PI_HORIZON}/claimable_balances?claimant=${sourcePublicKey}&asset=native&limit=50`);
    const claimables = data._embedded.records;

    claimable = claimables.find(c =>
      c.claimants.some(cl => cl.destination === sourcePublicKey)
    );
  } catch (e) {
    console.error('❌ Failed to fetch claimable balances:', e.message || e);
    return;
  }

  if (!claimable) {
    console.error('❌ No native claimable balance found.');
    return;
  }

  const balanceId = claimable.id;
  const amount = parseFloat(claimable.amount);
  console.log(`🔒 Balance ID: ${balanceId}`);
  console.log(`💰 Amount: ${amount} Pi`);

  // === Calculate unlock delay ===
  const now = new Date();
  const unlock = new Date();
  const [hh, mm, ss] = TARGET_TIME.split(':').map(Number);
  unlock.setHours(hh, mm, ss, 0);
  const adjusted = new Date(unlock.getTime() - FLOOD_OFFSET_MS);
  const delay = adjusted.getTime() - now.getTime();

  if (delay > 0) {
    console.log(`⏳ Waiting ${delay}ms until presign (starts at ${adjusted.toISOString()})...`);
    await sleep(delay);
  } else {
    console.log(`🚨 Unlock time passed — presigning immediately`);
  }

  // === Pre-sign transactions ===
  let baseAccount;
  try {
    baseAccount = await server.loadAccount(sourcePublicKey);
  } catch (e) {
    console.error(`❌ Failed to load account:`, e.message || e);
    return;
  }

  let currentSeq = BigInt(baseAccount.sequence);
  const txXDRs = [];
  console.log(`🔐 Pre-signing ${SEND_ATTEMPTS} TXs...`);

  for (let i = 0; i < SEND_ATTEMPTS; i++) {
    currentSeq += 1n;
    const tempAccount = new StellarSdk.Account(sourcePublicKey, currentSeq.toString());
    const builder = new StellarSdk.TransactionBuilder(tempAccount, {
      fee: (CUSTOM_FEE_STROOPS * 2).toString(),
      networkPassphrase: PI_NETWORK,
    });

    const mainAmount = (amount - (CUSTOM_FEE_STROOPS * 2) / 1e7).toFixed(7);
    const stealthAmount = '0.000001';

    builder
      .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }))
      .addOperation(StellarSdk.Operation.payment({
        destination: destinationPublicKey,
        asset: StellarSdk.Asset.native(),
        amount: mainAmount,
      }))
      .addOperation(StellarSdk.Operation.payment({
        destination: StellarSdk.Keypair.random().publicKey(),
        asset: StellarSdk.Asset.native(),
        amount: stealthAmount,
      }))
      .addMemo(StellarSdk.Memo.text(`tx_${i}_${Math.floor(Math.random() * 1000000)}`));

    const tx = builder.setTimeout(30).build();
    tx.sign(sourceKeypair);
    txXDRs.push(tx.toXDR());
  }

  console.log(`✅ Pre-signed ${txXDRs.length} TXs — starting burst flood...`);

  const totalBatches = Math.ceil(txXDRs.length / BATCH_SIZE);

  for (let i = 0; i < totalBatches; i++) {
    const batch = txXDRs.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);

    console.log(`🚀 Sending batch ${i + 1}/${totalBatches} @ ${new Date().toISOString()}`);

    await Promise.all(batch.map(async (xdr, j) => {
      const txNum = i * BATCH_SIZE + j + 1;

      try {
        const tx = new StellarSdk.Transaction(xdr, PI_NETWORK);
        const res = await server.submitTransaction(tx);

        if (res.hash) {
          console.log(`✅ CLAIM SUCCESS (TX #${txNum})`);
          console.log(`🔗 Hash: ${res.hash}`);
          process.exit(0);
        }

      } catch (err) {
        const status = err?.response?.status;
        const ops = err?.response?.data?.extras?.result_codes?.operations || [];
        const txErr = err?.response?.data?.extras?.result_codes?.transaction || err.message;

        if (ops.includes('op_already_claimed')) {
          console.log(`⛔ Already claimed. Exiting (TX #${txNum}).`);
          process.exit(0);
        }

        if (txErr === 'tx_bad_seq') {
          console.log(`⚠️ TX #${txNum}: Bad sequence. Skipping...`);
        } else if (status === 429) {
          console.warn(`⚠️ TX #${txNum}: Rate limit. Skipping...`);
        } else {
          console.error(`❌ TX #${txNum} failed:`, ops.join(', ') || txErr);
        }
      }
    }));

    await sleep(FLOOD_INTERVAL_MS);
  }

  console.log(`❌ All ${SEND_ATTEMPTS} attempts used. Claim likely failed.`);
})();

