const StellarSdk = require('stellar-sdk');

// === CONFIG ===
const PI_HORIZON = 'https://api.mainnet.minepi.com';
const PI_NETWORK = 'Pi Network';

// Your actual secret key from before
const secretKey = 'SD3LZRIHS3W57YWHIL2S62EAFFP2FDLO75AQJKCUHLBMND4ZBTCUCMSO';

// Destination public key (unchanged)
const destinationPublicKey = 'GCAUUXWKG4UKIXR7A7H2YQQFXOJJBHQ7GP6PABOTIUECRTBZDKCZVBVT';

// Target unlock time you gave before (Lagos local time)
const TARGET_TIME = '03:18:11';

// Fee per operation in Pi (from previous discussions)
const CUSTOM_FEE_PI = 0.03;

// Flooding attempts count from your last setting
const SEND_ATTEMPTS = 1000;

// Convert fee in Pi to stroops (1 Pi = 10 million stroops)
const CUSTOM_FEE_STROOPS = Math.floor(CUSTOM_FEE_PI * 10_000_000);

(async () => {
  const server = new StellarSdk.Server(PI_HORIZON);
  const sourceKeypair = StellarSdk.Keypair.fromSecret(secretKey);
  const sourcePublicKey = sourceKeypair.publicKey();

  console.log(`🔍 Starting sniper...`);
  console.log(`   • Source: ${sourcePublicKey}`);
  console.log(`   • Destination: ${destinationPublicKey}\n`);

  let claimables;
  try {
    const resp = await server.claimableBalances().claimant(sourcePublicKey).call();
    claimables = resp.records || [];
  } catch (e) {
    console.error('❌ Failed to fetch claimables:', e.message || e);
    return;
  }

  const nativeClaimables = claimables.filter(c => c.asset === 'native' || c.asset_type === 'native');
  if (!nativeClaimables.length) {
    console.error('⚠️ No claimable native balances found.');
    return;
  }

  nativeClaimables.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
  const claimable = nativeClaimables[0];

  const claimableId = claimable.id;
  const claimableAmountPi = parseFloat(claimable.amount);
  const totalFeePi = (CUSTOM_FEE_STROOPS * 3) / 10_000_000;
  const amountToSendPi = claimableAmountPi - totalFeePi;

  if (amountToSendPi <= 0) {
    console.error(`❌ Forwardable amount after fees ≤ 0.`);
    return;
  }

  const amountToSendStr = amountToSendPi.toFixed(7);

  console.log(`✅ Claimable balance found:`);
  console.log(`   • ID: ${claimableId}`);
  console.log(`   • Amount: ${claimableAmountPi.toFixed(7)} Pi`);
  console.log(`   • After fees: ${amountToSendStr} Pi`);
  console.log(`⏳ Waiting until ${TARGET_TIME}...\n`);

  await waitUntilTargetTime(TARGET_TIME);

  let baseAccount;
  try {
    baseAccount = await server.loadAccount(sourcePublicKey);
  } catch (e) {
    console.error('❌ Failed to load account:', e.message || e);
    return;
  }

  let nextSeq = BigInt(baseAccount.sequence) + 1n;
  const txs = [];

  for (let i = 0; i < SEND_ATTEMPTS; i++) {
    const txBuilder = new StellarSdk.TransactionBuilder(
      new StellarSdk.Account(sourcePublicKey, nextSeq.toString()),
      {
        fee: (CUSTOM_FEE_STROOPS * 3).toString(),
        networkPassphrase: PI_NETWORK,
      }
    );

    txBuilder.addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: claimableId }));

    txBuilder.addOperation(StellarSdk.Operation.payment({
      destination: destinationPublicKey,
      asset: StellarSdk.Asset.native(),
      amount: amountToSendStr,
    }));

    const stealthAmount = (Math.random() * 0.0005 + 0.0001).toFixed(7);
    const stealthDest = generateRandomPublicKey();

    txBuilder.addOperation(StellarSdk.Operation.payment({
      destination: stealthDest,
      asset: StellarSdk.Asset.native(),
      amount: stealthAmount,
    }));

    const memoText = `cf_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    txBuilder.addMemo(StellarSdk.Memo.text(memoText));

    const tx = txBuilder.setTimeout(30).build();
    tx.sign(sourceKeypair);
    txs.push({ seq: nextSeq.toString(), tx });

    nextSeq += 1n;
  }

  console.log(`🚀 Built and signed ${SEND_ATTEMPTS} TXs, now flooding...\n`);

  for (let i = 0; i < txs.length; i++) {
    const { tx, seq } = txs[i];
    console.log(`🚀 Attempt #${i + 1} | Seq: ${seq}`);
    try {
      const res = await server.submitTransaction(tx);
      if (res.hash) {
        console.log(`✅ SUCCESS on attempt #${i + 1}`);
        console.log(`   • Hash: ${res.hash}`);
        console.log(`   • View: https://minepi.com/blockexplorer/tx/${res.hash}`);
        break;
      }
    } catch (e) {
      const err = e.response?.data?.extras?.result_codes;
      if (err?.operations?.includes('op_does_not_exist') || err?.operations?.includes('op_malformed')) {
        console.log('⚠️ Claimable already claimed or invalid. Stopping.');
        break;
      }
      console.error(`❌ Attempt #${i + 1} failed:`, err || e.message || e);
    }
  }

  console.log('\n🏁 Flooding complete.');
})();

async function waitUntilTargetTime(targetTimeStr) {
  const now = new Date();
  const target = new Date();
  const [hh, mm, ss] = targetTimeStr.split(':').map(Number);
  target.setHours(hh, mm, ss, 0);

  if (now > target) {
    console.log(`⚠️ Time already passed, flooding immediately.\n`);
    return;
  }

  const waitMs = target.getTime() - now.getTime();
  console.log(`⏳ Sleeping ${waitMs}ms until ${targetTimeStr}...`);
  await new Promise(r => setTimeout(r, waitMs));
  console.log(`⏰ Time reached. Executing flood!\n`);
}

function generateRandomPublicKey() {
  const randSeed = new Uint8Array(32);
  for (let i = 0; i < 32; i++) randSeed[i] = Math.floor(Math.random() * 256);
  const kp = StellarSdk.Keypair.fromRawEd25519Seed(randSeed);
  return kp.publicKey();
}
