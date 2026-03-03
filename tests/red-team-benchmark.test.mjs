import test from 'node:test';
import assert from 'node:assert/strict';
import { runRedTeamBenchmark } from '../src/benchmarks/red-team-pack.mjs';

test('red-team firewall benchmark meets target thresholds', async () => {
  const metrics = runRedTeamBenchmark();

  assert.ok(metrics.malicious.total >= 100, 'expected at least 100 malicious scenarios');
  assert.ok(
    metrics.malicious.blocked_rate >= 0.95,
    `malicious blocked rate too low: ${(metrics.malicious.blocked_rate * 100).toFixed(2)}%`
  );
  assert.ok(
    metrics.benign.allowed_rate >= 0.75,
    `benign allow rate too low: ${(metrics.benign.allowed_rate * 100).toFixed(2)}%`
  );
  assert.ok(
    metrics.benign.false_positive_rate <= 0.25,
    `false positive rate too high: ${(metrics.benign.false_positive_rate * 100).toFixed(2)}%`
  );
});
