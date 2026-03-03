import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function freshImport(workspaceRelativePath) {
  const abs = path.resolve(process.cwd(), workspaceRelativePath);
  const href = pathToFileURL(abs).href;
  return import(`${href}?t=${Date.now()}_${Math.random()}`);
}

function withEnv(overrides, fn) {
  const previous = { ...process.env };
  const overrideKeys = Object.keys(overrides);
  Object.assign(process.env, overrides);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous) && overrideKeys.includes(key)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    });
}

test('telegram governance authorization blocks non-allowlisted /resume', { concurrency: false }, async () => {
  await withEnv(
    {
      TG_BOT_TOKEN: 'token',
      TG_CHAT_ID: 'chat',
      TG_OPERATOR_IDS: '42',
      TG_OPERATOR_USERNAMES: '',
    },
    async () => {
      const mod = await freshImport('src/governance/telegram-bot.mjs');
      const unauthorized = mod.isGovernanceActionAuthorized('/resume', { id: 7, username: 'guest' });
      const authorized = mod.isGovernanceActionAuthorized('/resume', { id: 42, username: 'admin' });

      assert.equal(unauthorized, false);
      assert.equal(authorized, true);
    }
  );
});

test('intent firewall rejects malformed blockchain intent', async () => {
  const { inspectIntent } = await freshImport('src/enforcement/intent-firewall.mjs');
  const result = inspectIntent({
    domain: 'BLOCKCHAIN',
    action: 'WALLET_TRANSFER',
    params: {
      amount: -5,
      recipient: '0x1',
    },
  });

  assert.equal(result.allowed, false);
  assert.match(result.reason, /Malformed blockchain intent parameters/);
});

test('sdk blocks execution when audit upload fails', { concurrency: false }, async () => {
  await withEnv(
    {
      TEST_MODE: '0',
      PACKAGE_ID: '0x123',
      FREEZE_STATE_ID: '0xdef',
      RPC_URL: 'https://fullnode.testnet.sui.io:443',
      OS_QUILT_ENABLED: '0',
      WALRUS_MAX_RETRIES: '1',
    },
    async () => {
      // Import the gateway which has our production logic
      const { mintAndExecute } = await freshImport('src/chain/sui-transaction-gateway.mjs');
      const { unfreeze } = await freshImport('src/state/kill-switch.mjs');
      unfreeze('TEST_SETUP');
      
      const recipient = `0x${'1'.repeat(64)}`;

      // In real code, logProposal uses Walrus. We can't easily mock internal 
      // module-level imports like logProposal without a heavy mocking lib.
      // However, we can test that when it fails (which it will without Walrus setup),
      // it returns the correct layer.
      
      const result = await mintAndExecute({
        signer: { toSuiAddress: () => recipient },
        guardCapId: '0xabc',
        vaultId: '0xvault',
        constraint: {
          max_amount: 10,
          allowed_recipient: recipient,
          coin_type: '0x2::sui::SUI',
          expiry_ms: Date.now() + 60_000,
          nonce: [],
        },
        amount: 10,
        recipient,
        proposal: { id: 'proposal-1' },
        risk: { risk_level: 'LOW', risk_score: 10, reasoning: 'test' },
      });

      assert.equal(result.ok, false);
      assert.equal(result.decision, 'BLOCKED');
      assert.equal(result.layer, 'AUDIT');
    }
  );
});

test('policy tamper mismatch auto-freezes runtime', { concurrency: false }, async () => {
  await withEnv(
    {
      POLICY_INTEGRITY_MODE: 'strict',
      POLICY_BUNDLE_SHA256_SOURCE: 'process',
      POLICY_BUNDLE_SHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      POLICY_ANCHOR_MODE: 'off',
      POLICY_CAP_ID: '',
      ENFORCE_CAP_ISOLATION: '1',
      OS_QUILT_ENABLED: '0',
      TG_BOT_TOKEN: '',
      TG_CHAT_ID: '',
      TG_OPERATOR_IDS: '',
      TG_OPERATOR_USERNAMES: '',
    },
    async () => {
      // Clear caches
      delete globalThis[Symbol.for('clawall.policy_integrity.cache')];
      delete globalThis[Symbol.for('clawall.policy_anchor.cache')];
      
      const { processIntent, resetAgentState } = await freshImport('src/orchestrator/intent-orchestrator.mjs');
      const { status, unfreeze } = await freshImport('src/state/kill-switch.mjs');

      const result = await processIntent({
        id: 'tamper-guard-test',
        domain: 'BLOCKCHAIN',
        action: 'WALLET_TRANSFER',
        params: { amount: 1, recipient: `0x${'9'.repeat(64)}` },
        metadata: { source: 'USER_CHAT' },
      });

      assert.equal(result.ok, false);
      assert.equal(result.layer, 'TAMPER_GUARD');

      const state = status();
      assert.equal(state.frozen, true);
      assert.equal(state.triggered_by, 'TAMPER_GUARD');

      unfreeze('TEST_CLEANUP');
      resetAgentState();
    }
  );
});

test('runtime cap isolation auto-freezes when POLICY_CAP_ID is present', { concurrency: false }, async () => {
  await withEnv(
    {
      POLICY_INTEGRITY_MODE: 'off',
      POLICY_ANCHOR_MODE: 'off',
      POLICY_CAP_ID: '0xabc123',
      ENFORCE_CAP_ISOLATION: '1',
      OS_QUILT_ENABLED: '0',
      TG_BOT_TOKEN: '',
      TG_CHAT_ID: '',
      TG_OPERATOR_IDS: '',
      TG_OPERATOR_USERNAMES: '',
    },
    async () => {
      const { processIntent, resetAgentState } = await freshImport('src/orchestrator/intent-orchestrator.mjs');
      const { status, unfreeze } = await freshImport('src/state/kill-switch.mjs');

      const result = await processIntent({
        id: 'cap-isolation-test',
        domain: 'OS',
        action: 'EXECUTE_COMMAND',
        params: { command: 'pwd' },
        metadata: { source: 'USER_CHAT' },
      });

      assert.equal(result.ok, false);
      assert.equal(result.layer, 'TAMPER_GUARD');

      const state = status();
      assert.equal(state.frozen, true);
      assert.equal(state.triggered_by, 'TAMPER_GUARD');

      unfreeze('TEST_CLEANUP');
      resetAgentState();
    }
  );
});
