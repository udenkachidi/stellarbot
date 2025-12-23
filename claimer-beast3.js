const StellarSdk = require('stellar-sdk');
const moment = require('moment-timezone');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');

const mnemonic = 'machine this feed border spray keep term pumpkin range source lava sudden route nurse category analyst chair elephant process receive walk green mystery also';
const recipientPublicKey = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';
const localUnlockTime = '2025-05-07T11:03:35';

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const networkPassphrase = 'Pi Network';

async function deriveKeyFromPhrase(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const key = edHd.derivePath("m/44'/314159'/0'", seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(key.key);
}

async function getClaimableBalance(publicKey) {
  const res = await server.claimableBalances().claimant(publicKey).limit(1).order('desc').call();
  return res.records.length > 0 ? res.records[0] : null;
}

async function waitUntil(timeUTC) {
  process.stdout.write(`⏳ Waiting for unlock time: ${timeUTC.toISOString()} `);
  while (new Date() < timeUTC) {
    process.stdout.write('.');
    await new Promise(res => setTimeout(res, 300));
  }
  console.log(`\n🚀 Unlock time reached: ${new Date().toISOString()}`);
}

function buildTransaction(account, balanceId, sendAmount, keypair, memoText) {
  const baseFee = 100;
  const totalFee = baseFee * 4;

  const builder = new StellarSdk.TransactionBuilder(account, {
    fee: totalFee.toString(),
    networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + 90,
    },
  });

  builder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }));
  builder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: '0.00001',
  }));
  builder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: sendAmount,
  }));
  builder.addOperation(StellarSdk.Operation.payment({
    destination: recipientPublicKey,
    asset: StellarSdk.Asset.native(),
    amount: '0.00001',
  }));

  builder.addMemo(StellarSdk.Memo.text(memoText));
  const tx = builder.build();
  tx.sign(keypair);
  return tx.toXDR();
}

async function floodSubmitMultiple(xdrArray, unlockUTC) {
  console.log("🚨 Starting parallel transaction flood...");
  let success = false;

  await Promise.all(xdrArray.map((xdr, index) =>
    (async () => {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
      let attempt = 0;

      while (!success) {
        try {
          if (new Date() < unlockUTC) {
            await new Promise(res => setTimeout(res, 50));
            continue;
          }

          const result = await server.submitTransaction(tx);
          if (result.hash) {
            success = true;
            console.log(`✅ SUCCESS! Transaction #${index + 1} sent.`);
            console.log(`🔗 https://minepi.com/blockexplorer/tx/${result.hash}`);
            process.exit(0); // Exit after first valid success
          }
        } catch (err) {
          attempt++;
          const delay = 100 + Math.random() * 150;
          process.stdout.write(`🔁 T${index + 1} retry ${attempt}... `);
          await new Promise(res => setTimeout(res, delay));
        }
      }
    })()
  ));
}

(async () => {
  const keypair = await deriveKeyFromPhrase(mnemonic);
  const publicKey = keypair.publicKey();
  console.log(`🔐 Public Key: ${publicKey}`);

  const unlockUTC = moment.tz(localUnlockTime, 'Africa/Lagos').utc().toDate();
  console.log(`🕒 Unlock (UTC): ${unlockUTC.toISOString()}`);

  const balance = await getClaimableBalance(publicKey);
  if (!balance) {
    console.log("❌ No claimable balance found.");
    return;
  }

  const claimAmount = parseFloat(balance.amount);
  console.log(`💰 Claimable: ${claimAmount} Pi`);

  const feeInPi = (100 * 4) / 10000000;
  const sendAmount = (claimAmount - feeInPi - 0.00002).toFixed(7);

  const account = await server.loadAccount(publicKey);

  const transactionVariants = [];
  const variantCount = 3 + Math.floor(Math.random() * 3); // 3 to 5 variants

  for (let i = 0; i < variantCount; i++) {
    const memo = Math.random().toString(36).substring(2, 10);
    const txXDR = buildTransaction(account, balance.id, sendAmount, keypair, memo);
    transactionVariants.push(txXDR);
  }

  await waitUntil(unlockUTC);
  await floodSubmitMultiple(transactionVariants, unlockUTC);
})();
