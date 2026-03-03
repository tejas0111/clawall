import 'dotenv/config';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { logSecurityEvent } from '../observability/security-events.mjs';

const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
const PACKAGE_ID = process.env.PACKAGE_ID;
const DEFAULT_ANCHOR_ID = process.env.POLICY_ANCHOR_ID ?? '';
const DEFAULT_MODE = String(process.env.POLICY_ANCHOR_MODE ?? 'auto').trim().toLowerCase();
const CACHE_TTL_MS = Number.isFinite(Number(process.env.POLICY_ANCHOR_CACHE_MS))
  ? Math.max(5_000, Number(process.env.POLICY_ANCHOR_CACHE_MS))
  : 60_000;
const GLOBAL_KEY = Symbol.for('clawall.policy_anchor.cache');
const ANCHOR_TYPE_SUFFIX = '::enforcer::PolicyAnchor';

function normalizeHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) return null;
  return hash;
}

function normalizeMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (mode === 'off' || mode === 'auto' || mode === 'strict') return mode;
  return 'auto';
}

function shouldEnforce(mode, anchorId) {
  if (mode === 'off') return false;
  if (mode === 'strict') return true;
  return Boolean(anchorId);
}

function buildClient() {
  return new SuiJsonRpcClient({ url: RPC_URL });
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
    const direct = normalizeHash(value);
    if (direct) return Array.from(Buffer.from(direct, 'utf8'));
    try {
      const decoded = Buffer.from(value, 'base64');
      if (decoded.length > 0) return Array.from(decoded);
    } catch {
      // Ignore parse errors.
    }
  }

  return [];
}

function decodeAnchorHash(rawField) {
  const bytes = parseVectorU8(rawField);
  if (!bytes.length) return null;
  const text = Buffer.from(bytes).toString('utf8');
  return normalizeHash(text);
}

function cacheKey(anchorId, expectedSha256) {
  return `${anchorId || 'none'}:${expectedSha256 || 'none'}`;
}

function getCache() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = new Map();
  }
  return globalThis[GLOBAL_KEY];
}

async function fetchAnchorObject({
  client,
  anchorId,
} = {}) {
  const resolvedClient = client ?? buildClient();
  return resolvedClient.getObject({
    id: anchorId,
    options: {
      showType: true,
      showContent: true,
    },
  });
}

function parseAnchorFromObject(obj, packageId = PACKAGE_ID) {
  const objectError = obj?.error;
  if (objectError) {
    throw new Error(
      `Policy anchor object read failed: ${JSON.stringify(objectError)}`
    );
  }

  const data = obj?.data;
  const type = String(data?.type ?? '');
  const expectedType =
    packageId && packageId.startsWith('0x')
      ? `${packageId}${ANCHOR_TYPE_SUFFIX}`
      : null;

  if (!data) {
    throw new Error('Policy anchor object missing data (possibly not indexed yet)');
  }

  if (!type || !type.includes(ANCHOR_TYPE_SUFFIX)) {
    throw new Error(`Policy anchor object type mismatch: ${type || 'unknown'}`);
  }

  if (expectedType && type !== expectedType) {
    throw new Error(`Policy anchor package mismatch: expected ${expectedType}, got ${type}`);
  }

  const fields = data?.content?.fields;
  if (!fields || typeof fields !== 'object') {
    throw new Error('Policy anchor object missing fields');
  }

  const hash = decodeAnchorHash(fields.current_hash);
  if (!hash) {
    throw new Error('Policy anchor hash missing or invalid');
  }

  return {
    hash,
    updated_at_ms: Number(fields.updated_at_ms ?? 0) || null,
    updated_by: String(fields.updated_by ?? ''),
    type,
  };
}

export async function readPolicyAnchorHash({
  client = null,
  anchorId = DEFAULT_ANCHOR_ID,
  packageId = PACKAGE_ID,
} = {}) {
  const id = String(anchorId ?? '').trim();
  if (!id) {
    throw new Error('POLICY_ANCHOR_ID not configured');
  }

  const object = await fetchAnchorObject({ client, anchorId: id });
  const parsed = parseAnchorFromObject(object, packageId);
  return {
    anchor_id: id,
    ...parsed,
  };
}

export async function verifyPolicyAnchorIntegrity({
  expectedSha256,
  anchorId = DEFAULT_ANCHOR_ID,
  packageId = PACKAGE_ID,
  mode = DEFAULT_MODE,
  force = false,
  client = null,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  const expected = normalizeHash(expectedSha256);
  const id = String(anchorId ?? '').trim();
  const enforce = shouldEnforce(normalizedMode, id);

  if (!expected) {
    return {
      ok: false,
      enforce,
      mode: normalizedMode,
      anchor_id: id || null,
      expected_sha256: null,
      onchain_sha256: null,
      reason: 'Expected policy hash missing or invalid',
    };
  }

  if (!enforce) {
    return {
      ok: true,
      enforce: false,
      mode: normalizedMode,
      anchor_id: id || null,
      expected_sha256: expected,
      onchain_sha256: null,
      reason: 'Policy anchor enforcement disabled',
    };
  }

  if (!id) {
    return {
      ok: false,
      enforce: true,
      mode: normalizedMode,
      anchor_id: null,
      expected_sha256: expected,
      onchain_sha256: null,
      reason: 'POLICY_ANCHOR_ID missing while enforcement is active',
    };
  }

  const key = cacheKey(id, expected);
  const cache = getCache();
  const cached = cache.get(key);
  if (!force && cached && Date.now() - cached.ts <= CACHE_TTL_MS) {
    return cached.result;
  }

  try {
    const resolvedClient = client ?? buildClient();
    const anchor = await readPolicyAnchorHash({
      client: resolvedClient,
      anchorId: id,
      packageId,
    });
    const ok = anchor.hash === expected;

    const result = {
      ok,
      enforce: true,
      mode: normalizedMode,
      anchor_id: id,
      expected_sha256: expected,
      onchain_sha256: anchor.hash,
      updated_at_ms: anchor.updated_at_ms ?? null,
      updated_by: anchor.updated_by ?? null,
      reason: ok ? 'Policy anchor hash matched' : 'Policy anchor hash mismatch',
    };

    cache.set(key, { ts: Date.now(), result });
    return result;
  } catch (err) {
    const result = {
      ok: false,
      enforce: true,
      mode: normalizedMode,
      anchor_id: id,
      expected_sha256: expected,
      onchain_sha256: null,
      reason: err?.message ?? 'Failed to read policy anchor',
    };
    cache.set(key, { ts: Date.now(), result });
    return result;
  }
}

export async function assertPolicyAnchorIntegrity({
  expectedSha256,
  anchorId = DEFAULT_ANCHOR_ID,
  packageId = PACKAGE_ID,
  mode = DEFAULT_MODE,
  force = false,
  client = null,
} = {}) {
  const result = await verifyPolicyAnchorIntegrity({
    expectedSha256,
    anchorId,
    packageId,
    mode,
    force,
    client,
  });
  if (!result.ok) {
    throw new Error(
      `Policy anchor check failed (${result.reason}; expected=${result.expected_sha256}; onchain=${result.onchain_sha256 ?? 'n/a'})`
    );
  }
  return result;
}

function encodeHashVector(policyHash) {
  const normalized = normalizeHash(policyHash);
  if (!normalized) {
    throw new Error('policyHash must be a 64-char lowercase hex string');
  }
  return Array.from(Buffer.from(normalized, 'utf8'));
}

function parseCreatedPolicyAnchorId(result, packageId = PACKAGE_ID) {
  const expectedSuffix =
    packageId && packageId.startsWith('0x')
      ? `${packageId}${ANCHOR_TYPE_SUFFIX}`
      : ANCHOR_TYPE_SUFFIX;
  const changes = Array.isArray(result?.objectChanges) ? result.objectChanges : [];

  const created = changes.find(
    (change) =>
      change?.type === 'created' &&
      typeof change?.objectType === 'string' &&
      change.objectType.endsWith(ANCHOR_TYPE_SUFFIX) &&
      (expectedSuffix === ANCHOR_TYPE_SUFFIX || change.objectType === expectedSuffix)
  );
  return created?.objectId ?? null;
}

export async function upsertPolicyAnchor({
  signer,
  policyCapId,
  policyHash,
  anchorId = DEFAULT_ANCHOR_ID,
  packageId = PACKAGE_ID,
  client = null,
} = {}) {
  if (!packageId || !String(packageId).startsWith('0x')) {
    throw new Error('PACKAGE_ID missing or invalid');
  }
  if (!policyCapId || !String(policyCapId).startsWith('0x')) {
    throw new Error('POLICY_CAP_ID missing or invalid');
  }
  if (!signer || typeof signer.toSuiAddress !== 'function') {
    throw new Error('signer with toSuiAddress() is required');
  }

  const resolvedClient = client ?? buildClient();
  const hashVec = encodeHashVector(policyHash);
  const sender = signer.toSuiAddress();
  const id = String(anchorId ?? '').trim();
  const tx = new Transaction();
  tx.setSender(sender);

  if (id) {
    tx.moveCall({
      target: `${packageId}::enforcer::set_policy_hash`,
      arguments: [
        tx.object(policyCapId),
        tx.object(id),
        tx.pure.vector('u8', hashVec),
        tx.object('0x6'),
      ],
    });
  } else {
    tx.moveCall({
      target: `${packageId}::enforcer::mint_policy_anchor`,
      arguments: [
        tx.object(policyCapId),
        tx.pure.vector('u8', hashVec),
        tx.object('0x6'),
      ],
    });
  }

  const { bytes, signature } = await tx.sign({ client: resolvedClient, signer });
  const result = await resolvedClient.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: {
      showEffects: true,
      showObjectChanges: true,
      showEvents: true,
    },
  });

  if (result?.effects?.status?.status !== 'success') {
    throw new Error(
      `policy anchor tx failed: ${JSON.stringify(result?.effects?.status ?? {})}`
    );
  }

  const resolvedAnchorId = id || parseCreatedPolicyAnchorId(result, packageId);
  const payload = {
    digest: result.digest,
    anchor_id: resolvedAnchorId ?? null,
    action: id ? 'updated' : 'created',
    policy_sha256: normalizeHash(policyHash),
    signer: sender,
  };
  logSecurityEvent('policy_anchor.updated', payload);
  return payload;
}
