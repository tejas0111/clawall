import {
  sendApprovalRequest,
  waitForApproval,
} from './telegram-bot.mjs';

const APPROVAL_TIMEOUT_MS = Number.isFinite(
  Number(process.env.APPROVAL_TIMEOUT_MS)
)
  ? Number(process.env.APPROVAL_TIMEOUT_MS)
  : 60_000;

export async function requestApproval({ proposal, risk }) {
  if (!proposal || !risk) {
    return {
      approved: false,
      reason: 'Missing proposal or risk',
    };
  }

  try {
    await sendApprovalRequest({ proposal, risk });

    const decision = await waitForApproval({
      proposalId: proposal.id,
      timeoutMs: APPROVAL_TIMEOUT_MS,
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

