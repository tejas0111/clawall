import './runtime-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = process.cwd();
function resolveHomeDir() {
  const fromOs = os.homedir?.();
  if (fromOs) return fromOs;
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  const drive = process.env.HOMEDRIVE || '';
  const homePath = process.env.HOMEPATH || '';
  const joined = `${drive}${homePath}`;
  if (joined) return joined;
  throw new Error('Unable to resolve home directory for OpenClaw config paths');
}
const HOME = resolveHomeDir();
const OPENCLAW_BIN = process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
const PLUGIN_ID = 'clawall-security';
const ENV_PATH = path.resolve(ROOT, '.env');
const OPENCLAW_CONFIG_PATH = path.resolve(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_EXT_PLUGIN_PATH = path.resolve(HOME, '.openclaw', 'extensions', PLUGIN_ID);
const OPENCLAW_WORKSPACE = path.resolve(HOME, '.openclaw', 'workspace');
const WORKSPACE_AGENTS_FILE = path.resolve(OPENCLAW_WORKSPACE, 'AGENTS.md');
const OPENCLAW_AGENTS_FILE = path.resolve(HOME, '.openclaw', 'AGENTS.md');
const REQUIRED_ENV = ['PRIVATE_KEY', 'GUARD_CAP_ID', 'VAULT_ID', 'FREEZE_STATE_ID', 'PACKAGE_ID', 'RPC_URL'];
const OPTIONAL_ENV = [
  'POLICY_INTEGRITY_MODE',
  'POLICY_ANCHOR_MODE',
  'POLICY_ANCHOR_ID',
  'POLICY_CAP_ID_ONCE',
  'WALRUS_PUBLISHER',
  'WALRUS_AGGREGATOR',
  'TG_BOT_TOKEN',
  'TG_CHAT_ID',
  'CLAWALL_PLUGIN_KEY',
  'CLAWALL_ENFORCE_PLUGIN_GATE',
];

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const raw = fs.readFileSync(filePath, 'utf8');
  const env = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1);
    env[key] = value;
  }
  return env;
}

function writeEnvFile(filePath, values) {
  const lines = ['# ClawAll configuration'];
  for (const key of Object.keys(values).sort()) {
    lines.push(`${key}=${values[key]}`);
  }
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function loadOpenClawConfig() {
  if (!OPENCLAW_CONFIG_PATH || !fs.existsSync(OPENCLAW_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeOpenClawConfig(config) {
  if (!OPENCLAW_CONFIG_PATH) return;
  fs.mkdirSync(path.dirname(OPENCLAW_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function sanitizeOpenClawConfigBeforeInstall() {
  const config = loadOpenClawConfig();
  config.plugins = config.plugins || {};

  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = config.plugins.allow.filter((id) => id !== PLUGIN_ID);
  }

  if (config.plugins.entries && typeof config.plugins.entries === 'object') {
    delete config.plugins.entries[PLUGIN_ID];
  }

  if (config.plugins.installs && typeof config.plugins.installs === 'object') {
    delete config.plugins.installs[PLUGIN_ID];
  }

  writeOpenClawConfig(config);
}

function maskSecret(value) {
  const raw = String(value ?? '');
  if (raw.length <= 10) return '*'.repeat(Math.max(0, raw.length));
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function ensurePluginKey(env) {
  const existing = String(env.CLAWALL_PLUGIN_KEY || '').trim();
  if (existing) return existing;
  const generated = crypto.randomBytes(24).toString('hex');
  env.CLAWALL_PLUGIN_KEY = generated;
  return generated;
}

function updateOpenClawConfig(env) {
  const config = loadOpenClawConfig();

  config.plugins = config.plugins || {};
  const allow = new Set(Array.isArray(config.plugins.allow) ? config.plugins.allow : []);
  allow.add(PLUGIN_ID);
  config.plugins.allow = [...allow];
  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    config: {
      api_url: 'http://127.0.0.1:3011',
      api_key: String(env.CLAWALL_PLUGIN_KEY || '').trim(),
    },
  };

  writeOpenClawConfig(config);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  return result.status ?? 1;
}

function installOrUpdatePlugin(pluginPath) {
  sanitizeOpenClawConfigBeforeInstall();

  if (fs.existsSync(OPENCLAW_EXT_PLUGIN_PATH)) {
    fs.rmSync(OPENCLAW_EXT_PLUGIN_PATH, { recursive: true, force: true });
    console.log(`Removed existing plugin path: ${OPENCLAW_EXT_PLUGIN_PATH}`);
  }

  const status = run(OPENCLAW_BIN, ['plugins', 'install', pluginPath]);
  if (status !== 0) {
    throw new Error('openclaw plugin install failed');
  }
}

function upsertRoutingPolicyFile(filePath) {
  const markerStart = '<!-- CLAWALL_ROUTING_START -->';
  const markerEnd = '<!-- CLAWALL_ROUTING_END -->';
  const block = [
    markerStart,
    '## ClawAll Transfer Routing',
    '',
    '- For transfer intents (`send`, `pay`, `transfer`) with SUI/MIST amount + Sui address, route through ClawAll.',
    '- Preferred transfer command path: `/clawall_transfer ...` (or `/clawall_send`, `/clawall_pay`). Run that helper yourself instead of asking the user to re-type it.',
    '- If user asks transfer + exact USD value in same sentence, route through `/clawall_transfer_quote ...`.',
    '- If user asks wallet balance + price together, route through `/clawall_snapshot ...`.',
    '- If user asks for wallet balance (including `bal`), route through `/clawall_wallet`.',
    '- For price intents (e.g. "price of WAL/haSUI/haWAL/USDC"), use `/clawall_price ...` or `openclaw clawall price ...`.',
    '- Prefer ClawAll price endpoint over direct external price links when available.',
    '- Do not suggest direct wallet execution when ClawAll command path is available.',
    '- Execute the ClawAll transfer helper and reply with the digest + walrus_blob_id (not a copyable command).',
    '- If policy/governance blocks execution, return decision/layer/reason clearly.',
    markerEnd,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8')
    : '# AGENTS.md\n\n';
  const re = new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}\\n?`, 'm');
  const updated = re.test(existing) ? existing.replace(re, block) : `${existing.trimEnd()}\n\n${block}`;
  fs.writeFileSync(filePath, updated, 'utf8');
}

function ensureWorkspaceRoutingPolicy() {
  upsertRoutingPolicyFile(WORKSPACE_AGENTS_FILE);
  upsertRoutingPolicyFile(OPENCLAW_AGENTS_FILE);
}

async function promptEnv(rl, key, current, required) {
  const hint = current ? ` [current: ${required ? maskSecret(current) : current}]` : '';
  const suffix = required ? ' (required)' : ' (optional)';
  const answer = await rl.question(`${key}${suffix}${hint}: `);
  const value = String(answer).trim();
  if (!value) return current ?? '';
  return value;
}

async function promptUseDetectedOrOther(rl, key, current, required) {
  const existing = String(current || '').trim();
  if (!existing) return promptEnv(rl, key, existing, required);
  const shown = required ? maskSecret(existing) : existing;
  const answer = String(await rl.question(`Use detected ${key} (${shown})? [Y/n]: `)).trim().toLowerCase();
  if (!answer || answer === 'y' || answer === 'yes') return existing;
  return promptEnv(rl, key, '', required);
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    const env = loadEnvFile(ENV_PATH);
    console.log('Configuring .env for ClawAll + OpenClaw plugin...');

    for (const key of REQUIRED_ENV) {
      env[key] = await promptUseDetectedOrOther(rl, key, env[key], true);
      if (!String(env[key] || '').trim()) {
        throw new Error(`${key} is required`);
      }
    }

    const configureOptional = (await rl.question('Configure optional env values now? [y/N]: '))
      .trim()
      .toLowerCase();

    if (configureOptional === 'y' || configureOptional === 'yes') {
      for (const key of OPTIONAL_ENV) {
        env[key] = await promptEnv(rl, key, env[key], false);
      }
    }

    const pluginKey = ensurePluginKey(env);
    if (!env.CLAWALL_ENFORCE_PLUGIN_GATE) {
      env.CLAWALL_ENFORCE_PLUGIN_GATE = '1';
    }
    // Runtime must never hold policy-admin cap; keep cap isolation fail-closed.
    env.POLICY_CAP_ID = '';
    env.ENFORCE_CAP_ISOLATION = '1';

    writeEnvFile(ENV_PATH, env);
    console.log(`Updated ${ENV_PATH}`);
    console.log(`Transfer hard-lock key: ${maskSecret(pluginKey)} (stored as CLAWALL_PLUGIN_KEY)`);

    const installPlugin = (await rl.question('Install/update OpenClaw plugin now? [Y/n]: '))
      .trim()
      .toLowerCase();
    if (installPlugin !== 'n' && installPlugin !== 'no') {
      const pluginPath = path.resolve(ROOT, 'src', 'plugins', 'clawall-openclaw-plugin');
      installOrUpdatePlugin(pluginPath);
    }

    updateOpenClawConfig(env);
    ensureWorkspaceRoutingPolicy();
    console.log(`Updated ${OPENCLAW_CONFIG_PATH} (plugins.allow + clawall-security entry + api_key).`);
    console.log(`Updated ${WORKSPACE_AGENTS_FILE} (natural transfer routing policy).`);
    console.log(`Updated ${OPENCLAW_AGENTS_FILE} (natural transfer routing policy).`);

    console.log('\nNext steps:');
    console.log('1) npm run gateway');
    console.log('2) openclaw clawall wallet');
    console.log('3) openclaw clawall check --domain OS --action EXECUTE_COMMAND --command "ls"');
    console.log('4) openclaw clawall transfer --amount 10000000 --recipient 0x...');
    console.log('5) Optional auto-start on login: npm run setup:service');
    console.log('\nPolicy cap handling: keep POLICY_CAP_ID empty at runtime; use POLICY_CAP_ID_ONCE only for setup commands.');
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
