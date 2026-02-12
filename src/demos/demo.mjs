import 'dotenv/config';
import '../governance/telegram-bot.mjs';

import readline from 'node:readline';
import crypto from 'node:crypto';

import { processIntent, resetAgentState } from '../core/brain.mjs';
import { getDemoExecutionContext, buildDemoConstraint } from './demo-context.mjs';
import { isFrozen } from '../state/kill-switch.mjs';

/* ============================================================
   CLI SETUP
============================================================ */

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'clawall> ',
});

function printBanner() {
  console.clear();
  console.log(`
/**********************************************/
|* 🦞 CLAWALL SHELL                           *|
|* Autonomous AI Constraint Layer             *|
\**********************************************/
`);
}

function printMenu() {
  console.log(`
1  → Normal Transaction
2  → Medium Risk Transaction
3  → High Risk Transaction (Approval Required)
4  → Simulate OS Attack
5  → Show Frozen Status
6  → Reset In-Memory State
0  → Exit
`);
}

/* ============================================================
   HELPERS
============================================================ */

function printResult(label, r) {
  console.log('\n------------------------------------');
  console.log(label);
  console.log('Decision:', r.decision);
  console.log('Layer   :', r.layer ?? 'EXECUTION');
  console.log('OK      :', r.ok);
  if (r.reason) console.log('Reason  :', r.reason);
  if (r.risk)   console.log('Risk    :', r.risk.risk_level, '| Score:', r.risk.risk_score);
  if (r.digest) {
    console.log('Digest  :', r.digest);
    console.log(`Explorer: https://suiscan.xyz/testnet/tx/${r.digest}`);
  }
  console.log('------------------------------------\n');
}

function buildBlockchainIntent(amount) {
  const { signer, guardCapId } = getDemoExecutionContext();
  const recipient = signer.toSuiAddress();

  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    domain: 'BLOCKCHAIN',
    action: 'WALLET_TRANSFER',
    params: { amount, recipient },
    metadata: {
      signer,
      guardCapId,
      constraint: buildDemoConstraint(recipient),
    },
  };
}

function buildOSViolation() {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    domain: 'OS',
    action: 'EXECUTE_COMMAND',
    params: { command: 'rm -rf ~/Documents' },
    metadata: {},
  };
}

/* ============================================================
   ACTION HANDLERS
============================================================ */

async function normalTx() {
  const intent  = buildBlockchainIntent(10_000_000);
  const context = {};                     // low amount, known recipient → LOW

  console.log('⏳ Processing normal transaction...');
  const result = await processIntent(intent, context);
  printResult('Normal TX', result);
}

async function mediumRiskTx() {
  const intent  = buildBlockchainIntent(150_000_000);
  const context = {
    recipientKnown: false,               // unknown recipient bumps score
  };

  console.log('⏳ Processing medium risk transaction...');
  console.log('👀 Watch Telegram for MEDIUM alert');
  const result = await processIntent(intent, context);
  printResult('Medium Risk TX', result);
}

async function highRiskTx() {
  const intent  = buildBlockchainIntent(260_000_000);
  const context = {
    recipientKnown:    false,
    shortExpiry:       true,
    repeatedRecipient: true,
  };

  console.log('⏳ Processing high risk transaction...');
  console.log('👉 Check Telegram for approval popup');
  const result = await processIntent(intent, context);
  printResult('High Risk TX', result);
}

async function simulateOS() {
  console.log('🚨 Simulating destructive OS command...');
  const result = await processIntent(buildOSViolation());
  printResult('OS Attack', result);
}

function showFrozen() {
  console.log('\nKill-switch frozen?:', isFrozen(), '\n');
}

function resetState() {
  resetAgentState();
  console.log('\n🔄 In-memory agent state reset\n');
}

/* ============================================================
   MAIN LOOP
============================================================ */

async function startShell() {
  printBanner();
  printMenu();
  rl.prompt();

  rl.on('line', async (line) => {
    const cmd = line.trim();

    try {
      switch (cmd) {
        case '1': await normalTx();    break;
        case '2': await mediumRiskTx(); break;
        case '3': await highRiskTx();  break;
        case '4': await simulateOS();  break;
        case '5': showFrozen();        break;
        case '6': resetState();        break;
        case '0':
          console.log('\n👋 Exiting CLAWALL\n');
          process.exit(0);
        default:
          console.log('Unknown option.');
      }
    } catch (err) {
      console.error('❌ Error:', err.message);
    }

    printMenu();
    rl.prompt();
  });
}

startShell();
