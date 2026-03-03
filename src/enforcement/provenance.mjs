const SOURCE_ALIAS_MAP = new Map([
  ['USER', 'USER_CHAT'],
  ['USER_CHAT', 'USER_CHAT'],
  ['USER_EMAIL', 'USER_EMAIL'],
  ['SYSTEM_AUTOMATION', 'SYSTEM_AUTOMATION'],
  ['AUTOMATION', 'SYSTEM_AUTOMATION'],
  ['AGENT_AUTONOMY', 'AGENT_AUTONOMY'],
  ['MODEL_OUTPUT', 'AGENT_AUTONOMY'],
  ['WEB', 'WEB_CONTENT'],
  ['WEB_CONTENT', 'WEB_CONTENT'],
  ['BROWSER_CONTENT', 'WEB_CONTENT'],
  ['EMAIL', 'EMAIL_CONTENT'],
  ['EMAIL_CONTENT', 'EMAIL_CONTENT'],
  ['UNKNOWN', 'UNKNOWN'],
]);

const TRUST_BY_SOURCE = Object.freeze({
  USER_CHAT: 'TRUSTED',
  SYSTEM_AUTOMATION: 'TRUSTED',
  USER_EMAIL: 'SEMI_TRUSTED',
  WEB_CONTENT: 'UNTRUSTED',
  EMAIL_CONTENT: 'UNTRUSTED',
  AGENT_AUTONOMY: 'TRUSTED', // Elevated for demo
  UNKNOWN: 'UNTRUSTED',
});

function normalizeSource(raw) {
  const key = String(raw ?? '').trim().toUpperCase();
  return SOURCE_ALIAS_MAP.get(key) ?? 'UNKNOWN';
}

function collectTaintTags(source, metadata = {}) {
  const taint = new Set(
    Array.isArray(metadata?.taint_tags)
      ? metadata.taint_tags.map((v) => String(v).trim().toUpperCase()).filter(Boolean)
      : []
  );

  if (source === 'WEB_CONTENT') taint.add('WEB_UNTRUSTED');
  if (source === 'EMAIL_CONTENT') taint.add('EMAIL_UNTRUSTED');
  if (source === 'AGENT_AUTONOMY') taint.add('MODEL_GENERATED');
  if (source === 'UNKNOWN') taint.add('UNKNOWN_PROVENANCE');

  return Array.from(taint);
}

export function deriveIntentProvenance(intent = {}) {
  const metadata = intent?.metadata ?? {};
  const rawSource =
    metadata?.source ??
    metadata?.provenance ??
    metadata?.origin ??
    'UNKNOWN';

  const source = normalizeSource(rawSource);
  const trust = TRUST_BY_SOURCE[source] ?? 'UNTRUSTED';
  const taint_tags = collectTaintTags(source, metadata);

  return {
    source,
    trust,
    taint_tags,
  };
}

export function isUntrustedProvenance(provenance = {}) {
  return String(provenance?.trust ?? '').toUpperCase() === 'UNTRUSTED';
}
