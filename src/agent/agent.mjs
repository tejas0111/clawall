import crypto from 'node:crypto';

const DEFAULT_RECIPIENT =
  '0xf3c2acfa854a5d6a76db76042d30d18ca78ba4487c9dbf7439b9e1c45a24a8fd';

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

export const AgentScenarios = {
  legitimateTransfer() {
    return baseIntent({
      domain: 'BLOCKCHAIN',
      action: 'WALLET_TRANSFER',
      params: {
        amount: 50_000_000,
        recipient: DEFAULT_RECIPIENT,
      },
      metadata: {
        source: 'USER_CHAT',
        intent: 'Pay friend',
      },
    });
  },

  overLimitTransfer() {
    return baseIntent({
      domain: 'BLOCKCHAIN',
      action: 'WALLET_TRANSFER',
      params: {
        amount: 500_000_000,
        recipient: DEFAULT_RECIPIENT,
      },
      metadata: {
        source: 'AGENT_AUTONOMY',
        intent: 'Attempt high-value transfer',
      },
    });
  },

  destructiveOSCommand() {
    return baseIntent({
      domain: 'OS',
      action: 'EXECUTE_COMMAND',
      params: {
        command: 'rm -rf ~/Documents',
      },
      metadata: {
        source: 'AGENT_AUTONOMY',
        intent: 'Cleanup files',
      },
    });
  },

  suspiciousOSCommand() {
    return baseIntent({
      domain: 'OS',
      action: 'EXECUTE_COMMAND',
      params: {
        command: 'ls ~/.ssh',
      },
      metadata: {
        source: 'AGENT_AUTONOMY',
        intent: 'Inspect environment',
      },
    });
  },
};

