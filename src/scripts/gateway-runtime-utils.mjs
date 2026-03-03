import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const NODE_BIN = process.execPath;
const LOG_DIR = path.resolve(ROOT, 'logs');
const LOG_PATH = path.resolve(LOG_DIR, 'gateway.log');
const PID_DIR = path.resolve(ROOT, 'src', 'state');
const PID_PATH = path.resolve(PID_DIR, 'gateway.pid');

function ensureDirs() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.mkdirSync(PID_DIR, { recursive: true });
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_PATH, 'utf8').trim();
    const pid = Number(raw);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return Math.floor(pid);
  } catch {
    return null;
  }
}

function writePid(pid) {
  ensureDirs();
  fs.writeFileSync(PID_PATH, `${pid}\n`, 'utf8');
}

function clearPid() {
  try {
    fs.rmSync(PID_PATH, { force: true });
  } catch {
    // ignore
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // ignore
  }
  const start = Date.now();
  while (Date.now() - start < 1500) {
    if (!isProcessRunning(pid)) return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // ignore
  }
  return !isProcessRunning(pid);
}

function stopFallbackByPattern() {
  const scriptPattern = 'src/openclaw/gateway.mjs';
  if (process.platform === 'win32') {
    const ps = [
      '-NoProfile',
      '-Command',
      `$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${scriptPattern.replace(/\//g, '\\/')}*' };` +
      'foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    ];
    spawnSync('powershell.exe', ps, { stdio: 'ignore' });
    return;
  }
  spawnSync('pkill', ['-f', scriptPattern], { stdio: 'ignore' });
}

export function stopGateway() {
  const pid = readPid();
  let stopped = false;
  if (pid && isProcessRunning(pid)) {
    stopped = killPid(pid);
  }
  if (!stopped) {
    stopFallbackByPattern();
  }
  clearPid();
}

export function startGateway(runtimeEnv = process.env) {
  ensureDirs();
  const out = fs.openSync(LOG_PATH, 'a');
  const child = spawn(NODE_BIN, ['src/openclaw/gateway.mjs', '--port=3011'], {
    cwd: ROOT,
    env: runtimeEnv,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writePid(child.pid);
  return child.pid;
}

export function restartGateway(runtimeEnv = process.env) {
  stopGateway();
  return startGateway(runtimeEnv);
}

export function gatewayStatus() {
  const pid = readPid();
  if (!pid) return { running: false, pid: null, logPath: LOG_PATH };
  return { running: isProcessRunning(pid), pid, logPath: LOG_PATH };
}
