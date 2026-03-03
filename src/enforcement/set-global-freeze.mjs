import 'dotenv/config';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
const FREEZE_TYPE_SUFFIX = '::enforcer::GlobalFreeze';
const MAX_REASON_BYTES = 256;

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (const part of argv) {
    if (!part.startsWith('--')) continue;
    const token = part.slice(2);
    const [key, value] = token.split('=');
    out[key] = typeof value === 'string' ? value : '1';
  }
  return out;
}

function parseBoolean(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function resolveFrozen(args) {
  if (Object.prototype.hasOwnProperty.call(args, 'freeze')) return true;
  if (Object.prototype.hasOwnProperty.call(args, 'unfreeze')) return false;

  if (Object.prototype.hasOwnProperty.call(args, 'frozen')) {
    const parsed = parseBoolean(args.frozen);
    if (parsed === null) throw new Error('--frozen must be one of: 1/0 true/false yes/no');
    return parsed;
  }

  throw new Error('missing action: use --freeze or --unfreeze');
}

function parseVectorU8(value) {
  if (Array.isArray(value)) {
    return value
      .map((v) => Number(v))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.bytes)) {
      return value.bytes
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 255);
    }
    if (typeof value.value === 'string') {
      try {
        return Array.from(Buffer.from(value.value, 'base64'));
      } catch {
        return [];
      }
    }
  }
  if (typeof value === 'string') {
    try {
      return Array.from(Buffer.from(value, 'base64'));
    } catch {
      return [];
    }
  }
  return [];
}

function decodeReason(rawField) {
  const bytes = parseVectorU8(rawField);
  if (!bytes.length) return '';
  return Buffer.from(bytes).toString('utf8');
}

async function readFreezeState({ client, freezeStateId, packageId }) {
  const object = await client.getObject({
    id: freezeStateId,
    options: {
      showType: true,
      showContent: true,
    },
  });

  const type = String(object?.data?.type ?? '');
  const expectedType = `${packageId}${FREEZE_TYPE_SUFFIX}`;
  if (!type.endsWith(FREEZE_TYPE_SUFFIX) || type !== expectedType) {
    throw new Error(`freeze object type mismatch: expected ${expectedType}, got ${type || 'unknown'}`);
  }

  const fields = object?.data?.content?.fields;
  if (!fields || typeof fields !== 'object') {
    throw new Error('freeze object fields missing');
  }

  return {
    freeze_id: freezeStateId,
    frozen: Boolean(fields.frozen),
    reason: decodeReason(fields.reason),
    updated_at_ms: Number(fields.updated_at_ms ?? 0) || null,
    updated_by: String(fields.updated_by ?? ''),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const frozen = resolveFrozen(args);
  const reasonInput = String(
    args.reason ??
      (frozen ? 'Manual emergency freeze' : 'Manual emergency unfreeze')
  );
  const reasonBytes = Buffer.from(reasonInput, 'utf8');
  if (reasonBytes.length > MAX_REASON_BYTES) {
    throw new Error(`reason too long (${reasonBytes.length} bytes, max=${MAX_REASON_BYTES})`);
  }

  const privateKey = requiredEnv('PRIVATE_KEY');
  const packageId = requiredEnv('PACKAGE_ID');
  const policyCapId = requiredEnv('POLICY_CAP_ID');
  const freezeStateId = requiredEnv('FREEZE_STATE_ID');

  const client = new SuiJsonRpcClient({ url: RPC_URL });
  const { secretKey } = decodeSuiPrivateKey(privateKey);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());
  tx.moveCall({
    target: `${packageId}::enforcer::set_global_freeze`,
    arguments: [
      tx.object(policyCapId),
      tx.object(freezeStateId),
      tx.pure.bool(frozen),
      tx.pure.vector('u8', Array.from(reasonBytes)),
      tx.object('0x6'),
    ],
  });

  const { bytes, signature } = await tx.sign({ client, signer });
  const result = await client.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });

  if (result?.effects?.status?.status !== 'success') {
    throw new Error(`freeze tx failed: ${JSON.stringify(result?.effects?.status ?? {})}`);
  }

  const state = await readFreezeState({ client, freezeStateId, packageId });

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        action: frozen ? 'freeze' : 'unfreeze',
        digest: result.digest,
        ...state,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
