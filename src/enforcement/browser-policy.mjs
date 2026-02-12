const BLOCKED_PROTOCOLS = ['file:', 'chrome:', 'about:'];
const BLOCKED_ACTIONS = ['DOWNLOAD', 'UPLOAD'];

export function enforceBrowserPolicy({ action, url }) {
  if (!action || typeof action !== 'string') {
    return {
      allowed: false,
      severity: 'MEDIUM',
      reason: 'Missing or invalid browser action',
    };
  }

  if (BLOCKED_ACTIONS.includes(action)) {
    return {
      allowed: false,
      severity: 'HIGH',
      reason: `Browser ${action.toLowerCase()} blocked`,
    };
  }

  if (url) {
    try {
      const parsed = new URL(url);

      if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
        return {
          allowed: false,
          severity: 'CRITICAL',
          reason: 'Local browser access blocked',
        };
      }
    } catch {
      return {
        allowed: false,
        severity: 'MEDIUM',
        reason: 'Malformed URL',
      };
    }
  }

  return {
    allowed: true,
    severity: 'LOW',
  };
}

