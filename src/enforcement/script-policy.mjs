import path from 'path';

const SANDBOX_ROOT = path.resolve('./claw-workspace');

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\b/i,
  /curl\s+.*\|\s*bash/i,
  /wget\s+.*\|\s*sh/i,
  /\bsudo\b/i,
  /\bchmod\s+\+x\b/i,
  /\/etc\/|\/bin\/|\/usr\//i,
];

function normalize(input) {
  return String(input).replace(/\s+/g, ' ').trim();
}

function isInsideSandbox(target) {
  const resolved = path.resolve(SANDBOX_ROOT, target);
  const relative = path.relative(SANDBOX_ROOT, resolved);
  return (
    relative &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

export function inspectScriptIntent({ url, target }) {
  if (!target || typeof target !== 'string') {
    return {
      allowed: false,
      severity: 'HIGH',
      reason: 'Missing or invalid script target',
    };
  }

  if (!isInsideSandbox(target)) {
    return {
      allowed: false,
      severity: 'CRITICAL',
      reason: 'Script target outside sandbox workspace',
    };
  }

  const haystack = normalize(`${url ?? ''} ${target}`);

  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(haystack)) {
      return {
        allowed: false,
        severity: 'CRITICAL',
        reason: 'Dangerous script execution pattern detected',
      };
    }
  }

  return {
    allowed: true,
    severity: 'LOW',
    reason: 'Script classified as safe by static analysis',
  };
}

