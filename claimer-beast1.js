


const StellarSdk = require('stellar-sdk');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const moment = require('moment-timezone');
const readline = require('readline');
const axios = require('axios');
const HttpsProxyAgent = require('https-proxy-agent');

const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';
const server = new StellarSdk.Server(PI_HORIZON);

// 🔑 INPUT
const mnemonic = 'ADD_SKEY';
const recipientPublicKey = 'ADD_PKEY';
const LOCAL_UNLOCK_TIME = '2025-05-01 17:45:22'; // GMT+1
const MAX_CONCURRENCY = 10;
const PROXY_LIST = [
  'http://sp3njrtwvn:113wQ9pfddCcGi_xsM@gate.decodo.com:10001'
]; // Add your proxy list here

function convertToUTC(localTimeString) {
  return moment.tz(localTimeString, 'YYYY-MM-DD HH:mm:ss', 'Africa/Lagos').utc().toDate();
}

async function deriveKeyFromPhrase(mnemonic) {
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const key = edHd.derivePath("m/44'/314159'/0'", seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(key.key);
}

function overwriteLine(message) {
  readline.clearLine(process.stdout, 0);
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(message);
}

// 🕒 Waits until unlock time
async function waitUntilUnlock(unlockTimeUTC, callback) {
  console.log(`🕒 Waiting for unlock time (${unlockTimeUTC.toISOString()})...`);
  while (new Date() < unlockTimeUTC) {
    const now = new Date().toISOString();
    overwriteLine(`⏳ Still waiting... (${now})`);
    await new Promise(res => setTimeout(res, 1000));
  }
  console.log(`\n🚀 Time reached: ${new Date().toISOString()}`);
  callback(); // trigger claim
}

// 🔁 Multi-threaded submission loop
async function startConcurrentSubmitters(keypair, txXDRs) {
  let success = false;

  console.log(`⚡ Launching ${MAX_CONCURRENCY} concurrent submitters...`);

  const workers = Array.from({ length: MAX_CONCURRENCY }).map((_, index) =>
    (async () => {
      let attempt = 0;
      while (!success) {
        attempt++;
        try {
          // Rotate proxy for each request
          const proxy = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
          const agent = new HttpsProxyAgent(proxy);
          const customAxios = axios.create({ httpsAgent: agent });

          // Chaining multiple XDR submissions
          for (let xdr of txXDRs) {
            const tx = StellarSdk.TransactionBuilder.fromXDR(xdr, PI_NETWORK);
            const result = await customAxios.post(PI_HORIZON + '/transactions', tx.toXDR(), {
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              }
            });

            if (result && result.data.hash) {
              success = true;
              console.log(`\n✅ Worker ${index + 1} succeeded! Tx Hash: ${result.data.hash}`);
              console.log(`🔍 View: https://minepi.com/blockexplorer/tx/${result.data.hash}`);
              break;
            } else {
              console.log(`❌ Worker ${index + 1}, Attempt ${attempt}: No hash`);
            }
          }
        } catch (err) {
          const code = err.response?.data?.extras?.result_codes || err.message;
          console.log(`❌ Worker ${index + 1}, Attempt ${attempt} Failed:`, code);
        }
        await new Promise(res => setTimeout(res, 200)); // short pause between retries
      }
    })()
  );

  await Promise.all(workers);
}

// 🧠 MAIN EXECUTION
(async () => {
  const keypair = await deriveKeyFromPhrase(mnemonic);
  const publicKey = keypair.publicKey();
  const unlockTime = convertToUTC(LOCAL_UNLOCK_TIME);

  console.log(`🔐 Public Key: ${publicKey}`);
  console.log(`🎯 Target UTC Time: ${unlockTime.toISOString()}`);

  const balances = await server.claimableBalances().claimant(publicKey).limit(1).order('desc').call();
  if (balances.records.length === 0) {
    console.log("❌ No claimable balance found.");
    return;
  }

  const balance = balances.records[0];
  const balanceId = balance.id;
  const claimAmount = parseFloat(balance.amount).toFixed(7);

  console.log(`🆔 Balance ID: ${balanceId}`);
  console.log(`💰 Claimable Amount: ${claimAmount} Pi`);

  const account = await server.loadAccount(publicKey);
  const nativeBalance = account.balances.find(b => b.asset_type === 'native')?.balance || '0';
  console.log(`💼 Current Wallet Balance: ${nativeBalance} Pi`);

  const baseFee = await server.fetchBaseFee();
  const fee = (parseInt(baseFee) + 100).toString();

  const tx = new StellarSdk.TransactionBuilder(account, {
    fee,
    networkPassphrase: PI_NETWORK
  })
    .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId }))
    .addOperation(StellarSdk.Operation.payment({
      destination: recipientPublicKey,
      asset: StellarSdk.Asset.native(),
      amount: (parseFloat(claimAmount) - 0.07).toFixed(7)
    }))
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const txXDR = tx.toXDR();

  // Create multiple signed transactions for flooding
  const txXDRs = Array.from({ length: 5 }, () => txXDR); // Example: Chaining 5 transactions

  waitUntilUnlock(unlockTime, () => {
    startConcurrentSubmitters(keypair, txXDRs);
  });
})();

