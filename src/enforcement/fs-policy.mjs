import path from 'path';

const SANDBOX_ROOT = path.resolve('./claw-workspace');

function isInsideSandbox(resolvedPath) {
  const relative = path.relative(SANDBOX_ROOT, resolvedPath);
  return (
    relative &&
    !relative.startsWith('..') &&
    !path.isAbsolute(relative)
  );
}

export function enforceFSPolicy({ action, targetPath }) {
  if (!targetPath || typeof targetPath !== 'string') {
    return {
      allowed: false,
      severity: 'HIGH',
      reason: 'Missing or invalid file path',
    };
  }

  if (!action || typeof action !== 'string') {
    return {
      allowed: false,
      severity: 'MEDIUM',
      reason: 'Missing or invalid filesystem action',
    };
  }

  const resolved = path.resolve(SANDBOX_ROOT, targetPath);

  if (!isInsideSandbox(resolved)) {
    return {
      allowed: false,
      severity: 'CRITICAL',
      reason: 'Access outside sandbox denied',
    };
  }

  if (action === 'WRITE' || action === 'DELETE') {
    return {
      allowed: true,
      severity: 'MEDIUM',
      reason: 'Write operation inside sandbox',
    };
  }

  if (action === 'READ' || action === 'LIST') {
    return {
      allowed: true,
      severity: 'LOW',
    };
  }

  return {
    allowed: false,
    severity: 'MEDIUM',
    reason: `Unsupported filesystem action: ${action}`,
  };
}

