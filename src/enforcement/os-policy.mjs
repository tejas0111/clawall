const BLOCKED_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\bsudo\b/i,
  /\bchmod\s+777\b/i,
  /\bdd\s+if=/i,
  />\s*\/dev\/sd/i,
  /\|\|/,
  /&&/,
  /\|\s+\w/,
  /\bnohup\b/i,
  /\bmkfs\b/i,
];

const BLOCKED_EXTENSIONS = ['.sh', '.bat', '.ps1'];

const ALLOWED_COMMANDS = [
  'ls',
  'cat',
  'pwd',
  'echo',
  'grep',
  'head',
  'tail',
];

function normalizeCommand(cmd) {
  return cmd.trim().replace(/\s+/g, ' ');
}

function extractBaseCommand(cmd) {
  const token = cmd.split(' ')[0];
  return token.replace(/^.*\//, '').replace(/^\.\//, '');
}

export function enforceOSPolicy({ command }) {
  if (typeof command !== 'string' || !command.trim()) {
    return {
      allowed: false,
      severity: 'HIGH',
      reason: 'Empty or invalid OS command',
    };
  }

  const normalized = normalizeCommand(command);

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        allowed: false,
        severity: 'CRITICAL',
        reason: 'Destructive OS command blocked',
      };
    }
  }

  for (const ext of BLOCKED_EXTENSIONS) {
    if (normalized.toLowerCase().includes(ext)) {
      return {
        allowed: false,
        severity: 'HIGH',
        reason: `Script execution blocked (${ext})`,
      };
    }
  }

  const baseCmd = extractBaseCommand(normalized).toLowerCase();

  if (!ALLOWED_COMMANDS.includes(baseCmd)) {
    return {
      allowed: false,
      severity: 'MEDIUM',
      reason: `Command not allow-listed: ${baseCmd}`,
    };
  }

  return {
    allowed: true,
    severity: 'LOW',
  };
}

