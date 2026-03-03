import 'dotenv/config';
import fs from 'fs';
import crypto from 'node:crypto';
import { freeze, unfreeze } from '../state/kill-switch.mjs';
import { generateForensicBundle } from '../forensics/bundle.mjs';
import {
  listPendingPromptQuarantine,
  releasePromptQuarantineTicket,
} from '../state/prompt-quarantine.mjs';
import {
  findLastSecurityEvent,
  logSecurityEvent,
} from '../observability/security-events.mjs';
import {
  fetchTransactionShared,
  fetchTransferEventsShared,
  formatTransferAmountShared,
  parseEventCoinTypeShared,
  readSecurityEventsShared,
} from '../shared/tx-log-shared.mjs';

const BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const CHAT_ID    = process.env.TG_CHAT_ID;
const RPC_URL    = process.env.RPC_URL;
const PACKAGE_ID = process.env.PACKAGE_ID;
const GATEWAY_URL = process.env.CLAWALL_GATEWAY_URL || 'http://127.0.0.1:3011';
const PLUGIN_KEY = String(process.env.CLAWALL_PLUGIN_KEY || '').trim();
const OS_QUILT_INDEX_FILE = 'src/state/os-security-quilt.log';

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('[telegram] disabled (missing TG_BOT_TOKEN or TG_CHAT_ID)');
}

const ENABLED = Boolean(BOT_TOKEN && CHAT_ID);
const API     = ENABLED ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const GLOBAL_KEY = Symbol.for('clawall.telegram.singleton');
const SENSITIVE_COMMANDS = new Set(['/freeze', '/resume', '/releaseq']);
const MAX_LOG_LIMIT = 20;
const DEFAULT_HELP_LIMIT = 5;
const TG_DEBUG = process.env.TG_DEBUG === '1';
const SUI_COIN_TYPE = '0x2::sui::SUI';

function parseCsvSet(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  );
}

const AUTHORIZED_USER_IDS = parseCsvSet(process.env.TG_OPERATOR_IDS);
const AUTHORIZED_USERNAMES = parseCsvSet(
  String(process.env.TG_OPERATOR_USERNAMES ?? '').replace(/@/g, '')
);
const HAS_OPERATOR_ALLOWLIST =
  AUTHORIZED_USER_IDS.size > 0 || AUTHORIZED_USERNAMES.size > 0;

if (!globalThis[GLOBAL_KEY]) {
  globalThis[GLOBAL_KEY] = {
    lastUpdateId:    0,
    pendingApprovals: new Map(),
    usedApprovalTokens: new Set(),
    killSwitchState: { engaged: false, reason: null, since: null },
    started:         false,
  };
}

const state = globalThis[GLOBAL_KEY];

function actorLabel(user = {}) {
  return user.username ? `@${user.username}` : `id:${user.id}`;
}

function isAuthorizedOperator(user = {}) {
  if (!HAS_OPERATOR_ALLOWLIST) return false;

  const userId = String(user.id ?? '');
  const username = String(user.username ?? '').replace(/^@/, '');

  return (
    AUTHORIZED_USER_IDS.has(userId) ||
    (username.length > 0 && AUTHORIZED_USERNAMES.has(username))
  );
}

export function isGovernanceActionAuthorized(cmd, user = {}) {
  if (!SENSITIVE_COMMANDS.has(cmd)) return true;
  return isAuthorizedOperator(user);
}

async function denyUnauthorizedAction(reason) {
  logSecurityEvent('governance.unauthorized_action', { reason });
  await sendTemplate('Governance Action Rejected', [
    kv('Reason', reason),
  ]);
}

function parseLimit(limitArg, fallback = 5) {
  const raw = limitArg ? Number(limitArg) : fallback;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), MAX_LOG_LIMIT);
}

function parseBundleLimit(limitArg, fallback = 300) {
  const raw = limitArg ? Number(limitArg) : fallback;
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), 2000);
}

function formatTimestamp(ts) {
  if (!ts) return 'n/a';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString();
}

function block(title, lines = []) {
  const cleaned = lines.filter((line) => line !== null && line !== undefined && line !== '');
  const head = [`CLAWALL | ${title}`, '-----------------------------'];
  if (!cleaned.length) return head.join('\n');
  return [...head, '', cleaned.join('\n\n')].join('\n');
}

function kv(key, value) {
  return `${String(key)}: ${value ?? 'n/a'}`;
}

function section(title, lines = []) {
  const cleaned = lines.filter(Boolean).map((line) => `- ${line}`);
  return [title, ...cleaned].join('\n');
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function code(value) {
  return `<code>${escHtml(value ?? 'n/a')}</code>`;
}

function htmlBlock(title, lines = []) {
  const cleaned = lines.filter(Boolean);
  const head = `<b>CLAWALL | ${escHtml(title)}</b>`;
  if (!cleaned.length) return head;
  return `${head}\n\n${cleaned.join('\n\n')}`;
}

function templateLine(line) {
  return escHtml(String(line ?? ''));
}

async function sendTemplate(title, lines = [], extra = {}) {
  return tg('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: htmlBlock(
      title,
      lines
        .filter((line) => line !== null && line !== undefined && line !== '')
        .map((line) => templateLine(line))
    ),
    ...extra,
  });
}

function normalizeGatewayReason(reasonRaw) {
  const reason = String(reasonRaw ?? '').trim();
  const lower = reason.toLowerCase();
  if (!reason) return 'Transfer blocked by policy/gateway.';
  if (lower.includes('moveabort') && lower.includes('abort code: 12')) {
    return 'On-chain transfer aborted (Move abort code 12). Check freeze state, vault balances, and coin type.';
  }
  if (lower.includes('policy integrity check failed')) {
    return 'Policy integrity mismatch detected. Runtime is frozen until hash/state is restored.';
  }
  if (lower.includes('approval denied') || lower.includes('timed out')) {
    return 'Transfer requires governance approval and was denied or timed out.';
  }
  return reason;
}

function cleanNumeric(raw) {
  return String(raw || '').replace(/,/g, '').trim();
}

function parseEventCoinType(rawCoinType) {
  return parseEventCoinTypeShared(rawCoinType);
}

async function formatTransferAmount({ amountRaw, coinType, fallbackDecimals = null }) {
  return formatTransferAmountShared({
    amountRaw,
    coinType,
    fallbackDecimals,
    rpcUrl: RPC_URL,
    suiCoinType: SUI_COIN_TYPE,
  });
}

function parseBaseUnits(raw, decimals) {
  const cleaned = cleanNumeric(raw);
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) throw new Error('invalid amount');
  const [whole, frac = ''] = cleaned.split('.');
  const d = Number(decimals);
  if (!Number.isFinite(d) || d < 0 || d > 18) throw new Error('invalid decimals');
  if (frac.length > d) throw new Error(`too many decimals (max ${d})`);
  const wholeUnits = BigInt(whole) * (10n ** BigInt(d));
  const fracUnits = BigInt((frac + '0'.repeat(d)).slice(0, d));
  const total = wholeUnits + fracUnits;
  if (total <= 0n) throw new Error('amount must be > 0');
  return total.toString();
}

function toSafeIntegerNumber(raw) {
  const n = BigInt(String(raw ?? '0'));
  if (n <= 0n) throw new Error('amount must be > 0');
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('amount too large for safe transfer encoding');
  }
  return Number(n);
}

async function fetchWallet() {
  const headers = { Accept: 'application/json' };
  if (PLUGIN_KEY) headers['x-clawall-plugin-key'] = PLUGIN_KEY;
  const res = await fetch(`${GATEWAY_URL}/v1/wallet`, { headers });
  if (!res.ok) throw new Error(`wallet fetch failed (${res.status})`);
  return await res.json();
}

function symbolFromCoinType(coinType) {
  const raw = String(coinType || '').trim();
  if (!raw) return '';
  const parts = raw.split('::');
  return String(parts[2] || raw).trim().toUpperCase();
}

async function fetchWalletSymbolDecimalsMap() {
  try {
    const wallet = await fetchWallet();
    const coins = Array.isArray(wallet?.coins) ? wallet.coins : [];
    return Object.fromEntries(
      coins
        .map((c) => [String(c?.symbol || '').toUpperCase(), Number(c?.decimals)])
        .filter(([sym, dec]) => sym && Number.isFinite(dec))
    );
  } catch {
    return {};
  }
}

function resolveCoinFromWallet(wallet, symbolOrType) {
  const coins = Array.isArray(wallet?.coins) ? wallet.coins : [];
  const needle = String(symbolOrType || '').trim();
  if (!needle) return null;
  const byType = coins.find((c) => String(c.coin_type || '').toLowerCase() === needle.toLowerCase());
  if (byType) return byType;
  const symbolMatches = coins.filter((c) => String(c.symbol || '').toUpperCase() === needle.toUpperCase());
  if (!symbolMatches.length) return null;
  symbolMatches.sort((a, b) => {
    const aDec = Number.isFinite(Number(a?.decimals)) ? 1 : 0;
    const bDec = Number.isFinite(Number(b?.decimals)) ? 1 : 0;
    if (aDec !== bDec) return bDec - aDec;
    try {
      const aBal = BigInt(String(a?.total_balance ?? '0'));
      const bBal = BigInt(String(b?.total_balance ?? '0'));
      if (aBal > bBal) return -1;
      if (aBal < bBal) return 1;
    } catch (_) {
      return 0;
    }
    return 0;
  });
  return symbolMatches[0];
}

async function handleNaturalTransferText(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const recipient = s.match(/0x[a-fA-F0-9]{64}\b/)?.[0] || null;
  if (!recipient) return null;
  const amountUnit = s.match(/\b([0-9][0-9,]*(?:\.[0-9]+)?)\s*([a-zA-Z][a-zA-Z0-9_-]{1,15})(?:\s+token)?\b/i);
  if (!amountUnit) return null;
  const amountText = amountUnit[1];
  const unit = String(amountUnit[2] || '').toLowerCase();
  if (!unit || unit === 'to' || unit === 'them') return null;

  let amountBase = null;
  let coinType = SUI_COIN_TYPE;
  let coinObjectId = null;

  if (unit === 'mist') {
    if (!/^\d+$/.test(cleanNumeric(amountText))) throw new Error('mist amount must be integer');
    amountBase = cleanNumeric(amountText);
  } else if (unit === 'sui') {
    amountBase = parseBaseUnits(amountText, 9);
  } else {
    const wallet = await fetchWallet();
    const coin = resolveCoinFromWallet(wallet, unit);
    if (!coin) throw new Error(`token "${unit.toUpperCase()}" not found in wallet`);
    const decimals = Number(coin.decimals);
    if (!Number.isFinite(decimals)) {
      throw new Error(`missing decimals for ${unit.toUpperCase()}; provide explicit coin-type`);
    }
    amountBase = parseBaseUnits(amountText, decimals);
    coinType = String(coin.coin_type || '').trim();
    coinObjectId = coin.sample_coin_object_id || null;
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (PLUGIN_KEY) headers['x-clawall-plugin-key'] = PLUGIN_KEY;

  const payload = {
    amount: toSafeIntegerNumber(amountBase),
    recipient,
    coin_type: coinType,
    coin_object_id: coinObjectId,
    context: { source: 'TELEGRAM_CHAT' },
  };

  const res = await fetch(`${GATEWAY_URL}/v1/signed-transfer`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const reason = body?.reason || body?.error || `gateway error (${res.status})`;
    throw new Error(normalizeGatewayReason(reason));
  }

  const prettyAmount = await formatTransferAmount({
    amountRaw: amountBase,
    coinType,
  });

  return {
    ok: true,
    amount: prettyAmount,
    recipient,
    digest: body.digest || null,
    walrusBlobId: body.walrus_blob_id || body.walrusBlobId || null,
    decision: body.decision || null,
  };
}

function validateTelegramGovernanceConfig() {
  if (!ENABLED) return;
  if (!HAS_OPERATOR_ALLOWLIST) {
    throw new Error(
      'Telegram governance misconfigured: set TG_OPERATOR_IDS and/or TG_OPERATOR_USERNAMES'
    );
  }
}

async function tg(method, body) {
  if (!ENABLED) return null;

  try {
    const res  = await fetch(`${API}/${method}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });

    const json = await res.json();
    if (!json.ok) {
      console.error(`[TG ERROR] ${method}:`, json.description);
    }

    return json;
  } catch (err) {
    console.error('[TG FETCH ERROR]', err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTransferEvents(limit = 10) {
  return fetchTransferEventsShared({
    limit,
    packageId: PACKAGE_ID,
    rpcUrl: RPC_URL,
  });
}

async function fetchTransaction(digest) {
  return fetchTransactionShared(digest, { rpcUrl: RPC_URL });
}

export function isKillSwitchEngaged() {
  return state.killSwitchState.engaged;
}

export async function engageKillSwitch(reason) {
  if (state.killSwitchState.engaged) return;

  state.killSwitchState.engaged = true;
  state.killSwitchState.reason  = reason;
  state.killSwitchState.since   = Date.now();

  freeze({ reason, by: 'TELEGRAM' });
  logSecurityEvent('governance.kill_switch_engaged', {
    source: 'TELEGRAM',
    reason,
  });

  await sendTemplate('Kill Switch Engaged', [
    kv('Reason', reason),
    kv('Action', 'Use /resume to unlock'),
  ]);
}

export async function resumeSystem({ approvedBy }) {
  state.killSwitchState.engaged = false;
  state.killSwitchState.reason  = null;
  state.killSwitchState.since   = null;

  unfreeze('TELEGRAM_RESUME');
  const { resetAgentState } = await import('../orchestrator/intent-orchestrator.mjs');
  resetAgentState();
  logSecurityEvent('governance.system_resumed', {
    approved_by: approvedBy,
  });

  await sendTemplate('System Resumed', [
    kv('Approved By', approvedBy),
  ]);
}

function shortDigest(value, len = 8) {
  if (typeof value !== 'string') return '';
  return value.slice(0, len);
}

function normalizeToken(value, len = 8) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.slice(0, len);
}

function shortToken(value, len = 8) {
  const normalized = normalizeToken(value, len);
  if (normalized) return normalized;
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

function trimUsedTokens(maxSize = 512) {
  if (state.usedApprovalTokens.size <= maxSize) return;
  const arr = Array.from(state.usedApprovalTokens);
  const overflow = arr.length - maxSize;
  for (let i = 0; i < overflow; i += 1) {
    state.usedApprovalTokens.delete(arr[i]);
  }
}

export async function sendApprovalRequest({
  proposal,
  risk,
  approvalDigest,
  approvalExpiryMs,
  oneTimeToken,
}) {
  if (!ENABLED) return null;
  const amountLabel = await formatTransferAmount({
    amountRaw: proposal?.params?.amount,
    coinType: proposal?.params?.coin_type,
    fallbackDecimals: proposal?.params?.coin_decimals ?? null,
  });
  const approvalDigestShort = shortDigest(approvalDigest, 8) || 'none';
  const oneTimeTokenShort = shortToken(oneTimeToken, 8);
  const expiryLabel = Number.isFinite(Number(approvalExpiryMs))
    ? new Date(Number(approvalExpiryMs)).toLocaleString()
    : 'n/a';

  logSecurityEvent('governance.approval_requested', {
    proposal_id: proposal?.id ?? null,
    risk_level: risk?.risk_level ?? null,
    risk_score: risk?.risk_score ?? null,
    approval_digest: approvalDigestShort,
    approval_token: oneTimeTokenShort,
    approval_expiry_ms: Number.isFinite(Number(approvalExpiryMs)) ? Number(approvalExpiryMs) : null,
  });

  const res = await tg('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: htmlBlock('Approval Required', [
      section('Transfer', [
        `Proposal ID: ${code(proposal.id)}`,
        `Amount: <b>${escHtml(amountLabel)}</b>`,
        `Coin Type: ${code(proposal?.params?.coin_type || SUI_COIN_TYPE)}`,
        `Recipient: ${code(proposal.params.recipient)}`,
      ]),
      section('Risk', [
        `Risk Level: <b>${escHtml(risk.risk_level)}</b>`,
        `Risk Score: <b>${escHtml(risk.risk_score)}</b>`,
        `Reason: ${escHtml(risk.reasoning)}`,
      ]),
      section('Verification', [
        `Approval Hash: ${code(approvalDigestShort)}`,
        `Approval Token: ${code(oneTimeTokenShort)}`,
        `Valid Until: ${escHtml(expiryLabel)}`,
      ]),
      'Action: use inline Approve/Reject buttons below.',
    ]),
    reply_markup: {
      inline_keyboard: [[
        {
          text: 'Approve',
          callback_data: `APPROVE:${proposal.id}:${approvalDigestShort}:${oneTimeTokenShort}`,
        },
        {
          text: 'Reject',
          callback_data: `REJECT:${proposal.id}:${approvalDigestShort}:${oneTimeTokenShort}`,
        },
      ]],
    },
  });

  return res?.result?.message_id ?? null;
}

export function waitForApproval({
  proposalId,
  timeoutMs,
  approvalDigest,
  approvalExpiryMs,
  oneTimeToken,
}) {
  if (!ENABLED) {
    return Promise.resolve({ approved: false });
  }

  const approvalDigestShort = shortDigest(approvalDigest, 8) || null;
  const oneTimeTokenShort = shortToken(oneTimeToken, 8);
  const expiresAt = Number.isFinite(Number(approvalExpiryMs))
    ? Number(approvalExpiryMs)
    : Date.now() + timeoutMs;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      state.pendingApprovals.delete(proposalId);
      logSecurityEvent('governance.approval_timeout', {
        proposal_id: proposalId,
        approval_digest: approvalDigestShort,
        approval_token: oneTimeTokenShort,
      });
      resolve({ approved: false, reason: 'timeout' });
    }, timeoutMs);

    state.pendingApprovals.set(proposalId, {
      resolve,
      timeout,
      approvalDigest: approvalDigestShort,
      oneTimeToken: oneTimeTokenShort,
      expiresAt,
    });
    if (TG_DEBUG) {
      console.log(
        `[telegram] waiting for approval: ${proposalId} (pending=${state.pendingApprovals.size})`
      );
    }
  });
}

function resolveApproval({
  proposalId,
  approved,
  approvedBy,
  approvalDigest,
  oneTimeToken,
}) {
  if (TG_DEBUG) {
    console.log(
      `[telegram] resolveApproval id=${proposalId} pending=${state.pendingApprovals.size}`
    );
  }

  if (!state.pendingApprovals.has(proposalId)) {
    if (TG_DEBUG) {
      console.warn('[telegram] no pending approval for:', proposalId);
    }
    return { ok: false, code: 'NOT_PENDING' };
  }

  const entry = state.pendingApprovals.get(proposalId);
  const providedToken = normalizeToken(oneTimeToken, 8);
  const tokenMatches =
    !entry.oneTimeToken ||
    (typeof providedToken === 'string' && providedToken === entry.oneTimeToken);
  const digestMatches =
    !entry.approvalDigest ||
    (typeof approvalDigest === 'string' && approvalDigest === entry.approvalDigest);
  const notExpired = !entry.expiresAt || Date.now() <= entry.expiresAt;
  const tokenKey = `${proposalId}:${entry.oneTimeToken ?? 'none'}`;

  if (state.usedApprovalTokens.has(tokenKey)) {
    logSecurityEvent('governance.approval_replay_detected', {
      proposal_id: proposalId,
      approval_digest: approvalDigest ?? null,
      approval_token: entry.oneTimeToken ?? null,
      approved_by: approvedBy ?? null,
    });
    return { ok: false, code: 'REPLAY' };
  }

  if (!digestMatches) {
    logSecurityEvent('governance.approval_digest_mismatch', {
      proposal_id: proposalId,
      expected_digest: entry.approvalDigest,
      received_digest: approvalDigest ?? null,
      approved_by: approvedBy ?? null,
    });
    return { ok: false, code: 'DIGEST_MISMATCH' };
  }

  if (!tokenMatches) {
    logSecurityEvent('governance.approval_token_mismatch', {
      proposal_id: proposalId,
      expected_token: entry.oneTimeToken ?? null,
      received_token: providedToken ?? null,
      approved_by: approvedBy ?? null,
    });
    return { ok: false, code: 'TOKEN_MISMATCH' };
  }

  if (!notExpired) {
    clearTimeout(entry.timeout);
    state.pendingApprovals.delete(proposalId);
    logSecurityEvent('governance.approval_expired', {
      proposal_id: proposalId,
      approval_digest: approvalDigest ?? null,
      approval_token: entry.oneTimeToken ?? null,
      approved_by: approvedBy ?? null,
    });
    return { ok: false, code: 'EXPIRED' };
  }

  clearTimeout(entry.timeout);
  state.pendingApprovals.delete(proposalId);
  state.usedApprovalTokens.add(tokenKey);
  trimUsedTokens();
  logSecurityEvent('governance.approval_resolved', {
    proposal_id: proposalId,
    approved,
    approved_by: approvedBy,
    approval_digest: approvalDigest ?? null,
    approval_token: entry.oneTimeToken ?? null,
  });
  entry.resolve({ approved, approvedBy });
  return { ok: true, code: approved ? 'APPROVED' : 'REJECTED' };
}

function readSecurityEvents(limit = 200, predicate = null) {
  return readSecurityEventsShared({
    limit,
    predicate,
    newestFirst: true,
  });
}

function formatOsLogLine(event, index) {
  const reason =
    event.reason ??
    event.message ??
    event.command ??
    event.event_type;
  return `${index}. ${formatTimestamp(event.ts)} | ${event.event_type} | ${reason}`;
}

async function handleOsLogs(limitArg) {
  const limit = parseLimit(limitArg, 5);
  const osEvents = readSecurityEvents(
    limit,
    (e) =>
      e.domain === 'OS' ||
      e.layer === 'OS_POLICY' ||
      (e.event_type === 'kill_switch.freeze' && e.triggered_by === 'OS_FIREWALL')
  );

  if (!osEvents.length) {
    await sendTemplate('OS Logs', ['No OS security logs found for the requested range.']);
    return;
  }

  const body = osEvents
    .map((e, idx) => formatOsLogLine(e, idx + 1))
    .join('\n');

  await sendTemplate(`OS Logs (latest ${osEvents.length})`, [body]);
}

async function handleChainLogs(limitArg) {
  const limit = parseLimit(limitArg, 5);
  const events = await fetchTransferEvents(limit);
  if (!events.length) {
    await sendTemplate('On-Chain Logs', ['No on-chain transfers found.']);
    return;
  }
  const symbolDecimals = await fetchWalletSymbolDecimalsMap();
  const sections = [];
  for (const [i, e] of events.entries()) {
    const p = e?.parsedJson || {};
    const digest = String(e?.id?.txDigest || 'n/a');
    const coinType = parseEventCoinType(p.coin_type) || SUI_COIN_TYPE;
    const fallbackDecimals = Number(symbolDecimals?.[symbolFromCoinType(coinType)]);
    const prettyAmount = await formatTransferAmount({
      amountRaw: p.amount,
      coinType,
      fallbackDecimals: Number.isFinite(fallbackDecimals) ? fallbackDecimals : null,
    });
    const blobId = Array.isArray(p.audit_blob_id)
      ? Buffer.from(p.audit_blob_id).toString()
      : String(p.audit_blob_id || 'n/a');
    sections.push(
      section(`Transfer ${i + 1}`, [
        `Digest: ${code(digest)}`,
        `Amount: <b>${escHtml(prettyAmount)}</b>`,
        `Coin Type: ${code(coinType)}`,
        `Recipient: ${code(p.recipient || 'n/a')}`,
        `Executed At: ${escHtml(formatTimestamp(Number(p.timestamp_ms)))}`,
        `Walrus Blob: ${code(blobId || 'n/a')}`,
        digest !== 'n/a'
          ? `Explorer: https://suiscan.xyz/testnet/tx/${encodeURIComponent(digest)}`
          : null,
      ])
    );
  }

  await tg('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    text: htmlBlock(`On-Chain Logs (latest ${events.length})`, [
      ...sections,
      'Use /tx &lt;index|digest&gt; for full transaction detail.',
    ]),
  });
}

async function handleLogs(limitArg) {
  const limit = parseLimit(limitArg, 5);
  const osEvents = readSecurityEvents(
    limit,
    (e) =>
      e.domain === 'OS' ||
      e.layer === 'OS_POLICY' ||
      (e.event_type === 'kill_switch.freeze' && e.triggered_by === 'OS_FIREWALL')
  );
  const chainEvents = readSecurityEvents(
    limit,
    (e) =>
      e.event_type === 'sdk.tx_success' ||
      e.event_type === 'sdk.tx_failure' ||
      e.event_type === 'sdk.tx_submitted'
  );

  const lastOs = osEvents[0];
  const lastChain = chainEvents[0];
  await sendTemplate('Security Log Summary', [
    section('OS', [
      kv('Logs Found', osEvents.length),
      kv('Last Event', lastOs ? `${lastOs.event_type} @ ${formatTimestamp(lastOs.ts)}` : 'n/a'),
    ]),
    section('On-Chain', [
      kv('Logs Found', chainEvents.length),
      kv('Last Event', lastChain ? `${lastChain.event_type} @ ${formatTimestamp(lastChain.ts)}` : 'n/a'),
    ]),
    section('Quick Commands', [
      `/oslogs ${limit}`,
      `/chainlogs ${limit}`,
      '/tx <index|digest>',
      '/osproof last',
    ]),
  ]);
}

async function handleHelp() {
  await sendTemplate('Command Center', [
    section('Governance', [
      '/freeze',
      '/resume',
      '/status',
    ]),
    section('Logs & Evidence', [
      '/logs [n]',
      '/oslogs [n]',
      '/chainlogs [n]',
      '/osproof [last|index]',
      '/tx <index|digest>',
      '/bundle [n]',
    ]),
    section('Quarantine', [
      '/quarantine [n]',
      '/releaseq <ticket_id>',
    ]),
    section('Notes', [
      `n defaults to ${DEFAULT_HELP_LIMIT}`,
      `max n is ${MAX_LOG_LIMIT}`,
      'Natural transfer text is supported (example: send 0.02 wal to 0x...)',
    ]),
  ]);
}

async function handleForensicBundle(limitArg, actor = {}) {
  const limit = parseBundleLimit(limitArg, 300);
  const actorName = `telegram:${actorLabel(actor)}`;

  const bundle = await generateForensicBundle({
    reason: 'telegram_bundle_request',
    actor: actorName,
    limit,
  });

  await sendTemplate('Forensic Bundle Ready', [
    section('Bundle', [
      kv('Bundle ID', bundle.bundle_id),
      kv('Generated', bundle.generated_at),
    ]),
    section('Summary', [
      kv('Events', bundle.summary?.security_event_count ?? 0),
      kv('OS Quilt', bundle.summary?.os_quilt_count ?? 0),
      kv('Walrus Refs', bundle.summary?.walrus_ref_count ?? 0),
    ]),
    section('Files', [
      kv('JSON', bundle.paths?.json ?? 'n/a'),
      kv('Markdown', bundle.paths?.markdown ?? 'n/a'),
    ]),
  ]);
}

async function handleQuarantine(limitArg) {
  const limit = parseLimit(limitArg, 5);
  const pending = listPendingPromptQuarantine(limit);

  if (!pending.length) {
    await sendTemplate('Prompt Quarantine', ['No pending quarantine tickets.']);
    return;
  }

  const lines = pending.map((ticket, idx) => (
    `${idx + 1}. ${ticket.id}\n` +
    `   source=${ticket.source} severity=${ticket.severity}\n` +
    `   reason=${ticket.reason}\n` +
    `   created=${formatTimestamp(ticket.created_at)}\n` +
    `   snippet="${ticket.snippet}"`
  ));

  await sendTemplate(`Prompt Quarantine (pending ${pending.length})`, [lines.join('\n\n')]);
}

async function handleReleaseQuarantine(ticketId, actor = {}) {
  const id = String(ticketId ?? '').trim();
  if (!id) {
    await sendTemplate('Prompt Quarantine', ['Usage: /releaseq <ticket_id>']);
    return;
  }

  const released = releasePromptQuarantineTicket(id, {
    releasedBy: `telegram:${actorLabel(actor)}`,
  });

  if (!released) {
    await sendTemplate('Prompt Quarantine', [`No pending quarantine ticket found for id: ${id}`]);
    return;
  }

  await sendTemplate('Quarantine Ticket Released', [
    kv('Ticket', released.id),
    kv('Released By', released.released_by),
    kv('Valid Until', formatTimestamp(released.release_expires_at_ms)),
    kv('Reason', released.reason),
  ]);
}

async function handleTx(input) {
  if (!input) {
    await sendTemplate('Transaction Lookup', [
      'Usage:',
      '  /tx <index>',
      '  /tx <digest>',
    ]);
    return;
  }

  let digest    = input;
  let eventData = null;

  if (/^\d+$/.test(input)) {
    const index  = Number(input);
    const events = await fetchTransferEvents(20);

    if (index < 1 || index > events.length) {
      await sendTemplate('Transaction Lookup', ['Invalid index.']);
      return;
    }

    const event = events[index - 1];
    digest    = event.id.txDigest;
    eventData = event.parsedJson;
  }

  const tx = await fetchTransaction(digest);

  if (!tx) {
    await sendTemplate('Transaction Lookup', ['No transaction found.']);
    return;
  }

  if (!eventData) {
    const events = await fetchTransferEvents(20);
    const match  = events.find(e => e.id.txDigest === digest);
    if (match) eventData = match.parsedJson;
  }

  const status = tx.effects?.status?.status === 'success' ? 'SUCCESS' : 'FAILED';

  const detailLines = [
    `Digest: ${code(tx.digest)}`,
    `Status: <b>${escHtml(status)}</b>`,
  ];

  if (tx.effects?.gasUsed) {
    const gas      = tx.effects.gasUsed;
    const totalGas =
      Number(gas.computationCost) +
      Number(gas.storageCost) -
      Number(gas.storageRebate);

    detailLines.push(`Gas Used: <b>${escHtml(`${totalGas / 1e9} SUI`)}</b>`);
  }

  if (eventData) {
    const coinType = parseEventCoinType(eventData.coin_type) || SUI_COIN_TYPE;
    const symbolDecimals = await fetchWalletSymbolDecimalsMap();
    const fallbackDecimals = Number(symbolDecimals?.[symbolFromCoinType(coinType)]);
    const prettyAmount = await formatTransferAmount({
      amountRaw: eventData.amount,
      coinType,
      fallbackDecimals: Number.isFinite(fallbackDecimals) ? fallbackDecimals : null,
    });
    detailLines.push(section('Transfer', [
      `Constraint ID: ${code(eventData.constraint_id)}`,
      `Amount: <b>${escHtml(prettyAmount)}</b>`,
      `Coin Type: ${code(coinType)}`,
      `Recipient: ${code(eventData.recipient)}`,
      `Executed At: ${escHtml(new Date(Number(eventData.timestamp_ms)).toLocaleString())}`,
      `Walrus Blob: ${code(Buffer.from(eventData.audit_blob_id || []).toString())}`,
    ]));
  }
  detailLines.push(`Explorer: https://suiscan.xyz/testnet/tx/${encodeURIComponent(tx.digest)}`);

  await tg('sendMessage', {
    chat_id: CHAT_ID,
    parse_mode: 'HTML',
    text: htmlBlock('Transaction Detail', detailLines),
    disable_web_page_preview: true,
  });
}

async function handleOsProof(input = 'last') {
  const mode = String(input || 'last').toLowerCase();
  let lines = [];

  try {
    const raw = fs.readFileSync(OS_QUILT_INDEX_FILE, 'utf8');
    lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    await sendTemplate('OS Quilt Proof', ['No OS Quilt proofs found yet.']);
    return;
  }

  if (lines.length === 0) {
    await sendTemplate('OS Quilt Proof', ['No OS Quilt proofs found yet.']);
    return;
  }

  let idx = lines.length - 1;
  if (mode !== 'last' && /^\d+$/.test(mode)) {
    const n = Number(mode);
    if (n < 1 || n > lines.length) {
      await sendTemplate('OS Quilt Proof', [
        `Invalid proof index. Available range: 1-${lines.length}`,
      ]);
      return;
    }
    idx = n - 1;
  }

  let record = null;
  try {
    record = JSON.parse(lines[idx]);
  } catch {
    await sendTemplate('OS Quilt Proof', ['Failed to parse OS Quilt proof record.']);
    return;
  }

  const patchLines = Array.isArray(record.patch_ids) && record.patch_ids.length > 0
    ? record.patch_ids.map((id, i) => `${i + 1}. ${id}`).join('\n')
    : 'n/a';

  await sendTemplate('OS Quilt Proof', [
    kv('Index', `${idx + 1}/${lines.length}`),
    kv('Timestamp', record.ts ?? 'n/a'),
    kv('Event Count', record.event_count ?? 'n/a'),
    kv('Blob ID', record.blob_id ?? 'n/a'),
    section('Patch IDs', [patchLines]),
  ]);
}

async function clearWebhook() {
  if (!ENABLED) return;
  await tg('deleteWebhook', { drop_pending_updates: false });
}

async function pollTelegram() {
  if (!ENABLED) return;

  try {
    const res  = await fetch(`${API}/getUpdates`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offset:          state.lastUpdateId + 1,
        timeout:         30,
        allowed_updates: ['message', 'callback_query'],
      }),
    });

    const json = await res.json();
    if (!json.ok) return;

    for (const u of json.result) {
      state.lastUpdateId = u.update_id;

      if (u.message?.text) {
        const chatId = u.message.chat.id;
        if (String(chatId) !== String(CHAT_ID)) continue;
        const rawText = u.message.text.trim();

        if (!rawText.startsWith('/')) {
          try {
            const routed = await handleNaturalTransferText(rawText);
            if (routed?.ok) {
              await tg('sendMessage', {
                chat_id: CHAT_ID,
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                text: htmlBlock('Transfer Executed', [
                  `Amount: <b>${escHtml(routed.amount)}</b>`,
                  `Recipient: ${code(routed.recipient)}`,
                  `Decision: <b>${escHtml(routed.decision ?? 'EXECUTED')}</b>`,
                  '',
                  `Digest: ${code(routed.digest ?? 'n/a')}`,
                  `Walrus Blob: ${code(routed.walrusBlobId ?? 'n/a')}`,
                  routed.digest
                    ? `Explorer: https://suiscan.xyz/testnet/tx/${encodeURIComponent(routed.digest)}`
                    : null,
                ]),
              });
              continue;
            }
          } catch (err) {
            await tg('sendMessage', {
              chat_id: CHAT_ID,
              parse_mode: 'HTML',
              text: htmlBlock('Transfer Failed', [
                `Reason: ${escHtml(normalizeGatewayReason(err?.message || String(err)))}`,
                'Tip: verify vault balance and policy status before retry.',
              ]),
            });
            continue;
          }
        }

        const parts = rawText.split(/\s+/);
        const cmd   = parts[0].split('@')[0].toLowerCase();
        const arg   = parts[1];

        if (!isGovernanceActionAuthorized(cmd, u.message.from)) {
          await denyUnauthorizedAction(
            `${actorLabel(u.message.from)} attempted ${cmd}`
          );
          continue;
        }

        if      (cmd === '/help')      await handleHelp();
        else if (cmd === '/logs')      await handleLogs(arg);
        else if (cmd === '/oslogs')    await handleOsLogs(arg);
        else if (cmd === '/chainlogs') await handleChainLogs(arg);
        else if (cmd === '/tx')        await handleTx(arg);
        else if (cmd === '/osproof')   await handleOsProof(arg);
        else if (cmd === '/bundle')    await handleForensicBundle(arg, u.message.from);
        else if (cmd === '/quarantine') await handleQuarantine(arg);
        else if (cmd === '/releaseq')   await handleReleaseQuarantine(arg, u.message.from);
        else if (cmd === '/freeze') await engageKillSwitch('Manual freeze via Telegram');
        else if (cmd === '/resume') await resumeSystem({ approvedBy: `telegram:${actorLabel(u.message.from)}` });
        else if (cmd === '/status') {
          const lastBlocked = findLastSecurityEvent(
            (e) =>
              e.event_type === 'brain.decision' &&
              e.decision === 'BLOCKED'
          );
          const lastAuditFailure = findLastSecurityEvent(
            (e) => e.event_type === 'sdk.audit_upload_failed'
          );
          const killSwitchSince = state.killSwitchState.since
            ? new Date(state.killSwitchState.since).toLocaleString()
            : 'n/a';

          await tg('sendMessage', {
            chat_id: CHAT_ID,
            parse_mode: 'HTML',
            text: htmlBlock('System Status', [
              templateLine(section('Runtime', [
                kv('Kill Switch', state.killSwitchState.engaged ? 'ENGAGED' : 'ACTIVE'),
                kv('Reason', state.killSwitchState.reason ?? 'n/a'),
                kv('Since', killSwitchSince),
                kv('Pending Approvals', state.pendingApprovals.size),
              ])),
              templateLine(section('Recent Blocks', [
                kv('Layer', lastBlocked?.layer ?? 'n/a'),
                kv('Reason', lastBlocked?.reason ?? 'n/a'),
              ])),
              templateLine(section('Audit', [
                kv('Last Failure', lastAuditFailure?.ts ?? 'n/a'),
                kv('Failure Code', lastAuditFailure?.code ?? 'n/a'),
              ])),
            ]),
          });
        }
      }

      if (u.callback_query) {
        const cb = u.callback_query;
        const callbackChatId = cb.message?.chat?.id;
        if (String(callbackChatId) !== String(CHAT_ID)) continue;

        if (typeof cb.data !== 'string' || !cb.data.includes(':')) {
          await tg('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Invalid action',
            show_alert: true,
          });
          continue;
        }

        if (!isAuthorizedOperator(cb.from)) {
          await tg('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Unauthorized',
            show_alert: true,
          });
          await denyUnauthorizedAction(
            `${actorLabel(cb.from)} attempted approval action`
          );
          continue;
        }

        const [action, proposalId, approvalDigest, oneTimeToken] = cb.data.split(':');
        if (!action || !proposalId) {
          await tg('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Invalid action',
            show_alert: true,
          });
          continue;
        }

        if (action !== 'APPROVE' && action !== 'REJECT') {
          await tg('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Invalid action',
            show_alert: true,
          });
          continue;
        }

        const approved = action === 'APPROVE';
        const approver = `telegram:${cb.from.username || cb.from.id}`;

        await tg('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: approved ? 'Approved' : 'Rejected',
        });

        const resolved = resolveApproval({
          proposalId,
          approved,
          approvedBy: approver,
          approvalDigest: approvalDigest ?? null,
          oneTimeToken: oneTimeToken ?? null,
        });

        if (resolved.ok) {
          await tg('sendMessage', {
            chat_id: CHAT_ID,
            parse_mode: 'HTML',
            text: htmlBlock('Approval Decision', [
              kv('Result', approved ? '<b>APPROVED</b>' : '<b>REJECTED</b>'),
              kv('Proposal ID', code(proposalId)),
            ]),
          });
        } else if (resolved.code === 'DIGEST_MISMATCH' || resolved.code === 'TOKEN_MISMATCH') {
          await tg('sendMessage', {
            chat_id: CHAT_ID,
            parse_mode: 'HTML',
            text: htmlBlock('Approval Decision Rejected', [
              kv('Reason', resolved.code === 'DIGEST_MISMATCH' ? 'Digest mismatch' : 'Approval token mismatch'),
              kv('Proposal ID', code(proposalId)),
            ]),
          });
        } else {
          // Ignore noisy replay/not-pending/expired messages in chat.
          await tg('answerCallbackQuery', {
            callback_query_id: cb.id,
            text: 'Approval already handled',
            show_alert: false,
          });
        }
      }
    }
  } catch (err) {
    console.error('pollTelegram error:', err.message);
  }
}

export async function startTelegramBot() {
  if (!ENABLED || state.started) return;

  validateTelegramGovernanceConfig();

  state.started = true;
  console.log('[telegram] bot started');

  await clearWebhook();

  (async () => {
    while (true) {
      await pollTelegram();
      await sleep(500);
    }
  })().catch((err) => {
    state.started = false;
    console.error('[telegram] bot loop crashed:', err?.message ?? err);
  });
}
