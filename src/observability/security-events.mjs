import fs from 'fs';
import { enqueueOSSecurityEvent } from '../audit/walrus.mjs';

const LOG_FILE = 'src/state/security-events.log';
const MAX_IN_MEMORY_EVENTS = 200;
const MAX_LOG_BYTES = 1_000_000;
const events = [];
const EMIT_TO_STDOUT = process.env.SECURITY_EVENT_STDOUT === '1';

function short(value, head = 10, tail = 6) {
  if (typeof value !== 'string') return value;
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function compactStdout(event) {
  const parts = [];
  if (event?.event_type) parts.push(`type=${event.event_type}`);
  if (event?.layer) parts.push(`layer=${event.layer}`);
  if (event?.decision) parts.push(`decision=${event.decision}`);
  if (event?.proposal_id) parts.push(`proposal=${short(String(event.proposal_id), 8, 4)}`);
  if (event?.digest) parts.push(`digest=${short(String(event.digest), 10, 6)}`);
  if (event?.recipient) parts.push(`recipient=${short(String(event.recipient), 10, 6)}`);
  if (event?.risk_level) parts.push(`risk=${event.risk_level}`);
  if (typeof event?.risk_score === 'number') parts.push(`score=${event.risk_score}`);
  if (event?.triggered_by) parts.push(`by=${event.triggered_by}`);
  if (event?.reason) parts.push(`reason=${String(event.reason).slice(0, 120)}`);

  const ts = typeof event?.ts === 'string' ? event.ts : nowIso();
  return `[security] ${ts} ${parts.join(' ')}`.trim();
}

function nowIso() {
  return new Date().toISOString();
}

export function logSecurityEvent(eventType, payload = {}) {
  const event = {
    ts: nowIso(),
    event_type: eventType,
    ...payload,
  };

  events.push(event);
  if (events.length > MAX_IN_MEMORY_EVENTS) {
    events.shift();
  }

  try {
    tryRotateLogFile();
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(event)}\n`);
  } catch {
    // File logging should never break runtime control flow.
  }

  if (EMIT_TO_STDOUT) {
    // Keep full fidelity in the JSONL file; stdout is intended for humans.
    console.log(compactStdout(event));
  }

  if (shouldMirrorToOsQuilt(event)) {
    try {
      enqueueOSSecurityEvent(event);
    } catch {
      // Quilt mirror is best-effort and must not break control flow.
    }
  }
  return event;
}

function tryRotateLogFile() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_BYTES) return;
    const rotated = `${LOG_FILE}.${Date.now()}.bak`;
    fs.renameSync(LOG_FILE, rotated);
  } catch {
    // Ignore if file does not exist or cannot be rotated.
  }
}

function shouldMirrorToOsQuilt(event) {
  if (!event || typeof event !== 'object') return false;

  if (event.domain === 'OS') return true;
  if (event.layer === 'OS_POLICY') return true;

  if (
    event.event_type === 'kill_switch.freeze' &&
    event.triggered_by === 'OS_FIREWALL'
  ) {
    return true;
  }

  if (
    event.event_type === 'brain.decision' &&
    event.layer === 'CROSS_DOMAIN' &&
    typeof event.reason === 'string' &&
    event.reason.toLowerCase().includes('os')
  ) {
    return true;
  }

  return false;
}

export function getRecentSecurityEvents(limit = 10) {
  const n = Math.max(1, Math.min(Number(limit) || 10, MAX_IN_MEMORY_EVENTS));
  return events.slice(-n);
}

export function findLastSecurityEvent(predicate) {
  if (typeof predicate !== 'function') return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (predicate(e)) return e;
  }
  return null;
}

export function getLastSecurityEventByType(eventType) {
  return findLastSecurityEvent((e) => e.event_type === eventType);
}
