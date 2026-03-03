import fs from 'node:fs';

function uniqueNonEmpty(values = []) {
  const out = [];
  const seen = new Set();
  for (const v of values) {
    const s = String(v || '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

export function readSecurityEventsShared({
  filePath = 'src/state/security-events.log',
  limit = 200,
  predicate = null,
  newestFirst = false,
} = {}) {
  let lines = [];
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }

  const max = Math.max(1, Math.min(Number(limit) || 200, 5000));
  const events = [];

  if (newestFirst) {
    for (let i = lines.length - 1; i >= 0 && events.length < max; i -= 1) {
      try {
        const event = JSON.parse(lines[i]);
        if (!predicate || predicate(event)) events.push(event);
      } catch {
        // ignore malformed row
      }
    }
    return events;
  }

  const start = Math.max(0, lines.length - max);
  for (let i = start; i < lines.length; i += 1) {
    try {
      const event = JSON.parse(lines[i]);
      if (!predicate || predicate(event)) events.push(event);
    } catch {
      // ignore malformed row
    }
  }
  return events;
}

export async function rpcCallShared(method, params, { rpcUrl } = {}) {
  const urls = uniqueNonEmpty([
    rpcUrl,
    process.env.RPC_URL,
    'https://rpc.testnet.sui.io:443',
    'https://fullnode.testnet.sui.io:443',
  ]);
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(12_000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`http ${res.status}`);
      if (json?.error) throw new Error(json.error?.message || 'rpc error');
      return json?.result ?? null;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`rpc ${method} failed: ${lastErr?.message || 'unknown error'}`);
}

export async function fetchTransferEventsShared({
  limit = 10,
  packageId = process.env.PACKAGE_ID,
  rpcUrl = process.env.RPC_URL,
} = {}) {
  const pkg = String(packageId || '').trim();
  if (!pkg) return [];
  const n = Math.max(1, Math.min(Number(limit) || 10, 100));
  const result = await rpcCallShared(
    'suix_queryEvents',
    [{ MoveEventType: `${pkg}::enforcer::TransferExecuted` }, null, n, true],
    { rpcUrl }
  );
  return Array.isArray(result?.data) ? result.data : [];
}

export async function fetchTransactionShared(digest, { rpcUrl = process.env.RPC_URL } = {}) {
  const d = String(digest || '').trim();
  if (!d) return null;
  return rpcCallShared(
    'sui_getTransactionBlock',
    [
      d,
      {
        showEffects: true,
        showEvents: true,
        showBalanceChanges: true,
        showInput: true,
      },
    ],
    { rpcUrl }
  );
}

function sanitizeCoinTypeString(raw) {
  let s = String(raw || '').replace(/\u0000/g, '').trim();
  if (!s) return '';
  const parts = s.split('::');
  if (parts.length === 3) {
    const addrRaw = parts[0].trim();
    if (addrRaw && !addrRaw.startsWith('0x') && /^[a-fA-F0-9]+$/.test(addrRaw)) {
      parts[0] = `0x${addrRaw}`;
      s = parts.join('::');
    }
  }
  return s;
}

export function parseEventCoinTypeShared(rawCoinType) {
  if (typeof rawCoinType === 'string') return sanitizeCoinTypeString(rawCoinType) || null;
  if (Array.isArray(rawCoinType)) return sanitizeCoinTypeString(Buffer.from(rawCoinType).toString()) || null;
  return null;
}

function trimTrailingZeros(value) {
  return String(value).replace(/\.?0+$/, '');
}

function toDecimalString(amountRaw, decimals) {
  const amount = BigInt(String(amountRaw ?? '0'));
  const places = Number(decimals);
  if (!Number.isFinite(places) || places < 0) return String(amount);
  if (places === 0) return String(amount);
  const base = 10n ** BigInt(places);
  const whole = amount / base;
  const frac = String(amount % base).padStart(places, '0');
  return trimTrailingZeros(`${whole}.${frac}`);
}

function parseUnitCoinType(coinType) {
  const raw = String(coinType || '').trim();
  if (!raw) return null;
  const parts = raw.split('::');
  return parts[2] || null;
}

const coinMetaCacheShared = new Map();

function isSuiCoinType(coinType) {
  const raw = String(coinType || '').trim();
  if (!raw) return false;
  const parts = sanitizeCoinTypeString(raw).split('::');
  if (parts.length !== 3) return false;
  const addr = parts[0].toLowerCase();
  const mod = parts[1].toLowerCase();
  const name = parts[2].toLowerCase();
  if (mod === 'sui' && name === 'sui') {
    if (!addr || addr === '0x' || /^[a-f0-9]+$/i.test(addr.replace(/^0x/, ''))) {
      return true;
    }
  }
  return false;
}

async function fetchCoinMetadataShared(coinType, { rpcUrl = process.env.RPC_URL } = {}) {
  const normalized = String(coinType || '').trim();
  if (!normalized) return null;
  if (coinMetaCacheShared.has(normalized)) return coinMetaCacheShared.get(normalized);
  const meta = await rpcCallShared('suix_getCoinMetadata', [normalized], { rpcUrl }).catch(() => null);
  // Cache only successful metadata; do not pin transient RPC failures.
  if (meta) coinMetaCacheShared.set(normalized, meta);
  return meta || null;
}

export async function formatTransferAmountShared({
  amountRaw,
  coinType,
  fallbackDecimals = null,
  rpcUrl = process.env.RPC_URL,
  suiCoinType = '0x2::sui::SUI',
} = {}) {
  const normalizedType = sanitizeCoinTypeString(coinType) || suiCoinType;
  const fallbackSymbol = parseUnitCoinType(normalizedType) || (normalizedType === suiCoinType ? 'SUI' : 'COIN');
  let decimals = Number(fallbackDecimals);
  let symbol = fallbackSymbol.toUpperCase();
  if (!Number.isFinite(decimals)) {
    const meta = await fetchCoinMetadataShared(normalizedType, { rpcUrl });
    if (meta) {
      decimals = Number(meta.decimals);
      symbol = String(meta.symbol || symbol).toUpperCase();
    }
  }

  if (!Number.isFinite(decimals) && isSuiCoinType(normalizedType)) {
    decimals = 9;
    symbol = 'SUI';
  }

  if (!Number.isFinite(decimals) || decimals < 0 || decimals > 18) {
    return `${String(amountRaw ?? '0')} ${symbol}`;
  }
  return `${toDecimalString(amountRaw, decimals)} ${symbol}`;
}
