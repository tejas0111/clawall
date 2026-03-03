import fs from 'node:fs';
import path from 'node:path';

function parseDotEnv(content) {
  const out = {};
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function applyRuntimeEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  let parsed = {};
  try {
    parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return;
  }
  for (const [k, v] of Object.entries(parsed)) {
    // Keep explicit shell-exported values authoritative.
    if (process.env[k] === undefined) process.env[k] = String(v ?? '');
  }
}

applyRuntimeEnv();

