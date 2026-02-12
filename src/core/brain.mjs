import { inspectIntent }    from '../enforcement/intent-firewall.mjs';
import { rankRisk }          from '../risk/risk-engine.mjs';
import { evaluatePolicy }    from '../risk/policy.mjs';
import { sendAlert, sendFreezeAlert } from '../governance/alerts.mjs';
import { requestApproval }   from '../governance/approval.mjs';
import { mintAndExecute }    from '../sdk/index.mjs';
import { freeze, isFrozen, unfreeze } from '../state/kill-switch.mjs';
import { enforceOSPolicy }   from '../enforcement/os-policy.mjs';

const agentState = {
  recentOSViolations: 0,
  recentHighRiskTx:   0,
  globalFreeze:       false,
  freezeReason:       null,
};

export async function processIntent(intent, context = {}) {

  if (isFrozen()) {
    await sendAlert({
      level:   'CRITICAL',
      domain:  'GLOBAL',
      stage:   'KILL_SWITCH',
      message: 'Agent blocked by kill-switch',
      reason:  'Kill-switch engaged',
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'KILL_SWITCH',
      reason:   'Kill-switch engaged',
    };
  }

  if (agentState.globalFreeze) {
    await sendAlert({
      level:   'CRITICAL',
      domain:  'GLOBAL',
      stage:   'KILL_SWITCH',
      message: 'Agent globally frozen',
      reason:  agentState.freezeReason,
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'KILL_SWITCH',
      reason:   agentState.freezeReason || 'Agent globally frozen',
    };
  }

  if (agentState.recentOSViolations > 0 && intent.domain === 'BLOCKCHAIN') {
    await sendAlert({
      level:   'CRITICAL',
      domain:  'CROSS_DOMAIN',
      stage:   'KILL_SWITCH',
      message: 'Blockchain action blocked due to prior OS violation',
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'CROSS_DOMAIN',
      reason:   'OS violation triggered blockchain freeze',
    };
  }

  const firewall = inspectIntent(intent);

  if (!firewall.allowed) {
    await recordViolation(intent, firewall.severity, firewall.reason);
    await sendAlert({
      level:   firewall.severity,
      domain:  intent.domain,
      stage:   'FIREWALL',
      message: 'Agent action blocked by intent firewall',
      reason:  firewall.reason,
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'FIREWALL',
      reason:   firewall.reason,
      severity: firewall.severity,
    };
  }

  const risk = rankRisk(intent, {
    ...context,
    recentOSViolations: agentState.recentOSViolations,
    recentHighRiskTx:   agentState.recentHighRiskTx,
  });

  const policy = evaluatePolicy(risk);

  if (policy.alert) {
    try {
      await sendAlert({
        level:   risk.risk_level,
        domain:  intent.domain,
        stage:   'RISK_ENGINE',
        message: 'Risk policy alert triggered',
        reason:  policy.reason,
        risk,
        intent,
      });
    } catch (err) {
      console.error('[brain] sendAlert failed:', err.message);
    }
  }
  if (policy.action === 'BLOCK') {
    recordHighRisk(intent);
    await sendAlert({
      level:   'HIGH',
      domain:  intent.domain,
      stage:   'RISK_ENGINE',
      message: 'Agent action blocked due to high risk',
      reason:  policy.reason,
      risk,
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'RISK_ENGINE',
      risk,
      reason:   policy.reason,
    };
  }

  if (policy.action === 'REQUIRE_APPROVAL') {
    const approval = await requestApproval({ proposal: intent, risk });
    if (!approval?.approved) {
      return {
        ok:       false,
        decision: 'AWAITING_APPROVAL',
        layer:    'GOVERNANCE',
        risk,
        reason:   'Approval denied or timed out',
      };
    }
  }

  switch (intent.domain) {
    case 'OS':         return executeOS(intent, risk);
    case 'BLOCKCHAIN': return executeBlockchain(intent, risk);
    default:
      return {
        ok:       false,
        decision: 'BLOCKED',
        layer:    'BRAIN',
        reason:   `Unsupported domain: ${intent.domain}`,
      };
  }
}

async function executeOS(intent, risk) {
  const osCheck = enforceOSPolicy(intent.params);
  if (!osCheck.allowed) {
    await recordViolation(intent, osCheck.severity, osCheck.reason);
    await sendAlert({
      level:   osCheck.severity,
      domain:  'OS',
      stage:   'OS_POLICY',
      message: 'Agent violated OS safety policy',
      reason:  osCheck.reason,
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'OS_POLICY',
      reason:   osCheck.reason,
    };
  }
  return {
    ok:      true,
    decision: 'EXECUTED',
    domain:  'OS',
    message: 'OS command allowed (simulated execution)',
    command: intent.params?.command,
    risk,
  };
}

async function executeBlockchain(intent, risk) {
  const { signer, guardCapId, constraint } = intent.metadata || {};

  if (!signer || !guardCapId || !constraint) {
    await sendAlert({
      level:   'HIGH',
      domain:  'BLOCKCHAIN',
      stage:   'BRAIN',
      message: 'Blockchain execution metadata missing',
      intent,
    });
    return {
      ok:       false,
      decision: 'BLOCKED',
      layer:    'BRAIN',
      reason:   'Missing blockchain execution metadata',
    };
  }
  const result = await mintAndExecute({
    signer,
    guardCapId,
    constraint,
    amount:    intent.params.amount,
    recipient: intent.params.recipient,
    proposal:  intent,
    risk,
  });

  if (!result.ok) {
    recordHighRisk(intent);
    await sendAlert({
      level:   'HIGH',
      domain:  'BLOCKCHAIN',
      stage:   'EXECUTION',
      message: 'Blockchain execution failed or rejected',
      reason:  result.reason ?? result.error,
      result,
      intent,
    });
  }

  return result;
}

async function recordViolation(intent, severity, reason) {
  if (intent.domain === 'OS' && severity === 'CRITICAL') {
    agentState.recentOSViolations += 1;
    agentState.globalFreeze  = true;
    agentState.freezeReason  = reason || 'Critical OS integrity violation';
    freeze({ reason: agentState.freezeReason, by: 'OS_FIREWALL' });
    await sendFreezeAlert({
      reason: agentState.freezeReason,
      source: 'OS_FIREWALL',
      intent,
    });
  }
}

function recordHighRisk(intent) {
  if (intent.domain === 'BLOCKCHAIN') {
    agentState.recentHighRiskTx += 1;
  }
}

export function resetAgentState() {
  agentState.recentOSViolations = 0;
  agentState.recentHighRiskTx   = 0;
  agentState.globalFreeze       = false;
  agentState.freezeReason       = null;
  unfreeze('RESET_AGENT_STATE');
}
