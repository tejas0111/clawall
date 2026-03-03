import './runtime-env.mjs';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { gatewayStatus } from './gateway-runtime-utils.mjs';
import { resetAgentState } from '../orchestrator/intent-orchestrator.mjs';

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || (process.platform === 'win32' ? 'openclaw.cmd' : 'openclaw');
const NODE_BIN = process.execPath;
const ENV_PATH = path.resolve(process.cwd(), '.env');

const REQUIRED_ENV_WITH_DEFAULTS = [
  { key: 'RPC_URL', defaultValue: 'https://fullnode.testnet.sui.io:443' },
  { key: 'NETWORK', defaultValue: 'testnet' },
];

const OPTIONAL_ENV_PROMPTS = [
  { key: 'TG_BOT_TOKEN', label: 'Telegram Bot Token', secret: true },
  { key: 'TG_CHAT_ID', label: 'Telegram Chat ID' },
  { key: 'TG_OPERATOR_USERNAMES', label: 'Telegram Operator Usernames (comma-separated)' },
  { key: 'TG_OPERATOR_IDS', label: 'Telegram Operator IDs (comma-separated)' },
  { key: 'COINGECKO_DEMO_API_KEY', label: 'CoinGecko API Key', secret: true },
  { key: 'WALRUS_PUBLISHER', label: 'Walrus Publisher URL' },
  { key: 'WALRUS_AGGREGATOR', label: 'Walrus Aggregator URL' },
  { key: 'WALRUS_UPLOAD_RELAY', label: 'Walrus Upload Relay URL' },
  { key: 'MARKET_FIXED_PRICE_USD_BY_SYMBOL_JSON', label: 'Fixed Price JSON (optional fallback)' },
];

function parseEnv(content) {
  const env = {};
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    if (key) env[key] = value;
  }
  return env;
}

function setEnvValue(content, key, value) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escaped}=.*$`, 'm');
  const line = `${key}=${value}`;
  if (re.test(content)) return content.replace(re, line);
  const suffix = content.endsWith('\n') ? '' : '\n';
  return `${content}${suffix}${line}\n`;
}

function maskSecret(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '(empty)';
  if (raw.length <= 12) return '*'.repeat(raw.length);
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function isYes(answer, defaultYes = true) {
  const v = String(answer ?? '').trim().toLowerCase();
  if (!v) return defaultYes;
  return v === 'y' || v === 'yes';
}

function printSetupBanner() {
  console.log(String.raw`
============================================================================
===     ===  ===========  =====  ====  ====  =====  =====  ========  =======
==  ===  ==  ==========    ====  ====  ====  ====    ====  ========  =======
=  ========  =========  ==  ===  ====  ====  ===  ==  ===  ========  =======
=  ========  ========  ====  ==  ====  ====  ==  ====  ==  ========  =======
=  ========  ========  ====  ==   ==    ==  ===  ====  ==  ========  =======
=  ========  ========        ===  ==    ==  ===        ==  ========  =======
=  ========  ========  ====  ===  ==    ==  ===  ====  ==  ========  =======
==  ===  ==  ========  ====  ====    ==    ====  ====  ==  ========  =======
===     ===        ==  ====  =====  ====  =====  ====  ==        ==        =
============================================================================
`);
  console.log('ClawAll Master Setup (All-in-One)');
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function runBestEffort(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  return result.status ?? 1;
}

async function checkHealth() {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const ok = await new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:3011/health', (res) => {
        process.stdout.write(`[verify] gateway /health -> ${res.statusCode}\n`);
        res.resume();
        resolve(true);
      });
      req.on('error', (err) => {
        if (attempt === 8) {
          process.stdout.write(`[verify] gateway /health unavailable (${err.message})\n`);
        }
        resolve(false);
      });
      req.setTimeout(2500, () => {
        req.destroy();
        if (attempt === 8) process.stdout.write('[verify] gateway /health timeout\n');
        resolve(false);
      });
    });
    if (ok) return;
    await wait(500);
  }
}

async function runEnvWizard() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  let changed = false;

  try {
    const start = await rl.question('Review .env config now? [Y/n]: ');
    if (!isYes(start, true)) return false;

    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    let env = parseEnv(content);

    console.log('\n[setup] Required runtime config');
    for (const entry of REQUIRED_ENV_WITH_DEFAULTS) {
      const current = String(env[entry.key] ?? '').trim();
      const fallback = entry.defaultValue ?? '';
      const display = current || fallback;
      const answer = (await rl.question(`${entry.key} [${display}]: `)).trim();
      const nextValue = answer || current || fallback;
      if (String(nextValue) !== String(current)) {
        content = setEnvValue(content, entry.key, nextValue);
        changed = true;
      }
      env[entry.key] = nextValue;
    }

    const askOptional = await rl.question('\nConfigure optional integrations now? [y/N]: ');
    if (isYes(askOptional, false)) {
      console.log('[setup] Optional values: Enter to keep current, "-" to clear value.');
      for (const item of OPTIONAL_ENV_PROMPTS) {
        const current = String(env[item.key] ?? '');
        const shown = item.secret ? maskSecret(current) : (current || '(empty)');
        const answer = await rl.question(`${item.label} (${item.key}) [${shown}]: `);
        const trimmed = String(answer ?? '').trim();
        if (!trimmed) continue;
        const nextValue = trimmed === '-' ? '' : trimmed;
        if (nextValue !== current) {
          content = setEnvValue(content, item.key, nextValue);
          env[item.key] = nextValue;
          changed = true;
        }
      }
    }

    if (changed) {
      fs.writeFileSync(ENV_PATH, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
      console.log(`[setup] Updated ${ENV_PATH}`);
    } else {
      console.log('[setup] .env unchanged.');
    }
  } finally {
    rl.close();
  }

  return changed;
}

async function main() {
  try {
    printSetupBanner();
    console.log('\n[phase 1/3] Admin + Vault + Policy bootstrap');
    runOrThrow(NODE_BIN, ['src/scripts/admin-init.mjs', '--no-runtime-prompt', '--recorded-prompts']);

    console.log('\n[phase 2/3] Runtime + Plugin setup');
    runOrThrow(NODE_BIN, ['src/scripts/setup.mjs']);
    resetAgentState();
    console.log('[setup] Cleared local runtime freeze/state (setup-time only).');
    const envChanged = await runEnvWizard();
    if (envChanged) {
      console.log('[setup] Reapplying runtime setup after .env updates...');
      runOrThrow(NODE_BIN, ['src/scripts/setup.mjs', '--skip-plugin-install']);
    }

    console.log('\n[phase 3/3] Verification');
    await checkHealth();
    const gw = gatewayStatus();
    if (gw.running) {
      console.log(`[verify] gateway process running (pid ${gw.pid})`);
    } else {
      console.log('[verify] gateway process not detected (pid file missing or stale).');
    }
    runBestEffort(OPENCLAW_BIN, ['clawall', 'wallet']);
    runBestEffort(OPENCLAW_BIN, ['clawall', 'check', '--domain', 'OS', '--action', 'EXECUTE_COMMAND', '--command', 'ls']);

    console.log('\n=== SETUP COMPLETE ===');
    console.log('Try:');
    console.log('1) openclaw clawall wallet');
    console.log('2) npm run demo');
    console.log('3) npm run setup:service (optional auto-start on reboot/login)');
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
