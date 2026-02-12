import 'dotenv/config';
import { freeze, unfreeze } from '../state/kill-switch.mjs';
import { resetAgentState } from '../core/brain.mjs';

const BOT_TOKEN  = process.env.TG_BOT_TOKEN;
const CHAT_ID    = process.env.TG_CHAT_ID;
const RPC_URL    = process.env.RPC_URL;
const PACKAGE_ID = process.env.PACKAGE_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.warn('⚠️  Telegram disabled (missing TG_BOT_TOKEN or TG_CHAT_ID)');
}

const ENABLED = Boolean(BOT_TOKEN && CHAT_ID);
const API     = ENABLED ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;
const GLOBAL_KEY = Symbol.for('clawall.telegram.singleton');

if (!globalThis[GLOBAL_KEY]) {
  globalThis[GLOBAL_KEY] = {
    lastUpdateId:    0,
    pendingApprovals: new Map(),
    killSwitchState: { engaged: false, reason: null, since: null },
    started:         false,
  };
}

const state = globalThis[GLOBAL_KEY];

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
  return new Promise(r => setTimeout(r, ms));
}

async function rpc(method, params) {
  try {
    const res  = await fetch(RPC_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const json = await res.json();
    return json?.result;
  } catch (err) {
    console.error('RPC error:', err.message);
    return null;
  }
}

async function fetchTransferEvents(limit = 10) {
  if (!RPC_URL || !PACKAGE_ID) return [];

  const result = await rpc('suix_queryEvents', [
    { MoveEventType: `${PACKAGE_ID}::enforcer::TransferExecuted` },
    null,
    limit,
    true,
  ]);

  return result?.data || [];
}

async function fetchTransaction(digest) {
  return await rpc('sui_getTransactionBlock', [
    digest,
    {
      showEffects:        true,
      showEvents:         true,
      showBalanceChanges: true,
      showInput:          true,
    },
  ]);
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

  await tg('sendMessage', {
    chat_id: CHAT_ID,
    text: `🚨 KILL SWITCH ENGAGED\n\nReason:\n${reason}\n\nUse /resume to unlock.`,
  });
}

export async function resumeSystem({ approvedBy }) {
  state.killSwitchState.engaged = false;
  state.killSwitchState.reason  = null;
  state.killSwitchState.since   = null;

  unfreeze('TELEGRAM_RESUME');
  resetAgentState();

  await tg('sendMessage', {
    chat_id: CHAT_ID,
    text: `✅ SYSTEM RESUMED\n\nApproved by: ${approvedBy}`,
  });
}

export async function sendApprovalRequest({ proposal, risk }) {
  if (!ENABLED) return null;

  const text =
`🚨 APPROVAL REQUIRED

Proposal ID:
${proposal.id}

Amount:
${proposal.params.amount}

Recipient:
${proposal.params.recipient}

Risk Level:
${risk.risk_level}

Risk Score:
${risk.risk_score}

Reason:
${risk.reasoning}
`;

  const res = await tg('sendMessage', {
    chat_id: CHAT_ID,
    text,
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `APPROVE:${proposal.id}` },
        { text: '❌ Reject',  callback_data: `REJECT:${proposal.id}`  },
      ]],
    },
  });

  return res?.result?.message_id ?? null;
}

export function waitForApproval({ proposalId, timeoutMs }) {
  if (!ENABLED) {
    return Promise.resolve({ approved: false });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      state.pendingApprovals.delete(proposalId);
      resolve({ approved: false, reason: 'timeout' });
    }, timeoutMs);

    state.pendingApprovals.set(proposalId, { resolve, timeout });
    console.log(`[TG] Waiting for approval: ${proposalId} | pending: ${state.pendingApprovals.size}`);
  });
}

function resolveApproval({ proposalId, approved, approvedBy }) {
  console.log(`[TG] resolveApproval called | map size: ${state.pendingApprovals.size} | id: ${proposalId}`);

  if (!state.pendingApprovals.has(proposalId)) {
    console.warn('[TG] No pending approval found for:', proposalId);
    return;
  }

  const entry = state.pendingApprovals.get(proposalId);
  clearTimeout(entry.timeout);
  state.pendingApprovals.delete(proposalId);
  entry.resolve({ approved, approvedBy });
}

async function handleLogs(limitArg) {
  const limit  = limitArg ? Number(limitArg) : 5;
  const events = await fetchTransferEvents(limit);

  if (!events.length) {
    await tg('sendMessage', { chat_id: CHAT_ID, text: '📭 No on-chain transfers found.' });
    return;
  }

  let message = '📦 Recent On-Chain Transfers\n\n';

  events.forEach((e, i) => {
    const p = e.parsedJson;
    message +=
`#${i + 1}
Digest: ${e.id.txDigest}
Amount: ${Number(p.amount) / 1e9} SUI
Recipient: ${p.recipient.slice(0, 8)}...
Time: ${new Date(Number(p.timestamp_ms)).toLocaleString()}

`;
  });

  message += '\nUse /tx <index|digest> for details';

  await tg('sendMessage', { chat_id: CHAT_ID, text: message });
}

async function handleTx(input) {
  if (!input) {
    await tg('sendMessage', {
      chat_id: CHAT_ID,
      text: 'Usage:\n/tx <index>\n/tx <digest>',
    });
    return;
  }

  let digest    = input;
  let eventData = null;

  if (/^\d+$/.test(input)) {
    const index  = Number(input);
    const events = await fetchTransferEvents(20);

    if (index < 1 || index > events.length) {
      await tg('sendMessage', { chat_id: CHAT_ID, text: '❌ Invalid index.' });
      return;
    }

    const event = events[index - 1];
    digest    = event.id.txDigest;
    eventData = event.parsedJson;
  }

  const tx = await fetchTransaction(digest);

  if (!tx) {
    await tg('sendMessage', { chat_id: CHAT_ID, text: '❌ No transaction found.' });
    return;
  }

  if (!eventData) {
    const events = await fetchTransferEvents(20);
    const match  = events.find(e => e.id.txDigest === digest);
    if (match) eventData = match.parsedJson;
  }

  const status = tx.effects?.status?.status === 'success' ? '✅ SUCCESS' : '❌ FAILED';

  let message =
`📋 Transaction Detail

🔗 Digest:
${tx.digest}

Status:
${status}

`;

  if (tx.effects?.gasUsed) {
    const gas      = tx.effects.gasUsed;
    const totalGas =
      Number(gas.computationCost) +
      Number(gas.storageCost) -
      Number(gas.storageRebate);

    message += `⛽ Gas Used:\n${totalGas / 1e9} SUI\n\n`;
  }

  if (eventData) {
    message +=
`💸 Transfer Data

Constraint ID:
${eventData.constraint_id}

Amount:
${Number(eventData.amount) / 1e9} SUI

Recipient:
${eventData.recipient}

Execution Time:
${new Date(Number(eventData.timestamp_ms)).toLocaleString()}

Walrus Blob ID:
${Buffer.from(eventData.audit_blob_id || []).toString()}

`;
  }

  message += `Explorer:\nhttps://suiscan.xyz/testnet/tx/${tx.digest}`;

  await tg('sendMessage', {
    chat_id: CHAT_ID,
    text: message,
    disable_web_page_preview: true,
  });
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

        const parts = u.message.text.trim().split(/\s+/);
        const cmd   = parts[0].split('@')[0].toLowerCase();
        const arg   = parts[1];

        if      (cmd === '/logs')   await handleLogs(arg);
        else if (cmd === '/tx')     await handleTx(arg);
        else if (cmd === '/freeze') await engageKillSwitch('Manual freeze via Telegram');
        else if (cmd === '/resume') await resumeSystem({ approvedBy: 'telegram:manual' });
        else if (cmd === '/status') {
          await tg('sendMessage', {
            chat_id: CHAT_ID,
            text:
`System Status:
Kill Switch: ${state.killSwitchState.engaged ? 'ENGAGED' : 'ACTIVE'}
Pending Approvals: ${state.pendingApprovals.size}`,
          });
        }
      }

      if (u.callback_query) {
        const cb = u.callback_query;

        const colonIdx  = cb.data.indexOf(':');
        const action     = cb.data.slice(0, colonIdx);
        const proposalId = cb.data.slice(colonIdx + 1);

        const approved = action === 'APPROVE';
        const approver = `telegram:${cb.from.username || cb.from.id}`;

        await tg('answerCallbackQuery', {
          callback_query_id: cb.id,
          text: approved ? '✅ Approved' : '❌ Rejected',
        });

        resolveApproval({ proposalId, approved, approvedBy: approver });

        await tg('sendMessage', {
          chat_id: CHAT_ID,
          text: approved
            ? `✅ Approved:\n${proposalId}`
            : `❌ Rejected:\n${proposalId}`,
        });
      }
    }
  } catch (err) {
    console.error('pollTelegram error:', err.message);
  }
}

async function start() {
  if (!ENABLED || state.started) return;

  state.started = true;
  console.log('🤖 Telegram bot running...');
  await clearWebhook();

  while (true) {
    await pollTelegram();
    await sleep(500);
  }
}

start();
