const StellarSdk = require('stellar-sdk');
const moment = require('moment-timezone');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');

const mnemonic = 'ADD_SKEY';
const recipientPublicKey = 'ADD_PKEY';
const localUnlockTime = '2025-05-03T21:12:31'; // GMT+1

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const networkPassphrase = 'Pi Network';

async function deriveKeyFromPhrase(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const key = edHd.derivePath("m/44'/314159'/0'", seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(key.key);
}

async function waitUntilUnlock(targetUTC) {
  process.stdout.write(`⏳ Waiting until unlock time: ${targetUTC.toISOString()} `);
  while (new Date() < targetUTC) {
    process.stdout.write('.');
    await new Promise(res => setTimeout(res, 1000));
  }
  console.log(`\n🚀 Unlock time reached: ${new Date().toISOString()}`);
}

function generateRandomMemo() {
  return Math.random().toString(36).substring(2, 10);
}

async function buildSignedTransaction(keypair, publicKey, recipientPublicKey, claimBalance) {
  const balanceId = claimBalance.id;
  const claimAmount = parseFloat(claimBalance.amount);
  const account = await server.loadAccount(publicKey);
  const baseFee = await server.fetchBaseFee();
  const extraFee = baseFee + 100;

  // Estimate fee for 5 ops: claim, micro1, main, micro2, micro3
  const totalOps = 5;
  const totalFee = extraFee * totalOps;
  const feeInPi = totalFee / 10000000;
  const sendAmount = (claimAmount - feeInPi - 0.00003).toFixed(7);

  const txBuilder = new StellarSdk.TransactionBuilder(account, {
    fee: totalFee.toString(),
    networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + 120,
    }
  });

  // 1. Claim
  txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }));

  // 2. Micro-transaction before main payment
  txBuilder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: '0.00001'
  }));

  // 3. Main payment
  txBuilder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: sendAmount
  }));

  // 4. Micro-transaction after main
  txBuilder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: '0.00001'
  }));

  // 5. One more micro-transaction
  txBuilder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: '0.00001'
  }));

  // Memo to diversify transactions
  txBuilder.addMemo(StellarSdk.Memo.text(generateRandomMemo()));

  const transaction = txBuilder.build();
  transaction.sign(keypair);
  return transaction.toXDR();
}

async function submitFloodLoop(signedXDR) {
  console.log("🚨 Starting transaction flood loop...");
  let submitted = false;
  const concurrency = 5;

  while (!submitted) {
    const attempts = Array.from({ length: concurrency }, async (_, i) => {
      await new Promise(r => setTimeout(r, Math.random() * 1000)); // Stagger
      try {
        const tx = StellarSdk.TransactionBuilder.fromXDR(signedXDR, networkPassphrase);
        const result = await server.submitTransaction(tx);
        if (result.hash) {
          console.log(`✅ SUCCESS! Tx Hash: ${result.hash}`);
          console.log(`🔍 View: https://minepi.com/blockexplorer/tx/${result.hash}`);
          submitted = true;
        }
      } catch (err) {
        // Minimal output to avoid spam
      }
    });

    await Promise.all(attempts);
  }
}

(async () => {
  const keypair = await deriveKeyFromPhrase(mnemonic);
  const publicKey = keypair.publicKey();
  console.log(`🔐 Public Key: ${publicKey}`);

  const unlockUTC = moment.tz(localUnlockTime, 'Africa/Lagos').utc().toDate();
  console.log(`🎯 Unlock Time (UTC): ${unlockUTC.toISOString()}`);
  await waitUntilUnlock(unlockUTC);

  const balances = await server.claimableBalances().claimant(publicKey).limit(1).order('desc').call();
  if (balances.records.length === 0) {
    console.log("❌ No claimable balances found.");
    return;
  }

  const txXDR = await buildSignedTransaction(keypair, publicKey, recipientPublicKey, balances.records[0]);
  await submitFloodLoop(txXDR);
})();

