import './runtime-env.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const NODE_BIN = process.execPath;
const SERVICE_NAME = 'clawall-gateway';
const WINDOWS_TASK = 'ClawAllGateway';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  return result.status ?? 1;
}

function runQuiet(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  return {
    code: result.status ?? 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function installLinux() {
  ensureDir(path.join(ROOT, 'logs'));
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, `${SERVICE_NAME}.service`);
  ensureDir(unitDir);
  const content = [
    '[Unit]',
    'Description=ClawAll Gateway',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${ROOT}`,
    `ExecStart=${NODE_BIN} ${path.join(ROOT, 'src', 'openclaw', 'gateway.mjs')} --port=3011`,
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
  fs.writeFileSync(unitPath, content, 'utf8');

  if (run('systemctl', ['--user', 'daemon-reload']) !== 0) {
    throw new Error('systemctl --user daemon-reload failed');
  }
  if (run('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]) !== 0) {
    throw new Error('systemctl --user enable --now failed');
  }

  console.log(`Installed user service: ${unitPath}`);
}

function removeLinux() {
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  run('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`]);
  run('systemctl', ['--user', 'daemon-reload']);
  fs.rmSync(unitPath, { force: true });
  console.log(`Removed user service: ${unitPath}`);
}

function statusLinux() {
  return run('systemctl', ['--user', 'status', `${SERVICE_NAME}.service`]);
}

function installMac() {
  ensureDir(path.join(ROOT, 'logs'));
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsDir, `ai.${SERVICE_NAME}.plist`);
  ensureDir(launchAgentsDir);

  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"> 
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${path.join(ROOT, 'src', 'openclaw', 'gateway.mjs')}</string>
    <string>--port=3011</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(ROOT, 'logs', 'gateway.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(ROOT, 'logs', 'gateway.log')}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, content, 'utf8');
  run('launchctl', ['unload', plistPath]);
  if (run('launchctl', ['load', '-w', plistPath]) !== 0) {
    throw new Error('launchctl load failed');
  }
  console.log(`Installed launch agent: ${plistPath}`);
}

function removeMac() {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `ai.${SERVICE_NAME}.plist`);
  run('launchctl', ['unload', plistPath]);
  fs.rmSync(plistPath, { force: true });
  console.log(`Removed launch agent: ${plistPath}`);
}

function statusMac() {
  return run('launchctl', ['list', `ai.${SERVICE_NAME}`]);
}

function installWindows() {
  ensureDir(path.join(ROOT, 'logs'));
  const gatewayScript = path.join(ROOT, 'src', 'openclaw', 'gateway.mjs');
  const cmd = `"${NODE_BIN}" "${gatewayScript}" --port=3011`;
  if (run('schtasks', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/TR', cmd, '/F']) !== 0) {
    throw new Error('schtasks create failed');
  }
  run('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
  console.log(`Installed scheduled task: ${WINDOWS_TASK}`);
}

function removeWindows() {
  run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
  console.log(`Removed scheduled task: ${WINDOWS_TASK}`);
}

function statusWindows() {
  return run('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/V', '/FO', 'LIST']);
}

function detectLinuxServiceManager() {
  const hasSystemctl = runQuiet('systemctl', ['--version']);
  return hasSystemctl.code === 0;
}

function printManualFallback() {
  const start = `node src/openclaw/gateway.mjs --port=3011`;
  console.log('\nAutomatic service setup is unavailable on this host.');
  console.log('Use manual startup command:');
  console.log(`  ${start}`);
  console.log("Or run full setup anytime with `npm run setup`.");
}

function usage() {
  console.log('Usage: node src/scripts/setup-service.mjs [install|remove|status]');
}

function main() {
  const action = String(process.argv[2] || 'install').trim().toLowerCase();
  if (!['install', 'remove', 'status'].includes(action)) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    if (process.platform === 'linux') {
      if (!detectLinuxServiceManager()) {
        printManualFallback();
        return;
      }
      if (action === 'install') installLinux();
      else if (action === 'remove') removeLinux();
      else statusLinux();
      return;
    }

    if (process.platform === 'darwin') {
      if (action === 'install') installMac();
      else if (action === 'remove') removeMac();
      else statusMac();
      return;
    }

    if (process.platform === 'win32') {
      if (action === 'install') installWindows();
      else if (action === 'remove') removeWindows();
      else statusWindows();
      return;
    }

    printManualFallback();
  } catch (err) {
    const detail = err?.message ?? String(err);
    console.error(`setup-service failed: ${detail}`);
    if (action === 'install') {
      printManualFallback();
    }
    process.exitCode = 1;
  }
}

main();
