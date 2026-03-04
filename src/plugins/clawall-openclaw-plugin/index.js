const PLUGIN_ID = 'clawall-security';
const GATEWAY_URL = 'http://127.0.0.1:3011';
const SUI_COIN_TYPE = '0x2::sui::SUI';
const DEFAULT_USDC_COIN_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';

// Safe request helper (no environment access)
const call = async (api, path, method = 'GET', body = null) => {
  const cfg = api?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
  const url = `${cfg.api_url || GATEWAY_URL}${path}`;
  const headers = { 
    'x-clawall-source': 'openclaw-plugin', 
    'x-clawall-plugin-key': cfg.api_key || 'demo' 
  };
  if (body) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : null });
    const data = await res.json().catch(() => ({ ok: false }));
    return { ok: res.ok, ...data };
  } catch (e) { return { ok: false, reason: 'Gateway offline' }; }
};

function normalizeInput(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) return input.join(' ');
  if (input && typeof input === 'object') {
    if (typeof input.text === 'string') return input.text;
    if (typeof input.content === 'string') return input.content;
    if (typeof input.message === 'string') return input.message;
    return String(input.input || input.prompt || input.value || input);
  }
  return String(input || '');
}

function parseAmountFromText(rawText) {
  const text = normalizeInput(rawText);
  const m = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(sui|mist|usdc|wal|hasui|hawal|usdt|token)\b/i) || 
            text.match(/--amount\s+([0-9]+(?:\.[0-9]+)?)/i);
  if (m) {
    const unitMatch = text.match(/--unit\s+([a-z]+)/i) || text.match(/--token\s+([a-z]+)/i) || [null, m[2]];
    return { value: m[1], unit: (unitMatch[1] || 'sui').toLowerCase() };
  }
  return null;
}

function parseRecipientFromText(rawText) {
  const text = normalizeInput(rawText);
  const m = text.match(/(0x[a-fA-F0-9]{40,64})/) || text.match(/--(?:recipient|to)\s+(0x[a-fA-F0-9]{40,64})/i);
  return m ? m[1] : null;
}

function isTransferIntent(rawText) {
  const text = normalizeInput(rawText);
  const lower = text.toLowerCase();
  const hasVerb = /\b(send|pay|transfer|give|move|ship)\b/.test(lower);
  if (!hasVerb) return false;
  const hasRecipient = /(0x[a-fA-F0-9]{40,64})/.test(text);
  const hasToken = /\b(sui|mist|usdc|wal|hasui|hawal|usdt|token)\b/.test(lower);
  const hasAmount = /[0-9]+(?:\.[0-9]+)?/.test(text);
  return hasRecipient || (hasAmount && hasToken);
}

function isPriceIntent(rawText) {
  const text = normalizeInput(rawText).toLowerCase();
  const asksPrice = /\b(price|prices|rate|worth|usd value|value in usd)\b/.test(text);
  const hasToken = /\b(sui|mist|usdc|wal|hasui|hawal|usdt|tram|tram_token|token)\b/.test(text);
  return asksPrice && hasToken;
}

function isTxIntent(rawText) {
  const text = normalizeInput(rawText).toLowerCase();
  if (/\b(tx|transaction|history|recent transfer|last transfer)\b/.test(text)) return true;
  if (/0x[a-f0-9]{64}/.test(text) && /\b(tx|transaction|digest)\b/.test(text)) return true;
  return false;
}

export function clawallTransformChatInput(input) {
  const rawText = normalizeInput(input).trim();
  if (!rawText || rawText.startsWith('/') || rawText.length < 3) return null;
  if (isTransferIntent(rawText)) {
    if (rawText.toLowerCase().includes('usd') || rawText.toLowerCase().includes('price')) {
      return `/clawall_transfer_quote ${rawText}`;
    }
    return `/clawall_transfer ${rawText}`;
  }
  if (isPriceIntent(rawText)) {
    return `/clawall_price ${rawText}`;
  }
  if (isTxIntent(rawText)) {
    return `/clawall_tx ${rawText}`;
  }
  return null;
}

// Core execution logic
async function doWallet(api) {
  const res = await call(api, '/v1/wallet');
  if (!res.ok) return { text: `❌ ${res.reason || res.error || 'Vault check failed'}` };
  let out = `### 🔐 Vault Summary\n\n`;
  res.coins.forEach(c => out += `- **${c.symbol}**: ${c.total_balance_human}\n`);
  out += `\n*Vault ID: ${res.vault_id.slice(0,12)}...*`;
  return { text: out };
}

function parsePriceArgs(raw) {
  const text = normalizeInput(raw);
  const unitMatch = text.match(/--unit\s+([a-zA-Z0-9_:\-]+)/);
  const coinTypeMatch = text.match(/--coin-type\s+([^\s]+)/);
  const amountMatch = text.match(/--amount\s+([0-9]+)/);
  return {
    unit: unitMatch ? unitMatch[1] : null,
    coin_type: coinTypeMatch ? coinTypeMatch[1] : null,
    amount: amountMatch ? amountMatch[1] : null,
  };
}

function parseCheckArgs(raw) {
  const text = normalizeInput(raw);
  const domainMatch = text.match(/--domain\s+([a-zA-Z_]+)/);
  const actionMatch = text.match(/--action\s+([a-zA-Z_]+)/);
  const commandMatch = text.match(/--command\s+(.+)$/);
  return {
    domain: domainMatch ? domainMatch[1] : null,
    action: actionMatch ? actionMatch[1] : null,
    command: commandMatch ? commandMatch[1].trim() : null,
    raw: text.trim(),
  };
}

function parseTxArgs(raw) {
  const text = normalizeInput(raw);
  const limitMatch = text.match(/--limit\s+([0-9]+)/i);
  const full = /\s--full(?:\s|$)/i.test(` ${text} `);
  const digestMatch =
    text.match(/--digest\s+([^\s]+)/i) ||
    text.match(/\b(?:digest|tx|transaction)\s+([1-9A-HJ-NP-Za-km-z]{20,})\b/i) ||
    text.match(/\b([1-9A-HJ-NP-Za-km-z]{20,})\b/);
  const idMatch = text.match(/--id\s+([^\s]+)/i);
  const proposalMatch =
    text.match(/--proposal(?:_id)?\s+([^\s]+)/i) ||
    text.match(/\bproposal(?:\s+id)?\s*[:=]?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i) ||
    text.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return {
    limit: limitMatch ? Number(limitMatch[1]) : null,
    full: full ? true : undefined,
    digest: digestMatch ? digestMatch[1] : null,
    id: idMatch ? idMatch[1] : null,
    proposal_id: proposalMatch ? proposalMatch[1] : null,
  };
}

function normalizeSymbol(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function resolveFallbackCoinTypeByUnit(unit) {
  const normalized = normalizeSymbol(unit);
  if (!normalized) return null;
  if (normalized === 'sui' || normalized === 'mist') return SUI_COIN_TYPE;
  if (normalized === 'usdc') return DEFAULT_USDC_COIN_TYPE;
  return null;
}

function normalizeUnitAlias(unit) {
  const normalized = normalizeSymbol(unit);
  if (normalized === 'hawal' || normalized === 'haw') return 'hawal';
  if (normalized === 'hasui' || normalized === 'has') return 'hasui';
  if (normalized === 'walrus') return 'wal';
  return normalized;
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(8)}`;
}

function extractUnitsFromText(text, walletSymbols = []) {
  const normalizedText = normalizeInput(text).toLowerCase();
  const fromWallet = walletSymbols
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.findIndex((x) => x.toLowerCase() === s.toLowerCase()) === i)
    .filter((symbol) => new RegExp(`\\b${symbol.toLowerCase()}\\b`).test(normalizedText));
  const fallback = ['sui', 'usdc', 'hasui', 'hawal', 'wal', 'usdt', 'tram_token']
    .filter((symbol) => new RegExp(`\\b${symbol}\\b`).test(normalizedText));
  return [...new Set([...fromWallet, ...fallback])];
}

async function doPrice(api, params) {
  const parsed = typeof params === 'string' ? parsePriceArgs(params) : (params || {});
  const reqAmount = parsed.amount != null ? String(parsed.amount).trim() : null;
  const explicitCoinType = String(parsed.coin_type || '').trim();
  const explicitUnit = String(parsed.unit || '').trim();

  const wallet = await call(api, '/v1/wallet');
  const walletCoins = Array.isArray(wallet?.coins) ? wallet.coins : [];
  const walletSymbols = walletCoins.map((c) => c.symbol);

  const requestedUnits = explicitCoinType
    ? []
    : explicitUnit
      ? [explicitUnit]
      : extractUnitsFromText(params, walletSymbols);

  const requests = [];
  if (explicitCoinType) {
    requests.push({ label: explicitCoinType, coinType: explicitCoinType });
  } else {
    for (const unit of requestedUnits) {
      const normalizedUnit = normalizeUnitAlias(unit);
      const coin = walletCoins.find((c) => normalizeUnitAlias(c.symbol) === normalizedUnit);
      const coinType = coin?.coin_type || resolveFallbackCoinTypeByUnit(normalizedUnit);
      if (!coinType) continue;
      requests.push({ label: coin?.symbol || unit.toUpperCase(), coinType });
    }
  }

  if (!requests.length) {
    return { text: 'I could not determine which token price to fetch. Try: "show me USDC price" or "/clawall_price --unit hasui".' };
  }

  const rows = [];
  const seen = new Set();
  for (const req of requests) {
    if (seen.has(req.coinType)) continue;
    seen.add(req.coinType);
    const query = new URLSearchParams({ coin_type: req.coinType });
    if (reqAmount) query.set('amount', reqAmount);
    const res = await call(api, `/v1/price?${query.toString()}`);
    if (!res.ok) {
      rows.push(`- ${req.label}: unavailable (${res.error || res.reason || 'price unavailable'})`);
      continue;
    }
    const symbol = res.symbol || req.label;
    const price = formatUsd(res.price_usd);
    const transfer = Number.isFinite(Number(res.transfer_usd))
      ? ` | amount value: ${formatUsd(res.transfer_usd)}`
      : '';
    rows.push(`- ${symbol}: ${price}${transfer}`);
  }

  return { text: `### Price Snapshot\n\n${rows.join('\n')}` };
}

async function doCheck(api, params) {
  const parsed = typeof params === 'string' ? parseCheckArgs(params) : (params || {});
  const domain = String(parsed.domain || 'OS').toUpperCase();
  const action = String(parsed.action || 'EXECUTE_COMMAND').toUpperCase();

  const payload = {
    domain,
    action,
    params: {},
    metadata: { source: 'USER_CHAT' },
  };

  if (parsed.command) {
    payload.params.command = parsed.command;
  } else if (typeof parsed.raw === 'string' && parsed.raw && !parsed.raw.startsWith('--')) {
    payload.params.command = parsed.raw;
  } else if (typeof params === 'string' && params.trim() && !params.trim().startsWith('--')) {
    payload.params.command = params.trim();
  }

  const res = await call(api, '/v1/check', 'POST', payload);
  const layer = res.layer || 'UNKNOWN';
  const decision = res.decision || (res.ok ? 'ALLOW' : 'BLOCKED');
  const reason = normalizeTransferReason(res.reason || res.error || '');
  const risk = res.risk?.risk_level ? ` | risk=${res.risk.risk_level}(${res.risk.risk_score ?? 'n/a'})` : '';

  if (!res.ok || decision === 'BLOCKED') {
    return { text: `Check blocked by ${layer}: ${reason}${risk}` };
  }
  if (decision === 'FLAGGED') {
    return { text: `Check flagged (${layer}): ${reason}${risk}` };
  }

  return { text: `Check passed: ${decision} via ${layer}${risk}` };
}

async function doTx(api, params) {
  const parsed = typeof params === 'string' ? parseTxArgs(params) : (params || {});
  const id = String(parsed.id || '').trim();
  const digest = String(parsed.digest || '').trim();
  const proposalId = String(parsed.proposal_id || '').trim();

  if (id || digest || proposalId) {
    const q = new URLSearchParams();
    if (id) q.set('id', id);
    if (digest) q.set('digest', digest);
    if (proposalId) q.set('proposal_id', proposalId);
    const res = await call(api, `/v1/tx?${q.toString()}`);
    if (!res.ok) {
      return { text: `TX not found. Try: "show recent tx history" or provide digest/proposal id.` };
    }
    const latest = Array.isArray(res.events) && res.events.length ? res.events[0] : null;
    if (!latest) return { text: 'TX found but no event details available.' };
    const lines = [
      `Status: ${latest.status || 'UNKNOWN'}`,
      `Layer: ${latest.layer || 'n/a'}`,
      `Digest: ${latest.digest || 'n/a'}`,
      `Proposal ID: ${latest.proposal_id || 'n/a'}`,
      `Time: ${latest.ts || 'n/a'}`,
      `Reason: ${latest.reason || 'n/a'}`,
    ];
    return { text: `### TX Details\n\n${lines.join('\n')}` };
  }

  const limit = Number.isFinite(Number(parsed.limit)) ? Math.max(1, Math.min(Number(parsed.limit), 50)) : 8;
  const useFull = parsed.full !== false;
  const chain = await call(api, `/v1/chainlogs?limit=${limit}${useFull ? '&full=1' : ''}`);
  if (chain.ok && Array.isArray(chain.lines) && chain.lines.length) {
    const requested = Number.isFinite(Number(chain.requested)) ? Number(chain.requested) : limit;
    const summary = `Showing ${chain.lines.length} of requested ${requested}.`;
    return {
      text: `### On-Chain Logs\n\n${summary}\n\n${chain.lines.join('\n')}\n\nUse \`openclaw clawall tx --digest <digest>\` for full transaction detail.`,
    };
  }

  const res = await call(api, `/v1/tx-history?limit=${limit}`);
  if (!res.ok) return { text: `TX history failed: ${res.error || res.reason || 'unavailable'}` };
  const lines = (res.items || []).map((e, i) => {
    const digestText = e.digest ? `${String(e.digest).slice(0, 12)}...` : 'n/a';
    const proposalText = e.proposal_id ? `${String(e.proposal_id).slice(0, 12)}...` : 'n/a';
    if (e.digest) return `${i + 1}) ${e.status || 'UNKNOWN'} | ${e.ts || 'n/a'} | digest=${digestText}`;
    return `${i + 1}) ${e.status || 'UNKNOWN'} | ${e.ts || 'n/a'} | proposal=${proposalText} | digest=n/a`;
  });
  const note = res.note ? `\n\nNote: ${res.note}` : '';
  return { text: `### TX History\n\n${lines.join('\n') || 'No transaction events yet.'}${note}` };
}

const UNIT_ALIASES = {
  'walrus': 'wal',
  'walrus token': 'wal',
  'sui token': 'sui',
  'mist': 'sui',
  'sui': 'sui',
  'wal': 'wal'
};

async function doTransfer(api, params) {
  let args = params;
  if (typeof params === 'string') {
    const amt = parseAmountFromText(params);
    const to = parseRecipientFromText(params);
    if (!amt || !to) {
      return { text: 'I couldn\'t parse the transfer details. Please use a format like: "send 0.1 sui to 0x..."' };
    }
    args = { amount: amt.value, unit: amt.unit, recipient: to };
  }

  const { amount, unit = 'sui', recipient } = args;
  
  // Resolve unit alias and find coin in vault
  const normalizedUnit = UNIT_ALIASES[unit.toLowerCase()] || unit.toLowerCase();
  const vault = await call(api, '/v1/wallet');
  const coins = Array.isArray(vault?.coins) ? vault.coins : [];
  const hasExactSui = coins.find((c) => String(c.coin_type || '').toLowerCase() === '0x2::sui::sui');
  const coin = coins.find((c) => normalizeUnitAlias(c.symbol) === normalizedUnit) ||
    (normalizedUnit === 'sui' ? hasExactSui : null) ||
    coins.find((c) => String(c.coin_type || '').toLowerCase().includes(`::${normalizedUnit}::`));

  if (!coin && normalizedUnit !== 'sui' && normalizedUnit !== 'usdc') {
    return { text: `I couldn't find any ${normalizedUnit.toUpperCase()} in the vault. Available coins: ${vault.coins?.map(c => c.symbol).join(', ')}` };
  }

  const decimals = coin?.decimals ?? 9;
  const amountBaseUnits = Math.floor(parseFloat(amount) * Math.pow(10, decimals));
  const coinType = coin?.coin_type ?? (normalizedUnit === 'usdc' ? '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC' : '0x2::sui::SUI');

  const res = await call(api, '/v1/signed-transfer', 'POST', {
    amount: amountBaseUnits, 
    recipient, 
    coin_type: coinType, 
    metadata: { source: 'USER_CHAT' }
  });

  if (!res.ok || res.decision === 'BLOCKED') {
    const rawReason = res.reason || res.error || 'Policy decision';
    const normalizedReason = normalizeTransferReason(rawReason);
    const layer = res.layer || 'unknown';
    return { 
      text: `The transfer of ${amount} ${normalizedUnit.toUpperCase()} was blocked by the ${layer} security layer. Reason: ${normalizedReason}`,
      error: normalizedReason,
      layer
    };
  }

  const explorerUrl = `https://testnet.suivision.xyz/txblock/${res.digest}`;
  const riskLevel = res.risk?.risk_level || 'LOW';

  return { 
    text: [
      `Transfer executed successfully.`,
      `Amount: ${amount} ${normalizedUnit.toUpperCase()}`,
      `Recipient: ${recipient}`,
      `Digest: ${res.digest}`,
      `Explorer: ${explorerUrl}`,
      `Walrus Blob: ${res.walrus_blob_id || 'n/a'}`,
      `Risk Level: ${riskLevel}`,
    ].join('\n'),
    amount,
    unit: normalizedUnit.toUpperCase(),
    recipient,
    digest: res.digest,
    explorer_url: explorerUrl,
    risk_level: riskLevel,
    audit_proof: res.walrus_blob_id
  };
}

function normalizeTransferReason(reason) {
  const text = String(reason || '').trim();
  const lower = text.toLowerCase();
  if (!text) return 'Policy decision';
  if (
    lower.includes('commandargumenterror') &&
    lower.includes('arg_idx: 3') &&
    lower.includes('typemismatch')
  ) {
    return 'Transfer argument type mismatch (freeze state). FREEZE_STATE_ID likely belongs to a different package.';
  }
  if (lower.includes('moveabort') && lower.includes('abort code: 12')) {
    return 'On-chain transfer aborted (Move abort code 12). Check freeze state, vault balances, and coin type.';
  }
  if (lower.includes('policy integrity check failed')) {
    return 'Policy integrity mismatch detected. Restore policy hash/anchor state and retry.';
  }
  return text;
}

export default function(api) {
  api.on('before_agent_start', async () => ({
    prependContext: [
      "ClawAll Security: You are equipped with secure Sui execution tools.",
      "1. Use `clawall_wallet` to show holdings before any transfer.",
      "2. Use `clawall_price` for all token price requests.",
      "3. Use `clawall_transfer` for all transfer requests.",
      "4. NEVER hallucinate hashes. ONLY return the data provided by the tool.",
      "5. Execute transfer tools immediately when requested.",
      "6. IMPORTANT: Respond in a warm, natural, human tone.",
      "7. For successful transfers, ALWAYS include Digest, Explorer URL, and Walrus Blob in your final user response.",
      "8. Do not omit security layer + reason when a transfer is blocked.",
      "9. Use `clawall_tx` when user asks for transaction history/details."
    ].join('\n')
  }), { priority: 1000 });

  api.registerTool(() => ({
    name: 'clawall_wallet',
    description: 'Check vault balances on Sui',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    async execute() { return await doWallet(api); }
  }));

  api.registerTool(() => ({
    name: 'clawall_price',
    description: 'Get token USD prices from ClawAll gateway pricing endpoint',
    parameters: {
      type: 'object',
      properties: {
        unit: { type: 'string', description: 'Token symbol like sui/usdc/hasui/hawal/wal' },
        coin_type: { type: 'string', description: 'Full Sui coin type 0x...::module::struct' },
        amount: { type: 'string', description: 'Optional base-unit amount for transfer_usd estimate' }
      },
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      const result = await doPrice(api, params);
      return JSON.stringify(result);
    }
  }));

  api.registerTool(() => ({
    name: 'clawall_check',
    description: 'Run a policy/risk/firewall check without executing transfer',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Intent domain, default OS' },
        action: { type: 'string', description: 'Intent action, default EXECUTE_COMMAND' },
        command: { type: 'string', description: 'OS command string for security check' }
      },
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      const result = await doCheck(api, params);
      return JSON.stringify(result);
    }
  }));

  api.registerTool(() => ({
    name: 'clawall_tx',
    description: 'Get transaction history and details from local ClawAll security logs',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'History length, default 8 (max 50)' },
        id: { type: 'string', description: 'Generic tx record id' },
        digest: { type: 'string', description: 'Sui tx digest' },
        proposal_id: { type: 'string', description: 'Proposal/intent id' }
      },
      additionalProperties: false
    },
    async execute(_toolCallId, params) {
      const result = await doTx(api, params);
      return JSON.stringify(result);
    }
  }));

  api.registerTool(() => ({
    name: 'clawall_transfer',
    description: 'Execute a secure transfer from the vault',
    parameters: {
      type: 'object',
      properties: {
        amount: { type: 'string', description: 'Amount (e.g. "0.1")' },
        unit: { type: 'string', description: 'Symbol (sui, usdc, wal)' },
        recipient: { type: 'string', description: 'Recipient (0x...)' }
      },
      required: ['amount', 'recipient'],
      additionalProperties: false
    },
    async execute(_toolCallId, params) { 
      const result = await doTransfer(api, params);
      return JSON.stringify(result); 
    }
  }));

  api.registerCommand({ name: 'clawall_wallet', handler: async () => (await doWallet(api)).text });
  api.registerCommand({ name: 'clawall_price', handler: async (args) => (await doPrice(api, args)).text });
  api.registerCommand({ name: 'clawall_check', handler: async (args) => (await doCheck(api, args)).text });
  api.registerCommand({ name: 'clawall_tx', handler: async (args) => (await doTx(api, args)).text });
  api.registerCommand({ name: 'clawall_transfer', handler: async (args) => (await doTransfer(api, args)).text });
  api.registerCommand({ name: 'clawall_send', handler: async (args) => (await doTransfer(api, args)).text });
  api.registerCommand({ name: 'clawall_pay', handler: async (args) => (await doTransfer(api, args)).text });
  api.registerCli(({ program }) => {
    const cmd = program.command('clawall');
    const transferHandler = async (argsArray) => console.log((await doTransfer(api, argsArray.join(' '))).text);
    cmd.command('wallet').action(async () => console.log((await doWallet(api)).text));
    cmd.command('check')
      .option('--domain <domain>', 'Intent domain, default OS')
      .option('--action <action>', 'Intent action, default EXECUTE_COMMAND')
      .option('--command <command>', 'OS command payload')
      .argument('[raw...]', 'Raw command text fallback')
      .action(async (...cliArgs) => {
        const rawArgs = cliArgs.find((a) => Array.isArray(a)) || [];
        const opts = cliArgs.find(
          (a) =>
            a &&
            typeof a === 'object' &&
            !Array.isArray(a) &&
            ('domain' in a || 'action' in a || 'command' in a)
        ) || {};
        const rawText = Array.isArray(rawArgs) ? rawArgs.join(' ') : '';
        const params = {
          domain: opts?.domain,
          action: opts?.action,
          command: opts?.command,
          raw: rawText,
        };
        console.log((await doCheck(api, params)).text);
      });
    cmd.command('price')
      .option('--unit <unit>', 'Token symbol like usdc/sui/hasui/hawal/wal')
      .option('--coin-type <coinType>', 'Full Sui coin type')
      .option('--amount <amount>', 'Optional amount in base units')
      .action(async (opts) => console.log((await doPrice(api, opts)).text));
    cmd.command('tx')
      .option('--limit <limit>', 'How many recent tx records')
      .option('--full', 'Show full digest/recipient/blob values (no truncation)')
      .option('--id <id>', 'Record id')
      .option('--digest <digest>', 'Sui tx digest')
      .option('--proposal <proposal>', 'Proposal id')
      .argument('[raw...]', 'Raw text fallback')
      .action(async (...cliArgs) => {
        const rawArgs = cliArgs.find((a) => Array.isArray(a)) || [];
        const opts = cliArgs.find(
          (a) =>
            a &&
            typeof a === 'object' &&
            !Array.isArray(a) &&
            ('limit' in a || 'full' in a || 'id' in a || 'digest' in a || 'proposal' in a)
        ) || {};
        const rawText = Array.isArray(rawArgs) ? rawArgs.join(' ') : '';
        const params = {
          limit: opts?.limit,
          full: opts?.full ? true : undefined,
          id: opts?.id,
          digest: opts?.digest,
          proposal_id: opts?.proposal,
          raw: rawText,
        };
        console.log((await doTx(api, params)).text);
      });
    cmd.command('transfer')
      .argument('<args...>', 'Transfer details')
      .action(transferHandler);
    cmd.command('send')
      .argument('<args...>', 'Alias of transfer')
      .action(transferHandler);
    cmd.command('pay')
      .argument('<args...>', 'Alias of transfer')
      .action(transferHandler);
  }, { commands: ['clawall'] });
}
