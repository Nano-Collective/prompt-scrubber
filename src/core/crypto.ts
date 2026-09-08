import * as crypto from 'node:crypto';
import type { SessionMap } from '../types/index.js';

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

export const SCRYPT_PARAMS: KdfParams = { N: 16384, r: 8, p: 1 };

const SCRYPT_PARAM_BOUNDS: Record<keyof KdfParams, { min: number; max: number }> = {
  N: { min: 1024, max: 1048576 },
  r: { min: 1, max: 256 },
  p: { min: 1, max: 16 },
};

export interface EncryptedEnvelope {
  version: 1;
  encrypted: true;
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
  kdfParams?: KdfParams;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class SessionDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionDecryptionError';
  }
}

export class SessionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionFormatError';
  }
}

function isKdfParams(value: unknown): value is KdfParams {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  for (const field of ['N', 'r', 'p'] as const) {
    const v = obj[field];
    if (
      typeof v !== 'number' ||
      !Number.isInteger(v) ||
      v < SCRYPT_PARAM_BOUNDS[field].min ||
      v > SCRYPT_PARAM_BOUNDS[field].max
    ) {
      return false;
    }
  }
  return true;
}

export function isEncryptedEnvelope(data: unknown): data is EncryptedEnvelope {
  if (!data || typeof data !== 'object') return false;
  const env = data as Partial<EncryptedEnvelope> & { kdfParams?: unknown };
  if (env.kdfParams !== undefined && !isKdfParams(env.kdfParams)) return false;
  return (
    env.version === 1 &&
    env.encrypted === true &&
    env.algorithm === 'aes-256-gcm' &&
    env.kdf === 'scrypt' &&
    typeof env.salt === 'string' &&
    typeof env.iv === 'string' &&
    typeof env.authTag === 'string' &&
    typeof env.ciphertext === 'string'
  );
}

/**
 * Module-level cache of derived keys keyed by `(passphrase, salt, kdfParams)`.
 * scrypt is intentionally expensive; this prevents us from re-deriving the
 * same key on every read/write of an encrypted session, while still returning
 * the correct key when the caller supplies a different passphrase against the
 * same salt (which is exactly what "wrong key" looks like).
 *
 * The cache key is a SHA-256 of (passphrase + salt + canonical kdfParams) so
 * we never hold the passphrase itself in the map.
 */
const derivedKeyCache = new Map<string, Buffer>();

function deriveCacheKey(inputKey: string, salt: Buffer, params: KdfParams): string {
  const paramsStr = `${params.N}:${params.r}:${params.p}`;
  return crypto.createHash('sha256').update(inputKey).update(salt).update(paramsStr).digest('hex');
}

export function deriveSessionKey(
  inputKey: string,
  salt: Buffer,
  params: KdfParams = SCRYPT_PARAMS,
): Buffer {
  const cacheKey = deriveCacheKey(inputKey, salt, params);
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  const key = crypto.scryptSync(inputKey, salt, 32, params);
  derivedKeyCache.set(cacheKey, key);
  return key;
}

/**
 * Test-only escape hatch — wipes the in-process key cache. Production code
 * should never need to call this.
 */
export function clearDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

export function encryptSession(data: SessionMap, inputKey: string): EncryptedEnvelope {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveSessionKey(inputKey, salt, SCRYPT_PARAMS);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const payload = JSON.stringify(data);
  let ciphertext = cipher.update(payload, 'utf8', 'base64');
  ciphertext += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    encrypted: true,
    algorithm: 'aes-256-gcm',
    kdf: 'scrypt',
    kdfParams: { ...SCRYPT_PARAMS },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext,
  };
}

export function decryptSession(envelope: EncryptedEnvelope, inputKey: string): SessionMap {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') {
    throw new SessionDecryptionError(
      'Unsupported encryption version or algorithm in session envelope.',
    );
  }

  const kdfParams: KdfParams = isKdfParams(envelope.kdfParams) ? envelope.kdfParams : SCRYPT_PARAMS;

  const salt = Buffer.from(envelope.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const key = deriveSessionKey(inputKey, salt, kdfParams);

  let decrypted: string;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAuthTag(authTag);
    let buf = decipher.update(envelope.ciphertext, 'base64', 'utf8');
    buf += decipher.final('utf8');
    decrypted = buf;
  } catch {
    throw new SessionDecryptionError(
      'Unable to decrypt session. The encryption key may be incorrect or the session file may have been modified.',
    );
  }

  try {
    return JSON.parse(decrypted) as SessionMap;
  } catch {
    throw new SessionFormatError(
      'Session decrypted successfully but its payload is not valid JSON. The file is corrupt.',
    );
  }
}
