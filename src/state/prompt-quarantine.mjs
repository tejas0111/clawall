import fs from 'fs';
import crypto from 'node:crypto';
import { logSecurityEvent } from '../observability/security-events.mjs';

const FILE = 'src/state/prompt-quarantine.json';
const MAX_ENTRIES = 300;
const MAX_RELEASES = 500;
const DEFAULT_RELEASE_TTL_MS = Number.isFinite(Number(process.env.PROMPT_QUARANTINE_RELEASE_TTL_MS))
  ? Math.max(60_000, Number(process.env.PROMPT_QUARANTINE_RELEASE_TTL_MS))
  : 30 * 60_000;
const ENTRY_RETENTION_MS = 14 * 24 * 60 * 60_000;

const DEFAULT_STATE = {
  schema: 'clawall/prompt-quarantine-v1',
  entries: [],
  releases: [],
};

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    const raw = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
      releases: Array.isArray(parsed?.releases) ? parsed.releases : [],
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

function normalizeFingerprint(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(v)) return null;
  return v;
}

function newTicketId() {
  const rand = crypto.randomBytes(3).toString('hex');
  return `q-${Date.now().toString(36)}-${rand}`;
}

function sanitizeSnippet(text, max = 220) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function pruneState(state) {
  const now = Date.now();
  const retentionFloor = now - ENTRY_RETENTION_MS;

  state.releases = state.releases
    .filter((r) => Number(r?.expires_at_ms) > now)
    .slice(-MAX_RELEASES);

  state.entries = state.entries
    .filter((e) => {
      const created = Date.parse(String(e?.created_at ?? ''));
      if (Number.isNaN(created)) return false;
      if (created < retentionFloor) return false;
      return true;
    })
    .slice(-MAX_ENTRIES);
}

function dedupePendingByFingerprint(entries, fingerprint) {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e?.status === 'PENDING' && e?.fingerprint === fingerprint) {
      return e;
    }
  }
  return null;
}

export function isPromptFingerprintReleased(fingerprint) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) return false;

  const state = loadState();
  pruneState(state);
  const now = Date.now();
  const released = state.releases.some(
    (r) => r?.fingerprint === normalized && Number(r?.expires_at_ms) > now
  );
  saveState(state);
  return released;
}

export function createPromptQuarantineTicket({
  fingerprint,
  source,
  severity = 'HIGH',
  reason,
  snippet,
  intent,
}) {
  const normalized = normalizeFingerprint(fingerprint);
  if (!normalized) {
    throw new Error('Invalid prompt fingerprint');
  }

  const state = loadState();
  pruneState(state);

  const existing = dedupePendingByFingerprint(state.entries, normalized);
  if (existing) return existing;

  const entry = {
    id: newTicketId(),
    status: 'PENDING',
    fingerprint: normalized,
    source: String(source ?? 'UNKNOWN'),
    severity: String(severity ?? 'HIGH'),
    reason: String(reason ?? 'Suspicious prompt pattern'),
    snippet: sanitizeSnippet(snippet),
    domain: String(intent?.domain ?? ''),
    action: String(intent?.action ?? ''),
    intent_id: String(intent?.id ?? ''),
    created_at: nowIso(),
    released_at: null,
    released_by: null,
    release_expires_at_ms: null,
  };

  state.entries.push(entry);
  pruneState(state);
  saveState(state);

  logSecurityEvent('quarantine.ticket_created', {
    ticket_id: entry.id,
    source: entry.source,
    severity: entry.severity,
    reason: entry.reason,
    domain: entry.domain,
    action: entry.action,
    fingerprint: entry.fingerprint.slice(0, 12),
  });

  return entry;
}

export function listPendingPromptQuarantine(limit = 10) {
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));
  const state = loadState();
  pruneState(state);
  saveState(state);
  const pending = state.entries.filter((e) => e?.status === 'PENDING');
  return pending.slice(-n).reverse();
}

export function releasePromptQuarantineTicket(ticketId, { releasedBy, ttlMs } = {}) {
  const id = String(ticketId ?? '').trim();
  if (!id) return null;

  const ttl = Number.isFinite(Number(ttlMs))
    ? Math.max(60_000, Number(ttlMs))
    : DEFAULT_RELEASE_TTL_MS;

  const state = loadState();
  pruneState(state);
  const entry = state.entries.find((e) => e?.id === id);
  if (!entry || entry.status !== 'PENDING') {
    saveState(state);
    return null;
  }

  const now = Date.now();
  const expiresAt = now + ttl;
  const actor = String(releasedBy ?? 'UNKNOWN_OPERATOR');

  entry.status = 'RELEASED';
  entry.released_at = new Date(now).toISOString();
  entry.released_by = actor;
  entry.release_expires_at_ms = expiresAt;

  state.releases.push({
    fingerprint: entry.fingerprint,
    ticket_id: entry.id,
    released_by: actor,
    released_at: entry.released_at,
    expires_at_ms: expiresAt,
  });

  pruneState(state);
  saveState(state);

  logSecurityEvent('quarantine.ticket_released', {
    ticket_id: entry.id,
    released_by: actor,
    release_expires_at_ms: expiresAt,
    fingerprint: entry.fingerprint.slice(0, 12),
  });

  return { ...entry };
}
