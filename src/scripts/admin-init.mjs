import 'dotenv/config';
import './runtime-env.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
const client = new SuiJsonRpcClient({ url: RPC_URL });
const NODE_BIN = process.execPath;
const NPM_BIN = process.platform === 'win32' ? 'npm.cmd' : 'npm';

async function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

function isTransientRpcError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  const code = String(err?.code ?? err?.cause?.code ?? '').toUpperCase();
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    msg.includes('fetch failed') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('429') ||
    msg.includes('503')
  );
}

async function withRpcRetry(fn, label = 'rpc', attempts = 6) {
  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRpcError(err) || i === attempts) break;
      const waitMs = Math.min(300 * i, 1500);
      console.log(`! transient RPC issue on ${label}; retry ${i}/${attempts} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    noRuntimePrompt: argv.includes('--no-runtime-prompt'),
    recordedPrompts: argv.includes('--recorded-prompts'),
  };
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (s) return s;
  }
  return '';
}

function setEnvValue(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) return content.replace(re, line);
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

function removeEnvValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*\\n?`, 'm');
  return re.test(content) ? content.replace(re, '') : content;
}

function parseEnvValue(content, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=(.*)$`, 'm');
  const match = String(content ?? '').match(re);
  return match?.[1]?.trim() ?? '';
}

function isYes(answer, defaultYes = true) {
  const v = String(answer ?? '').trim().toLowerCase();
  if (!v) return defaultYes;
  return v === 'y' || v === 'yes';
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

async function waitForObject(objectId) {
  for (let i = 0; i < 10; i++) {
    try {
      const obj = await withRpcRetry(
        () => client.getObject({ id: objectId, options: { showType: true } }),
        'getObject(waitForObject)',
        3
      );
      if (obj.data) return obj.data;
    } catch (e) {}
    await sleep(1500);
  }
  return null;
}

function coinSymbolFromType(coinType) {
  return String(coinType || '').split('::')[2]?.toUpperCase() || coinType;
}

function resolveAgentAddress(inputValue) {
  const raw = String(inputValue || '').trim();
  if (!raw) throw new Error('Agent wallet input is required.');
  if (/^0x[a-fA-F0-9]{64}$/.test(raw)) return raw;
  try {
    const { secretKey } = decodeSuiPrivateKey(raw);
    const kp = Ed25519Keypair.fromSecretKey(secretKey);
    return kp.toSuiAddress();
  } catch {
    throw new Error('Invalid AGENT wallet input. Provide 0x address or valid suiprivkey.');
  }
}

function maskSecret(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '(empty)';
  if (raw.length <= 12) return '*'.repeat(raw.length);
  return `${raw.slice(0, 8)}...${raw.slice(-6)}`;
}

function parsePrivateKeyToAddress(rawKey) {
  const trimmed = String(rawKey || '').trim();
  if (!trimmed) throw new Error('Agent private key is required.');
  const { secretKey } = decodeSuiPrivateKey(trimmed);
  const kp = Ed25519Keypair.fromSecretKey(secretKey);
  return { privateKey: trimmed, address: kp.toSuiAddress() };
}

async function promptWithDefault(rl, label, currentValue = '', { secret = false } = {}) {
  const current = String(currentValue || '').trim();
  if (!current) {
    return String(await rl.question(`${label}: `)).trim();
  }
  const shown = secret ? maskSecret(current) : current;
  const answer = String(await rl.question(`${label} [press Enter to keep ${shown}]: `)).trim();
  return answer || current;
}

async function promptUseDetectedOrOther(rl, label, detectedValue = '', { secret = false } = {}) {
  const detected = String(detectedValue || '').trim();
  if (!detected) return promptWithDefault(rl, label, '', { secret });
  const shown = secret ? maskSecret(detected) : detected;
  const useDetected = String(await rl.question(`Use detected ${label} (${shown})? [Y/n]: `)).trim().toLowerCase();
  if (!useDetected || useDetected === 'y' || useDetected === 'yes') return detected;
  return promptWithDefault(rl, label, '', { secret });
}

async function readObjectTypeSafe(objectId) {
  try {
    const obj = await withRpcRetry(
      () => client.getObject({ id: objectId, options: { showType: true } }),
      'getObject(readObjectTypeSafe)',
      4
    );
    return String(obj?.data?.type || '');
  } catch {
    return '';
  }
}

async function discoverFreezeStateIdFromHistory({ packageId, adminAddr }) {
  const expectedType = `${packageId}::enforcer::GlobalFreeze`;
  let cursor = null;
  for (let page = 0; page < 6; page += 1) {
    let resp;
    try {
      resp = await withRpcRetry(
        () => client.queryTransactionBlocks({
          filter: { FromAddress: adminAddr },
          options: { showObjectChanges: true },
          cursor,
          limit: 50,
        }),
        'queryTransactionBlocks(discoverFreezeStateId)',
        4
      );
    } catch {
      return '';
    }
    const txs = Array.isArray(resp?.data) ? resp.data : [];
    for (const tx of txs) {
      const changes = Array.isArray(tx?.objectChanges) ? tx.objectChanges : [];
      for (const ch of changes) {
        if (ch?.type === 'created' && ch?.objectType === expectedType && ch?.objectId) {
          return ch.objectId;
        }
      }
    }
    if (!resp?.hasNextPage || !resp?.nextCursor) break;
    cursor = resp.nextCursor;
  }
  return '';
}

async function resolveFreezeStateId({ packageId, adminAddr, envContent, rl }) {
  const expectedType = `${packageId}::enforcer::GlobalFreeze`;
  let freezeStateId = parseEnvValue(envContent, 'FREEZE_STATE_ID');

  if (freezeStateId) {
    const t = await readObjectTypeSafe(freezeStateId);
    if (t === expectedType) {
      console.log(`[setup] Using FREEZE_STATE_ID from .env: ${freezeStateId}`);
      return freezeStateId;
    }
    console.log(`[setup] FREEZE_STATE_ID in .env is incompatible (expected ${expectedType}, got ${t || 'unknown'}).`);
  }

  const discovered = await discoverFreezeStateIdFromHistory({ packageId, adminAddr });
  if (discovered) {
    const t = await readObjectTypeSafe(discovered);
    if (t === expectedType) {
      console.log(`[setup] Auto-discovered FREEZE_STATE_ID: ${discovered}`);
      return discovered;
    }
  }

  while (true) {
    const prompt = freezeStateId
      ? `Enter FREEZE_STATE_ID for ${packageId} (current invalid: ${freezeStateId}): `
      : `Enter FREEZE_STATE_ID for ${packageId}: `;
    const next = (await rl.question(prompt)).trim();
    if (!next) {
      console.log('[setup] FREEZE_STATE_ID is required for transfers.');
      continue;
    }
    const t = await readObjectTypeSafe(next);
    if (t === expectedType) {
      console.log(`[setup] FREEZE_STATE_ID validated: ${next}`);
      return next;
    }
    console.log(`[setup] Invalid FREEZE_STATE_ID type. Expected ${expectedType}, got ${t || 'unknown'}.`);
    freezeStateId = next;
  }
}

async function main() {
  const args = parseArgs();
  const rl = readline.createInterface({ input, output });
  console.log('\n=== ClawAll Master Vault Initializer ===');
  
  try {
    const envPath = './.env';
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const currentAgentPrivateKey = parseEnvValue(envContent, 'PRIVATE_KEY');
    const envAdminPrivateKey = firstNonEmpty(process.env.ADMIN_PRIVATE_KEY, process.env.ADMIN_PK);
    const envAgentPrivateKey = firstNonEmpty(process.env.AGENT_PRIVATE_KEY, process.env.AGENT_PK);
    const envPackageId = firstNonEmpty(process.env.PACKAGE_ID);

    let adminPrivKey = '';
    let packageId = '';
    let selectedAgentPrivateKey = '';

    if (!process.stdin.isTTY) {
      // Non-interactive mode: require env vars, no stdin prompt fallback.
      adminPrivKey = envAdminPrivateKey;
      packageId = envPackageId;
      selectedAgentPrivateKey = firstNonEmpty(envAgentPrivateKey, currentAgentPrivateKey);
      if (!adminPrivKey || !packageId || !selectedAgentPrivateKey) {
        throw new Error(
          'Non-interactive mode requires env vars: ADMIN_PK (or ADMIN_PRIVATE_KEY), PACKAGE_ID, AGENT_PK (or AGENT_PRIVATE_KEY).'
        );
      }
    } else {
      if (args.recordedPrompts) {
        adminPrivKey = await promptWithDefault(rl, 'Enter ADMIN Private Key', envAdminPrivateKey, { secret: true });
        packageId = await promptWithDefault(rl, 'Enter PACKAGE_ID', envPackageId);
        selectedAgentPrivateKey = await promptWithDefault(
          rl,
          'Enter AGENT Private Key',
          firstNonEmpty(envAgentPrivateKey, currentAgentPrivateKey),
          { secret: true }
        );
      } else {
        adminPrivKey = await promptUseDetectedOrOther(rl, 'ADMIN Private Key', envAdminPrivateKey, { secret: true });
        packageId = await promptUseDetectedOrOther(rl, 'PACKAGE_ID', envPackageId);
        selectedAgentPrivateKey = await promptUseDetectedOrOther(
          rl,
          'AGENT Private Key',
          firstNonEmpty(envAgentPrivateKey, currentAgentPrivateKey),
          { secret: true }
        );
      }
    }

    const { privateKey: agentPrivateKey, address: agentAddress } = parsePrivateKeyToAddress(selectedAgentPrivateKey);

    const { secretKey } = decodeSuiPrivateKey(adminPrivKey);
    const adminSigner = Ed25519Keypair.fromSecretKey(secretKey);
    const adminAddr = adminSigner.toSuiAddress();

    console.log(`\nAdmin: ${adminAddr}`);

    // 1. GuardCap Check
    const caps = await withRpcRetry(
      () => client.getOwnedObjects({ owner: adminAddr, filter: { StructType: `${packageId}::enforcer::GuardCap` } }),
      'getOwnedObjects(GuardCap admin)'
    );
    let guardCapId = caps.data[0]?.data?.objectId;

    if (guardCapId) {
      console.log(`\n- Delegating GuardCap ${guardCapId}...`);
      const txD = new Transaction();
      txD.setSender(adminAddr);
      txD.transferObjects([txD.object(guardCapId)], txD.pure.address(agentAddress));
      await client.signAndExecuteTransaction({ signer: adminSigner, transaction: txD });
      console.log('[setup] GuardCap delegated.');
      await waitForObject(guardCapId);
    } else {
      const agentCaps = await withRpcRetry(
        () => client.getOwnedObjects({ owner: agentAddress, filter: { StructType: `${packageId}::enforcer::GuardCap` } }),
        'getOwnedObjects(GuardCap agent)'
      );
      guardCapId = agentCaps.data[0]?.data?.objectId;
      if (!guardCapId) throw new Error('GuardCap not found for this package.');
      console.log(`[setup] GuardCap confirmed with Agent: ${guardCapId}`);
    }

    // 2. Master Vault Validation (Package Match)
    const freezeStateId = await resolveFreezeStateId({ packageId, adminAddr, envContent, rl });
    let vaultId = envContent.match(/^VAULT_ID=(0x[a-fA-F0-9]+)/m)?.[1];

    if (vaultId) {
      const vaultObj = await withRpcRetry(
        () => client.getObject({ id: vaultId, options: { showType: true } }),
        'getObject(VAULT_ID)'
      );
      if (!vaultObj.data || !vaultObj.data.type.startsWith(packageId)) {
        console.log(`\n[setup] Existing Vault belongs to a different package. A new one is required.`);
        vaultId = null;
      }
    }

    if (!vaultId) {
      console.log('\n- Creating Master Vault for current package...');
      const txV = new Transaction();
      txV.setSender(adminAddr);
      txV.moveCall({ target: `${packageId}::enforcer::create_vault` });
      const resV = await client.signAndExecuteTransaction({ signer: adminSigner, transaction: txV, options: { showObjectChanges: true } });
      vaultId = resV.objectChanges.find(oc => oc.type === 'created' && oc.objectType.includes('::Vault'))?.objectId;
      if (!vaultId) throw new Error('Vault creation failed.');
      console.log(`[setup] Master Vault created: ${vaultId}`);
      await waitForObject(vaultId);
    } else {
      console.log(`\n[setup] Using existing Master Vault: ${vaultId}`);
    }

    // 3. Funding (multi-coin loop)
    let depositedCount = 0;
    while (true) {
      console.log('\nFetching balances...');
      const balances = await withRpcRetry(
        () => client.getAllBalances({ owner: adminAddr }),
        'getAllBalances(admin)'
      );

      if (!balances.length) {
        console.log('[setup] No coins available in admin wallet.');
        break;
      }

      console.log('\nAvailable Coins:');
      balances.forEach((b, i) => {
        const symbol = coinSymbolFromType(b.coinType);
        console.log(`${i + 1}) ${symbol} (${b.totalBalance} units)`);
      });
      console.log('0) Done depositing');

      const rawChoice = (await rl.question('\nSelect coin to deposit (number, 0 to finish): ')).trim();
      if (!rawChoice || rawChoice === '0') break;

      const choice = Number(rawChoice) - 1;
      const selectedCoin = balances[choice];
      if (!selectedCoin) {
        console.log('[setup] Invalid selection. Try again.');
        continue;
      }

      const coinType = selectedCoin.coinType;
      const coinSymbol = coinSymbolFromType(coinType);
      const maxBalance = BigInt(selectedCoin.totalBalance || '0');
      const amountRaw = (await rl.question(`Amount of ${coinSymbol} to deposit (base units): `)).trim();

      let amount;
      try {
        amount = BigInt(amountRaw);
      } catch {
        console.log('[setup] Invalid amount. Enter an integer in base units.');
        continue;
      }

      if (amount <= 0n) {
        console.log('[setup] Amount must be > 0.');
        continue;
      }
      if (amount > maxBalance) {
        console.log(`[setup] Amount exceeds available ${coinSymbol} balance (${maxBalance} units).`);
        continue;
      }

      console.log(`- Depositing ${amount} ${coinSymbol}...`);
      const txF = new Transaction();
      txF.setSender(adminAddr);

      if (coinType === '0x2::sui::SUI') {
        const [coin] = txF.splitCoins(txF.gas, [txF.pure.u64(amount)]);
        txF.moveCall({
          target: `${packageId}::enforcer::deposit`,
          typeArguments: [coinType],
          arguments: [txF.object(vaultId), coin],
        });
      } else {
        const coinObjs = await withRpcRetry(
          () => client.getCoins({ owner: adminAddr, coinType }),
          `getCoins(${coinSymbol})`
        );
        const coinIds = (coinObjs.data ?? []).map((c) => c.coinObjectId).filter(Boolean);
        if (!coinIds.length) {
          console.log(`[setup] No ${coinSymbol} objects found.`);
          continue;
        }
        const primaryCoin = txF.object(coinIds[0]);
        if (coinIds.length > 1) {
          txF.mergeCoins(
            primaryCoin,
            coinIds.slice(1).map((id) => txF.object(id))
          );
        }
        const [splitCoin] = txF.splitCoins(primaryCoin, [txF.pure.u64(amount)]);
        txF.moveCall({
          target: `${packageId}::enforcer::deposit`,
          typeArguments: [coinType],
          arguments: [txF.object(vaultId), splitCoin],
        });
      }

      const resF = await client.signAndExecuteTransaction({
        signer: adminSigner,
        transaction: txF,
        options: { showEffects: true },
      });
      if (resF.effects?.status.status !== 'success') {
        console.log(`[setup] Funding failed: ${JSON.stringify(resF.effects?.status)}`);
        continue;
      }

      depositedCount += 1;
      console.log(`[setup] Successfully deposited ${coinSymbol} into Master Vault.`);
    }

    if (depositedCount === 0) {
      console.log('[setup] No deposits were made in this run.');
    } else {
      console.log(`[setup] Deposit loop complete. Successful deposits: ${depositedCount}`);
    }

    // 4. Update .env
    const updates = {
      PRIVATE_KEY: agentPrivateKey,
      PACKAGE_ID: packageId,
      GUARD_CAP_ID: guardCapId,
      VAULT_ID: vaultId,
      FREEZE_STATE_ID: freezeStateId,
    };
    for (const [k, v] of Object.entries(updates)) {
      envContent = setEnvValue(envContent, k, v);
    }
    envContent = setEnvValue(envContent, 'POLICY_CAP_ID', '');
    envContent = setEnvValue(envContent, 'POLICY_CAP_ID_ONCE', '');
    envContent = setEnvValue(envContent, 'ENFORCE_CAP_ISOLATION', '1');
    envContent = removeEnvValue(envContent, 'ADMIN_PRIVATE_KEY');
    fs.writeFileSync(envPath, envContent.trim() + '\n', 'utf8');

    // 5. Optional strict policy setup (hash sign + on-chain anchor)
    const policyCaps = await withRpcRetry(
      () => client.getOwnedObjects({
        owner: adminAddr,
        filter: { StructType: `${packageId}::enforcer::PolicyAdminCap` },
      }),
      'getOwnedObjects(PolicyAdminCap)'
    );
    const detectedPolicyCapId = policyCaps.data[0]?.data?.objectId ?? '';
    if (detectedPolicyCapId) {
      console.log(`[setup] PolicyAdminCap detected: ${detectedPolicyCapId}`);
    } else {
      console.log('[setup] No PolicyAdminCap auto-detected for this admin wallet.');
    }

    const strictNowAnswer = await rl.question('Run strict policy setup now (sign + anchor)? [Y/n]: ');
    if (isYes(strictNowAnswer, true)) {
      const policyCapPrompt = detectedPolicyCapId
        ? `PolicyAdminCap object id [${detectedPolicyCapId}]: `
        : 'PolicyAdminCap object id (0x...): ';
      let policyCapInput = (await rl.question(policyCapPrompt)).trim() || detectedPolicyCapId;

      if (!policyCapInput) {
        console.log('[setup] Skipping strict policy setup (PolicyAdminCap not provided).');
      } else {
        const runtimePriv = parseEnvValue(envContent, 'PRIVATE_KEY') || adminPrivKey.trim();
        let strictDone = false;
        while (!strictDone) {
          try {
            runOrThrow(NODE_BIN, ['src/enforcement/setup-policy-once.mjs', `--policy_cap_id=${policyCapInput}`], {
              env: {
                ...process.env,
                PRIVATE_KEY: runtimePriv,
                ADMIN_PRIVATE_KEY: adminPrivKey.trim(),
                PACKAGE_ID: packageId,
                FREEZE_STATE_ID: freezeStateId,
              },
            });
            console.log('[setup] Strict policy setup completed.');
            envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : envContent;
            strictDone = true;
          } catch (err) {
            console.log(`[setup] Strict policy setup failed: ${err.message}`);
            console.log('  Retry options:');
            console.log('  1) Retry with same PolicyAdminCap');
            console.log('  2) Enter different PolicyAdminCap');
            console.log('  3) Skip strict setup for now');
            const retryChoice = (await rl.question('Select [1/2/3] (default 1): ')).trim() || '1';

            if (retryChoice === '1') {
              console.log('- Retrying strict setup with same PolicyAdminCap...');
              continue;
            }
            if (retryChoice === '2') {
              const nextCap = (await rl.question('PolicyAdminCap object id (0x...): ')).trim();
              if (!nextCap) {
                console.log('[setup] No PolicyAdminCap entered. Keeping previous value.');
              } else {
                policyCapInput = nextCap;
              }
              continue;
            }
            console.log('[setup] Strict policy setup skipped (you can rerun later).');
            break;
          }
        }
      }
    } else {
      console.log('[setup] Strict policy setup skipped (integrity-only mode remains available).');
    }

    // 6. Optional runtime/plugin setup
    if (args.noRuntimePrompt) {
      console.log('[setup] Skipping runtime + plugin prompt (--no-runtime-prompt).');
    } else {
      const runSetupAnswer = await rl.question('Run runtime + plugin setup now (npm run setup:runtime)? [Y/n]: ');
      if (isYes(runSetupAnswer, true)) {
        runOrThrow(NPM_BIN, ['run', 'setup:runtime']);
        console.log('[setup] Runtime + plugin setup completed.');
      } else {
        console.log('[setup] Skipped npm run setup:runtime.');
      }
    }

    console.log('\n=== BOOTSTRAP COMPLETE ===');
    console.log('Try: openclaw clawall wallet');

  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
  } finally {
    rl.close();
  }
}

main();
