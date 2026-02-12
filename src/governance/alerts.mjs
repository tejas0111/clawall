import 'dotenv/config';

const BOT_TOKEN = process.env.TG_BOT_TOKEN;
const CHAT_ID   = process.env.TG_CHAT_ID;

const ENABLED = Boolean(BOT_TOKEN && CHAT_ID);
const API     = ENABLED ? `https://api.telegram.org/bot${BOT_TOKEN}` : null;

let freezeAlertSent = false;

function escape(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
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
        parse_mode: 'MarkdownV2',
      }),
    });

    const json = await res.json();

    if (!json.ok) {
      console.error('[TG sendMessage error]', json.description);
      console.error('[TG message text was]', text);
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

  const text = [
    `🚨 *AGENT ALERT*`,
    ``,
    `*Level:* ${escape(level)}`,
    `*Domain:* ${escape(domain)}`,
    `*Stage:* ${escape(stage)}`,
    ``,
    `*Message:*`,
    escape(message),
    reason ? `\n*Reason:*\n${escape(reason)}` : '',
    risk    ? `\n*Risk:* ${escape(risk.risk_level)} \\(${escape(String(risk.risk_score))}\\)` : '',
    intent  ? `\n*Action:* ${escape(intent.action)}` : '',
  ].filter(line => line !== '').join('\n');

  await sendTelegram(text);
}

export async function sendFreezeAlert({
  reason = 'Agent frozen due to critical violation',
  source = 'SYSTEM',
  intent,
} = {}) {
  if (!ENABLED || freezeAlertSent) return;

  freezeAlertSent = true;

  const text = [
    `🧊 *AGENT FROZEN*`,
    ``,
    `🚫 *Status:* GLOBAL FREEZE ENABLED`,
    `📍 *Source:* ${escape(source)}`,
    ``,
    `*Reason:*`,
    escape(reason),
    intent ? `\n*Triggered By:*\n${escape(intent.domain)} → ${escape(intent.action)}` : '',
    ``,
    `⚠️ All agent actions are now blocked\\.`,
  ].filter(line => line !== '').join('\n');

  await sendTelegram(text);
}

export function resetFreezeAlert() {
  freezeAlertSent = false;
}
