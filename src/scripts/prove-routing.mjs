import './runtime-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

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
const OPENCLAW_CONFIG_PATH = path.resolve(HOME, '.openclaw', 'openclaw.json');
const OPENCLAW_WORKSPACE_AGENTS_PATH = path.resolve(HOME, '.openclaw', 'workspace', 'AGENTS.md');
const OPENCLAW_AGENTS_PATH = path.resolve(HOME, '.openclaw', 'AGENTS.md');
const BASE_URL = process.env.CLAWALL_API_URL || 'http://127.0.0.1:3011';
const TEST_RECIPIENT =
  process.env.PROVE_RECIPIENT ||
  process.env.DEMO_RECIPIENT ||
  '0x1111111111111111111111111111111111111111111111111111111111111111';

function loadPluginConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8'));
    const pluginCfg = cfg?.plugins?.entries?.['clawall-security']?.config ?? {};
    return {
      apiUrl: String(pluginCfg.api_url || BASE_URL).trim() || BASE_URL,
      apiKey: String(pluginCfg.api_key || '').trim(),
    };
  } catch {
    return { apiUrl: BASE_URL, apiKey: '' };
  }
}

async function post(url, payload, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: 'non_json_response' };
  }
  return { status: res.status, body };
}

async function get(url) {
  const res = await fetch(url);
  let body = {};
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: 'non_json_response' };
  }
  return { status: res.status, body };
}

function runOpenClawTransfer() {
  const res = spawnSync(
    OPENCLAW_BIN,
    ['clawall', 'transfer', '--amount', '10000000', '--recipient', TEST_RECIPIENT],
    { encoding: 'utf8' }
  );
  const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  return {
    status: res.status ?? 1,
    output: combined,
  };
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hasPriceRoutingBlock(text) {
  return (
    text.includes('CLAWALL_ROUTING_START') &&
    text.includes('/clawall_price') &&
    text.includes('openclaw clawall price')
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const plugin = loadPluginConfig();
  const status = await get(`${plugin.apiUrl}/v1/status`);
  assert(status.status === 200 && status.body?.ok, 'gateway status failed');

  const gate = status.body?.plugin_gate ?? {};
  assert(gate.enforced === true, 'plugin gate is not enforced');
  assert(gate.key_configured === true, 'plugin gate key is not configured');

  const workspaceAgents = readText(OPENCLAW_WORKSPACE_AGENTS_PATH);
  const openclawAgents = readText(OPENCLAW_AGENTS_PATH);
  assert(
    hasPriceRoutingBlock(workspaceAgents),
    'workspace AGENTS.md missing ClawAll price routing block'
  );
  assert(
    hasPriceRoutingBlock(openclawAgents),
    'openclaw AGENTS.md missing ClawAll price routing block'
  );

  const direct = await post(
    `${plugin.apiUrl}/v1/signed-transfer`,
    { amount: 10000000, recipient: TEST_RECIPIENT },
    {}
  );
  assert(direct.status === 401, `expected direct request 401, got ${direct.status}`);

  const proof = {
    gateway_status: status.body,
    routing_policy: {
      workspace_agents_file: OPENCLAW_WORKSPACE_AGENTS_PATH,
      openclaw_agents_file: OPENCLAW_AGENTS_PATH,
      workspace_has_price_routing: true,
      openclaw_has_price_routing: true,
    },
    direct_without_key: {
      status: direct.status,
      body: direct.body,
    },
    plugin_transfer: null,
  };

  if (!plugin.apiKey) {
    throw new Error('plugin api_key missing in ~/.openclaw/openclaw.json (cannot prove plugin path)');
  }

  const withKey = await post(
    `${plugin.apiUrl}/v1/signed-transfer`,
    { amount: 260000000, recipient: TEST_RECIPIENT },
    { 'x-clawall-plugin-key': plugin.apiKey }
  );
  assert(withKey.status === 200, `expected keyed request 200, got ${withKey.status}`);

  const openclaw = runOpenClawTransfer();
  proof.plugin_transfer = {
    keyed_route_status: withKey.status,
    keyed_route_result: withKey.body,
    openclaw_cli_exit: openclaw.status,
    openclaw_cli_excerpt: openclaw.output.slice(0, 600),
  };

  const out = {
    ok: true,
    message: 'Routing proof passed: direct transfer blocked, authenticated/plugin transfer path available.',
    proof,
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((err) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: err?.message ?? String(err),
      },
      null,
      2
    )
  );
  process.exit(1);
});
