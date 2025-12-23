const StellarSdk = require('stellar-sdk');
const moment = require('moment-timezone');

const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';
const CUSTOM_FEE = '10000'; // in stroops (0.001 Pi)
const PARALLEL_ATTEMPTS = 3;
const MAX_TOTAL_ATTEMPTS = 100;
const RETRY_DELAY_MS = 150;

const secretKey = 'SDVYA7TMCLHUCD6BDPMS3EDCZRE2QSWO6LJJRBTCQNBKNWJ4QIX54KA2';
const destination = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';

// 🕰️ Optional: Unlock time (local time, e.g. '2025-05-26 10:38:48')
const LOCAL_UNLOCK_TIME = '2025-05-29 18:10:28';
const LOCAL_TIMEZONE = 'Africa/Lagos';

(async () => {
  const unlockUTC = moment.tz(LOCAL_UNLOCK_TIME, LOCAL_TIMEZONE).utc();
  const unlockTimestamp = unlockUTC.valueOf();
  const now = Date.now();

  console.log(`⏳ Waiting until unlock time: ${unlockUTC.format()} UTC`);
  if (now < unlockTimestamp - 200) {
    const wait = () => new Promise(res => setTimeout(res, 100));
    while (Date.now() < unlockTimestamp - 200) {
      process.stdout.write(`⏳ ${((unlockTimestamp - Date.now()) / 1000).toFixed(1)}s remaining\r`);
      await wait();
    }
  } else {
    console.log(`⚠️ Unlock time has already passed. Firing immediately.`);
  }

  const server = new StellarSdk.Server(PI_HORIZON);
  const keypair = StellarSdk.Keypair.fromSecret(secretKey);
  const publicKey = keypair.publicKey();

  // 🔍 Get claimable balance
  let balanceId, claimAmount;
  try {
    const result = await server.claimableBalances().claimant(publicKey).limit(1).call();
    if (!result.records.length) throw new Error("No claimable balances found.");
    const cb = result.records[0];
    balanceId = cb.id;
    claimAmount = parseFloat(cb.amount);
    console.log(`🎯 Claimable Balance ID: ${balanceId}`);
    console.log(`💰 Lockup Amount: ${claimAmount} Pi`);
  } catch (err) {
    console.error("❌ Failed to fetch claimable balance:", err.message || err);
    return;
  }

  // 🔢 Load account & base sequence
  let account;
  try {
    account = await server.loadAccount(publicKey);
  } catch (err) {
    console.error("❌ Failed to load account:", err.message || err);
    return;
  }

  let attempts = 0;
  let claimed = false;
  let baseSeq = BigInt(account.sequence);

  const claimAndPay = async (threadId) => {
    while (!claimed && attempts < MAX_TOTAL_ATTEMPTS) {
      const i = attempts++;
      const seq = baseSeq + 1n + BigInt(i);
      const txAccount = new StellarSdk.Account(publicKey, seq.toString());

      try {
        const builder = new StellarSdk.TransactionBuilder(txAccount, {
          fee: CUSTOM_FEE,
          networkPassphrase: PI_NETWORK
        });

        builder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }));

        const feePi = parseFloat(CUSTOM_FEE) / 10000000; // Convert stroops to Pi
        const sendAmount = (claimAmount - feePi).toFixed(7);

        builder.addOperation(StellarSdk.Operation.payment({
          destination,
          asset: StellarSdk.Asset.native(),
          amount: sendAmount
        }));

        builder.addMemo(StellarSdk.Memo.text(`c${Date.now() % 100000}`));
        const tx = builder.setTimeout(30).build();
        tx.sign(keypair);

        const result = await server.submitTransaction(tx);
        if (result?.successful && result.hash?.length === 64) {
          console.log(`\n✅ SUCCESS! Claimed and paid at attempt #${i + 1} via Thread-${threadId}`);
          console.log(`🔗 Tx Hash: ${result.hash}`);
          console.log(`🔍 https://minepi.com/blockexplorer/tx/${result.hash}`);
          claimed = true;
          return;
        } else {
          console.warn(`⚠️ Thread-${threadId} Unexpected response:`, result);
        }

      } catch (err) {
        const error = err.response?.data || err.message || err;
        console.warn(`⚠️ Thread-${threadId} Attempt #${i + 1} failed:`, error);
      }

      await new Promise(r => setTimeout(r, RETRY_DELAY_MS + Math.random() * 100));
    }
  };

  console.log(`🚀 Launching up to ${MAX_TOTAL_ATTEMPTS} attempts with ${PARALLEL_ATTEMPTS} threads...`);
  await Promise.all(Array.from({ length: PARALLEL_ATTEMPTS }, (_, i) => claimAndPay(i + 1)));

  if (!claimed) {
    console.log(`❌ All ${MAX_TOTAL_ATTEMPTS} attempts exhausted. Claim failed.`);
  }
})();
