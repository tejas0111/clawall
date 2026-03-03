import 'dotenv/config';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { initWalrus, logProposal } from '../audit/walrus.mjs';
import { isFrozen } from '../state/kill-switch.mjs';
import { logSecurityEvent } from '../observability/security-events.mjs';

export const PACKAGE_ID = process.env.PACKAGE_ID;
const RPC_URL = process.env.RPC_URL ?? 'https://fullnode.testnet.sui.io:443';
export const client = new SuiJsonRpcClient({ url: RPC_URL });

try { initWalrus(); } catch (err) { console.warn('Walrus init failed:', err.message); }

function bytesOrEmpty(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') return [...Buffer.from(v, 'utf8')];
  return [];
}

function buildTransaction({ signer, guardCapId, freezeStateId, vaultId, constraint, walrusBlobId }) {
  const tx = new Transaction();
  tx.setSender(signer.toSuiAddress());

  // Dynamic type argument support for any coin (SUI, WAL, etc.)
  const coinType = constraint.coin_type || '0x2::sui::SUI';

  const constraintVal = tx.moveCall({
    target: `${PACKAGE_ID}::enforcer::mint_constraint`,
    arguments: [
      tx.object(guardCapId),
      tx.pure.u64(constraint.max_amount),
      tx.pure.address(constraint.allowed_recipient),
      tx.pure.vector('u8', bytesOrEmpty(coinType)),
      tx.pure.u64(constraint.expiry_ms),
      tx.pure.vector('u8', bytesOrEmpty(constraint.nonce)),
      tx.pure.vector('u8', bytesOrEmpty(walrusBlobId)),
    ],
  });

  tx.moveCall({
    target: `${PACKAGE_ID}::enforcer::execute_transfer_from_vault`,
    typeArguments: [coinType],
    arguments: [
      constraintVal,
      tx.object(vaultId),
      tx.pure.address(constraint.allowed_recipient),
      tx.object(freezeStateId),
      tx.object('0x6'),
      tx.pure.vector('u8', bytesOrEmpty(coinType)),
    ],
  });

  return tx;
}

export async function mintAndExecute({ signer, guardCapId, freezeStateId, vaultId, constraint, proposal, risk }) {
  if (isFrozen()) return { ok: false, decision: 'BLOCKED', layer: 'KILL_SWITCH', reason: 'Agent frozen' };

  // 1. Mandatory Walrus audit logging
  let finalBlobId = null;
  try {
    console.log('[audit] submitting proposal to Walrus...');
    finalBlobId = await logProposal({ proposal, risk, constraint, signer });
    if (!finalBlobId) throw new Error('Walrus returned empty blob ID');
    console.log(`[audit] anchor: ${finalBlobId}`);
  } catch (err) {
    console.error('[audit] CRITICAL: Audit logging failed. Blocking transaction for safety.', err.message);
    return { 
      ok: false, 
      decision: 'BLOCKED', 
      layer: 'AUDIT', 
      reason: `Audit submission failed: ${err.message}. Transaction aborted for safety.` 
    };
  }

  try {
    // 2. Prepare and Execute Transaction with REAL Walrus ID
    const tx = buildTransaction({ 
      signer, guardCapId, freezeStateId, vaultId, constraint, 
      walrusBlobId: finalBlobId 
    });
    
    const coins = await client.getCoins({ owner: signer.toSuiAddress() });
    if (coins.data.length > 1) {
      const sorted = coins.data.sort((a, b) => Number(b.balance) - Number(a.balance));
      tx.setGasPayment(sorted.map(c => ({ objectId: c.coinObjectId, version: c.version, digest: c.digest })));
    }

    const { bytes, signature } = await tx.sign({ client, signer });
    const result = await client.executeTransactionBlock({
      transactionBlock: bytes, signature,
      options: { showEffects: true }
    });

    logSecurityEvent('sdk.tx_submitted', {
      proposal_id: proposal?.id ?? null,
      digest: result?.digest ?? null,
      coin_type: constraint?.coin_type ?? null,
      amount: constraint?.max_amount ?? null,
      recipient: constraint?.allowed_recipient ?? null,
    });

    if (result.effects?.status.status !== 'success') throw new Error(JSON.stringify(result.effects.status));

    logSecurityEvent('sdk.tx_success', {
      proposal_id: proposal?.id ?? null,
      digest: result.digest,
      walrus_blob_id: finalBlobId,
      coin_type: constraint?.coin_type ?? null,
      amount: constraint?.max_amount ?? null,
      recipient: constraint?.allowed_recipient ?? null,
      risk_level: risk?.risk_level ?? null,
      risk_score: risk?.risk_score ?? null,
    });

    return { 
      ok: true, 
      decision: 'EXECUTED', 
      digest: result.digest, 
      walrus_blob_id: finalBlobId 
    };
  } catch (err) {
    console.error('[sdk] execution error:', err.message);
    logSecurityEvent('sdk.tx_failure', {
      proposal_id: proposal?.id ?? null,
      reason: err?.message ?? String(err),
      coin_type: constraint?.coin_type ?? null,
      amount: constraint?.max_amount ?? null,
      recipient: constraint?.allowed_recipient ?? null,
      risk_level: risk?.risk_level ?? null,
      risk_score: risk?.risk_score ?? null,
    });
    return { ok: false, decision: 'FAILED', layer: 'SDK', error: err.message, reason: err.message };
  }
}
