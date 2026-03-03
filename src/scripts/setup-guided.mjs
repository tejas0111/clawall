import './runtime-env.mjs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ENV_PATH = path.resolve(process.cwd(), '.env');
const NODE_BIN = process.execPath;
const REQUIRED_RUNTIME_KEYS = [
  'PRIVATE_KEY',
  'RPC_URL',
  'PACKAGE_ID',
  'GUARD_CAP_ID',
  'VAULT_ID',
  'FREEZE_STATE_ID',
  'CLAWALL_PLUGIN_KEY',
];

function loadEnvContent() {
  if (!fs.existsSync(ENV_PATH)) return '';
  return fs.readFileSync(ENV_PATH, 'utf8');
}

function parseEnv(content) {
  const env = {};
  for (const line of String(content || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
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

function maskValue(key, value) {
  const raw = String(value || '');
  if (!raw) return '(empty)';
  if (/key|secret|token|password/i.test(key)) {
    if (raw.length <= 10) return '*'.repeat(raw.length);
    return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
  }
  return raw;
}

function isYes(value, defaultYes = true) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return defaultYes;
  return v === 'y' || v === 'yes';
}

async function ensureRuntimeEnv(rl) {
  let envContent = loadEnvContent();
  const env = parseEnv(envContent);

  console.log('\n[guided] Runtime .env check');
  for (const key of REQUIRED_RUNTIME_KEYS) {
    const existing = String(env[key] || '').trim();
    if (existing) {
      console.log(`- ${key}: ${maskValue(key, existing)}`);
      continue;
    }
    const value = (await rl.question(`Enter ${key}: `)).trim();
    if (!value) {
      console.log(`! ${key} left empty.`);
      continue;
    }
    envContent = setEnvValue(envContent, key, value);
    env[key] = value;
  }

  envContent = setEnvValue(envContent, 'POLICY_CAP_ID', '');
  envContent = setEnvValue(envContent, 'ENFORCE_CAP_ISOLATION', '1');
  fs.writeFileSync(ENV_PATH, envContent, 'utf8');
  console.log(`[guided] Updated ${ENV_PATH}`);
}

function runOrThrow(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  const status = result.status ?? 1;
  if (status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function normalizeChoice(v) {
  return String(v || '').trim().toLowerCase();
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    console.log('\n=== ClawAll Guided Setup ===');
    console.log('Choose a flow:\n');
    console.log('1) First-time setup (recommended)');
    console.log('   - bootstrap (admin + vault + funding + policy)');
    console.log('   - runtime/plugin setup');
    console.log('2) Runtime refresh only');
    console.log('   - rerun plugin + gateway setup');
    console.log('3) Vault top-up only');
    console.log('   - fast refill without full bootstrap');

    const choice = normalizeChoice(await rl.question('\nSelect option [1/2/3] (default 1): ')) || '1';

    if (choice === '1') {
      console.log('\n[guided] Running first-time bootstrap...\n');
      runOrThrow(NODE_BIN, ['src/scripts/admin-init.mjs']);
      const review = normalizeChoice(await rl.question('Review/fill runtime .env values now? [Y/n]: '));
      if (isYes(review, true)) {
        await ensureRuntimeEnv(rl);
      }
      console.log('\n[guided] First-time setup complete.\n');
    } else if (choice === '2') {
      const review = normalizeChoice(await rl.question('Review/fill runtime .env values now? [Y/n]: '));
      if (isYes(review, true)) {
        await ensureRuntimeEnv(rl);
      }
      console.log('\n[guided] Running runtime refresh...\n');
      runOrThrow(NODE_BIN, ['src/scripts/setup.mjs']);
      console.log('\n[guided] Runtime refresh complete.\n');
    } else if (choice === '3') {
      console.log('\n[guided] Running vault top-up...\n');
      runOrThrow(NODE_BIN, ['src/scripts/topup-vault.mjs']);
      console.log('\n[guided] Vault top-up complete.\n');
    } else {
      throw new Error('Invalid option. Use 1, 2, or 3.');
    }

    const service = normalizeChoice(await rl.question('Install OS auto-start service for gateway now? [y/N]: '));
    if (isYes(service, false)) {
      runOrThrow(NODE_BIN, ['src/scripts/setup-service.mjs', 'install']);
    }

    console.log('Next recommended checks:');
    console.log('1) openclaw clawall wallet');
    console.log('2) openclaw clawall check --domain OS --action EXECUTE_COMMAND --command "ls"');
    console.log('3) npm run demo');
  } catch (err) {
    console.error(`\nFAILED: ${err.message}`);
  } finally {
    rl.close();
  }
}

main();
