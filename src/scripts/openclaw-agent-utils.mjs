import './runtime-env.mjs';
import { spawnSync } from 'node:child_process';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const CLI_GATEWAY_COMMAND = 'clawall';

const KEY_ALIASES = Object.freeze({
  to: 'recipient',
  recipient: 'recipient',
  amount: 'amount',
  unit: 'unit',
  'coin-type': 'coin-type',
  coin_type: 'coin-type',
  cointype: 'coin-type',
  'coin-object-id': 'coin-object-id',
  coin_object_id: 'coin-object-id',
  coinobjectid: 'coin-object-id',
});

const VALUE_NORMALIZERS = Object.freeze({
  unit: (value) => String(value ?? '').toLowerCase(),
});

function normalizeKey(key) {
  if (!key) return null;
  const cleaned = key.trim().toLowerCase().replace(/_/g, '-');
  return KEY_ALIASES[cleaned] || cleaned;
}

function normalizeValue(key, value) {
  if (!key) return String(value ?? '');
  const normalizer = VALUE_NORMALIZERS[key];
  if (!normalizer) return String(value ?? '');
  return normalizer(value);
}

function pushOption(normalized, key, value) {
  if (!key) return;
  normalized.push(`--${key}`);
  if (value !== undefined && value !== null && value !== '') {
    normalized.push(normalizeValue(key, value));
  }
}

export function normalizeAgentArgs(argv = []) {
  const normalized = [];
  for (let i = 0; i < argv.length; ++i) {
    const raw = argv[i];
    if (raw === '--') {
      normalized.push(raw);
      continue;
    }

    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      const keyPart = eq >= 0 ? raw.slice(2, eq) : raw.slice(2);
      const normalizedKey = normalizeKey(keyPart);
      if (eq >= 0) {
        const valuePart = raw.slice(eq + 1);
        pushOption(normalized, normalizedKey, valuePart);
        continue;
      }

      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        pushOption(normalized, normalizedKey, next);
        ++i;
      } else {
        pushOption(normalized, normalizedKey);
      }
      continue;
    }

    if (raw.includes('=')) {
      const [keyPart, valuePart] = raw.split('=');
      const normalizedKey = normalizeKey(keyPart);
      if (normalizedKey) {
        pushOption(normalized, normalizedKey, valuePart);
        continue;
      }
    }

    normalized.push(raw);
  }
  return normalized;
}

export function runOpenClawCommand(subcommand, args = []) {
  const command = OPENCLAW_BIN;
  const cliArgs = [CLI_GATEWAY_COMMAND, subcommand, ...args];
  const result = spawnSync(command, cliArgs, { stdio: 'inherit' });
  if (result.error) {
    const msg = result.error?.message ?? String(result.error);
    throw new Error(`failed to execute "${command} ${cliArgs.join(' ')}": ${msg}`);
  }
  return result.status ?? 1;
}
