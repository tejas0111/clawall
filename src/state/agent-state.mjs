import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = 'src/state/agent-persistent-state.json';

const DEFAULT_STATE = {
  recentOSViolations: 0,
  highRiskTxHistory: [],
  txHistory: [],
  sequenceSignals: [],
};

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return { ...DEFAULT_STATE };
    }
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(data) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function save(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('[agent-state] failed to persist state:', err.message);
  }
}

export const agentState = {
  get() {
    return load();
  },

  update(fn) {
    const current = load();
    const updated = fn(current);
    save(updated);
    return updated;
  },

  reset() {
    save(DEFAULT_STATE);
    return DEFAULT_STATE;
  }
};
