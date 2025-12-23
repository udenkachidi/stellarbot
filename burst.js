


const StellarSdk = require('stellar-sdk');
const axios = require('axios');

const HORIZON_URL = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';

const SECRET_KEY = 'ADD_SKEY';
const DESTINATION = 'ADD_PKEY';
const MIN_CLAIMABLE_AMOUNT = 3;
const MAX_ATTEMPTS = 1000;
const BURST_INTERVAL_MS = 100;
const FORCE_START_IMMEDIATE = false;

const server = new StellarSdk.Server(HORIZON_URL);
const sourceKeypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
const sourcePublicKey = sourceKeypair.publicKey();

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function randomMemo() {
  return Math.random().toString(36).substring(2, 10);
}
function parseUnlockTime(predicate) {
  if (!predicate) return null;
  if (predicate.abs_before_epoch) return parseInt(predicate.abs_before_epoch);
  if (predicate.abs_before) return Math.floor(new Date(predicate.abs_before).getTime() / 1000);
  if (predicate.not?.abs_before_epoch) return parseInt(predicate.not.abs_before_epoch);
  if (predicate.not?.abs_before) return Math.floor(new Date(predicate.not.abs_before).getTime() / 1000);
  return null;
}

async function findClaimableBalance() {
  const url = `${HORIZON_URL}/claimable_balances?claimant=${sourcePublicKey}&asset=native&limit=50&order=asc`;
  const { data } = await axios.get(url);
  const claimables = data._embedded.records;

  const valid = claimables
    .filter(c => parseFloat(c.amount) >= MIN_CLAIMABLE_AMOUNT)
    .map(c => {
      const ourClaimant = c.claimants.find(cl => cl.destination === sourcePublicKey);
      if (!ourClaimant) return null;
      const unlockEpoch = parseUnlockTime(ourClaimant.predicate);
      return { id: c.id, amount: parseFloat(c.amount), unlockEpoch };
    })
    .filter(Boolean)
    .sort((a, b) => (a.unlockEpoch ?? Infinity) - (b.unlockEpoch ?? Infinity));

  return valid[0] || null;
}

function buildTx(account, seq, id, amount, fee, memo) {
  const payAmount = (amount - 0.00001).toFixed(7);
  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: (fee * 2).toString(),
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  account.incrementSequenceNumber();
  builder.tx.sequence = seq;

  const tx = builder
    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: id }))
    .addOperation(StellarSdk.Operation.payment({
      destination: DESTINATION,
      asset: StellarSdk.Asset.native(),
      amount: payAmount,
    }))
    .addMemo(StellarSdk.Memo.text(memo))
    .setTimeout(10)
    .build();

  tx.sign(sourceKeypair);
  return tx;
}

async function flood(claimable) {
  const baseFee = await server.fetchBaseFee();
  const account = await server.loadAccount(sourcePublicKey);
  let seq = BigInt(account.sequence);

  console.log(`🚀 Starting claim flood (max ${MAX_ATTEMPTS} attempts)`);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      seq += 1n;
      const tx = buildTx(account, seq.toString(), claimable.id, claimable.amount, baseFee, randomMemo());
      const res = await server.submitTransaction(tx);

      if (res.hash) {
        console.log(`✅ Claimed! Hash: ${res.hash}`);
        break;
      }
    } catch (err) {
      const msg = err.response?.data?.extras?.result_codes?.operations || [];
      if (msg.includes('op_already_claimed')) {
        console.log(`⛔ Already claimed.`);
        break;
      }
    }
    await sleep(BURST_INTERVAL_MS);
  }
  console.log(`🏁 Done.`);
}

(async () => {
  const claimable = await findClaimableBalance();
  if (!claimable) return console.log(`❌ No eligible claimable found.`);

  const now = Math.floor(Date.now() / 1000);
  if (!FORCE_START_IMMEDIATE && claimable.unlockEpoch && claimable.unlockEpoch > now) {
    const wait = (claimable.unlockEpoch - now) * 1000;
    console.log(`⏳ Waiting ${wait / 1000}s for unlock...`);
    await sleep(wait);
  }

  await flood(claimable);
})();

