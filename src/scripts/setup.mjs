import './runtime-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writePolicySignatureFile, computePolicyBundleHash } from '../enforcement/policy-integrity.mjs';
import { restartGateway } from './gateway-runtime-utils.mjs';

const ROOT = process.cwd();
const NODE_BIN = process.execPath;
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const PLUGIN_ID = 'clawall-security';
const DEFAULT_API_URL = 'http://127.0.0.1:3011';
const ENV_PATH = path.resolve(ROOT, '.env');
const HOME = resolveHomeDir();
const OPENCLAW_CONFIG_PATH = path.resolve(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_EXT_PLUGIN_PATH = path.resolve(HOME, '.openclaw', 'extensions', PLUGIN_ID);
const OPENCLAW_WORKSPACE = path.resolve(HOME, '.openclaw', 'workspace');
const WORKSPACE_AGENTS_FILE = path.resolve(OPENCLAW_WORKSPACE, 'AGENTS.md');
const OPENCLAW_AGENTS_FILE = path.resolve(HOME, '.openclaw', 'AGENTS.md');

function resolveHomeDir() {
  const fromOs = os.homedir?.();
  if (fromOs) return fromOs;
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  const drive = process.env.HOMEDRIVE || '';
  const homePath = process.env.HOMEPATH || '';
  const joined = `${drive}${homePath}`;
  if (joined) return joined;
  throw new Error('Unable to resolve home directory for OpenClaw config');
}

function setEnvValue(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) return content.replace(re, line);
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

function parseEnv(content) {
  const env = {};
  for (const line of String(content ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) env[key] = value;
  }
  return env;
}

function ensurePluginKey(envContent, env) {
  const existing = String(env.CLAWALL_PLUGIN_KEY ?? '').trim();
  if (existing) return { envContent, key: existing };
  const generated = crypto.randomBytes(24).toString('hex');
  return {
    envContent: setEnvValue(envContent, 'CLAWALL_PLUGIN_KEY', generated),
    key: generated,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = { noRestart: false, skipPluginInstall: false, apiUrl: DEFAULT_API_URL };
  for (const part of argv) {
    if (part === '--no-restart') out.noRestart = true;
    else if (part === '--skip-plugin-install') out.skipPluginInstall = true;
    else if (part.startsWith('--api-url=')) {
      const value = part.slice('--api-url='.length).trim();
      if (value) out.apiUrl = value;
    }
  }
  return out;
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function loadOpenClawConfig() {
  if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeOpenClawConfig(config) {
  try {
    fs.mkdirSync(path.dirname(OPENCLAW_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[setup] Warning: failed to write OpenClaw config (${err?.message ?? err})`);
    return false;
  }
}

function removeExistingPluginPath() {
  if (!fs.existsSync(OPENCLAW_EXT_PLUGIN_PATH)) return;
  fs.rmSync(OPENCLAW_EXT_PLUGIN_PATH, { recursive: true, force: true });
  console.log(`[setup] Removed existing plugin: ${OPENCLAW_EXT_PLUGIN_PATH}`);
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

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '# AGENTS.md\n\n';
    const re = new RegExp(`${markerStart}[\\s\\S]*?${markerEnd}\\n?`, 'm');
    const updated = re.test(existing) ? existing.replace(re, block) : `${existing.trimEnd()}\n\n${block}`;
    fs.writeFileSync(filePath, updated, 'utf8');
  } catch (err) {
    console.warn(`[setup] Warning: failed to update routing policy at ${filePath} (${err?.message ?? err})`);
  }
}

function ensureWorkspaceRoutingPolicy() {
  upsertRoutingPolicyFile(WORKSPACE_AGENTS_FILE);
  upsertRoutingPolicyFile(OPENCLAW_AGENTS_FILE);
}

function updateOpenClawPluginConfig({ apiUrl, apiKey, pluginPath, installed } = {}) {
  const config = loadOpenClawConfig();
  config.plugins = config.plugins || {};

  const allow = new Set(Array.isArray(config.plugins.allow) ? config.plugins.allow : []);
  if (installed) allow.add(PLUGIN_ID);
  else allow.delete(PLUGIN_ID);
  config.plugins.allow = [...allow];

  config.plugins.entries = config.plugins.entries || {};
  config.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    config: {
      api_url: apiUrl || DEFAULT_API_URL,
      api_key: String(apiKey ?? '').trim(),
    },
  };
  // Do not mutate plugins.installs here; OpenClaw CLI manages install provenance.

  return writeOpenClawConfig(config);
}

function restartGateways(runtimeEnv = null) {
  console.log('\n[setup] Restarting Gateways...');
  const pid = restartGateway(runtimeEnv || process.env);
  console.log(`- ClawAll active (pid ${pid})`);
}

async function main() {
  const args = parseArgs();
  let envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const env = parseEnv(envContent);

  const policyCapOnce = String(env.POLICY_CAP_ID_ONCE ?? '').trim();
  if (policyCapOnce) {
    console.log('[setup] Running strict-anchor bootstrap via setup-policy-once...');
    runOrThrow(NODE_BIN, ['src/enforcement/setup-policy-once.mjs', `--policy_cap_id=${policyCapOnce}`], {
      cwd: ROOT,
      env: process.env,
    });
    envContent = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : envContent;
    envContent = setEnvValue(envContent, 'POLICY_CAP_ID_ONCE', '');
    fs.writeFileSync(ENV_PATH, envContent, 'utf8');
    console.log('[setup] strict-anchor mode enabled (POLICY_CAP_ID_ONCE cleared).');
  } else {
    writePolicySignatureFile({ generatedBy: 'clawall-setup' });
    const { sha256 } = computePolicyBundleHash();
    envContent = setEnvValue(envContent, 'POLICY_BUNDLE_SHA256', sha256);
    envContent = setEnvValue(envContent, 'POLICY_INTEGRITY_MODE', 'strict');
    const existing = parseEnv(envContent);
    const keepStrictAnchor =
      String(existing.POLICY_ANCHOR_MODE || '').trim().toLowerCase() === 'strict' &&
      String(existing.POLICY_ANCHOR_ID || '').trim();
    if (keepStrictAnchor) {
      console.log('[setup] strict-anchor already configured; preserving POLICY_ANCHOR_MODE=strict.');
    } else {
      envContent = setEnvValue(envContent, 'POLICY_ANCHOR_MODE', 'off');
      console.log('[setup] integrity-only mode enabled (strict local integrity, anchor off).');
    }
    envContent = setEnvValue(envContent, 'POLICY_CAP_ID', '');
  }
  // Runtime must not retain admin cap ids after setup.
  envContent = setEnvValue(envContent, 'POLICY_CAP_ID', '');
  envContent = setEnvValue(envContent, 'POLICY_CAP_ID_ONCE', '');
  envContent = setEnvValue(envContent, 'ENFORCE_CAP_ISOLATION', '1');
  envContent = setEnvValue(envContent, 'CLAWALL_ENABLE_OS_ENFORCEMENT', '0');
  const pluginKeyResult = ensurePluginKey(envContent, parseEnv(envContent));
  envContent = pluginKeyResult.envContent;
  envContent = setEnvValue(envContent, 'CLAWALL_ENFORCE_PLUGIN_GATE', '1');
  fs.writeFileSync(ENV_PATH, envContent, 'utf8');

  const pluginPath = path.resolve(ROOT, 'src', 'plugins', 'clawall-openclaw-plugin');
  let installed = fs.existsSync(OPENCLAW_EXT_PLUGIN_PATH);

  if (!args.skipPluginInstall) {
    sanitizeOpenClawConfigBeforeInstall();
    removeExistingPluginPath();
    runOrThrow(OPENCLAW_BIN, ['plugins', 'install', pluginPath]);
    installed = fs.existsSync(OPENCLAW_EXT_PLUGIN_PATH);
  } else {
    console.log('[setup] Skipped plugin install by flag (--skip-plugin-install).');
  }

  const configUpdated = updateOpenClawPluginConfig({
    apiUrl: args.apiUrl,
    apiKey: pluginKeyResult.key,
    pluginPath,
    installed,
  });
  ensureWorkspaceRoutingPolicy();

  const runtimeEnv = {
    ...process.env,
    ...parseEnv(envContent),
  };
  if (!args.noRestart) restartGateways(runtimeEnv);
  else console.log('[setup] Skipped gateway restart by flag (--no-restart).');

  console.log(`[setup] OpenClaw config updated: ${configUpdated ? 'yes' : 'no'} (${OPENCLAW_CONFIG_PATH})`);
  console.log(`[setup] Plugin allowlisted=${installed ? 'yes' : 'no'} api_url=${args.apiUrl}`);
  console.log('\n[setup] Done.');
}

main().catch(err => console.error(err.message));
