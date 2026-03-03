import crypto from 'node:crypto';
import {
  startTelegramBot,
  sendApprovalRequest,
  waitForApproval,
} from './telegram-bot.mjs';

const APPROVAL_TIMEOUT_MS = Number.isFinite(
  Number(process.env.APPROVAL_TIMEOUT_MS)
)
  ? Number(process.env.APPROVAL_TIMEOUT_MS)
  : 60_000;

function shortTokenHex(sizeBytes = 4) {
  return crypto.randomBytes(sizeBytes).toString('hex');
}

function getProposalSignerAddress(proposal) {
  try {
    const signer = proposal?.metadata?.signer;
    if (signer && typeof signer.toSuiAddress === 'function') {
      return signer.toSuiAddress();
    }
  } catch {
    // Ignore signer parsing issues and fall back.
  }
  return String(proposal?.metadata?.signer_address ?? '');
}

export function buildApprovalDigest({ proposal, risk, approvalExpiryMs }) {
  const payload = {
    id: proposal?.id ?? null,
    domain: proposal?.domain ?? null,
    action: proposal?.action ?? null,
    amount: proposal?.params?.amount ?? null,
    recipient: proposal?.params?.recipient ?? null,
    signer: getProposalSignerAddress(proposal) || null,
    approval_expiry_ms: Number.isFinite(Number(approvalExpiryMs))
      ? Number(approvalExpiryMs)
      : null,
    risk_level: risk?.risk_level ?? null,
    risk_score: risk?.risk_score ?? null,
  };

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

export async function requestApproval({ proposal, risk }) {
  if (!proposal || !risk) {
    return {
      approved: false,
      reason: 'Missing proposal or risk',
    };
  }

  const approvalExpiryMs = Date.now() + APPROVAL_TIMEOUT_MS;
  const approvalDigest = buildApprovalDigest({
    proposal,
    risk,
    approvalExpiryMs,
  });
  const oneTimeToken = shortTokenHex(4);

  try {
    await startTelegramBot();
    await sendApprovalRequest({
      proposal,
      risk,
      approvalDigest,
      approvalExpiryMs,
      oneTimeToken,
    });

    const decision = await waitForApproval({
      proposalId: proposal.id,
      timeoutMs: APPROVAL_TIMEOUT_MS,
      approvalDigest,
      approvalExpiryMs,
      oneTimeToken,
    });

    if (!decision?.approved) {
      return {
        approved: false,
        reason: decision?.reason ?? 'Approval denied or timed out',
      };
    }

    return decision;
  } catch (err) {
    return {
      approved: false,
      reason: err?.message ?? 'Approval system failure',
    };
  }
}
