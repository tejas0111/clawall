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

test('policy requires approval for MEDIUM and HIGH risk', async () => {
  const { evaluatePolicy } = await freshImport('src/risk/policy.mjs');
  const medium = evaluatePolicy({ risk_level: 'MEDIUM' });
  const high = evaluatePolicy({ risk_level: 'HIGH' });

  assert.equal(medium.action, 'REQUIRE_APPROVAL');
  assert.equal(high.action, 'REQUIRE_APPROVAL');
});

test('approval digest is deterministic and payload-bound', async () => {
  const { buildApprovalDigest } = await freshImport('src/governance/approval.mjs');
  const proposal = {
    id: 'p1',
    domain: 'BLOCKCHAIN',
    action: 'WALLET_TRANSFER',
    params: {
      amount: 10,
      recipient: `0x${'1'.repeat(64)}`,
    },
  };
  const risk = { risk_level: 'MEDIUM', risk_score: 55 };

  const a = buildApprovalDigest({ proposal, risk });
  const b = buildApprovalDigest({ proposal, risk });
  const c = buildApprovalDigest({
    proposal: {
      ...proposal,
      params: { ...proposal.params, amount: 11 },
    },
    risk,
  });

  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('risk engine escalates bursty small-transfer drain pattern', async () => {
  const { rankRisk } = await freshImport('src/risk/risk-engine.mjs');
  const recipient = `0x${'2'.repeat(64)}`;
  const result = rankRisk(
    { params: { amount: 40_000_000, recipient } },
    {
      recentSpend: 210_000_000,
      recentTxCount: 5,
      txVelocity: 3,
      smallTxBurstCount: 5,
      repeatedRecipient: true,
    }
  );

  assert.equal(result.risk_level, 'HIGH');
  assert.ok(result.factors.some((f) => f.factor === 'DRAIN_PATTERN'));
});

test('sdk blocks execution when audit upload fails', { concurrency: false }, async () => {
  await withEnv(
    {
      PACKAGE_ID: '0x123',
      FREEZE_STATE_ID: '0xdef',
      RPC_URL: 'https://fullnode.testnet.sui.io:443',
      WALRUS_MAX_RETRIES: '1',
    },
    async () => {
      const { mintAndExecute } = await freshImport('src/chain/sui-transaction-gateway.mjs');
      const { unfreeze } = await freshImport('src/state/kill-switch.mjs');
      unfreeze('TEST_SETUP');

      const recipient = `0x${'3'.repeat(64)}`;

      // mintAndExecute will naturally fail logProposal if Walrus isn't mock-configured
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
        proposal: { id: 'p1' },
        risk: { risk_level: 'LOW' }
      });

      assert.equal(result.ok, false);
      assert.equal(result.layer, 'AUDIT');
      assert.equal(result.decision, 'BLOCKED');
    }
  );
});
