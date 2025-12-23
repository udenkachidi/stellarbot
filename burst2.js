const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const StellarSdk = require('stellar-sdk');
const axios = require('axios');

// ——— CONFIG ———
const HORIZON_URL = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const SECRET_KEY = 'ADD_SKEY';
const DESTINATION = 'ADD_PKEY';

const THREADS = 4;
const MAX_ATTEMPTS = 1000;
const EARLY_MS = 1000;
const BURST_INTERVAL_MS = 30;
const MIN_CLAIMABLE_AMOUNT = 3;
const FORCE_START_IMMEDIATE = true;

// ——— Init ———
const sourceKeypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
const sourcePublicKey = sourceKeypair.publicKey();
const server = new StellarSdk.Server(HORIZON_URL);

// ——— Utils ———
function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}
function randomMemo() {
  return Math.random().toString(36).substring(2, 10);
}
function randomPublicKey() {
  return StellarSdk.Keypair.random().publicKey();
}
function parseUnlockTime(predicate) {
  if (!predicate) return null;
  if (predicate.abs_before_epoch) return parseInt(predicate.abs_before_epoch);
  if (predicate.abs_before) return Math.floor(new Date(predicate.abs_before).getTime() / 1000);
  if (predicate.not?.abs_before_epoch) return parseInt(predicate.not.abs_before_epoch);
  if (predicate.not?.abs_before) return Math.floor(new Date(predicate.not.abs_before).getTime() / 1000);
  return null;
}
function formatLocalTime(utcEpoch) {
  const utcDate = new Date(utcEpoch * 1000);
  const local = new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'full',
    timeStyle: 'medium'
  }).format(utcDate);
  return { utc: utcDate.toUTCString(), local };
}
function buildTx(account, seq, id, amount, fee, memo) {
  const feeInPi = (fee * 2) / 1e7;
  const payAmount = (amount - feeInPi).toFixed(7);

  const tempAccount = new StellarSdk.Account(account.accountId(), seq);
  const builder = new StellarSdk.TransactionBuilder(tempAccount, {
    fee: (fee * 2).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  });

  const tx = builder
    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: id }))
    .addOperation(StellarSdk.Operation.payment({
      destination: DESTINATION,
      asset: StellarSdk.Asset.native(),
      amount: payAmount,
    }))
    .addOperation(StellarSdk.Operation.payment({
      destination: randomPublicKey(),
      asset: StellarSdk.Asset.native(),
      amount: '0.000001',
    }))
    .addMemo(StellarSdk.Memo.text(memo))
    .setTimeout(10)
    .build();

  tx.sign(sourceKeypair);
  const txXDR = tx.toXDR();
  console.log(`📦 Built TX XDR length: ${txXDR.length}`);
  return txXDR;
}

// ——— Worker Logic ———
async function runWorker() {
  try {
    console.log("👋 Worker booted up");
    const server = new StellarSdk.Server(workerData.horizon);
    const txs = workerData.txs;
    console.log(`🧵 Worker started with ${txs.length} TXs`);

    for (let i = 0; i < txs.length; i++) {
      console.log(`🔁 Worker TX ${i + 1}/${txs.length}`);
      try {
        const tx = new StellarSdk.Transaction(txs[i], NETWORK_PASSPHRASE);
        const res = await server.submitTransaction(tx);
        console.log(`📤 Submitted TX ${i + 1}`);

        if (res.hash) {
          console.log(`✅ Claimed! Hash: ${res.hash}`);
          parentPort.postMessage({ success: true });
          return;
        }
      } catch (err) {
        const errData = err?.response?.data?.extras?.result_codes || {};
        const ops = errData.operations || [];
        const txCode = errData.transaction || err.message;

        if (ops.includes('op_already_claimed')) {
          console.log(`⛔ Already claimed.`);
          parentPort.postMessage({ success: false, alreadyClaimed: true });
          return;
        } else {
          console.log(`⚠️ TX ${i + 1} failed:`, ops.join(', ') || txCode);
        }
      }

      await sleep(BURST_INTERVAL_MS);
    }

    parentPort.postMessage({ success: false });
  } catch (fatal) {
    console.error(`💥 Worker crashed:`, fatal.message || fatal);
    parentPort.postMessage({ success: false, crash: true });
  }
}

// ——— Main Logic ———
async function main() {
  const url = `${HORIZON_URL}/claimable_balances?claimant=${sourcePublicKey}&asset=native&limit=50&order=asc`;
  const { data } = await axios.get(url);
  const claimables = data._embedded.records;

  const valid = claimables
    .map(c => {
      const claimant = c.claimants.find(cl => cl.destination === sourcePublicKey);
      if (!claimant) return null;
      const unlockEpoch = parseUnlockTime(claimant.predicate);
      return { id: c.id, amount: parseFloat(c.amount), unlockEpoch };
    })
    .filter(c => c && c.amount >= MIN_CLAIMABLE_AMOUNT)
    .sort((a, b) => (a.unlockEpoch ?? Infinity) - (b.unlockEpoch ?? Infinity));

  const claimable = valid[0];
  if (!claimable) return console.log('❌ No eligible claimable balance found.');

  const { utc, local } = formatLocalTime(claimable.unlockEpoch);
  console.log(`🔒 Claimable Balance ID: ${claimable.id}`);
  console.log(`💰 Amount: ${claimable.amount} Pi`);
  console.log(`⏰ Unlock Time (UTC): ${utc}`);
  console.log(`🕰️ Unlock Time (Local): ${local}`);

  const now = Date.now();
  const unlockTime = claimable.unlockEpoch * 1000;
  const waitMs = Math.max(unlockTime - EARLY_MS - now, 0);

  if (!FORCE_START_IMMEDIATE && waitMs > 0) {
    console.log(`⏳ Waiting ${Math.round(waitMs / 1000)}s until early start...`);
    await sleep(waitMs);
  } else if (FORCE_START_IMMEDIATE) {
    console.log(`🚨 FORCE_START_IMMEDIATE = true → skipping unlock wait`);
  }

  const baseFee = await server.fetchBaseFee();
  const account = await server.loadAccount(sourcePublicKey);
  const txs = [];
  let seq = BigInt(account.sequence);

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    seq += 1n;
    txs.push(buildTx(account, seq.toString(), claimable.id, claimable.amount, baseFee, randomMemo()));
  }

  // ——— Split TXs & Spawn Workers ———
  const chunkSize = Math.ceil(txs.length / THREADS);
  for (let i = 0; i < THREADS; i++) {
    const chunk = txs.slice(i * chunkSize, (i + 1) * chunkSize);
    const worker = new Worker(__filename, {
      workerData: { txs: chunk, horizon: HORIZON_URL }
    });

    worker.on('message', (msg) => {
      if (msg.success) {
        console.log(`🏁 Worker ${i + 1} claimed successfully.`);
        process.exit(0);
      }
      if (msg.alreadyClaimed) {
        console.log(`🔁 Balance already claimed. Exiting.`);
        process.exit(0);
      }
      if (msg.crash) {
        console.error(`💥 Worker ${i + 1} crashed during processing.`);
      }
    });

    worker.on('error', (err) => {
      console.error(`💥 Worker ${i + 1} thread error:`, err.message || err);
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.log(`⚠️ Worker ${i + 1} exited with code ${code}`);
      }
    });
  }
}

// ——— Entry Point ———
if (isMainThread) {
  main();
} else {
  runWorker();
}

