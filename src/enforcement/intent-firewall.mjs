import { enforceOSPolicy } from './os-policy.mjs';
import { enforceFSPolicy } from './fs-policy.mjs';
import { enforceBrowserPolicy } from './browser-policy.mjs';
import { inspectScriptIntent } from './script-policy.mjs';
import { deriveIntentProvenance, isUntrustedProvenance } from './provenance.mjs';

const SUI_ADDRESS_RE = /^0x[a-fA-F0-9]{64}$/;

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

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

export function inspectIntent(intent) {
  if (!intent || typeof intent !== 'object') {
    return deny('HIGH', 'Intent missing or not an object');
  }

  if (!intent.domain || !intent.action) {
    return deny('HIGH', 'Malformed intent (missing domain or action)');
  }

  const provenance = deriveIntentProvenance(intent);

  switch (intent.domain) {
    case 'OS': {
      if (intent.action === 'EXECUTE_COMMAND') {
        return normalize(
          enforceOSPolicy(intent.params, { provenance }),
          'HIGH'
        );
      }

      if (intent.action === 'DOWNLOAD_AND_EXECUTE') {
        if (!intent.payload) {
          return deny('HIGH', 'Missing script payload');
        }

        if (isUntrustedProvenance(provenance)) {
          return deny(
            'CRITICAL',
            `Untrusted provenance cannot perform DOWNLOAD_AND_EXECUTE (${provenance.source})`
          );
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
      if (isUntrustedProvenance(provenance) && intent.params?.url) {
        return deny(
          'HIGH',
          `Untrusted provenance browser action blocked (${provenance.source})`
        );
      }

      return normalize(
        enforceBrowserPolicy(intent.params),
        'MEDIUM'
      );
    }

    case 'BLOCKCHAIN': {
      if (
        !intent.params ||
        !isPositiveInteger(intent.params.amount) ||
        typeof intent.params.recipient !== 'string' ||
        !SUI_ADDRESS_RE.test(intent.params.recipient)
      ) {
        return deny('MEDIUM', 'Malformed blockchain intent parameters (amount/recipient)');
      }

      if (isUntrustedProvenance(provenance) && intent.params.amount > 0) {
        return deny(
          'HIGH',
          `Blockchain action blocked from untrusted provenance (${provenance.source})`
        );
      }

      return allow('LOW');
    }

    default:
      return deny('MEDIUM', `Unknown intent domain: ${intent.domain}`);
  }
}
