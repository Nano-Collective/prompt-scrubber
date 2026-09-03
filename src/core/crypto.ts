import * as crypto from 'node:crypto';
import type { SessionMap } from '../types/index.js';

export interface EncryptedEnvelope {
  version: 1;
  encrypted: true;
  algorithm: 'aes-256-gcm';
  kdf: 'scrypt';
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

export function isEncryptedEnvelope(data: unknown): data is EncryptedEnvelope {
  if (!data || typeof data !== 'object') return false;
  const env = data as Partial<EncryptedEnvelope>;
  return (
    env.version === 1 &&
    env.encrypted === true &&
    env.algorithm === 'aes-256-gcm' &&
    env.kdf === 'scrypt'
  );
}

/**
 * Module-level cache of derived keys keyed by `(passphrase, salt)`. scrypt
 * is intentionally expensive; this prevents us from re-deriving the same key
 * on every read/write of an encrypted session, while still returning the
 * correct key when the caller supplies a different passphrase against the
 * same salt (which is exactly what "wrong key" looks like).
 *
 * The cache key is a SHA-256 of the passphrase concatenated with the salt
 * so we never hold the passphrase itself in the map.
 */
const derivedKeyCache = new Map<string, Buffer>();

function deriveCacheKey(passphrase: string, salt: Buffer): string {
  return crypto.createHash('sha256').update(passphrase).update(salt).digest('hex');
}

export function deriveSessionKey(passphrase: string, salt: Buffer): Buffer {
  const cacheKey = deriveCacheKey(passphrase, salt);
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  // Recommended scrypt parameters for general-purpose AEAD use.
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
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

export function encryptSession(data: SessionMap, passphrase: string): EncryptedEnvelope {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveSessionKey(passphrase, salt);

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
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext,
  };
}

export function decryptSession(envelope: EncryptedEnvelope, passphrase: string): SessionMap {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') {
    throw new SessionDecryptionError(
      'Unsupported encryption version or algorithm in session envelope.',
    );
  }

  const salt = Buffer.from(envelope.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const key = deriveSessionKey(passphrase, salt);

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(envelope.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted) as SessionMap;
  } catch {
    throw new SessionDecryptionError(
      'Unable to decrypt session. The encryption key may be incorrect or the session file may have been modified.',
    );
  }
}
