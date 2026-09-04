import type { Detector, Finding, ScoredFinding } from '../types/index.js';

// Confidence per layer. A vendor prefix plus a characteristic length is as close
// to certain as pattern matching gets; a suggestive key name is a good guess;
// entropy alone is only ever a hint.
const PREFIX_CONFIDENCE = 0.99;
const BEARER_CONFIDENCE = 0.9;
const KEY_NAME_CONFIDENCE = 0.7;
const ENTROPY_CONFIDENCE = 0.6;

// --- Layer 1: Known API key prefixes ---
// These are high-precision patterns: specific vendor prefixes + characteristic lengths.
const PREFIX_PATTERNS: { regex: RegExp; name: string; confidence: number }[] = [
  // OpenAI: sk-...48 alphanumeric chars (new format: sk-proj-..., sk-svcacct-...)
  {
    regex: /sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{20,80}/g,
    name: 'OpenAI/Anthropic key',
    confidence: PREFIX_CONFIDENCE,
  },
  // GitHub personal access tokens
  { regex: /ghp_[A-Za-z0-9]{36}/g, name: 'GitHub PAT', confidence: PREFIX_CONFIDENCE },
  { regex: /gho_[A-Za-z0-9]{36}/g, name: 'GitHub OAuth', confidence: PREFIX_CONFIDENCE },
  {
    regex: /github_pat_[A-Za-z0-9_]{82}/g,
    name: 'GitHub fine-grained PAT',
    confidence: PREFIX_CONFIDENCE,
  },
  // Slack tokens
  {
    regex: /xoxb-[0-9]{11}-[0-9]{11}-[A-Za-z0-9]{24}/g,
    name: 'Slack bot token',
    confidence: PREFIX_CONFIDENCE,
  },
  {
    regex: /xoxp-[0-9]{11}-[0-9]{11}-[0-9]{11}-[A-Za-z0-9]{32}/g,
    name: 'Slack user token',
    confidence: PREFIX_CONFIDENCE,
  },
  // Google API key
  { regex: /AIza[0-9A-Za-z\-_]{35}/g, name: 'Google API key', confidence: PREFIX_CONFIDENCE },
  // Google OAuth access token
  {
    regex: /ya29\.[0-9A-Za-z\-_]{60,200}/g,
    name: 'Google OAuth token',
    confidence: PREFIX_CONFIDENCE,
  },
  // AWS Access Key ID
  {
    regex: /(?<![A-Z0-9])(AKIA[0-9A-Z]{16})(?![A-Z0-9])/g,
    name: 'AWS Access Key ID',
    confidence: PREFIX_CONFIDENCE,
  },
  // Bearer token in Authorization header
  {
    regex: /(?:Bearer|bearer)\s+([A-Za-z0-9\-._~+/]{20,}={0,2})/g,
    name: 'Bearer token',
    confidence: BEARER_CONFIDENCE,
  },
];

// --- Layer 2: Key-value heuristic ---
// Matches KEY=value or KEY: value where the key name suggests it's a secret.
const SECRET_KEY_NAMES =
  /(?:key|secret|token|password|pass|pwd|api|auth|cred|credential|private|access)[_-]?(?:id|key|secret|token)?/i;
const KV_PATTERN = /(?:^|[\s,;{])([a-zA-Z0-9_.-]+)\s*[:=]\s*["']?([A-Za-z0-9+/\-_.~@]{8,})["']?/gm;

// --- Layer 3: High-entropy strings ---
// Only fires when the value is surrounded by quotes or follows an = sign.
const HIGH_ENTROPY_PATTERN = /(?:=|["'])([A-Za-z0-9+/]{20,})(?:["']|={0,2}(?!\w))/g;
const LOG2 = Math.log(2);

function shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] ?? 0) + 1;
  }
  return Object.values(freq).reduce((e, count) => {
    const p = count / str.length;
    return e - p * (Math.log(p) / LOG2);
  }, 0);
}

export class SecretDetector implements Detector {
  readonly name = 'SecretDetector';

  detect(text: string): Finding[] {
    const raw: ScoredFinding[] = [];

    // Layer 1: prefix-based patterns
    for (const { regex, confidence } of PREFIX_PATTERNS) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        // For Bearer token, capture group 1 is the token value; otherwise use full match
        const value =
          match[1] !== undefined && match[1].length > 0 && !match[0].startsWith(match[1])
            ? match[1]
            : match[0];
        const start = match.index + (match[0].length - value.length);
        raw.push({
          category: 'Secret',
          span: [start, start + value.length],
          value,
          placeholderPrefix: 'Secret',
          confidence,
          method: 'exact-pattern',
        });
      }
    }

    // Layer 2: key-value heuristic
    KV_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = KV_PATTERN.exec(text)) !== null) {
      const key = match[1] ?? '';
      const value = match[2] ?? '';
      if (!SECRET_KEY_NAMES.test(key)) continue;

      const valueStart = match.index + match[0].indexOf(value);
      raw.push({
        category: 'Secret',
        span: [valueStart, valueStart + value.length],
        value,
        placeholderPrefix: 'Secret',
        confidence: KEY_NAME_CONFIDENCE,
        method: 'key-name',
      });
    }

    // Layer 3: high-entropy strings in quotes or after =
    HIGH_ENTROPY_PATTERN.lastIndex = 0;
    while ((match = HIGH_ENTROPY_PATTERN.exec(text)) !== null) {
      const value = match[1] ?? '';
      if (shannonEntropy(value) < 4.5) continue;

      const valueStart = match.index + match[0].indexOf(value);
      raw.push({
        category: 'Secret',
        span: [valueStart, valueStart + value.length],
        value,
        placeholderPrefix: 'Secret',
        confidence: ENTROPY_CONFIDENCE,
        method: 'entropy',
      });
    }

    // Sort and deduplicate overlapping findings, keeping the longest match
    raw.sort((a, b) => a.span[0] - b.span[0]);
    const findings: ScoredFinding[] = [];
    for (const candidate of raw) {
      const overlapIdx = findings.findIndex(
        (existing) => candidate.span[0] < existing.span[1] && candidate.span[1] > existing.span[0],
      );
      if (overlapIdx === -1) {
        findings.push(candidate);
        continue;
      }

      // The layers describe the same secret from different angles, so keep the
      // widest span (nothing should leak past the placeholder) but report the
      // strongest evidence for it. Without this, a loose key-name match that
      // happens to run one character longer would downgrade a vendor-prefixed
      // key to 0.7 and let `--min-confidence 0.8` drop a certain secret.
      const existing = findings[overlapIdx]!;
      const widest = candidate.value.length > existing.value.length ? candidate : existing;
      const strongest = candidate.confidence > existing.confidence ? candidate : existing;
      findings[overlapIdx] = {
        ...widest,
        confidence: strongest.confidence,
        method: strongest.method,
      };
    }

    return findings;
  }
}
