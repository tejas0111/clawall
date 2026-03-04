import crypto from 'node:crypto';
import { inspectIntent }    from '../enforcement/intent-firewall.mjs';
import { rankRisk, RISK_POLICY } from '../risk/risk-engine.mjs';
import { evaluatePolicy }    from '../risk/policy.mjs';
import { requestApproval } from '../governance/approval.mjs';
import { sendAlert, sendFreezeAlert } from '../governance/alerts.mjs';
import { mintAndExecute }    from '../chain/sui-transaction-gateway.mjs';
import { freeze, isFrozen, unfreeze, status as killSwitchStatus } from '../state/kill-switch.mjs';
import { enforceOSPolicy }   from '../enforcement/os-policy.mjs';
import { logSecurityEvent }  from '../observability/security-events.mjs';
import { assertPolicyBundleIntegrity } from '../enforcement/policy-integrity.mjs';
import { assertPolicyAnchorIntegrity } from '../enforcement/policy-anchor.mjs';
import { inspectPromptQuarantine } from '../enforcement/prompt-quarantine.mjs';
import { deriveIntentProvenance } from '../enforcement/provenance.mjs';
import { computeTransferPricing } from '../risk/market-data.mjs';
import { agentState as persistentState } from '../state/agent-state.mjs';

const RISK_HISTORY_WINDOW_MS = RISK_POLICY.LIMITS.DRAIN_TIME_MIN * 60_000;
const HIGH_RISK_RETENTION_MS = 24 * 60 * 60_000; 
const VELOCITY_WINDOW_MS = RISK_POLICY.LIMITS.FAST_WINDOW_SEC * 1_000;
const DEFAULT_CONSTRAINT_TTL_MS = 5 * 60_000;
const MIN_CONSTRAINT_TTL_MS = 30_000;
const MAX_CONSTRAINT_TTL_MS = 24 * 60 * 60 * 1_000;

function nowMs() { return Date.now(); }

function getAgentState() {
  const state = persistentState.get();
  // Sync global freeze from kill-switch file state
  if (isFrozen() && !state.globalFreeze) {
    state.globalFreeze = true;
  }
  return state;
}

function pruneHighRiskHistory(state, now = nowMs()) {
  state.highRiskTxHistory = (state.highRiskTxHistory || []).filter(
    (ts) => now - ts <= HIGH_RISK_RETENTION_MS
  );
}

function recordHighRisk(intent) {
  if (intent.domain === 'BLOCKCHAIN') {
    persistentState.update((state) => {
      state.highRiskTxHistory = state.highRiskTxHistory || [];
      state.highRiskTxHistory.push(nowMs());
      return state;
    });
  }
}

function getRecentHighRiskCount() {
  const state = getAgentState();
  const now = nowMs();
  const filtered = (state.highRiskTxHistory || []).filter(
    (ts) => now - ts <= HIGH_RISK_RETENTION_MS
  );
  return filtered.length;
}

const SEQUENCE_BLOCK_THRESHOLD = Number.isFinite(Number(process.env.SEQUENCE_BLOCK_THRESHOLD))
  ? Math.max(1, Number(process.env.SEQUENCE_BLOCK_THRESHOLD))
  : 3;

const OS_FREEZE_DURATION_MS = 24 * 60 * 60_000;
const ENFORCE_CAP_ISOLATION = String(process.env.ENFORCE_CAP_ISOLATION ?? '1') !== '0';
const ENABLE_OS_ENFORCEMENT = String(process.env.CLAWALL_ENABLE_OS_ENFORCEMENT ?? '0') === '1';

function assertRuntimeCapIsolation() {
  if (!ENFORCE_CAP_ISOLATION) return;
  if (String(process.env.POLICY_CAP_ID ?? '').trim()) {
    throw new Error('Runtime cap isolation violation: POLICY_CAP_ID must not be set on runtime host');
  }
}

function getConstraintTtlMs() {
  const raw = Number(process.env.CONSTRAINT_TTL_MS);
  if (!Number.isFinite(raw) || raw < MIN_CONSTRAINT_TTL_MS || raw > MAX_CONSTRAINT_TTL_MS) {
    return DEFAULT_CONSTRAINT_TTL_MS;
  }
  return Math.floor(raw);
}

function pruneTxHistory(state, now = nowMs()) {
  state.txHistory = (state.txHistory || []).filter(e => now - e.ts <= RISK_HISTORY_WINDOW_MS);
}

function pushSequenceSignal({ type, severity, reason, domain }) {
  persistentState.update((state) => {
    state.sequenceSignals = state.sequenceSignals || [];
    state.sequenceSignals.push({ ts: nowMs(), type, severity, reason, domain });
    const window = 5 * 60_000;
    state.sequenceSignals = state.sequenceSignals.filter(s => nowMs() - s.ts <= window);
    return state;
  });
}

function shouldBlockBlockchainBySequence() {
  const state = getAgentState();
  const hardSignals = (state.sequenceSignals || []).filter(
    s => s.domain === 'OS' && (s.severity === 'CRITICAL' || s.severity === 'HIGH')
  );
  return hardSignals.length >= SEQUENCE_BLOCK_THRESHOLD;
}

function buildDerivedBlockchainRiskContext(intent) {
  const now = nowMs();
  const state = getAgentState();
  
  // Prune local copy for calculation
  const txHistory = (state.txHistory || []).filter(e => now - e.ts <= RISK_HISTORY_WINDOW_MS);
  
  const amount = Number(intent?.params?.amount) || 0;
  const recipient = intent?.params?.recipient;
  const transferUsd = Number(intent?.params?.transfer_value_usd ?? 0);

  const recentSpend = txHistory.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  const recentSpendUsd = txHistory.reduce((sum, tx) => sum + (Number(tx.transfer_usd) || 0), 0);
  const txVelocity = txHistory.filter(tx => now - tx.ts <= VELOCITY_WINDOW_MS).length;
  const smallTxBurstCount = txHistory.filter(
    tx => Number(tx.amount) > 0 && Number(tx.amount) <= RISK_POLICY.LIMITS.SMALL_TX_MAX
  ).length;

  return {
    recentSpend: recentSpend + amount,
    recentSpendUsd: recentSpendUsd + transferUsd,
    recentTxCount: txHistory.length + 1,
    txVelocity: txVelocity,
    smallTxBurstCount: smallTxBurstCount,
    repeatedRecipient: recipient ? txHistory.some(tx => tx.recipient === recipient) : false,
    smallChunkBurst: (smallTxBurstCount + (amount <= RISK_POLICY.LIMITS.SMALL_TX_MAX ? 1 : 0)) >= RISK_POLICY.LIMITS.SMALL_TX_BURST,
  };
}

function finalizeDecision(intent, result, risk = null) {
  logSecurityEvent('brain.decision', {
    intent_id: intent?.id,
    domain: intent?.domain,
    decision: result?.decision,
    layer: result?.layer,
    reason: result?.reason,
    risk_level: risk?.risk_level ?? result?.risk?.risk_level,
    risk_score: risk?.risk_score ?? result?.risk?.risk_score ?? null,
    digest: result?.digest ?? null,
    walrus_blob_id: result?.walrus_blob_id ?? result?.walrusBlobId ?? null,
    proposal_id: intent?.id ?? null,
    recipient: intent?.params?.recipient ?? null,
    amount: intent?.params?.amount ?? null,
    coin_type: intent?.params?.coin_type ?? null,
  });
  return result;
}

async function engageTamperFreeze(intent, layer, reason) {
  const freezeReason = reason || 'Policy tamper detection triggered safety freeze';
  if (!isFrozen()) freeze({ reason: freezeReason, by: layer });
  persistentState.update((state) => {
    state.globalFreeze = true;
    state.freezeReason = freezeReason;
    return state;
  });
  await sendFreezeAlert({ reason: freezeReason, source: layer, intent });
  return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer, reason: freezeReason });
}

export async function processIntent(intent, context = {}) {
  try {
    assertRuntimeCapIsolation();
    const policyIntegrity = assertPolicyBundleIntegrity();
    await assertPolicyAnchorIntegrity({ expectedSha256: policyIntegrity.computed_sha256 });
  } catch (err) {
    return engageTamperFreeze(intent, 'TAMPER_GUARD', err.message);
  }

  const state = getAgentState();
  if (isFrozen() || state.globalFreeze) {
    const reason = isFrozen() ? (killSwitchStatus().reason || 'Agent globally frozen (kill-switch file)') : (state.freezeReason || 'Agent globally frozen (in-memory state)');
    return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'KILL_SWITCH', reason });
  }

  const quarantine = inspectPromptQuarantine(intent);
  if (!quarantine.allowed) {
    return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'QUARANTINE', reason: quarantine.reason });
  }

  // CROSS-DOMAIN ENFORCEMENT
  if (
    ENABLE_OS_ENFORCEMENT &&
    intent.domain === 'BLOCKCHAIN' &&
    (state.recentOSViolations > 0 || shouldBlockBlockchainBySequence())
  ) {
    const reason = 'Blockchain blocked due to prior OS security violations';
    await sendAlert({ level: 'CRITICAL', domain: 'CROSS_DOMAIN', stage: 'FIREWALL', message: reason, intent });
    return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'CROSS_DOMAIN', reason });
  }

  let osPreflightFlagReason = null;
  const firewall = inspectIntent(intent);
  if (!firewall.allowed) {
    if (intent.domain === 'OS' && !ENABLE_OS_ENFORCEMENT) {
      osPreflightFlagReason = firewall.reason;
      logSecurityEvent('os_firewall.audit_flagged', {
        intent_id: intent?.id,
        severity: firewall.severity ?? null,
        reason: firewall.reason ?? null,
      });
    } else {
      pushSequenceSignal({ type: 'FIREWALL_BLOCK', severity: firewall.severity, reason: firewall.reason, domain: intent.domain });
      await recordViolation(intent, firewall.severity, firewall.reason);
      return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'FIREWALL', reason: firewall.reason });
    }
  }

  const executionIntent = { ...intent, params: { ...intent.params } };
  if (executionIntent.domain === 'BLOCKCHAIN') {
    const pricing = await computeTransferPricing({ coinType: executionIntent.params.coin_type, amountRaw: executionIntent.params.amount });
    executionIntent.params.transfer_value_usd = pricing?.transferUsd ?? null;
  }

  const risk = rankRisk(executionIntent, {
    ...context,
    ...(executionIntent.domain === 'BLOCKCHAIN' ? buildDerivedBlockchainRiskContext(executionIntent) : {}),
    recentOSViolations: state.recentOSViolations,
    recentHighRiskTx: getRecentHighRiskCount(),
    transferUsd: executionIntent.params.transfer_value_usd,
  });

  const policy = evaluatePolicy(risk);
  if (policy.action === 'BLOCK') {
    recordHighRisk(intent);
    return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'RISK_ENGINE', risk, reason: policy.reason }, risk);
  }

  if (policy.action === 'REQUIRE_APPROVAL') {
    const approval = await requestApproval({ proposal: executionIntent, risk });
    if (!approval?.approved) {
      return finalizeDecision(
        intent,
        {
          ok: false,
          decision: 'BLOCKED',
          layer: 'GOVERNANCE',
          reason:
            approval?.reason ??
            'GOV_APPROVAL_DENIED: Approval not granted (rejected or timed out).',
        },
        risk
      );
    }
  }

  return executionIntent.domain === 'OS'
    ? executeOS(executionIntent, risk, osPreflightFlagReason)
    : executeBlockchain(executionIntent, risk);
}

async function executeOS(intent, risk, preflightFlagReason = null) {
  if (preflightFlagReason) {
    return finalizeDecision(intent, {
      ok: true,
      decision: 'FLAGGED',
      layer: 'OS_POLICY',
      reason: preflightFlagReason,
      mode: ENABLE_OS_ENFORCEMENT ? 'enforce' : 'audit',
    }, risk);
  }

  const osCheck = enforceOSPolicy(intent.params, { provenance: deriveIntentProvenance(intent) });
  if (!osCheck.allowed) {
    if (ENABLE_OS_ENFORCEMENT) {
      await recordViolation(intent, osCheck.severity, osCheck.reason);
      return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'OS_POLICY', reason: osCheck.reason }, risk);
    }
    logSecurityEvent('os_policy.audit_flagged', {
      intent_id: intent?.id,
      severity: osCheck.severity ?? null,
      reason: osCheck.reason ?? null,
    });
    return finalizeDecision(intent, {
      ok: true,
      decision: 'FLAGGED',
      layer: 'OS_POLICY',
      reason: osCheck.reason,
      mode: 'audit',
    }, risk);
  }
  return finalizeDecision(intent, { ok: true, decision: 'EXECUTED', domain: 'OS', risk }, risk);
}

async function executeBlockchain(intent, risk) {
  const { signer, guardCapId, freezeStateId, vaultId } = intent.metadata || {};
  if (!signer || !guardCapId || !vaultId) {
    return finalizeDecision(intent, { ok: false, decision: 'BLOCKED', layer: 'BRAIN', reason: 'Missing execution metadata (signer/cap/vault)' }, risk);
  }

  const result = await mintAndExecute({
    signer, guardCapId, freezeStateId, vaultId,
    amount: intent.params.amount,
    recipient: intent.params.recipient,
    constraint: {
      max_amount: intent.params.amount,
      allowed_recipient: intent.params.recipient,
      coin_type: intent.params.coin_type || '0x2::sui::SUI',
      expiry_ms: nowMs() + getConstraintTtlMs(),
      nonce: crypto.randomUUID().replace(/-/g, ''),
    },
    proposal: intent, risk
  });

  if (result.ok) {
    persistentState.update((state) => {
      state.txHistory = state.txHistory || [];
      state.txHistory.push({ ts: nowMs(), amount: intent.params.amount, transfer_usd: intent.params.transfer_value_usd, recipient: intent.params.recipient });
      return state;
    });
  } else {
    recordHighRisk(intent);
  }
  return finalizeDecision(intent, result, risk);
}

async function recordViolation(intent, severity, reason) {
  if (!ENABLE_OS_ENFORCEMENT) {
    logSecurityEvent('os_violation.audit_only', {
      intent_id: intent?.id,
      severity: severity ?? null,
      reason: reason ?? null,
      domain: intent?.domain ?? null,
    });
    return;
  }
  if (intent.domain === 'OS' && severity === 'CRITICAL') {
    persistentState.update((state) => {
      state.recentOSViolations = (state.recentOSViolations || 0) + 1;
      state.globalFreeze = true;
      state.freezeReason = reason;
      return state;
    });
    freeze({ reason, by: 'OS_FIREWALL', durationMs: OS_FREEZE_DURATION_MS });
    await sendFreezeAlert({ reason, source: 'OS_FIREWALL', intent });
  }
}

export function resetAgentState() {
  persistentState.reset();
  unfreeze('RESET_AGENT_STATE');
}
