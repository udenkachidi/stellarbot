const StellarSdk = require('stellar-sdk');

// ——— CONFIG ———
const HORIZON_URL = 'https://api.mainnet.minepi.com';
const PUBLIC_KEY = 'GCBDEBX7B6ZWB5G25Q5N4K5URH3GGGTBBF2CRRSFYOLMVF5WSV3MZONZ'; // Replace if needed

// ——— SETUP ———
const server = new StellarSdk.Server(HORIZON_URL);

(async () => {
  try {
    const page = await server
      .claimableBalances({ claimant: PUBLIC_KEY })
      .call();

    const records = page.records || [];

    if (records.length === 0) {
      console.log('🚫 No claimable balances found.');
      return;
    }

    for (const cb of records) {
      console.log(`\n🔒 Claimable Balance ID: ${cb.id}`);
      console.log(`💰 Amount: ${cb.amount} Pi`);
      console.log(`📅 Last Modified: ${cb.last_modified_time}`);

      const claimant = cb.claimants?.[0];
      const predicate = claimant?.predicate;

      if (!predicate) {
        console.log('❓ No predicate info available.');
        continue;
      }

      if (predicate.unconditional) {
        console.log('✅ Unlocked (unconditional)');
      } else if (predicate.abs_before) {
        const unlockTime = new Date(predicate.abs_before);
        console.log(`🔓 Unlocks before: ${unlockTime.toLocaleString()}`);
      } else {
        console.log('🔒 Predicate:', JSON.stringify(predicate, null, 2));
      }
    }
  } catch (err) {
    console.error('❌ Error fetching claimable balances:', err.message || err);
  }
})();
