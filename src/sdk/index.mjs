import 'dotenv/config';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';

import { initWalrus, logProposal } from '../audit/walrus.mjs';
import { isFrozen } from '../state/kill-switch.mjs';

export const PACKAGE_ID = process.env.PACKAGE_ID;
const TEST_MODE = process.env.TEST_MODE === '1';
if (!PACKAGE_ID && !TEST_MODE) throw new Error('PACKAGE_ID missing in .env');

const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';

export const client = new SuiJsonRpcClient({ url: RPC_URL });

try {
  initWalrus();
} catch {
  console.warn('Walrus init failed');
}

function invariant(cond, msg) {
  if (!cond) throw new Error(msg);
}

function bytesOrEmpty(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [...Buffer.from(v, 'utf8')];
  return [];
}

function normalizeError(err) {
  const msg = err?.message ?? String(err);
  if (msg.includes('AWAITING_APPROVAL')) return { code: 'AWAITING_APPROVAL', error: msg };
  if (msg.includes('MoveAbort'))         return { code: 'MOVE_ABORT',         error: msg };
  if (msg.includes('TypeMismatch'))      return { code: 'TYPE_MISMATCH',      error: msg };
  return { code: 'SDK_ERROR', error: msg };
}

async function uploadToWalrus({ proposal, risk, constraint, signer }) {
  try {
    return await logProposal({
      proposal,
      risk,
      constraint,
      decision: 'PENDING',
      signer,
      approvedBy: signer.toSuiAddress(),
    });
  } catch {
    return null;
  }
}

function buildTransaction({ signer, guardCapId, constraint, amount, recipient, walrusBlobId }) {
  invariant(guardCapId, 'guardCapId required');
  invariant(constraint,  'constraint required');

  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());

  const constraintVal = tx.moveCall({
    target: `${PACKAGE_ID}::enforcer::mint_constraint`,
    arguments: [
      tx.object(guardCapId),
      tx.pure.u64(constraint.max_amount),
      tx.pure.address(constraint.allowed_recipient),
      tx.pure.u64(constraint.expiry_ms),
      tx.pure.vector('u8', bytesOrEmpty(constraint.nonce)),
      tx.pure.vector('u8', bytesOrEmpty(walrusBlobId)),
    ],
  });

  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amount)]);

  tx.moveCall({
    target: `${PACKAGE_ID}::enforcer::execute_transfer`,
    arguments: [
      constraintVal,
      coin,
      tx.pure.address(recipient),
      tx.object('0x6'),
    ],
  });

  return tx;
}

async function signAndExecute(tx, signer) {
  const { bytes, signature } = await tx.sign({ client, signer });
  return client.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: {
      showEffects: true,
      showEvents: true,
      showObjectChanges: true,
    },
  });
}

/**
 * Pure execution layer.
 * All policy checks, risk evaluation, alerts, and approvals
 * must be handled by brain.mjs BEFORE calling this function.
 */
export async function mintAndExecute({
  signer,
  guardCapId,
  constraint,
  amount,
  recipient,
  proposal,
  risk,
}) {
  if (TEST_MODE) {
    return {
      ok: true,
      digest: '0xTEST_' + Date.now(),
      walrusBlobId: 'walrus-test-' + Date.now(),
      effects: { status: { status: 'success' } },
      events: [],
    };
  }

  try {
    if (isFrozen()) {
      return {
        ok: false,
        decision: 'BLOCKED',
        layer: 'KILL_SWITCH',
        reason: 'Agent frozen by safety system',
      };
    }

    let walrusBlobId = null;
    if (proposal && risk) {
      walrusBlobId = await uploadToWalrus({ proposal, risk, constraint, signer });
    }

    const tx = buildTransaction({
      signer,
      guardCapId,
      constraint,
      amount,
      recipient,
      walrusBlobId,
    });

    const result = await signAndExecute(tx, signer);

    if (result.effects?.status.status !== 'success') {
      throw new Error(JSON.stringify(result.effects.status));
    }

    return {
      ok: true,
      digest: result.digest,
      walrusBlobId,
      effects: result.effects,
      events: result.events ?? [],
    };
  } catch (err) {
    return {
      ok: false,
      ...normalizeError(err),
    };
  }
}
