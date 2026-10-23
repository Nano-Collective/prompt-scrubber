import type { Detector, Finding, ScoredFinding } from '../types/index.js';

// Confidence per layer. A vendor prefix plus a characteristic length is as close
// to certain as pattern matching gets; a suggestive key name is a good guess;
// entropy alone is only ever a hint.
const PREFIX_CONFIDENCE = 0.99;
const BEARER_CONFIDENCE = 0.9;
const URL_CREDENTIALS_CONFIDENCE = 0.95;
const KEY_NAME_CONFIDENCE = 0.7;
const ENTROPY_CONFIDENCE = 0.6;

// --- Layer 1: Known API key prefixes ---
// These are high-precision patterns: specific vendor prefixes + characteristic lengths.
// `confidence` defaults to PREFIX_CONFIDENCE below; only Bearer overrides it.
const PREFIX_PATTERNS: { regex: RegExp; name: string; confidence?: number }[] = [
  // OpenAI and Anthropic: sk-... with no upper bound on the length. Project keys
  // (sk-proj-) run to about 164 characters and Anthropic keys to about 108, so a
  // cap would redact the head of a key and leave the tail in the clear. The match
  // runs over letters, digits, `-` and `_`, and ends at anything else (whitespace,
  // quotes, commas, brackets). A hyphenated word joined straight onto a key is
  // therefore redacted with it: over-redacting is the safe side of that trade.
  // The key must not start in the middle of a word (`risk-assessment`).
  {
    regex: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|ant-api\d+-)?[A-Za-z0-9_-]{20,}/g,
    name: 'OpenAI/Anthropic key',
  },
  // GitHub personal access tokens
  { regex: /ghp_[A-Za-z0-9]{36}/g, name: 'GitHub PAT' },
  { regex: /gho_[A-Za-z0-9]{36}/g, name: 'GitHub OAuth' },
  { regex: /github_pat_[A-Za-z0-9_]{82}/g, name: 'GitHub fine-grained PAT' },
  // Slack tokens
  { regex: /xoxb-[0-9]{11}-[0-9]{11}-[A-Za-z0-9]{24}/g, name: 'Slack bot token' },
  { regex: /xoxp-[0-9]{11}-[0-9]{11}-[0-9]{11}-[A-Za-z0-9]{32}/g, name: 'Slack user token' },
  // Google API key
  { regex: /AIza[0-9A-Za-z\-_]{35}/g, name: 'Google API key' },
  // Google OAuth access token
  { regex: /ya29\.[0-9A-Za-z\-_]{60,200}/g, name: 'Google OAuth token' },
  // AWS Access Key ID
  { regex: /(?<![A-Z0-9])(AKIA[0-9A-Z]{16})(?![A-Z0-9])/g, name: 'AWS Access Key ID' },
  // Credentials embedded in a URL or connection string, e.g. postgres://user:pass@host/db.
  // Matches the whole string so the user name, password and host go as one unit.
  {
    regex:
      /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{1,30}:\/\/[^\s:@/?#'"<>]*:[^\s@/?#'"<>]+@[^\s/?#'"<>]*[^\s/?#'"<>.,;:!?)\]](?:[/?#](?:[^\s'"<>]*[^\s'"<>.,;:!?)\]])?)?/g,
    name: 'URL credentials',
    confidence: URL_CREDENTIALS_CONFIDENCE,
  },
  // Bearer token in Authorization header
  {
    regex: /bearer\s+([A-Za-z0-9\-._~+/]{20,}={0,2})/gi,
    name: 'Bearer token',
    confidence: BEARER_CONFIDENCE,
  },
];

// --- Layer 2: Key-value heuristic ---
// Matches KEY=value or KEY: value where the key name suggests it's a secret.
// A key name suggests a secret in two ways, because the words differ in how often they
// appear inside an unrelated word.
//
// Strong words (`token`, `secret`, `password`, ...) are matched as substrings, so compounds
// such as `refreshtoken`, `clientsecret` and `dbpassword` are found. Hardly any ordinary
// word contains one of them.
const STRONG_KEY_WORD = /token|secret|passw(?:or)?d|passphrase|credential/;

// Weak words (`key`, `pass`, `auth`, `api`, ...) sit inside `monkey`, `compass`, `author`,
// so each must be a whole word of the name: the name is split at punctuation, case changes
// and digits (`key2` is `key`). A few compounds that glue one on without a separator are
// listed, since splitting cannot find them.
const WEAK_KEY_WORDS = new Set([
  'key',
  'keys',
  'pass',
  'pwd',
  'api',
  'apikey',
  'auth',
  'oauth',
  'authorization',
  'cred',
  'creds',
  'private',
  'access',
  'bearer',
  'passkey',
]);
const KEY_COMPOUND =
  /^(?:api|secret|private|access|master|signing|encryption|auth|session|ssh|license|app|client|service|hmac|aws)keys?$/;

function isSecretKeyName(key: string): boolean {
  const name = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (STRONG_KEY_WORD.test(name)) return true;
  return name.split(/[^a-z]+/).some((word) => WEAK_KEY_WORDS.has(word) || KEY_COMPOUND.test(word));
}

// The key may be quoted (`"api_key": ...` in JSON or YAML). A quoted value runs to its
// closing quote, so a passphrase with spaces is taken whole; an unquoted one stops at
// whitespace and at brackets, quotes, commas and semicolons, but keeps `!`, `#`, `$` and
// the other punctuation a password is allowed to contain. `&` and `?` are left out so a
// value in a query string stops where the next parameter starts.
const KV_PATTERN =
  /(?:^|[\s,;{])["']?([a-zA-Z0-9_.-]+)["']?\s*[:=]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([A-Za-z0-9+/\-_.~@!#$%^*=:]{8,}))/gm;

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
    for (const { regex, confidence = PREFIX_CONFIDENCE } of PREFIX_PATTERNS) {
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
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      if (!isSecretKeyName(key)) continue;

      const valueStart = match.index + match[0].lastIndexOf(value);
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
