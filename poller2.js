// poller2.js (micro-batch version)

const StellarSdk = require('stellar-sdk');

const SECRET_KEY       = 'SCKNRJHQZXF3234RXX56I4DR4JZLX7DDWVOYCURCK45YUGLQ337TUQDM';
const DEST_PUBLIC_KEY  = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';
const LOCAL_UNLOCK     = '2025-05-31 01:19:12';
const HORIZON_URL      = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPH   = 'Pi Network';
const NUM_TX           = 20;
const BATCH_SIZE       = 5;     // TXs per batch
const BATCH_DELAY_MS   = 500;   // Delay between batches
const STEALTH_ENABLED  = false;
const STEALTH_AMOUNT   = '0.000001';

(async () => {
  try {
    const localDate = new Date(LOCAL_UNLOCK.replace(' ', 'T'));
    if (isNaN(localDate)) throw new Error('Invalid LOCAL_UNLOCK format');
    const unlockEpochUTC = Math.floor(localDate.getTime() / 1000);
    console.log(`⏰ Scheduled local ${localDate.toString()} → UTC ${new Date(unlockEpochUTC * 1000).toUTCString()}`);

    const server = new StellarSdk.Server(HORIZON_URL);
    const keypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
    const pubkey = keypair.publicKey();

    let page = await server.claimableBalances().claimant(pubkey).limit(200).call();
    let claimables = page.records;
    if (!claimables.length) {
      console.error('❌ No claimable balances found.');
      process.exit(1);
    }

    const cb = claimables[0];
    const amountLocked = parseFloat(cb.amount);
    console.log(`🔒 Claimable Balance ID: ${cb.id}`);
    console.log(`💰 Amount Locked: ${amountLocked} Pi`);

    const STROOPS_PER_OP = 100_000;
    const opsCount = 2 + (STEALTH_ENABLED ? 1 : 0);
    const totalFeeSt = STROOPS_PER_OP * opsCount;
    const feePi = totalFeeSt / 1e7;
    const sendPi = (amountLocked - feePi).toFixed(7);
    if (sendPi <= 0) {
      console.error('❌ Not enough balance to cover fees.');
      process.exit(1);
    }

    console.log(`🔧 Fee: ${feePi.toFixed(7)} Pi for ${opsCount} ops`);
    console.log(`📤 Will send: ${sendPi} Pi to ${DEST_PUBLIC_KEY}`);

    const sourceAccount = await server.loadAccount(pubkey);
    const xdrs = [];

    for (let i = 0; i < NUM_TX; i++) {
      const builder = new StellarSdk.TransactionBuilder(sourceAccount, {
        fee: totalFeeSt.toString(),
        networkPassphrase: NETWORK_PASSPH,
        timebounds: {
          minTime: unlockEpochUTC - 2,
          maxTime: unlockEpochUTC + 2
        }
      })
        .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: cb.id }))
        .addOperation(StellarSdk.Operation.payment({
          destination: DEST_PUBLIC_KEY,
          asset: StellarSdk.Asset.native(),
          amount: sendPi
        }));

      if (STEALTH_ENABLED) {
        builder.addOperation(StellarSdk.Operation.payment({
          destination: pubkey,
          asset: StellarSdk.Asset.native(),
          amount: STEALTH_AMOUNT
        }));
      }

      builder.addMemo(StellarSdk.Memo.text(`run${i}`));
      const tx = builder.build();
      tx.sign(keypair);
      xdrs.push(tx.toXDR());
    }

    console.log(`✅ Prebuilt ${NUM_TX} TXs. Waiting for unlock...`);

    const waitMs = unlockEpochUTC * 1000 - Date.now() - 200;
    if (waitMs > 0) {
      console.log(`⏳ Waiting ${(waitMs / 1000).toFixed(2)}s until unlock...`);
      await new Promise(r => setTimeout(r, waitMs));
    } else {
      console.log('⚠️ Unlock time already passed — flooding now!');
    }

    console.log('🚀 Flooding TXs in micro-batches...');

    for (let i = 0; i < xdrs.length; i += BATCH_SIZE) {
      const batch = xdrs.slice(i, i + BATCH_SIZE);
      const promises = batch.map(async (xdr, j) => {
        try {
          const tx = new StellarSdk.Transaction(xdr, NETWORK_PASSPH);
          const res = await server.submitTransaction(tx);
          const txHash = res.hash || res.transactionHash;
          if (typeof txHash === 'string') {
            console.log(`🎉 TX run${i + j} SUCCESS: ${txHash}`);
            process.exit(0);
          } else {
            console.warn(`⚠️ TX run${i + j} responded without hash.`);
          }
        } catch (err) {
          const code = err.response?.data?.extras?.result_codes?.transaction || err.message || 'Unknown';
          console.error(`❌ TX run${i + j} failed: ${code}`);
        }
      });
      await Promise.all(promises);
      if (i + BATCH_SIZE < xdrs.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    console.error('❌ All TXs failed.');
    process.exit(1);

  } catch (e) {
    console.error('❌ Fatal error:', e.message || e);
    process.exit(1);
  }
})();
