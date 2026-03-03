import {
  fetchTransferEventsShared,
  fetchTransactionShared,
  formatTransferAmountShared,
  parseEventCoinTypeShared,
} from './tx-log-shared.mjs';

const SUI_COIN_TYPE = '0x2::sui::SUI';
const FULL_COIN_TYPE_RE = /^0x[a-fA-F0-9]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

export function shortHexShared(value, head = 10, tail = 6) {
  if (typeof value !== 'string') return 'n/a';
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function formatTimestampShared(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function isFullCoinType(value) {
  return FULL_COIN_TYPE_RE.test(String(value || '').trim());
}

function extractCoinTypeFromEventType(eventType) {
  const raw = String(eventType || '').trim();
  if (!raw) return null;
  const m = raw.match(/<([^>]+)>/);
  if (!m) return null;
  const candidate = String(m[1] || '').trim();
  return isFullCoinType(candidate) ? candidate : null;
}

function parseUnitSymbol(coinType) {
  const raw = String(coinType || '').trim();
  if (!raw) return '';
  const parts = raw.split('::');
  return String(parts[2] || raw).trim().toUpperCase();
}

function absBigInt(value) {
  const n = BigInt(String(value || '0'));
  return n < 0n ? -n : n;
}

async function detectCoinTypeFromDigest({ digest, amountRaw, rpcUrl }) {
  const d = String(digest || '').trim();
  if (!d) return null;
  const tx = await fetchTransactionShared(d, { rpcUrl }).catch(() => null);
  const changes = Array.isArray(tx?.balanceChanges) ? tx.balanceChanges : [];
  if (!changes.length) return null;

  const target = String(amountRaw || '').trim();
  if (/^\d+$/.test(target)) {
    const targetAbs = absBigInt(target);
    const exact = changes.find((c) => {
      const ct = String(c?.coinType || '').trim();
      if (!isFullCoinType(ct)) return false;
      try {
        return absBigInt(c?.amount) === targetAbs;
      } catch {
        return false;
      }
    });
    if (exact?.coinType) return String(exact.coinType);
  }

  const firstWithType = changes.find((c) => isFullCoinType(c?.coinType));
  return firstWithType?.coinType ? String(firstWithType.coinType) : null;
}

export async function buildChainLogsView({
  limit = 5,
  packageId = process.env.PACKAGE_ID,
  rpcUrl = process.env.RPC_URL,
  full = false,
  symbolDecimals = {},
} = {}) {
  const events = await fetchTransferEventsShared({ limit, packageId, rpcUrl });
  if (!events.length) {
    return { count: 0, lines: [] };
  }

  const lines = [];
  for (const [i, e] of events.entries()) {
    const parsed = e?.parsedJson || {};
    let coinType =
      parseEventCoinTypeShared(parsed.coin_type) ||
      extractCoinTypeFromEventType(e?.type) ||
      SUI_COIN_TYPE;
    if (!isFullCoinType(coinType)) {
      const detected = await detectCoinTypeFromDigest({
        digest: e?.id?.txDigest,
        amountRaw: parsed.amount,
        rpcUrl,
      });
      if (detected) coinType = detected;
    }
    const symbolKey = parseUnitSymbol(coinType);
    const decimalFromMap = Number(symbolDecimals?.[symbolKey]);
    const prettyAmount = await formatTransferAmountShared({
      amountRaw: parsed.amount,
      coinType,
      fallbackDecimals:
        parsed.decimals ??
        parsed.coin_decimals ??
        (Number.isFinite(decimalFromMap) ? decimalFromMap : null) ??
        (coinType === SUI_COIN_TYPE ? 9 : null),
      rpcUrl,
      suiCoinType: SUI_COIN_TYPE,
    });
    const blobId = Array.isArray(parsed.audit_blob_id)
      ? Buffer.from(parsed.audit_blob_id).toString()
      : String(parsed.audit_blob_id || '');
    const digest = String(e?.id?.txDigest || 'n/a');
    const recipient = String(parsed.recipient || 'n/a');
    const blob = String(blobId || 'n/a');
    lines.push(
      `${i + 1}) digest=${full ? digest : shortHexShared(digest, 14, 10)} | amount=${prettyAmount} | recipient=${full ? recipient : shortHexShared(recipient, 12, 10)} | time=${formatTimestampShared(Number(parsed.timestamp_ms))} | blob=${full ? blob : shortHexShared(blob, 14, 10)}`
    );
  }

  return { count: lines.length, lines };
}
