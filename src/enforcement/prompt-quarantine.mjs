import crypto from 'node:crypto';
import { deriveIntentProvenance } from './provenance.mjs';
import {
  createPromptQuarantineTicket,
  isPromptFingerprintReleased,
} from '../state/prompt-quarantine.mjs';

const PATTERNS = [
  {
    re: /\b(ignore|bypass|override)\b.{0,40}\b(previous|prior|system|developer|safety|policy)\b/i,
    weight: 3,
    reason: 'Prompt attempts to override safety instructions',
  },
  {
    re: /\b(reveal|show|print|expose)\b.{0,30}\b(system prompt|developer prompt|hidden instructions)\b/i,
    weight: 3,
    reason: 'Prompt requests hidden/system instructions',
  },
  {
    re: /\b(seed phrase|mnemonic|private key|wallet secret|api key)\b/i,
    weight: 4,
    reason: 'Prompt requests sensitive secrets',
  },
  {
    re: /\b(curl|wget)\b.{0,40}(\||&&).{0,20}\b(sh|bash|zsh)\b/i,
    weight: 3,
    reason: 'Prompt includes download-and-execute pattern',
  },
  {
    re: /\b(rm\s+-rf|chmod\s+777|sudo\b|scp\b|ssh\b)\b/i,
    weight: 2,
    reason: 'Prompt includes high-risk command patterns',
  },
  {
    re: /\b(transfer|send)\b.{0,30}\b(all|entire|everything|max)\b.{0,30}\b(sui|wallet|funds)\b/i,
    weight: 3,
    reason: 'Prompt attempts full-wallet transfer',
  },
  {
    re: /\b(do not tell|without approval|silently|hidden mode)\b/i,
    weight: 2,
    reason: 'Prompt requests stealth/unauthorized execution',
  },
];

const MIN_SCORE = 3;
const MAX_FIELD_BYTES = 8_000;

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortSnippet(value, max = 220) {
  return normalizeText(value).slice(0, max);
}

function extractTextFields(intent) {
  const candidates = [];
  const metadata = intent?.metadata;
  const params = intent?.params;

  const push = (value, label) => {
    if (typeof value !== 'string') return;
    const text = normalizeText(value);
    if (!text) return;
    if (Buffer.byteLength(text, 'utf8') > MAX_FIELD_BYTES) return;
    candidates.push({ label, text });
  };

  push(metadata?.external_text, 'metadata.external_text');
  push(metadata?.prompt, 'metadata.prompt');
  push(metadata?.instructions, 'metadata.instructions');
  push(metadata?.intent, 'metadata.intent');
  push(params?.prompt, 'params.prompt');
  push(params?.text, 'params.text');
  push(params?.command, 'params.command');

  if (typeof intent?.payload === 'string') {
    push(intent.payload, 'payload');
  }

  return candidates;
}

function scorePrompt(text) {
  const hits = [];
  let score = 0;
  for (const rule of PATTERNS) {
    if (rule.re.test(text)) {
      score += rule.weight;
      hits.push(rule.reason);
    }
  }

  return {
    score,
    reasons: Array.from(new Set(hits)),
    suspicious: score >= MIN_SCORE,
  };
}

function fingerprint(text, source) {
  return crypto
    .createHash('sha256')
    .update(`${source || 'UNKNOWN'}::${normalizeText(text).toLowerCase()}`)
    .digest('hex');
}

function bestCandidate(candidates) {
  if (!candidates.length) return null;
  let chosen = null;
  let chosenScore = -1;
  for (const item of candidates) {
    const scored = scorePrompt(item.text);
    if (scored.score > chosenScore) {
      chosen = { ...item, scored };
      chosenScore = scored.score;
    }
  }
  return chosen;
}

export function inspectPromptQuarantine(intent) {
  const provenance = deriveIntentProvenance(intent);
  if (provenance.trust === 'TRUSTED') {
    return { allowed: true, provenance };
  }

  const candidates = extractTextFields(intent);
  if (!candidates.length) {
    return { allowed: true, provenance };
  }

  const chosen = bestCandidate(candidates);
  if (!chosen || !chosen.scored.suspicious) {
    return { allowed: true, provenance };
  }

  const fp = fingerprint(chosen.text, provenance.source);
  if (isPromptFingerprintReleased(fp)) {
    return {
      allowed: true,
      released: true,
      provenance,
      fingerprint: fp,
      reason: 'Prompt fingerprint released by operator',
    };
  }

  const reason = chosen.scored.reasons[0] ?? 'Suspicious prompt pattern detected';
  const ticket = createPromptQuarantineTicket({
    fingerprint: fp,
    source: provenance.source,
    severity: 'HIGH',
    reason,
    snippet: shortSnippet(chosen.text),
    intent,
  });

  return {
    allowed: false,
    severity: 'HIGH',
    reason,
    ticket_id: ticket.id,
    fingerprint: fp,
    provenance,
    matched_patterns: chosen.scored.reasons,
    source_field: chosen.label,
  };
}
