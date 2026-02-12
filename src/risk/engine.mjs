import crypto from 'node:crypto';
import { rankRisk } from './risk-engine.mjs';
import { evaluatePolicy } from './policy.mjs';

export function assessRisk(proposal, context = {}) {
  const risk = rankRisk(proposal, context);
  const policy = evaluatePolicy(risk);

  return {
    ...risk,
    policy,
  };
}

export function proposalToConstraint(proposal, options = {}) {
  const now = Date.now();

  return {
    max_amount: proposal.params.amount,
    allowed_recipient: proposal.params.recipient,
    expiry_ms: options.expiryMs ?? now + 5 * 60 * 1000,
    nonce:
      options.nonce ??
      crypto.randomUUID().replace(/-/g, '').slice(0, 32),
  };
}

