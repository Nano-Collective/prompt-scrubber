import { placeholderTokensIn } from '../session/session-manager.js';
import type { Detector, Finding, ScoredFinding } from '../types/index.js';
import { isValidFullUrl, URL_CHARS } from './url.js';

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
  // Developer credentials. A body has a lower bound but no upper one (a capped match
  // would leave the tail of a longer key in the clear), and a short prefix must not
  // start in the middle of a word. No capture groups: layer 1 reads `match[1]` as the value.
  // Stripe live secret and restricted keys
  { regex: /(?<![A-Za-z0-9_])[sr]k_live_[A-Za-z0-9]{24,}/g, name: 'Stripe key' },
  // JSON Web Token: header and payload are base64url JSON, so both start with `eyJ`
  {
    regex: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    name: 'JWT',
  },
  // PEM private key block (PKCS#8 including `ENCRYPTED PRIVATE KEY`, RSA, EC, OpenSSH).
  // The body is base64 and whitespace only, which cannot cross a `-----` marker, so an
  // unterminated block costs one scan. A backslash is allowed because JSON files store the
  // newlines as `\n`. A legacy PEM encrypted with `Proc-Type`/`DEK-Info` headers is not
  // matched: those headers hold `:` and `,`, which the body does not allow.
  {
    regex:
      /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[A-Za-z0-9+/=\s\\]+-----END (?:[A-Z]+ )?PRIVATE KEY-----/g,
    name: 'Private key',
  },
  { regex: /(?<![A-Za-z0-9_])glpat-[A-Za-z0-9_-]{20,}/g, name: 'GitLab PAT' },
  { regex: /(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{34,}/g, name: 'HuggingFace token' },
  { regex: /(?<![A-Za-z0-9_])npm_[A-Za-z0-9]{36,}/g, name: 'npm token' },
  {
    regex: /(?<![A-Za-z0-9_])SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43,}/g,
    name: 'SendGrid key',
  },
  // Slack incoming webhook: the path is the credential
  {
    regex: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/g,
    name: 'Slack webhook',
  },
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

// A key is a run of name characters that does not continue a longer one, so it is found after
// whitespace, a backtick, a bracket, `$`, `@`, `&` or `?` just the same (`(password: ...)`,
// `$password = ...`, `user=bob&password=...`). It may be quoted (`"api_key": ...` in JSON or
// YAML), and markup or brackets that close the key may sit before the separator
// (`**password**: ...`, `config['password'] = ...`, `[password]=...`, or `\"password\": ...` in
// JSON that is itself a string). Reading the key on its own, then the value only for a
// secret-looking key, keeps the scan moving on after each separator, so a pair inside another
// key's value is found too.
const KEY_PATTERN = /(?<![A-Za-z0-9_.-])["']?([a-zA-Z0-9_.-]+)[\\"'`\])>*]*\s*[:=]\s*/g;

// A quoted value runs to its closing quote, so a passphrase with spaces is taken whole; an
// unquoted one stops at whitespace and at brackets, quotes, commas and semicolons, but keeps
// `!`, `#`, `$` and the other punctuation a password is allowed to contain. `&` and `?` are
// left out so a value in a query string stops where the next parameter starts. In JSON that is
// itself a string the quotes are escaped (`\"hunter2hunter2\"`), and an escape inside the value
// doubles its backslash: `\"` is `\\\"`, `\\` is `\\\\`, `\n` is `\\n`. Those never start with a
// lone `\"`, which is what ends the value.
const VALUE_PATTERN =
  /"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|([A-Za-z0-9+/\-_.~@!#$%^*=:]{8,})|\\"((?:[^"\\\r\n]|\\\\\\\\|\\\\\\"|\\\\[^\\"\r\n]){8,})\\"/y;

// A key inside an http(s) URL (`?token=...`) is left to the URL detector, which redacts the
// whole URL; reporting the value as well would split the URL into two placeholders. The pair
// counts as inside only when URL characters run unbroken from `http(s)://` through the end of
// its value, which is the span the URL detector takes: a space, a quote or a brace ends the
// URL, so a value after one (`https://x.io/a,token: ...`) is still found. A URL the URL
// detector rejects as malformed (`https:///x`) does not count, since nothing would redact it.
//
// Only a pair that the scanner never reported before the key could follow any character is
// left to the URL detector. One that follows `,` or `;` is always reported, because the URL
// detector may still not cover it: it skips an allowlisted host's `;`/`,` parameters, and it
// does not run at all when it is disabled.
const HTTP_URL = new RegExp(`https?://${URL_CHARS}+`, 'g');

/** The spans of the http(s) URLs in `text`, in order, that the URL detector would redact. */
function httpUrlSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  HTTP_URL.lastIndex = 0;
  let url: RegExpExecArray | null;
  while ((url = HTTP_URL.exec(text)) !== null) {
    if (isValidFullUrl(url[0])) spans.push([url.index, url.index + url[0].length]);
  }
  return spans;
}

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
    KEY_PATTERN.lastIndex = 0;
    let urlSpans: Array<[number, number]> | undefined;
    let urlIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = KEY_PATTERN.exec(text)) !== null) {
      if (!isSecretKeyName(match[1] ?? '')) continue;
      VALUE_PATTERN.lastIndex = KEY_PATTERN.lastIndex;
      const found = VALUE_PATTERN.exec(text);
      if (!found) continue;
      KEY_PATTERN.lastIndex = VALUE_PATTERN.lastIndex;
      const lead = text[match.index - 1];
      if (lead !== ',' && lead !== ';') {
        // Matches arrive in order, so the URL spans are walked once rather than searched.
        urlSpans ??= httpUrlSpans(text);
        while (urlIndex < urlSpans.length && (urlSpans[urlIndex]?.[1] ?? 0) <= match.index) {
          urlIndex++;
        }
        const url = urlSpans[urlIndex];
        if (url !== undefined && url[0] <= match.index && KEY_PATTERN.lastIndex <= url[1]) {
          continue;
        }
      }
      const value = found[1] ?? found[2] ?? found[3] ?? found[4] ?? '';
      const valueStart =
        found.index + (found[3] !== undefined ? 0 : found[4] !== undefined ? 2 : 1);
      // Already a placeholder (`api_key="«Secret_1»"`): scrubbing it again would mint a second one.
      if (placeholderTokensIn(value)[0] === value) continue;

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

// In structured data (tool-call arguments, `metadata`) the key names the field outright, so
// only a name that ends in a credential word counts, singular or plural (`secrets`, `api_keys`).
// `key`, `access`, `auth`, `api` or `private` on their own are ordinary field names there
// (`{"key": "logging.level"}`), where in prose `key: ...` is a good hint. `secret_name`,
// `token_type` and `tokenizer` do not end in a credential word, and `pwd` is a working
// directory as often as a password. `tokens` counts too (`tokens`, `access_tokens`), except
// after a word that makes it a count (`max_tokens`, `prompt_tokens`, `total_tokens`).
// This is not `isSecretKeyName`, the looser guess that decides whether `key: value` in free
// text is a secret; the two rules differ on purpose.
const CREDENTIAL_KEY =
  /(?:token|(?<!(?:max|min|prompt|completion|total|input|output|cached|reasoning|num|new)[_-]?)tokens|secrets?|passw(?:or)?ds?|passphrases?|credentials?|(?:api|access|private|secret|signing|encryption|master|ssh|auth|session)[_-]?keys?)$/;

export function isCredentialKeyName(key: string): boolean {
  return CREDENTIAL_KEY.test(key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase());
}

/**
 * Reports its whole input as one secret. The proxy adds it for a string that sits under a
 * credential key, where the key already says the value is a secret, so the value is redacted
 * whatever it looks like (a short password, one holding both quote kinds, a passphrase with
 * spaces) and no other detector can change what is redacted. The finding is certain, not a
 * guess from a key-name hint, so a `minConfidence` threshold, which drops guesses, never drops it.
 */
export const WHOLE_VALUE_SECRET_DETECTOR: Detector = {
  name: 'WholeValueSecret',
  detect(text: string): Finding[] {
    if (text.length === 0) return [];
    return [
      {
        category: 'Secret',
        span: [0, text.length],
        value: text,
        placeholderPrefix: 'Secret',
        confidence: 1,
        method: 'key-name',
      },
    ];
  },
};
