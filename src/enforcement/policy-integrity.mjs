import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const POLICY_FILES = Object.freeze([
  'src/orchestrator/intent-orchestrator.mjs',
  'src/chain/sui-transaction-gateway.mjs',
  'src/state/kill-switch.mjs',
  'src/enforcement/intent-firewall.mjs',
  'src/enforcement/os-policy.mjs',
  'src/enforcement/fs-policy.mjs',
  'src/enforcement/browser-policy.mjs',
  'src/enforcement/script-policy.mjs',
  'src/enforcement/policy-anchor.mjs',
  'src/enforcement/prompt-quarantine.mjs',
  'src/enforcement/provenance.mjs',
  'src/enforcement/policy-integrity.mjs',
  'src/risk/policy.mjs',
  'src/governance/approval.mjs',
]);

const SIGNATURE_FILE = 'src/enforcement/policy-signature.json';
const GLOBAL_KEY = Symbol.for('clawall.policy_integrity.cache');

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function readFileBytes(absPath) {
  return fs.readFileSync(absPath);
}

export function computePolicyBundleHash({
  files = POLICY_FILES,
  baseDir = process.cwd(),
} = {}) {
  const lines = [];
  for (const relative of files) {
    const absPath = path.resolve(baseDir, relative);
    const bytes = readFileBytes(absPath);
    const fileHash = sha256Hex(bytes);
    lines.push(`${relative}:${fileHash}`);
  }

  const manifest = lines.sort().join('\n');
  const sha256 = sha256Hex(manifest);
  return { sha256, manifest, files: [...files] };
}

function loadSignatureFromFile(baseDir = process.cwd()) {
  const absPath = path.resolve(baseDir, SIGNATURE_FILE);
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const json = JSON.parse(raw);
    const sha256 = String(json?.sha256 ?? '').trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) return null;
    return {
      sha256,
      source: SIGNATURE_FILE,
    };
  } catch {
    return null;
  }
}

function loadHashFromEnvFile(baseDir = process.cwd()) {
  const absPath = path.resolve(baseDir, '.env');
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      if (key !== 'POLICY_BUNDLE_SHA256') continue;
      const value = trimmed.slice(idx + 1).trim().toLowerCase();
      if (/^[a-f0-9]{64}$/.test(value)) {
        return { sha256: value, source: '.env:POLICY_BUNDLE_SHA256' };
      }
      break;
    }
    return null;
  } catch {
    return null;
  }
}

function loadExpectedSignature(baseDir = process.cwd()) {
  const fromEnv = String(process.env.POLICY_BUNDLE_SHA256 ?? '')
    .trim()
    .toLowerCase();

  const fromProcessEnv = /^[a-f0-9]{64}$/.test(fromEnv)
    ? { sha256: fromEnv, source: 'env:POLICY_BUNDLE_SHA256' }
    : null;
  const fromEnvFile = loadHashFromEnvFile(baseDir);
  const sourceMode = String(process.env.POLICY_BUNDLE_SHA256_SOURCE ?? 'auto')
    .trim()
    .toLowerCase();

  if (sourceMode === 'process') {
    return fromProcessEnv ?? fromEnvFile ?? loadSignatureFromFile(baseDir);
  }
  if (sourceMode === 'envfile') {
    return fromEnvFile ?? fromProcessEnv ?? loadSignatureFromFile(baseDir);
  }

  if (
    fromEnvFile &&
    fromProcessEnv &&
    fromEnvFile.sha256 !== fromProcessEnv.sha256
  ) {
    return fromEnvFile;
  }
  return fromProcessEnv ?? fromEnvFile ?? loadSignatureFromFile(baseDir);
}

function shouldEnforce(expected) {
  const mode = String(process.env.POLICY_INTEGRITY_MODE ?? 'off').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'strict') return true;
  return Boolean(expected?.sha256);
}

export function verifyPolicyBundleIntegrity({ force = false } = {}) {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      verified: false,
      result: null,
    };
  }

  const cache = globalThis[GLOBAL_KEY];
  if (!force && cache.verified && cache.result) {
    return cache.result;
  }

  const expected = loadExpectedSignature();
  const computed = computePolicyBundleHash();
  const enforce = shouldEnforce(expected);
  const ok = !enforce || (expected && expected.sha256 === computed.sha256);

  const result = {
    ok,
    enforce,
    expected_sha256: expected?.sha256 ?? null,
    expected_source: expected?.source ?? null,
    computed_sha256: computed.sha256,
    file_count: computed.files.length,
  };

  cache.verified = true;
  cache.result = result;
  return result;
}

export function assertPolicyBundleIntegrity() {
  const result = verifyPolicyBundleIntegrity();
  if (!result.ok) {
    throw new Error(
      `Policy integrity check failed (expected=${result.expected_sha256}, got=${result.computed_sha256})`
    );
  }
  return result;
}

export function writePolicySignatureFile({
  outputFile = SIGNATURE_FILE,
  generatedBy = 'clawall-policy-signer',
} = {}) {
  const computed = computePolicyBundleHash();
  const payload = {
    schema: 'clawall/policy-signature-v1',
    sha256: computed.sha256,
    generated_at: new Date().toISOString(),
    generated_by: generatedBy,
    files: computed.files,
  };
  const absPath = path.resolve(process.cwd(), outputFile);
  fs.writeFileSync(absPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}
