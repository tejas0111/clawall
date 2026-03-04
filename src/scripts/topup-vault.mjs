import 'dotenv/config';
import './runtime-env.mjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC_URL });
const SUI_COIN_TYPE = '0x2::sui::SUI';

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

function maskSecret(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '(empty)';
  if (raw.length <= 12) return '*'.repeat(raw.length);
  return `${raw.slice(0, 8)}...${raw.slice(-6)}`;
}

async function promptUseDetectedOrOther(rl, label, detectedValue = '', { secret = false } = {}) {
  const detected = String(detectedValue || '').trim();
  if (!detected) return String(await rl.question(`Enter ${label}: `)).trim();
  const shown = secret ? maskSecret(detected) : detected;
  const useDetected = String(await rl.question(`Use detected ${label} (${shown})? [Y/n]: `)).trim().toLowerCase();
  if (!useDetected || useDetected === 'y' || useDetected === 'yes') return detected;
  return String(await rl.question(`Enter ${label}: `)).trim();
}

function coinSymbolFromType(coinType) {
  return String(coinType || '').split('::')[2]?.toUpperCase() || coinType;
}

function toObjectId(value) {
  const v = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]+$/.test(v)) return null;
  return v;
}

async function depositIntoVault({
  signer,
  sender,
  packageId,
  vaultId,
  coinType,
  amount,
}) {
  const tx = new Transaction();
  tx.setSender(sender);

  if (coinType === SUI_COIN_TYPE) {
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);
    tx.moveCall({
      target: `${packageId}::enforcer::deposit`,
      typeArguments: [coinType],
      arguments: [tx.object(vaultId), coin],
    });
  } else {
    const coinObjs = await client.getCoins({ owner: sender, coinType });
    const coinIds = (coinObjs.data ?? []).map((c) => c.coinObjectId).filter(Boolean);
    if (!coinIds.length) {
      throw new Error(`No coin objects found for ${coinSymbolFromType(coinType)}.`);
    }

    const primaryCoin = tx.object(coinIds[0]);
    if (coinIds.length > 1) {
      tx.mergeCoins(
        primaryCoin,
        coinIds.slice(1).map((id) => tx.object(id))
      );
    }
    const [splitCoin] = tx.splitCoins(primaryCoin, [tx.pure.u64(amount)]);
    tx.moveCall({
      target: `${packageId}::enforcer::deposit`,
      typeArguments: [coinType],
      arguments: [tx.object(vaultId), splitCoin],
    });
  }

  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== 'success') {
    throw new Error(`Deposit failed: ${JSON.stringify(result.effects?.status ?? {})}`);
  }
  return result;
}

async function main() {
  const rl = readline.createInterface({ input, output });
  console.log('\n=== ClawAll Vault Top-Up ===');
  console.log('(Fast vault funding only. Use `npm run setup` for full bootstrap.)\n');

  try {
    const detectedAdminPrivKey = firstNonEmpty(
      process.env.ADMIN_PRIVATE_KEY,
      process.env.ADMIN_PK,
      process.env.PRIVATE_KEY
    );
    const adminPrivKey = await promptUseDetectedOrOther(rl, 'ADMIN Private Key', detectedAdminPrivKey, { secret: true });
    const envPackage = toObjectId(process.env.PACKAGE_ID);
    const envVault = toObjectId(process.env.VAULT_ID);
    const packageId = await promptUseDetectedOrOther(rl, 'PACKAGE_ID', envPackage);
    const vaultId = await promptUseDetectedOrOther(rl, 'VAULT_ID', envVault);

    if (!toObjectId(packageId)) throw new Error('Invalid PACKAGE_ID.');
    if (!toObjectId(vaultId)) throw new Error('Invalid VAULT_ID.');

    const { secretKey } = decodeSuiPrivateKey(adminPrivKey);
    const adminSigner = Ed25519Keypair.fromSecretKey(secretKey);
    const adminAddr = adminSigner.toSuiAddress();

    console.log(`\nAdmin: ${adminAddr}`);
    console.log(`Package: ${packageId}`);
    console.log(`Vault: ${vaultId}`);

    // Quick sanity check: vault object exists
    const vaultObj = await client.getObject({ id: vaultId, options: { showType: true } });
    if (!vaultObj?.data?.type || !String(vaultObj.data.type).startsWith(String(packageId))) {
      throw new Error('VAULT_ID does not belong to PACKAGE_ID (or object not found).');
    }

    let depositedCount = 0;
    while (true) {
      const balances = await client.getAllBalances({ owner: adminAddr });
      if (!balances.length) {
        console.log('\n[topup] No balances available in admin wallet.');
        break;
      }

      console.log('\nAvailable Coins:');
      balances.forEach((b, i) => {
        console.log(`${i + 1}) ${coinSymbolFromType(b.coinType)} (${b.totalBalance} units)`);
      });
      console.log('0) Done');

      const rawChoice = (await rl.question('\nSelect coin to deposit (number, 0 to finish): ')).trim();
      if (!rawChoice || rawChoice === '0') break;

      const choice = Number(rawChoice) - 1;
      const selectedCoin = balances[choice];
      if (!selectedCoin) {
        console.log('[topup] Invalid selection.');
        continue;
      }

      const coinType = selectedCoin.coinType;
      const symbol = coinSymbolFromType(coinType);
      const maxBalance = BigInt(selectedCoin.totalBalance || '0');

      const amountRaw = (await rl.question(`Amount of ${symbol} to deposit (base units): `)).trim();
      let amount;
      try {
        amount = BigInt(amountRaw);
      } catch {
        console.log('[topup] Invalid amount. Use integer base units.');
        continue;
      }

      if (amount <= 0n) {
        console.log('[topup] Amount must be > 0.');
        continue;
      }
      if (amount > maxBalance) {
        console.log(`[topup] Amount exceeds balance (${maxBalance} units).`);
        continue;
      }

      try {
        console.log(`- Depositing ${amount} ${symbol}...`);
        await depositIntoVault({
          signer: adminSigner,
          sender: adminAddr,
          packageId,
          vaultId,
          coinType,
          amount,
        });
        depositedCount += 1;
        console.log(`[topup] Deposited ${amount} ${symbol} into vault.`);
      } catch (err) {
        console.log(`[topup] Deposit failed: ${err.message}`);
      }
    }

    if (depositedCount === 0) {
      console.log('\nNo deposits completed.');
    } else {
      console.log(`\n[topup] Complete. Successful deposits: ${depositedCount}`);
    }
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
  } finally {
    rl.close();
  }
}

main();
