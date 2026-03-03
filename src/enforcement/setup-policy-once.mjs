import 'dotenv/config';
import fs from 'fs';
import path from 'node:path';
import readline from 'node:readline';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { computePolicyBundleHash, writePolicySignatureFile } from './policy-integrity.mjs';
import { upsertPolicyAnchor, verifyPolicyAnchorIntegrity } from './policy-anchor.mjs';

const ENV_FILE = path.resolve(process.cwd(), '.env');
const OBJECT_ID_RE = /^0x[a-fA-F0-9]+$/;

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const [k, v] = part.slice(2).split('=');
    out[k] = typeof v === 'string' ? v : '1';
  }
  return out;
}

function setEnvValue(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) {
    return content.replace(re, line);
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

async function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return String(answer ?? '').trim();
}

function assertObjectId(name, value) {
  if (!OBJECT_ID_RE.test(String(value ?? ''))) {
    throw new Error(`${name} must be a 0x-prefixed object id`);
  }
}

async function resolvePolicyCapId(args) {
  const fromArg = String(args.policy_cap_id ?? '').trim();
  if (fromArg) return fromArg;

  const fromEnv = String(process.env.POLICY_CAP_ID_ONCE ?? '').trim();
  if (fromEnv) return fromEnv;

  return prompt('Enter POLICY_CAP_ID (PolicyAdminCap object id): ');
}

async function main() {
  if (!fs.existsSync(ENV_FILE)) {
    throw new Error('.env not found in project root');
  }

  const args = parseArgs(process.argv.slice(2));
  const policyCapId = await resolvePolicyCapId(args);
  assertObjectId('POLICY_CAP_ID', policyCapId);

  const privateKey = requiredEnv('PRIVATE_KEY');
  const adminPrivateKey = process.env.ADMIN_PRIVATE_KEY || privateKey;
  const packageId = requiredEnv('PACKAGE_ID');
  const freezeStateId = requiredEnv('FREEZE_STATE_ID');
  assertObjectId('PACKAGE_ID', packageId);
  assertObjectId('FREEZE_STATE_ID', freezeStateId);

  const { secretKey } = decodeSuiPrivateKey(privateKey);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  const { secretKey: adminSecretKey } = decodeSuiPrivateKey(adminPrivateKey);
  const adminSigner = Ed25519Keypair.fromSecretKey(adminSecretKey);

  // 1) Sign local policy bundle.
  writePolicySignatureFile({ generatedBy: 'clawall-setup-policy-once' });
  const { sha256 } = computePolicyBundleHash();

  // 2) Create/update on-chain anchor with temporary policy cap.
  const configuredAnchorId = String(process.env.POLICY_ANCHOR_ID ?? '').trim() || null;
  let anchorResult;
  try {
    anchorResult = await upsertPolicyAnchor({
      signer: adminSigner,
      policyCapId,
      policyHash: sha256,
      packageId,
      anchorId: configuredAnchorId,
    });
  } catch (err) {
    const msg = String(err?.message ?? err);
    const looksLikeAnchorTypeMismatch =
      configuredAnchorId &&
      msg.includes('TypeMismatch') &&
      (msg.includes('arg_idx: 1') || msg.includes('arg_idx:1'));

    if (!looksLikeAnchorTypeMismatch) throw err;

    console.warn(
      `[setup-policy-once] Existing POLICY_ANCHOR_ID appears incompatible with current package/type; minting a fresh anchor (old=${configuredAnchorId}).`
    );
    anchorResult = await upsertPolicyAnchor({
      signer: adminSigner,
      policyCapId,
      policyHash: sha256,
      packageId,
      anchorId: null,
    });
  }

  // 3) Verify anchor strict match with retry to handle RPC indexing lag.
  const verify = await verifyAnchorWithRetry({
    expectedSha256: sha256,
    anchorId: anchorResult.anchor_id,
    packageId,
  });

  // 4) Persist strict runtime config and clear POLICY_CAP_ID.
  let envContent = fs.readFileSync(ENV_FILE, 'utf8');
  envContent = setEnvValue(envContent, 'POLICY_BUNDLE_SHA256', sha256);
  envContent = setEnvValue(envContent, 'POLICY_ANCHOR_ID', anchorResult.anchor_id ?? '');
  envContent = setEnvValue(envContent, 'POLICY_INTEGRITY_MODE', 'strict');
  envContent = setEnvValue(envContent, 'POLICY_ANCHOR_MODE', 'strict');
  envContent = setEnvValue(envContent, 'ENFORCE_CAP_ISOLATION', '1');
  envContent = setEnvValue(envContent, 'POLICY_CAP_ID', '');
  envContent = setEnvValue(envContent, 'POLICY_CAP_ID_ONCE', '');
  fs.writeFileSync(ENV_FILE, envContent, 'utf8');

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        package_id: packageId,
        freeze_state_id: freezeStateId,
        policy_sha256: sha256,
        anchor_id: anchorResult.anchor_id,
        anchor_action: anchorResult.action,
        anchor_digest: anchorResult.digest,
        runtime_config_written: [
          'POLICY_BUNDLE_SHA256',
          'POLICY_ANCHOR_ID',
          'POLICY_INTEGRITY_MODE=strict',
          'POLICY_ANCHOR_MODE=strict',
          'ENFORCE_CAP_ISOLATION=1',
          'POLICY_CAP_ID=',
          'POLICY_CAP_ID_ONCE=',
        ],
      },
      null,
      2
    )
  );
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyAnchorWithRetry({
  expectedSha256,
  anchorId,
  packageId,
  attempts = 15,
  delayMs = 800,
} = {}) {
  let last = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await verifyPolicyAnchorIntegrity({
      expectedSha256,
      anchorId,
      packageId,
      mode: 'strict',
      force: true,
    });

    if (last.ok) return last;
    if (attempt >= attempts) break;

    const reason = String(last.reason ?? '').toLowerCase();
    const retryable =
      reason.includes('missing data') ||
      reason.includes('notexists') ||
      reason.includes('not exists') ||
      reason.includes('not indexed') ||
      reason.includes('hash mismatch') ||
      reason.includes('policy anchor hash mismatch') ||
      reason.includes('object read failed') ||
      reason.includes('failed to read') ||
      reason.includes('fetch failed') ||
      reason.includes('timed out') ||
      reason.includes('connection');

    if (!retryable) break;
    await sleep(delayMs * attempt);
  }

  throw new Error(
    `Anchor verification failed: ${last?.reason ?? 'unknown'} (anchor_id=${anchorId || 'n/a'})`
  );
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
