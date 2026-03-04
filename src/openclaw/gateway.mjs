import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { processIntent } from '../orchestrator/intent-orchestrator.mjs';
import { status as killSwitchStatus } from '../state/kill-switch.mjs';
import { getDemoExecutionContext } from '../demos/demo-context.mjs';
import { startTelegramBot } from '../governance/telegram-bot.mjs';
import { client as suiClient } from '../chain/sui-transaction-gateway.mjs';
import {
  computeTransferPricing,
  fetchCoinDecimals,
  fetchCoinSymbol,
  fetchCoinUsdPrice,
} from '../risk/market-data.mjs';
import { readSecurityEventsShared, rpcCallShared } from '../shared/tx-log-shared.mjs';
import { buildChainLogsView } from '../shared/tx-log-view.mjs';

const DEFAULT_PORT = 3015;
const DEFAULT_HOST = '127.0.0.1';
const SUI_COIN_TYPE = '0x2::sui::SUI';
const SUI_COIN_TYPE_RE = /^0x[a-fA-F0-9]+::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$/;

const PLUGIN_KEY = String(
  process.env.CLAWALL_PLUGIN_KEY || process.env.OPENCLAW_PLUGIN_KEY || ''
).trim();
const ENFORCE_PLUGIN_GATE = String(process.env.CLAWALL_ENFORCE_PLUGIN_GATE || '1').trim() !== '0';

function isTransientNetworkError(err) {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  const code = String(err?.code ?? err?.cause?.code ?? '').toUpperCase();
  if (!msg && !code) return false;
  return (
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    msg.includes('fetch failed') ||
    msg.includes('getaddrinfo') ||
    msg.includes('network') ||
    msg.includes('timed out')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRpcRetry(fn, label = 'rpc_call', attempts = 4) {
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientNetworkError(err) || i === attempts) break;
      const waitMs = Math.min(250 * i, 1000);
      console.warn(`[clawall-gateway] transient RPC error on ${label}, retry ${i}/${attempts}: ${err?.message ?? err}`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

function installGlobalCrashGuards() {
  process.on('unhandledRejection', (reason) => {
    if (isTransientNetworkError(reason)) {
      console.warn('[clawall-gateway] transient unhandled rejection:', reason?.message ?? reason);
      return;
    }
    console.error('[clawall-gateway] unhandled rejection:', reason?.message ?? reason);
  });

  process.on('uncaughtException', (err) => {
    if (isTransientNetworkError(err)) {
      console.warn('[clawall-gateway] transient uncaught exception:', err?.message ?? err);
      return;
    }
    console.error('[clawall-gateway] uncaught exception:', err?.message ?? err);
  });
}

function parseArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    const [k, v] = raw.split('=');
    options[k] = v ?? '1';
  }
  return options;
}

function toPort(value, fallback = DEFAULT_PORT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(65535, Math.floor(n)));
}

function parseTransferAmountStrict(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error('invalid transfer amount: must be numeric');
  }
  if (n <= 0) {
    throw new Error('invalid transfer amount: must be > 0');
  }
  if (!Number.isSafeInteger(Math.floor(n))) {
    throw new Error('invalid transfer amount: exceeds safe integer range');
  }
  return Math.floor(n);
}

function parseRecipientStrict(value) {
  const recipient = String(value || '').trim();
  if (!recipient) {
    throw new Error('invalid recipient: missing');
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(recipient)) {
    throw new Error('invalid recipient: expected 0x + 64 hex chars');
  }
  return recipient;
}

function parseCoinTypeStrict(value) {
  const coinType = String(value || SUI_COIN_TYPE).trim();
  if (!SUI_COIN_TYPE_RE.test(coinType)) {
    throw new Error('invalid coin_type: expected 0x...::module::struct');
  }
  return coinType;
}

function parseCoinObjectIdOptional(value, coinType) {
  const coinObjectId = String(value || '').trim();
  if (!coinObjectId) return null; // Always optional in Vault mode
  if (!/^0x[a-fA-F0-9]+$/.test(coinObjectId)) {
    throw new Error('invalid coin_object_id: expected 0x-prefixed object id');
  }
  return coinObjectId;
}

function parseAmountOptional(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || !Number.isSafeInteger(Math.floor(n))) {
    throw new Error('invalid amount: must be positive safe integer base units');
  }
  return Math.floor(n);
}

function toFixedString(rawValue, decimals = 9) {
  const value = String(rawValue ?? '0');
  const negative = value.startsWith('-');
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals);
  const frac = padded.slice(-decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function normalizeTxRecord(event = {}, idx = 0) {
  const nestedTxDigest = event?.id?.txDigest || event?.tx?.digest || null;
  const nestedProposal = event?.data?.proposal_id || event?.data?.intent_id || null;
  const nestedWalrus = event?.data?.walrus_blob_id || event?.data?.walrusBlobId || null;
  const recordId =
    event.digest ||
    event.txDigest ||
    nestedTxDigest ||
    event.proposal_id ||
    nestedProposal ||
    event.intent_id ||
    `${event.ts || Date.now()}-${idx}`;

  const status = event.decision ||
    (event.event_type === 'sdk.tx_success' ? 'EXECUTED' :
      event.event_type === 'sdk.tx_failure' ? 'FAILED' :
      event.event_type === 'sdk.tx_submitted' ? 'SUBMITTED' : 'UNKNOWN');

  return {
    id: String(recordId),
    ts: event.ts || null,
    event_type: event.event_type || null,
    domain: event.domain || null,
    status,
    layer: event.layer || null,
    reason: event.reason || event.error || null,
    proposal_id: event.proposal_id || nestedProposal || event.intent_id || null,
    digest: event.digest || event.txDigest || nestedTxDigest || null,
    walrus_blob_id: event.walrus_blob_id || event.walrusBlobId || nestedWalrus || null,
    risk_level: event.risk_level || null,
    risk_score: event.risk_score ?? null,
  };
}

function isClawallPackageTx(tx) {
  const pkg = String(PACKAGE_ID || '').toLowerCase();
  if (!pkg) return true;
  const txBody = tx?.transaction?.data?.transaction;
  if (!txBody || txBody.kind !== 'ProgrammableTransaction') return false;
  const commands = Array.isArray(txBody.transactions) ? txBody.transactions : [];
  for (const cmd of commands) {
    const move = cmd?.MoveCall || cmd?.moveCall || null;
    const movePkg = String(move?.package || '').toLowerCase();
    if (movePkg && movePkg === pkg) return true;
  }
  return false;
}

async function fetchOnChainTxHistory(limit = 20) {
  const want = Math.max(1, Math.min(Number(limit) || 20, 100));
  const { signer } = getDemoExecutionContext();
  const owner = signer.toSuiAddress();
  const resp = await withRpcRetry(
    () =>
      rpcCallShared('suix_queryTransactionBlocks', [
        { filter: { FromAddress: owner }, options: { showInput: true, showEffects: true } },
        null,
        Math.min(want * 4, 120),
        true,
      ], { rpcUrl: process.env.RPC_URL }),
    'suix_queryTransactionBlocks(tx-history-chain)'
  );
  const txs = Array.isArray(resp?.data) ? resp.data : [];
  const packageFiltered = txs.filter((tx) => isClawallPackageTx(tx));
  const selected = (packageFiltered.length > 0 ? packageFiltered : txs).slice(0, want);
  return selected.map((tx, i) => {
    const statusRaw = String(tx?.effects?.status?.status || '').toLowerCase();
    const status = statusRaw === 'success' ? 'EXECUTED' : 'FAILED';
    const tsNum = Number(tx?.timestampMs || 0);
    return {
      id: String(tx?.digest || `chain-${i}`),
      ts: Number.isFinite(tsNum) && tsNum > 0 ? new Date(tsNum).toISOString() : null,
      event_type: 'chain.tx',
      domain: 'BLOCKCHAIN',
      status,
      layer: 'CHAIN',
      reason: tx?.effects?.status?.error || null,
      proposal_id: null,
      digest: tx?.digest || null,
      walrus_blob_id: null,
      risk_level: null,
      risk_score: null,
    };
  });
}

async function fetchOnChainEventHistory(limit = 20) {
  const want = Math.max(1, Math.min(Number(limit) || 20, 100));
  const pkg = String(PACKAGE_ID || '').trim();
  if (!pkg) return [];
  const moveEventType = `${pkg}::enforcer::TransferExecuted`;
  const resp = await withRpcRetry(
    () => rpcCallShared('suix_queryEvents', [{ MoveEventType: moveEventType }, null, want, true], { rpcUrl: process.env.RPC_URL }),
    'suix_queryEvents(tx-history-transfer-executed)'
  );
  const data = Array.isArray(resp?.data) ? resp.data : [];
  return data.slice(0, want).map((evt, i) => {
    const parsed = evt?.parsedJson || {};
    const tsMs = Number(parsed?.timestamp_ms || evt?.timestampMs || 0);
    const coinTypeRaw = parsed?.coin_type;
    const coinType = Array.isArray(coinTypeRaw)
      ? Buffer.from(coinTypeRaw).toString()
      : String(coinTypeRaw || '');
    return {
      id: String(evt?.id?.txDigest || `event-${i}`),
      ts: Number.isFinite(tsMs) && tsMs > 0 ? new Date(tsMs).toISOString() : null,
      event_type: 'chain.transfer_executed',
      domain: 'BLOCKCHAIN',
      status: 'EXECUTED',
      layer: 'CHAIN',
      reason: null,
      proposal_id: null,
      digest: evt?.id?.txDigest || null,
      walrus_blob_id: Array.isArray(parsed?.audit_blob_id)
        ? Buffer.from(parsed.audit_blob_id).toString()
        : (parsed?.audit_blob_id || null),
      risk_level: null,
      risk_score: null,
      amount: parsed?.amount ? String(parsed.amount) : null,
      coin_type: coinType || null,
      recipient: parsed?.recipient ? String(parsed.recipient) : null,
    };
  });
}

async function buildTxHistory(limit = 20) {
  const events = readSecurityEventsShared({ limit: 1000 });
  const txEvents = events.filter((e) =>
    (e.domain === 'BLOCKCHAIN' && e.event_type === 'brain.decision') ||
    e.event_type === 'sdk.tx_success' ||
    e.event_type === 'sdk.tx_failure' ||
    e.event_type === 'sdk.tx_submitted' ||
    e.event_type === 'governance.approval_requested' ||
    e.event_type === 'governance.approval_resolved'
  );
  const normalized = txEvents.map((e, i) => normalizeTxRecord(e, i));
  let capped = normalized.slice(-Math.max(1, Math.min(Number(limit) || 20, 100))).reverse();
  const { signer } = getDemoExecutionContext();
  const owner = signer.toSuiAddress();

  // 1) Prefer package TransferExecuted events (same source as Telegram /chainlogs).
  try {
    const eventItems = await fetchOnChainEventHistory(limit);
    if (eventItems.length > 0) {
      return {
        ok: true,
        count: eventItems.length,
        items: eventItems,
        note: `Showing on-chain TransferExecuted history for package ${String(PACKAGE_ID || '').slice(0, 12)}...`,
        now: new Date().toISOString(),
      };
    }
  } catch {
    // Fall through to sender-based chain history.
  }

  // 2) Prefer on-chain history for the current agent signer so output is wallet-scoped and digest-rich.
  try {
    const chainItems = await fetchOnChainTxHistory(limit);
    if (chainItems.length > 0) {
      return {
        ok: true,
        count: chainItems.length,
        items: chainItems,
        note: `Showing on-chain history for current agent address ${owner}.`,
        now: new Date().toISOString(),
      };
    }
  } catch {
    // Fall back to local logs if chain query is unavailable.
  }

  // If recent local tx logs are legacy rows without digest, fallback to chain history by agent address.
  const missingDigestCount = capped.filter((r) => !r.digest).length;
  if (capped.length > 0 && missingDigestCount === capped.length) {
    try {
      const chainItems = await fetchOnChainTxHistory(limit);
      if (chainItems.length > 0) {
        return {
          ok: true,
          count: chainItems.length,
          items: chainItems,
          note: `Showing on-chain history for current agent address ${owner} (local logs are legacy).`,
          now: new Date().toISOString(),
        };
      }
    } catch {
      // fallthrough to legacy note
    }
    capped = capped.map((r) => ({ ...r, reason: r.reason || 'Legacy local log entry without digest' }));
    return {
      ok: true,
      count: capped.length,
      items: capped,
      note: `Recent local tx records have no digest. Run a new transfer to populate digest logs for owner ${owner}.`,
      now: new Date().toISOString(),
    };
  }
  return {
    ok: true,
    count: capped.length,
    items: capped,
    now: new Date().toISOString(),
  };
}

function findTxDetails({ id, digest, proposalId } = {}) {
  const needleId = String(id || '').trim();
  const needleDigest = String(digest || '').trim();
  const needleProposal = String(proposalId || '').trim();
  const events = readSecurityEventsShared({ limit: 5000 });
  const matched = events.filter((e) => {
    const eDigest = String(e.digest || e.txDigest || '');
    const eProposal = String(e.proposal_id || e.intent_id || '');
    const eId = eDigest || eProposal;
    if (needleDigest && eDigest === needleDigest) return true;
    if (needleProposal && eProposal === needleProposal) return true;
    if (needleId && (eId === needleId || eDigest === needleId || eProposal === needleId)) return true;
    return false;
  });
  if (!matched.length) {
    return { ok: false, error: 'tx_not_found' };
  }
  return {
    ok: true,
    id: needleId || needleDigest || needleProposal,
    count: matched.length,
    events: matched.map((e, i) => normalizeTxRecord(e, i)),
    now: new Date().toISOString(),
  };
}

async function fetchVaultSummary() {
  const { vaultId } = getDemoExecutionContext();
  
  const obj = await withRpcRetry(
    () =>
      suiClient.getObject({
        id: vaultId,
        options: { showContent: true }
      }),
    'getObject(vault)'
  );

  if (!obj.data || !obj.data.content) {
    throw new Error(`Vault object ${vaultId} not found or inaccessible`);
  }

  const bagId = obj.data.content.fields.balances.fields.id.id;
  const coins = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const bagObjects = await withRpcRetry(
      () =>
        suiClient.getDynamicFields({
          parentId: bagId,
          cursor
        }),
      'getDynamicFields(vault.bag)'
    );

    const pageCoins = await Promise.all(
      (bagObjects.data || []).map(async (field) => {
        const fieldObj = await withRpcRetry(
          () =>
            suiClient.getDynamicFieldObject({
              parentId: bagId,
              name: field.name
            }),
          'getDynamicFieldObject(vault.coin)'
        );
        
        const coinTypeRaw = field.name.value.name; // TypeName to string
        const coinType = coinTypeRaw.startsWith('0x') ? coinTypeRaw : `0x${coinTypeRaw}`;
        const balanceValue = fieldObj.data.content.fields.value;
        
        let meta = null;
        try {
          meta = await withRpcRetry(
            () => suiClient.getCoinMetadata({ coinType }),
            'getCoinMetadata'
          );
        } catch { }

        const decimals = meta?.decimals ?? (coinType.endsWith('::SUI') ? 9 : 0);
        const symbol = meta?.symbol ?? coinType.split('::')[2];

        return {
          coin_type: coinType,
          symbol,
          decimals,
          total_balance: balanceValue,
          total_balance_human: toFixedString(balanceValue, decimals) + (symbol ? ` ${symbol}` : ''),
        };
      })
    );
    
    coins.push(...pageCoins);
    cursor = bagObjects.nextCursor;
    hasNextPage = bagObjects.hasNextPage && cursor;
  }

  return {
    ok: true,
    vault_id: vaultId,
    rpc_url: process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443',
    coin_count: coins.length,
    coins: coins.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    now: new Date().toISOString(),
  };
}

async function fetchPriceSummary({ coinType, amountRaw = null }) {
  const normalizedCoinType = parseCoinTypeStrict(coinType);
  const normalizedAmount = parseAmountOptional(amountRaw);

  const [priceUsd, decimals, symbol] = await Promise.all([
    fetchCoinUsdPrice(normalizedCoinType),
    fetchCoinDecimals(normalizedCoinType),
    fetchCoinSymbol(normalizedCoinType),
  ]);

  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return {
      ok: false,
      error: 'price unavailable',
      coin_type: normalizedCoinType,
      symbol: symbol || null,
      decimals: Number.isFinite(decimals) ? decimals : null,
      amount_raw: normalizedAmount,
      transfer_usd: null,
      now: new Date().toISOString(),
    };
  }

  let transferUsd = null;
  let humanAmount = null;
  if (Number.isFinite(normalizedAmount) && normalizedAmount > 0) {
    const priced = await computeTransferPricing({
      coinType: normalizedCoinType,
      amountRaw: normalizedAmount,
    });
    transferUsd = priced?.transferUsd ?? null;
    humanAmount = priced?.humanAmount ?? null;
  }

  return {
    ok: true,
    coin_type: normalizedCoinType,
    symbol: symbol || null,
    decimals: Number.isFinite(decimals) ? decimals : null,
    price_usd: priceUsd,
    amount_raw: normalizedAmount,
    amount_human: humanAmount,
    transfer_usd: transferUsd,
    now: new Date().toISOString(),
  };
}

function setCorsHeaders(req, res) {
  const origin = String(req?.headers?.origin || '*');
  res.setHeader('access-control-allow-origin', origin === 'null' ? '*' : origin);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'access-control-allow-headers',
    'content-type, authorization, x-clawall-plugin-key, x-clawall-source'
  );
  res.setHeader('access-control-max-age', '86400');
}

function json(req, res, code, payload) {
  const body = JSON.stringify(payload, null, 2);
  setCorsHeaders(req, res);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON payload: ${err.message}`);
  }
}

function baseIntent({ domain, action, params, metadata }) {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    domain,
    action,
    params,
    metadata,
  };
}

function buildCheckIntent(payload = {}, authz = {}) {
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  // Prevent provenance spoofing: derive source from auth state
  const derivedSource = authz.gate === 'enforced' ? 'AGENT_AUTONOMY' : 'UNKNOWN';
  
  return baseIntent({
    domain: String(payload.domain || 'OS').toUpperCase(),
    action: String(payload.action || 'EXECUTE_COMMAND').toUpperCase(),
    params: payload.params && typeof payload.params === 'object' ? payload.params : {},
    metadata: {
      ...metadata,
      source: derivedSource, // Strictly override
    },
  });
}

function buildTransferIntent(payload = {}, authz = {}) {
  const { signer, guardCapId, freezeStateId, vaultId } = getDemoExecutionContext();
  const coinType = parseCoinTypeStrict(payload.coin_type);
  const coinObjectId = parseCoinObjectIdOptional(payload.coin_object_id, coinType);
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  // Prevent provenance spoofing: derive source from auth state
  const derivedSource = authz.gate === 'enforced' ? 'AGENT_AUTONOMY' : 'UNKNOWN';

  return baseIntent({
    domain: 'BLOCKCHAIN',
    action: 'WALLET_TRANSFER',
    params: {
      amount: parseTransferAmountStrict(payload.amount),
      recipient: parseRecipientStrict(payload.recipient),
      coin_type: coinType,
      coin_object_id: coinObjectId,
    },
    metadata: {
      ...metadata,
      source: derivedSource, // Strictly override
      via: 'OPENCLAW_PLUGIN',
      signer,
      guardCapId,
      freezeStateId,
      vaultId,
    },
  });
}

function asResult(result) {
  // If result is already a finalized decision object, pass it through
  if (result && typeof result === 'object' && (result.decision || result.error)) {
    return {
      ok: result.ok !== false,
      decision: result.decision || 'FAILED',
      layer: result.layer || null,
      reason: result.reason || result.error || null,
      risk: result.risk || null,
      digest: result.digest || null,
      walrus_blob_id: result.walrus_blob_id || result.walrusBlobId || null,
    };
  }
  return {
    ok: Boolean(result?.ok),
    decision: result?.decision ?? 'UNKNOWN',
    layer: result?.layer ?? null,
    reason: result?.reason ?? null,
    risk: result?.risk ?? null,
    digest: result?.digest ?? null,
    walrus_blob_id: result?.walrus_blob_id ?? result?.walrusBlobId ?? null,
  };
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function readProvidedKey(req) {
  const direct = String(req.headers['x-clawall-plugin-key'] || '').trim();
  if (direct) return direct;
  const auth = String(req.headers.authorization || '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

function authorizePluginRoute(req) {
  if (!ENFORCE_PLUGIN_GATE) {
    return { ok: true, gate: 'disabled' };
  }
  if (!PLUGIN_KEY) {
    return { ok: false, code: 503, error: 'gateway misconfigured: CLAWALL_PLUGIN_KEY missing' };
  }
  const provided = readProvidedKey(req);
  if (!provided || !safeEq(provided, PLUGIN_KEY)) {
    return { ok: false, code: 401, error: 'unauthorized: clawall plugin key invalid or missing' };
  }
  return { ok: true, gate: 'enforced' };
}

async function startServer({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  const verboseLogs = String(process.env.CLAWALL_GATEWAY_VERBOSE || '').trim() === '1';

  const server = http.createServer(async (req, res) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    const startedAt = Date.now();
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const reply = (code, payload) => {
        json(req, res, code, payload);
        if (verboseLogs) {
          console.log(`[clawall-gateway] req=${reqId} ${req.method} ${reqUrl.pathname} -> ${code} ${Date.now() - startedAt}ms`);
        }
      };

      if (req.method === 'OPTIONS') {
        setCorsHeaders(req, res);
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/health') {
        reply(200, {
          ok: true,
          service: 'clawall-openclaw-gateway',
        });
        return;
      }

      const authz = authorizePluginRoute(req);
      if (!authz.ok) {
        reply(authz.code, {
          ok: false,
          error: authz.error,
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/status') {
        reply(200, {
          ok: true,
          kill_switch: killSwitchStatus(),
          plugin_gate: {
            enforced: ENFORCE_PLUGIN_GATE,
            key_configured: Boolean(PLUGIN_KEY),
          },
          now: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/tx-history') {
        const limit = Number(reqUrl.searchParams.get('limit') || '20');
        reply(200, await buildTxHistory(limit));
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/chainlogs') {
        const limit = Number(reqUrl.searchParams.get('limit') || '5');
        const full = ['1', 'true', 'yes'].includes(
          String(reqUrl.searchParams.get('full') || '').toLowerCase()
        );
        let symbolDecimals = {};
        try {
          const wallet = await fetchVaultSummary();
          const coins = Array.isArray(wallet?.coins) ? wallet.coins : [];
          symbolDecimals = Object.fromEntries(
            coins
              .map((c) => [String(c?.symbol || '').toUpperCase(), Number(c?.decimals)])
              .filter(([sym, dec]) => sym && Number.isFinite(dec))
          );
        } catch {
          // keep empty symbol map
        }
        const view = await buildChainLogsView({
          limit,
          packageId: process.env.PACKAGE_ID,
          rpcUrl: process.env.RPC_URL,
          full,
          symbolDecimals,
        });
        reply(200, {
          ok: true,
          count: view.count,
          requested: Math.max(1, Math.min(Number(limit) || 5, 100)),
          lines: view.lines,
          text: view.lines.join('\n'),
          now: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/tx') {
        const id = reqUrl.searchParams.get('id');
        const digest = reqUrl.searchParams.get('digest');
        const proposalId = reqUrl.searchParams.get('proposal_id');
        const details = findTxDetails({ id, digest, proposalId });
        reply(details.ok ? 200 : 404, details);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/wallet') {
        const summary = await fetchVaultSummary();
        reply(200, summary);
        return;
      }

      if (req.method === 'GET' && reqUrl.pathname === '/v1/price') {
        try {
          const coinType = String(reqUrl.searchParams.get('coin_type') || SUI_COIN_TYPE).trim();
          const amount = reqUrl.searchParams.get('amount');
          const summary = await fetchPriceSummary({
            coinType,
            amountRaw: amount,
          });
          reply(summary.ok ? 200 : 404, summary);
        } catch (err) {
          reply(400, {
            ok: false,
            error: String(err?.message ?? err),
          });
        }
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/v1/check') {
        try {
          const payload = await readBody(req);
          const intent = buildCheckIntent(payload, authz);
          const result = await processIntent(intent, payload?.context || {});
          reply(200, asResult(result));
        } catch (err) {
          reply(400, {
            ok: false,
            error: String(err?.message ?? err),
          });
        }
        return;
      }

      if (req.method === 'POST' && reqUrl.pathname === '/v1/signed-transfer') {
        try {
          const payload = await readBody(req);
          const intent = buildTransferIntent(payload, authz);
          const result = await processIntent(intent, payload?.context || {});
          reply(200, asResult(result));
        } catch (err) {
          reply(400, {
            ok: false,
            error: String(err?.message ?? err),
          });
        }
        return;
      }

      reply(404, {
        ok: false,
        error: 'not_found',
      });
    } catch (err) {
      console.error(
        `[clawall-gateway] req=${reqId} unhandled error:`,
        err?.stack || err?.message || err
      );
      json(req, res, 500, {
        ok: false,
        error: String(err?.message ?? err),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  console.log(
    `[clawall-gateway] listening on http://${host}:${port} (endpoints: /health, /v1/status, /v1/wallet, /v1/price, /v1/check, /v1/signed-transfer, /v1/tx-history, /v1/chainlogs, /v1/tx)`
  );
  console.log(
    `[clawall-gateway] transfer gate: enforced=${ENFORCE_PLUGIN_GATE} key_configured=${Boolean(PLUGIN_KEY)}`
  );

  // Start governance polling at gateway boot so operator commands/approvals
  // are available before the first high-risk request arrives.
  try {
    await startTelegramBot();
  } catch (err) {
    console.warn('[clawall-gateway] telegram startup warning:', err?.message ?? err);
  }

  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const opts = parseArgs(process.argv.slice(2));
installGlobalCrashGuards();
startServer({
  host: String(opts.host || process.env.CLAWALL_GATEWAY_HOST || DEFAULT_HOST),
  port: toPort(opts.port || process.env.CLAWALL_GATEWAY_PORT || DEFAULT_PORT),
}).catch((err) => {
  console.error('[clawall-gateway] fatal', err?.message ?? err);
  process.exit(1);
});
