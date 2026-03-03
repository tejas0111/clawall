import 'dotenv/config';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;

const ENABLED = Boolean(BOT_TOKEN && CHAT_ID);
const API     = ENABLED ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

let freezeAlertSent = false;

function block(title, lines = []) {
  const cleaned = lines.filter((line) => line !== null && line !== undefined && line !== '');
  return [
    `CLAWALL | ${title}`,
    '-----------------------------',
    ...cleaned,
  ].join('\n');
}

function kv(key, value) {
  return `${String(key).padEnd(16, ' ')} ${value ?? 'n/a'}`;
}

async function sendTelegram(text) {
  if (!ENABLED || typeof fetch !== 'function') return;

  try {
    const res  = await fetch(`${API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    CHAT_ID,
        text,
      }),
    });

    const json = await res.json();

    if (!json.ok) {
      console.error('[TG sendMessage error]', json.description);
    }
  } catch (err) {
    console.error('[TG fetch error]', err.message);
  }
}

export async function sendAlert(payload = {}) {
  if (!ENABLED) return;

  const {
    level   = 'INFO',
    domain  = 'UNKNOWN',
    stage   = 'SYSTEM',
    message = 'Alert triggered',
    reason,
    risk,
    intent,
  } = payload;

  if (stage === 'KILL_SWITCH') return;

  const text = block('Security Alert', [
    kv('Level', level),
    kv('Domain', domain),
    kv('Stage', stage),
    kv('Message', message),
    reason ? kv('Reason', reason) : null,
    risk ? kv('Risk', `${risk.risk_level} (score=${risk.risk_score})`) : null,
    intent ? kv('Action', `${intent.domain} -> ${intent.action}`) : null,
  ]);

  await sendTelegram(text);
}

export async function sendFreezeAlert({
  reason = 'Agent frozen due to critical violation',
  source = 'SYSTEM',
  intent,
} = {}) {
  if (!ENABLED || freezeAlertSent) return;

  freezeAlertSent = true;

  const text = block('Kill Switch Engaged', [
    kv('Status', 'GLOBAL FREEZE ENABLED'),
    kv('Source', source),
    kv('Reason', reason),
    intent ? kv('Triggered By', `${intent.domain} -> ${intent.action}`) : null,
    'All agent actions are now blocked until manual resume.',
  ]);

  await sendTelegram(text);
}

export function resetFreezeAlert() {
  freezeAlertSent = false;
}
