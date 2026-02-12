import { enforceOSPolicy } from './os-policy.mjs';
import { enforceFSPolicy } from './fs-policy.mjs';
import { enforceBrowserPolicy } from './browser-policy.mjs';
import { inspectScriptIntent } from './script-policy.mjs';

function deny(severity, reason) {
  return { allowed: false, severity, reason };
}

function allow(severity = 'LOW') {
  return { allowed: true, severity };
}

function normalize(result, fallbackSeverity = 'MEDIUM') {
  if (!result || typeof result !== 'object') {
    return deny(fallbackSeverity, 'Invalid policy response');
  }

  if (typeof result.allowed !== 'boolean') {
    return deny(fallbackSeverity, 'Policy missing allowed flag');
  }

  return {
    allowed: result.allowed,
    severity: result.severity ?? fallbackSeverity,
    reason: result.reason,
  };
}

export function inspectIntent(intent) {
  if (!intent || typeof intent !== 'object') {
    return deny('HIGH', 'Intent missing or not an object');
  }

  if (!intent.domain || !intent.action) {
    return deny('HIGH', 'Malformed intent (missing domain or action)');
  }

  switch (intent.domain) {
    case 'OS': {
      if (intent.action === 'EXECUTE_COMMAND') {
        return normalize(
          enforceOSPolicy(intent.params),
          'HIGH'
        );
      }

      if (intent.action === 'DOWNLOAD_AND_EXECUTE') {
        if (!intent.payload) {
          return deny('HIGH', 'Missing script payload');
        }

        return normalize(
          inspectScriptIntent(intent.payload),
          'HIGH'
        );
      }

      return deny('MEDIUM', `Unsupported OS action: ${intent.action}`);
    }

    case 'FS': {
      return normalize(
        enforceFSPolicy(intent.params),
        'MEDIUM'
      );
    }

    case 'BROWSER': {
      return normalize(
        enforceBrowserPolicy(intent.params),
        'MEDIUM'
      );
    }

    case 'BLOCKCHAIN': {
      if (
        !intent.params ||
        typeof intent.params.amount !== 'number' ||
        !intent.params.recipient
      ) {
        return deny('MEDIUM', 'Malformed blockchain intent parameters');
      }

      return allow('LOW');
    }

    default:
      return deny('MEDIUM', `Unknown intent domain: ${intent.domain}`);
  }
}

