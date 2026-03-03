import fs from 'fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verifyPolicyBundleIntegrity } from '../enforcement/policy-integrity.mjs';
import { verifyPolicyAnchorIntegrity } from '../enforcement/policy-anchor.mjs';

const SECURITY_EVENTS_FILE = 'src/state/security-events.log';
const OS_QUILT_INDEX_FILE = 'src/state/os-security-quilt.log';
const BENCHMARK_FILE = 'src/state/red-team-benchmark.json';
const SIGNATURE_FILE = 'src/enforcement/policy-signature.json';
const OUTPUT_ROOT = 'src/state/forensics';

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readJsonl(file, limit = 500) {
  try {
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const selected = lines.slice(-limit);
    const parsed = [];
    for (const line of selected) {
      try {
        parsed.push(JSON.parse(line));
      } catch {
        // Ignore malformed lines.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

function collectWalrusRefs(events, quiltEntries) {
  const refs = new Set();
  for (const e of events) {
    const values = [
      e?.walrus_blob_id,
      e?.blob_id,
      e?.audit_blob_id,
      e?.proposal_blob_id,
      e?.details?.blob_id,
    ];
    for (const v of values) {
      if (typeof v === 'string' && v.trim()) refs.add(v.trim());
    }
  }
  for (const q of quiltEntries) {
    if (typeof q?.blob_id === 'string' && q.blob_id.trim()) refs.add(q.blob_id.trim());
    if (Array.isArray(q?.patch_ids)) {
      for (const id of q.patch_ids) {
        if (typeof id === 'string' && id.trim()) refs.add(id.trim());
      }
    }
  }
  return Array.from(refs);
}

function compactLayerSummary(events) {
  const decisions = events.filter((e) => e?.event_type === 'brain.decision');
  const byLayer = countBy(decisions, (e) => e?.layer ?? 'UNKNOWN');
  const byDecision = countBy(decisions, (e) => e?.decision ?? 'UNKNOWN');
  return { byLayer, byDecision, total: decisions.length };
}

function latestTxDigests(events, max = 20) {
  const digests = [];
  for (const e of events) {
    if (typeof e?.digest === 'string' && e.digest) {
      digests.push(e.digest);
    }
  }
  const unique = Array.from(new Set(digests));
  return unique.slice(-max).reverse();
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(2)}%`;
}

function toMd(bundle) {
  const lines = [];
  lines.push('# ClawAll Forensic Bundle');
  lines.push('');
  lines.push(`Bundle ID: ${bundle.bundle_id}`);
  lines.push(`Generated At: ${bundle.generated_at}`);
  lines.push(`Reason: ${bundle.reason}`);
  lines.push(`Actor: ${bundle.actor}`);
  lines.push('');
  lines.push('## Integrity');
  lines.push(`- Policy signature: ${bundle.integrity?.bundle?.ok ? 'PASS' : 'FAIL'}`);
  lines.push(`- Policy anchor: ${bundle.integrity?.anchor?.ok ? 'PASS' : 'FAIL'} (${bundle.integrity?.anchor?.reason ?? 'n/a'})`);
  lines.push('');
  lines.push('## Decisions');
  lines.push(`- Total brain decisions: ${bundle.summary?.decisions?.total ?? 0}`);
  lines.push(`- Layers: ${JSON.stringify(bundle.summary?.decisions?.byLayer ?? {})}`);
  lines.push(`- Outcomes: ${JSON.stringify(bundle.summary?.decisions?.byDecision ?? {})}`);
  lines.push('');
  lines.push('## Evidence');
  lines.push(`- Security events: ${bundle.summary?.security_event_count ?? 0}`);
  lines.push(`- OS Quilt proofs: ${bundle.summary?.os_quilt_count ?? 0}`);
  lines.push(`- Walrus refs: ${bundle.summary?.walrus_ref_count ?? 0}`);
  lines.push('');

  if (bundle.benchmark) {
    lines.push('## Red-Team Snapshot');
    lines.push(`- Malicious blocked: ${bundle.benchmark.malicious?.blocked}/${bundle.benchmark.malicious?.total} (${formatPercent(bundle.benchmark.malicious?.blocked_rate)})`);
    lines.push(`- Benign allowed: ${bundle.benchmark.benign?.allowed}/${bundle.benchmark.benign?.total} (${formatPercent(bundle.benchmark.benign?.allowed_rate)})`);
    lines.push(`- False-positive rate: ${formatPercent(bundle.benchmark.benign?.false_positive_rate)}`);
    lines.push('');
  }

  lines.push('## Key Files');
  lines.push(`- JSON: ${bundle.paths?.json ?? 'n/a'}`);
  lines.push(`- Markdown: ${bundle.paths?.markdown ?? 'n/a'}`);
  lines.push('');
  return lines.join('\n');
}

export async function generateForensicBundle({
  reason = 'manual',
  actor = 'system',
  limit = 300,
} = {}) {
  const boundedLimit = Math.max(50, Math.min(Number(limit) || 300, 2000));
  const securityEvents = readJsonl(SECURITY_EVENTS_FILE, boundedLimit);
  const osQuilt = readJsonl(OS_QUILT_INDEX_FILE, 500);
  const signature = readJsonIfExists(SIGNATURE_FILE);
  const benchmark = readJsonIfExists(BENCHMARK_FILE);

  const bundleIntegrity = verifyPolicyBundleIntegrity({ force: true });
  const anchorIntegrity = await verifyPolicyAnchorIntegrity({
    expectedSha256: bundleIntegrity.computed_sha256,
    force: true,
  });

  const bundleId = `fb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const outDir = path.resolve(process.cwd(), OUTPUT_ROOT, bundleId);
  fs.mkdirSync(outDir, { recursive: true });

  const walrusRefs = collectWalrusRefs(securityEvents, osQuilt);
  const decisions = compactLayerSummary(securityEvents);

  const payload = {
    schema: 'clawall/forensic-bundle-v1',
    bundle_id: bundleId,
    generated_at: new Date().toISOString(),
    reason: String(reason),
    actor: String(actor),
    env: {
      package_id: process.env.PACKAGE_ID ?? null,
      network: process.env.NETWORK ?? null,
      policy_integrity_mode: process.env.POLICY_INTEGRITY_MODE ?? 'auto',
      policy_anchor_mode: process.env.POLICY_ANCHOR_MODE ?? 'auto',
      policy_anchor_id: process.env.POLICY_ANCHOR_ID ?? null,
    },
    integrity: {
      bundle: bundleIntegrity,
      anchor: anchorIntegrity,
      signature: signature ?? null,
    },
    summary: {
      security_event_count: securityEvents.length,
      os_quilt_count: osQuilt.length,
      walrus_ref_count: walrusRefs.length,
      decisions,
    },
    benchmark: benchmark ?? null,
    walrus_refs: walrusRefs,
    recent_tx_digests: latestTxDigests(securityEvents, 20),
    security_events: securityEvents,
    os_quilt_records: osQuilt,
  };

  const jsonPath = path.join(outDir, 'bundle.json');
  const mdPath = path.join(outDir, 'bundle.md');
  payload.paths = {
    json: path.relative(process.cwd(), jsonPath),
    markdown: path.relative(process.cwd(), mdPath),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.writeFileSync(mdPath, toMd(payload), 'utf8');

  return payload;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  generateForensicBundle({
    reason: 'cli',
    actor: 'local_cli',
    limit: Number(process.argv[2]) || 300,
  })
    .then((bundle) => {
      console.log(JSON.stringify({
        bundle_id: bundle.bundle_id,
        generated_at: bundle.generated_at,
        summary: bundle.summary,
        paths: bundle.paths,
      }, null, 2));
    })
    .catch((err) => {
      console.error(err?.message ?? String(err));
      process.exit(1);
    });
}
