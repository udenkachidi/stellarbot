// claim-beast-ultra.js

const StellarSdk = require('stellar-sdk');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const duration = require('dayjs/plugin/duration');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(duration);

// ========== CONFIG ==========
const SECRET_KEY = 'ADD_SKEY'; 
const DEST_ADDR  = 'ADD_PKEY';
const UNLOCK_TIME_LOCAL = '16:22:24';   // HH:mm:ss in your local time
const LOCAL_TZ_OFFSET   = +1;           // Nigeria = +1
const MAX_TXS           = 1;
const BASE_FEE          = '100000';     // 0.00001 Pi
const RETRY_INTERVAL    = 100;          // ms
// ============================

const PI_HORIZON = 'https://api.mainnet.minepi.com';
const NETWORK    = 'Pi Network';

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

(async () => {
  const keypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
  const publicKey = keypair.publicKey();
  const server = new StellarSdk.Server(PI_HORIZON);

  console.log(`🔐 Pi Wallet: ${publicKey}`);

  const balances = await server.claimableBalances().claimant(publicKey).call();
  if (!balances.records.length) {
    console.log('❌ No claimable balances found.');
    return;
  }

  const target = balances.records[balances.records.length - 1];
  const claimableId = target.id;
  const amountRaw = parseFloat(target.amount);
  console.log(`💰 Claimable: ${amountRaw} Pi`);
  console.log(`🆔 Balance ID: ${claimableId}`);

  const today = dayjs().format('YYYY-MM-DD');
  const unlockUTC = dayjs(`${today}T${UNLOCK_TIME_LOCAL}`).utcOffset(LOCAL_TZ_OFFSET * 60).utc();
  const nowUTC = dayjs.utc();

  console.log(`🕒 Now UTC:  ${nowUTC.format('YYYY-MM-DD HH:mm:ss')}`);
  console.log(`🔓 Unlock:   ${unlockUTC.format('YYYY-MM-DD HH:mm:ss')}\n`);

  const waitMs = unlockUTC.diff(nowUTC);
  if (waitMs > 0) {
    process.stdout.write(`⏳ Waiting ${(waitMs / 1000).toFixed(0)}s...`);
    await delay(waitMs);
    console.log('\n🚀 Unlock reached!');
  } else {
    console.log('⚠️ Past unlock — firing now!');
  }

  const account = await server.loadAccount(publicKey);
  const seqBase = BigInt(account.sequenceNumber());

  const txs = [];
  for (let i = 0; i < MAX_TXS; i++) {
    const microAmount = (Math.random() * 0.00001).toFixed(7);
    const finalAmount = (amountRaw - 2 * parseFloat(BASE_FEE) * 0.0000001 - parseFloat(microAmount)).toFixed(7);

    const tx = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(publicKey, (seqBase + BigInt(i + 1)).toString()), {
        fee: BASE_FEE,
        networkPassphrase: NETWORK,
      })
      .addOperation(StellarSdk.Operation.claimClaimableBalance({
        balanceId: claimableId,
      }))
      .addOperation(StellarSdk.Operation.payment({
        destination: DEST_ADDR,
        asset: StellarSdk.Asset.native(),
        amount: finalAmount,
      }))
      .addOperation(StellarSdk.Operation.payment({
        destination: DEST_ADDR,
        asset: StellarSdk.Asset.native(),
        amount: microAmount,
      }))
      .addMemo(StellarSdk.Memo.text(`cb-ultra-${Math.floor(Math.random() * 999999)}`))
      .setTimeout(30)
      .build();

    tx.sign(keypair);
    txs.push(tx);
  }

  console.log(`🚀 Firing ${MAX_TXS} ultra transactions in parallel...`);

  let success = false, round = 0;
  while (!success) {
    round++;
    console.log(`— Round ${round} —`);

    await Promise.all(txs.map(async (tx, i) => {
      try {
        await delay(i * 15); // slight stagger
        const res = await server.submitTransaction(tx);
        if (res && res.hash && res.successful) {
          console.log(`✅ [#${i}] SUCCESS! Hash: ${res.hash}`);
          console.log(`🔗 https://minepi.com/blockexplorer/tx/${res.hash}`);
          success = true;
        } else {
          console.log(`⚠️ [#${i}] No success hash returned.`);
        }
      } catch (err) {
        const msg = err?.response?.data?.extras?.result_codes?.operations?.join(', ') || err.message;
        console.log(`❌ [#${i}] failed: ${msg}`);
      }
    }));

    if (!success) {
      console.log(`⏳ Retrying in ${RETRY_INTERVAL}ms...\n`);
      await delay(RETRY_INTERVAL);
    }
  }

  console.log('🎉 Claim Beast Ultra — DONE!');
  process.exit(0);
})();

