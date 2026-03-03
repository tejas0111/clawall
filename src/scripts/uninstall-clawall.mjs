import './runtime-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OPENCLAW_BIN = process.env.OPENCLAW_BIN || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const PLUGIN_ID = 'clawall-security';

function resolveHomeDir() {
  const fromOs = os.homedir?.();
  if (fromOs) return fromOs;
  if (process.env.HOME) return process.env.HOME;
  if (process.env.USERPROFILE) return process.env.USERPROFILE;
  const drive = process.env.HOMEDRIVE || '';
  const homePath = process.env.HOMEPATH || '';
  const joined = `${drive}${homePath}`;
  if (joined) return joined;
  throw new Error('Unable to resolve home directory');
}

const HOME = resolveHomeDir();
const OPENCLAW_CONFIG_PATH = path.resolve(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_EXT_PLUGIN_PATH = path.resolve(HOME, '.openclaw', 'extensions', PLUGIN_ID);
const OPENCLAW_WORKSPACE = path.resolve(HOME, '.openclaw', 'workspace');
const WORKSPACE_AGENTS_FILE = path.resolve(OPENCLAW_WORKSPACE, 'AGENTS.md');
const OPENCLAW_AGENTS_FILE = path.resolve(HOME, '.openclaw', 'AGENTS.md');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  return result.status ?? 1;
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
    console.warn(`[uninstall] failed to write OpenClaw config: ${err?.message ?? err}`);
    return false;
  }
}

function cleanupOpenClawConfig() {
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

  return writeOpenClawConfig(config);
}

function removeRoutingBlock(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const markerStart = '<!-- CLAWALL_ROUTING_START -->';
  const markerEnd = '<!-- CLAWALL_ROUTING_END -->';
  const existing = fs.readFileSync(filePath, 'utf8');
  const re = new RegExp(`\\n?${markerStart}[\\s\\S]*?${markerEnd}\\n?`, 'm');
  if (!re.test(existing)) return false;
  const updated = existing.replace(re, '\n').replace(/\n{3,}/g, '\n\n');
  fs.writeFileSync(filePath, updated, 'utf8');
  return true;
}

function removeExtensionPath() {
  if (!fs.existsSync(OPENCLAW_EXT_PLUGIN_PATH)) return false;
  fs.rmSync(OPENCLAW_EXT_PLUGIN_PATH, { recursive: true, force: true });
  return true;
}

function main() {
  console.log('\n=== ClawAll Uninstall + Cleanup ===');
  console.log(`[uninstall] attempting: ${OPENCLAW_BIN} plugins uninstall ${PLUGIN_ID}`);
  const uninstallCode = run(OPENCLAW_BIN, ['plugins', 'uninstall', PLUGIN_ID], { cwd: ROOT });
  if (uninstallCode !== 0) {
    console.log('[uninstall] OpenClaw uninstall returned non-zero (continuing cleanup).');
  }

  const removedExt = removeExtensionPath();
  const cleanedConfig = cleanupOpenClawConfig();
  const cleanedWorkspaceAgents = removeRoutingBlock(WORKSPACE_AGENTS_FILE);
  const cleanedOpenclawAgents = removeRoutingBlock(OPENCLAW_AGENTS_FILE);

  console.log('\n[uninstall] cleanup summary:');
  console.log(`- extension path removed: ${removedExt ? 'yes' : 'no'}`);
  console.log(`- openclaw.json cleaned: ${cleanedConfig ? 'yes' : 'no'}`);
  console.log(`- workspace AGENTS.md cleaned: ${cleanedWorkspaceAgents ? 'yes' : 'no'}`);
  console.log(`- ~/.openclaw/AGENTS.md cleaned: ${cleanedOpenclawAgents ? 'yes' : 'no'}`);

  console.log('\nDone. Restart OpenClaw gateway/session if still running.');
}

main();
