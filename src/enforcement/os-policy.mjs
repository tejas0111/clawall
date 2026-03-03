import { URL } from 'node:url';

const ALLOWED_COMMANDS = new Set([
  'ls',
  'cat',
  'pwd',
  'echo',
  'grep',
  'head',
  'tail',
  'curl',
  'wget',
]);

const STRICT_UNTRUSTED_COMMANDS = new Set([
  'pwd',
  'ls',
  'echo',
]);

const BLOCKED_COMMANDS = new Set([
  'sudo',
  'rm',
  'dd',
  'mkfs',
  'chmod',
  'chown',
  'mount',
  'umount',
  'nohup',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'sh',
  'bash',
  'zsh',
  'fish',
  'nc',
  'ncat',
  'netcat',
  'scp',
  'ssh',
  'sftp',
  'rsync',
  'socat',
  'ftp',
  'telnet',
]);

const BLOCKED_PATH_FRAGMENTS = [
  '/etc',
  '/root',
  '/var/run',
  '/proc',
  '/sys',
  '/dev',
  '.ssh',
  '.gnupg',
  '.aws',
  '.npmrc',
  '.env',
];

const RESTRICTED_OPERATORS = new Set([
  ';',
  '&&',
  '||',
  '|',
  '>',
  '>>',
  '<',
  '<<',
  '&',
]);

const NETWORK_COMMANDS = new Set([
  'curl',
  'wget',
  'nc',
  'ncat',
  'netcat',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'socat',
  'ftp',
  'telnet',
]);

const IP_LITERAL_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HEX_IP_RE = /^0x[0-9a-f]+$/i;
const INTEGER_IP_RE = /^\d{8,}$/;
const LOCALHOST_NAMES = new Set([
  'localhost',
  'localhost.localdomain',
]);
const REBINDING_SUFFIXES = [
  '.nip.io',
  '.xip.io',
  '.sslip.io',
  '.traefik.me',
];

const SAFE_PATH_ARG_RE = /^[a-zA-Z0-9_\-./:@%+=]+$/;

function parseCsvLower(value) {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
}

const EGRESS_ALLOWLIST = parseCsvLower(process.env.OS_EGRESS_ALLOWLIST);
const EGRESS_BLOCK_PRIVATE =
  String(process.env.OS_EGRESS_BLOCK_PRIVATE ?? '1') !== '0';

function deny(severity, reason, details = {}) {
  return {
    allowed: false,
    severity,
    reason,
    details,
  };
}

function allow(details = {}) {
  return {
    allowed: true,
    severity: 'LOW',
    details,
  };
}

function decodeBackslashHex(input) {
  return input
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function canonicalizeCommand(raw) {
  let value = String(raw ?? '');
  value = value.normalize('NFKC');
  value = value.replace(/[\u200B-\u200D\uFEFF]/g, '');
  value = decodeBackslashHex(value);

  for (let i = 0; i < 2; i += 1) {
    const decoded = safeDecodeURIComponent(value);
    if (decoded === value) break;
    value = decoded;
  }

  value = value
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();

  return value;
}

function tokenizeShell(command) {
  const tokens = [];
  let i = 0;
  let buf = '';
  let quote = null;

  const flush = () => {
    if (buf.length > 0) {
      tokens.push({ type: 'word', value: buf });
      buf = '';
    }
  };

  const pushOperator = (value) => {
    flush();
    tokens.push({ type: 'op', value });
  };

  while (i < command.length) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        buf += command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === '\'') {
      quote = ch;
      i += 1;
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) {
      buf += command[i + 1];
      i += 2;
      continue;
    }

    if (/\s/.test(ch)) {
      flush();
      i += 1;
      continue;
    }

    const two = `${ch}${next ?? ''}`;
    if (two === '&&' || two === '||' || two === '>>' || two === '<<') {
      pushOperator(two);
      i += 2;
      continue;
    }

    if (';|><&'.includes(ch)) {
      pushOperator(ch);
      i += 1;
      continue;
    }

    if (ch === '`') {
      pushOperator('`');
      i += 1;
      continue;
    }

    if (ch === '$' && next === '(') {
      pushOperator('$(');
      i += 2;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  if (quote) {
    return { ok: false, reason: 'Unterminated shell quote', tokens: [] };
  }

  return { ok: true, tokens };
}

function parseShellAst(command) {
  const tokenized = tokenizeShell(command);
  if (!tokenized.ok) {
    return {
      ok: false,
      reason: tokenized.reason,
      ast: null,
    };
  }

  const tokens = tokenized.tokens;
  const operators = [];
  const segments = [];
  let argv = [];

  const flushSegment = () => {
    if (argv.length > 0) {
      segments.push({
        argv,
        command: argv.join(' '),
      });
      argv = [];
    }
  };

  for (const token of tokens) {
    if (token.type === 'word') {
      argv.push(token.value);
      continue;
    }

    operators.push(token.value);
    flushSegment();
  }
  flushSegment();

  if (segments.length === 0) {
    return {
      ok: false,
      reason: 'No command tokens found',
      ast: null,
    };
  }

  return {
    ok: true,
    ast: {
      segments,
      operators,
    },
  };
}

function baseCommand(segment) {
  const cmd = segment?.argv?.[0] ?? '';
  return cmd.replace(/^.*\//, '').replace(/^\.\//, '').toLowerCase();
}

function isPrivateIp(host) {
  if (!IP_LITERAL_RE.test(host)) return false;
  const parts = host.split('.').map((n) => Number(n));
  if (parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;

  if (parts[0] === 10) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 0) return true;
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // CGNAT
  if (parts[0] === 169 && parts[1] === 254) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true; // Cloud/Benchmarking
  return false;
}

function looksLikeRebindingHost(host) {
  const lc = host.toLowerCase();
  if (LOCALHOST_NAMES.has(lc)) return true;
  if (lc.endsWith('.local')) return true;
  if (lc.endsWith('.internal')) return true;
  if (REBINDING_SUFFIXES.some((suffix) => lc.endsWith(suffix))) return true;
  if (HEX_IP_RE.test(lc) || INTEGER_IP_RE.test(lc)) return true;
  if (IP_LITERAL_RE.test(lc) && isPrivateIp(lc)) return true;
  return false;
}

function hostAllowed(host) {
  const lc = host.toLowerCase();
  if (EGRESS_ALLOWLIST.size === 0) return false;
  if (EGRESS_ALLOWLIST.has(lc)) return true;

  for (const allow of EGRESS_ALLOWLIST) {
    if (allow.startsWith('*.')) {
      const suffix = allow.slice(1); // keep leading dot
      if (lc.endsWith(suffix)) return true;
    }
  }
  return false;
}

function extractNetworkTargets(segment) {
  const targets = [];
  for (const arg of segment.argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    try {
      const url = new URL(arg);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        targets.push(url);
      }
    } catch {
      // Non-URL argument.
    }
  }
  return targets;
}

function hasSensitivePathArg(segment) {
  return segment.argv.some((arg) => {
    const value = String(arg ?? '').toLowerCase();
    return BLOCKED_PATH_FRAGMENTS.some((frag) => value.includes(frag));
  });
}

function validateCommandArgs(segment, provenance) {
  const cmd = baseCommand(segment);
  const args = segment.argv.slice(1);

  if (args.some((arg) => !SAFE_PATH_ARG_RE.test(arg))) {
    return deny('HIGH', 'Unsafe characters in command arguments', { command: cmd });
  }

  if (BLOCKED_COMMANDS.has(cmd)) {
    return deny('CRITICAL', `Blocked command: ${cmd}`, { command: cmd });
  }

  if (!ALLOWED_COMMANDS.has(cmd)) {
    return deny('MEDIUM', `Command not allow-listed: ${cmd}`, { command: cmd });
  }

  if (provenance?.trust === 'UNTRUSTED' && !STRICT_UNTRUSTED_COMMANDS.has(cmd)) {
    return deny(
      'HIGH',
      `Untrusted provenance cannot run command: ${cmd}`,
      { command: cmd, provenance: provenance.source }
    );
  }

  if (hasSensitivePathArg(segment)) {
    return deny('CRITICAL', 'Sensitive path access blocked', { command: cmd });
  }

  if (NETWORK_COMMANDS.has(cmd)) {
    const targets = extractNetworkTargets(segment);
    if (targets.length === 0) {
      return deny('HIGH', 'Network command requires explicit URL target', { command: cmd });
    }

    for (const target of targets) {
      const host = target.hostname.toLowerCase();
      if (looksLikeRebindingHost(host)) {
        return deny('CRITICAL', 'Potential DNS rebinding/localhost target blocked', {
          command: cmd,
          host,
        });
      }

      if (EGRESS_BLOCK_PRIVATE && isPrivateIp(host)) {
        return deny('CRITICAL', 'Private-network egress target blocked', {
          command: cmd,
          host,
        });
      }

      if (!hostAllowed(host)) {
        return deny('HIGH', `Egress host not allow-listed: ${host}`, {
          command: cmd,
          host,
        });
      }
    }
  }

  return allow({ command: cmd });
}

export function parseCommandAst(command) {
  const canonical = canonicalizeCommand(command);
  const parsed = parseShellAst(canonical);
  if (!parsed.ok) {
    return {
      ok: false,
      canonical,
      reason: parsed.reason,
      ast: null,
    };
  }
  return {
    ok: true,
    canonical,
    ast: parsed.ast,
  };
}

export function enforceOSPolicy(params = {}, context = {}) {
  const rawCommand = params?.command;
  if (typeof rawCommand !== 'string' || !rawCommand.trim()) {
    return deny('HIGH', 'Empty or invalid OS command');
  }

  const parsed = parseCommandAst(rawCommand);
  if (!parsed.ok) {
    return deny('HIGH', parsed.reason, { canonical_command: parsed.canonical });
  }

  const { ast, canonical } = parsed;
  const restrictedOp = ast.operators.find((op) => RESTRICTED_OPERATORS.has(op));
  if (restrictedOp) {
    return deny('CRITICAL', `Shell operator blocked: ${restrictedOp}`, {
      canonical_command: canonical,
      operator: restrictedOp,
    });
  }

  if (ast.operators.includes('`') || ast.operators.includes('$(')) {
    return deny('CRITICAL', 'Command substitution blocked', {
      canonical_command: canonical,
    });
  }

  for (const segment of ast.segments) {
    const argDecision = validateCommandArgs(segment, context.provenance);
    if (!argDecision.allowed) {
      return {
        ...argDecision,
        details: {
          ...argDecision.details,
          canonical_command: canonical,
          segment: segment.command,
        },
      };
    }
  }

  return allow({
    canonical_command: canonical,
    segment_count: ast.segments.length,
    provenance: context?.provenance?.source ?? 'UNKNOWN',
  });
}
