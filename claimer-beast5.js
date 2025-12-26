const StellarSdk = require('stellar-sdk');
const bip39     = require('bip39');
const edHd      = require('ed25519-hd-key');

const PI_HORIZON      = 'https://api.mainnet.minepi.com';
const PI_PASSPHRASE   = 'Pi Network';
StellarSdk.Networks.PI = PI_PASSPHRASE;

const server  = new StellarSdk.Server(PI_HORIZON);
const recipient = 'ADD_PKEY';
const mnemonic  = '24 word phrase';
const UNLOCK_TS = Date.parse('2025-05-10T03:22:54Z') / 1000; // in seconds

async function deriveKeypair(m) {
  const seed = await bip39.mnemonicToSeed(m);
  const { key } = edHd.derivePath("m/44'/314159'/0'", seed);
  return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

(async () => {
  const keypair = await deriveKeypair(mnemonic);
  const pubKey   = keypair.publicKey();
  console.log('🔐 Public Key:', pubKey);
  console.log('🎯 Unlock Time (ledger ts):', UNLOCK_TS);

  // 1. fetch your claimable balance
  const { records } = await server
    .claimableBalances()
    .claimant(pubKey)
    .order('desc')
    .limit(1)
    .call();

  if (!records.length) {
    console.error('❌ No claimable balances found.');
    process.exit(1);
  }

  const balance = records[0];
  console.log('🆔 Balance ID:', balance.id);
  console.log('💰 Amount:', balance.amount, 'Pi');

  // 2. load account & compute a few fee‑tiers
  const account = await server.loadAccount(pubKey);
  const baseFee = await server.fetchBaseFee();
  const feeTiers = [baseFee + 50, baseFee + 100, baseFee + 200]; // try to outbid others

  // 3. pre‑build & sign one tx per fee
  const signedXDRs = feeTiers.map(fee => {
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: fee.toString(),
      networkPassphrase: PI_PASSPHRASE,
      timebounds: { minTime: 0, maxTime: UNLOCK_TS + 60 }
    })
      .addOperation(StellarSdk.Operation.claimClaimableBalance({ balanceId: balance.id }))
      .addOperation(StellarSdk.Operation.payment({
        destination: recipient,
        asset: StellarSdk.Asset.native(),
        amount: balance.amount
      }))
      .build();
    tx.sign(keypair);
    console.log(`📝 Prepared TX (fee=${fee})`);
    return tx.toXDR();
  });

  // 4. watch ledgers and fire as soon as on‐chain time ≥ your unlock
  console.log('⏳ Waiting for unlock on-chain...');
  const es = server
    .ledgers()
    .cursor('now')
    .stream({
      onmessage: async ledger => {
        const closedAt = Date.parse(ledger.closed_at) / 1000;
        if (closedAt >= UNLOCK_TS) {
          console.log('🚀 On-chain unlock reached:', ledger.closed_at);
          es(); // unsubscribe

          // submit all variants exactly once
          let done = false;
          signedXDRs.forEach(async (xdr, i) => {
            if (done) return;
            try {
              const tx = new StellarSdk.Transaction(xdr, PI_PASSPHRASE);
              const res = await server.submitTransaction(tx);
              console.log(`✅ SUCCESS [variant ${i}] Hash:`, res.hash);
              done = true;
            } catch (e) {
              const codes = e?.response?.data?.extras?.result_codes;
              console.warn(`❌ Variant ${i} failed:`, codes || e.message);
            }
          });
        }
      },
      onerror: err => {
        console.error('Stream error:', err);
      }
    });
})();

