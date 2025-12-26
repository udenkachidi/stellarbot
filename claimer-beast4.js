


const StellarSdk = require('stellar-sdk');
const moment = require('moment-timezone');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');

const mnemonic = '24 Word Mneumonic';
const recipient = 'ADD_PKEY';
const localUnlock = '2025-05-08T23:10:41'; // Local unlock time
const TIMEZONE = 'Africa/Lagos';

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const networkPassphrase = 'Pi Network';

async function deriveKey(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derived = edHd.derivePath("m/44'/314159'/0'", seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(derived.key);
}

async function findClaimable(publicKey) {
  const res = await server.claimableBalances().claimant(publicKey).limit(5).order('desc').call();
  return res.records.find(r => parseFloat(r.amount) > 0);
}

function buildTransaction(account, balanceId, amount, keypair, memo) {
  const baseFee = 100;
  const fee = (baseFee * 4).toString();

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase,
    timebounds: {
      minTime: 0,
      maxTime: Math.floor(Date.now() / 1000) + 60,
    },
  })
    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }))
    .addOperation(StellarSdk.Operation.payment({
      destination: recipient,
      asset: StellarSdk.Asset.native(),
      amount: '0.00001',
    }))
    .addOperation(StellarSdk.Operation.payment({
      destination: recipient,
      asset: StellarSdk.Asset.native(),
      amount: amount,
    }))
    .addOperation(StellarSdk.Operation.payment({
      destination: recipient,
      asset: StellarSdk.Asset.native(),
      amount: '0.00001',
    }))
    .addMemo(StellarSdk.Memo.text(memo))
    .build();

  tx.sign(keypair);
  return tx.toXDR();
}

async function floodTransactions(xdrList) {
  let success = false;

  await Promise.all(xdrList.map((xdr, idx) => (
    (async () => {
      const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, networkPassphrase);
      let attempt = 0;

      while (!success) {
        try {
          const result = await server.submitTransaction(tx);
          if (result.hash) {
            success = true;
            console.log(`✅ Transaction #${idx + 1} SUCCESS`);
            console.log(`🔗 Explorer: https://minepi.com/blockexplorer/tx/${result.hash}`);
            process.exit(0);
          }
        } catch (e) {
          attempt++;
          const delay = 100 + Math.random() * 200;
          console.log(`🔁 T${idx + 1} attempt ${attempt} failed, retrying in ${Math.floor(delay)}ms...`);
          await new Promise(res => setTimeout(res, delay));
        }
      }
    })()
  )));
}

async function main() {
  const unlockUTC = moment.tz(localUnlock, TIMEZONE).utc().toDate();
  console.log(`🕒 Unlock Time (UTC): ${unlockUTC.toISOString()}`);

  const keypair = await deriveKey(mnemonic);
  const publicKey = keypair.publicKey();
  const account = await server.loadAccount(publicKey);

  console.log(`🔐 Public Key: ${publicKey}`);
  console.log(`⏳ Watching for claimable balance...`);

  let balance = null;
  let retries = 0;

  while (!balance) {
    balance = await findClaimable(publicKey);
    if (balance) break;

    retries++;
    if (new Date() > unlockUTC && retries > 10) {
      console.log(`❌ Claimable balance not found after unlock. Exiting.`);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, 800));
  }

  const amount = (parseFloat(balance.amount) - 0.00002 - (100 * 4 / 1e7)).toFixed(7);
  console.log(`💰 Claimable: ${balance.amount} Pi`);
  console.log(`🆔 Balance ID: ${balance.id}`);

  while (new Date() < unlockUTC) {
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n🚀 Unlock time reached: ${new Date().toISOString()}`);
  console.log(`🚨 Launching stealth claim flood...`);

  const variants = 3 + Math.floor(Math.random() * 3);
  const txList = [];

  for (let i = 0; i < variants; i++) {
    const memo = Math.random().toString(36).substring(2, 10);
    txList.push(buildTransaction(account, balance.id, amount, keypair, memo));
  }

  await floodTransactions(txList);
}

main().catch(e => {
  console.error("❌ Script Error:", e);
});

