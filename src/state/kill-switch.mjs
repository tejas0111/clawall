import fs from 'fs';
import { logSecurityEvent } from '../observability/security-events.mjs';

const FILE = 'src/state/kill-switch.json';

const DEFAULT = {
  frozen: false,
  reason: null,
  triggered_at: null,
  expires_at: null,
  triggered_by: null,
  last_alert_at: 0,
};

function load() {
  try {
    const data = fs.readFileSync(FILE, 'utf8');
    return { ...DEFAULT, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT };
  }
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function isFrozen() {
  const state = load();

  if (
    state.frozen &&
    state.expires_at &&
    Date.now() > state.expires_at
  ) {
    unfreeze('AUTO_EXPIRE');
    logSecurityEvent('kill_switch.auto_expire', {
      reason: state.reason ?? 'expired',
      triggered_by: state.triggered_by ?? null,
    });
    return false;
  }

  return state.frozen;
}

export function freeze({ reason, by, durationMs = null }) {
  const now = Date.now();

  const state = {
    frozen: true,
    reason,
    triggered_by: by,
    triggered_at: now,
    expires_at: durationMs ? now + durationMs : null,
    last_alert_at: 0,
  };

  save(state);
  logSecurityEvent('kill_switch.freeze', {
    reason: reason ?? null,
    triggered_by: by ?? null,
    duration_ms: durationMs ?? null,
  });
  return state;
}

export function unfreeze(by = 'MANUAL') {
  const existing = load();
  if (!existing.frozen) {
    // Avoid noisy duplicate unfreeze logs when multiple subsystems attempt to
    // restore state (e.g. governance resume + agent reset).
    if (existing.triggered_by === by) return existing;
    const updated = {
      ...existing,
      triggered_by: by,
    };
    save(updated);
    return updated;
  }

  const state = { ...DEFAULT, triggered_by: by };
  save(state);
  logSecurityEvent('kill_switch.unfreeze', { triggered_by: by });
  return state;
}

export function status() {
  return load();
}

export function shouldAlert(cooldownMs = 60_000) {
  const state = load();
  const now = Date.now();

  if (now - state.last_alert_at < cooldownMs) {
    return false;
  }

  state.last_alert_at = now;
  save(state);
  return true;
}
