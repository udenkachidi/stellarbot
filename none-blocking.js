// claim-beast-resilient.js

const StellarSdk = require('stellar-sdk');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const fetch = require('node-fetch');
dayjs.extend(utc);

// ========== CONFIG ==========
const SECRET_KEY        = 'SAVE5J6XRFNIKUBP562HWNK335DTMRLOSTABZ2LMCMTQCPHOOYTMGTLL';
const DESTINATION_ADDR  = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';
const UNLOCK_TIME_LOCAL = '04:56:12'; // your local time
const LOCAL_TZ_OFFSET   = +1;
const MAX_PARALLEL_TXS  = 5;
const BASE_FEE          = '100000';
const RETRY_INTERVAL_MS = 300;
const REQUEST_TIMEOUT   = 10000; // 10s max per request
// ============================

// Custom timeout wrapper for async
async function withTimeout(promise, ms = 10000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('⏱ Timeout exceeded')), ms))
  ]);
}

(async () => {
  const keypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
  const publicKey = keypair.publicKey();

  const server = new StellarSdk.Server('https://api.mainnet.minepi.com', {
    fetch: (url, options) => fetch(url, { ...options, timeout: REQUEST_TIMEOUT })
  });

  console.log(`🔐 Wallet: ${publicKey}`);

  // Get claimable balances
  console.log('📡 Fetching claimables...');
  let claimableRecords;
  try {
    const { records } = await withTimeout(server.claimableBalances().claimant(publicKey).call(), REQUEST_TIMEOUT);
    claimableRecords = records;
  } catch (e) {
    console.error('❌ Failed to fetch claimables:', e.message);
    return;
  }

  if (!claimableRecords.length) {
    console.log('❌ No claimable balances found.');
    return;
  }

  const selected = claimableRecords[claimableRecords.length - 1];
  const claimableId = selected.id;
  const claimAmount = parseFloat(selected.amount);

  console.log(`💰 Claimable Amount: ${claimAmount} Pi`);
  console.log(`🆔 Balance ID: ${claimableId}`);

  // Compute UTC unlock time
  const today = dayjs().format('YYYY-MM-DD');
  const unlockUTC = dayjs(`${today}T${UNLOCK_TIME_LOCAL}`).subtract(LOCAL_TZ_OFFSET, 'hour').utc();
  const waitMs = unlockUTC.diff(dayjs.utc());

  if (waitMs > 0) {
    console.log(`⏳ Waiting until unlock: ${unlockUTC.toISOString()}`);
    await new Promise(r => setTimeout(r, waitMs));
  } else {
    console.log('⚠️ Unlock time passed; starting immediately.');
  }

  let baseSeq;
  try {
    const acct = await withTimeout(server.loadAccount(publicKey), REQUEST_TIMEOUT);
    baseSeq = BigInt(acct.sequenceNumber());
  } catch (e) {
    console.error('❌ Failed to load account:', e.message);
    return;
  }

  // Build TXs
  const feePi = parseInt(BASE_FEE, 10) * 2 * 0.0000001;
  const sendAmt = (claimAmount - feePi).toFixed(7);

  const txs = [];
  for (let i = 0; i < MAX_PARALLEL_TXS; i++) {
    const seq = (baseSeq + BigInt(i + 1)).toString();
    const seqAccount = new StellarSdk.Account(publicKey, seq);

    const tx = new StellarSdk.TransactionBuilder(seqAccount, {
      fee: BASE_FEE,
      networkPassphrase: 'Pi Network'
    })
      .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId }))
      .addOperation(StellarSdk.Operation.payment({
        destination: DESTINATION_ADDR,
        asset: StellarSdk.Asset.native(),
        amount: sendAmt
      }))
      .addMemo(StellarSdk.Memo.text(`claim-${Date.now().toString().slice(-5)}-${i}`))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    txs.push(tx);
  }

  console.log(`🚀 Prepared ${MAX_PARALLEL_TXS} transactions. Beginning flood...`);

  let success = false;
  let round = 0;

  while (!success) {
    round++;
    console.log(`🔁 Round ${round}: launching attempts`);

    await Promise.all(txs.map(async (tx, i) => {
      try {
        // Stagger each slightly
        await new Promise(res => setTimeout(res, i * 100 + Math.random() * 100));
        console.log(`[#${i}] ⏳ Submitting...`);
        const res = await withTimeout(server.submitTransaction(tx), REQUEST_TIMEOUT);

        if (res && res.hash && res.successful) {
          console.log(`[#${i}] ✅ SUCCESS! Hash: ${res.hash}`);
          console.log(`🔗 https://minepi.com/blockexplorer/tx/${res.hash}`);
          success = true;
        } else {
          console.log(`[#${i}] ⚠️ Submission failed (no hash).`);
        }
      } catch (err) {
        const reason = err?.response?.data?.extras?.result_codes?.operations?.join(', ') || err.message;
        console.log(`[#${i}] ❌ Error: ${reason}`);
      }
    }));

    if (!success) {
      console.log(`🔁 Retrying in ${RETRY_INTERVAL_MS}ms...\n`);
      await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }

  console.log('🎉 Done. Claim and transfer complete.');
})();
