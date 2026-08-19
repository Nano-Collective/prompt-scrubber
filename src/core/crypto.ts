import * as crypto from 'node:crypto';

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

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  // Use recommended scrypt parameters for general purpose
  return crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptSession(data: any, passphrase: string): EncryptedEnvelope {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);

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

export function decryptSession(envelope: EncryptedEnvelope, passphrase: string): any {
  if (envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm' || envelope.kdf !== 'scrypt') {
    throw new Error('Unsupported encryption version or algorithm');
  }

  const salt = Buffer.from(envelope.salt, 'hex');
  const iv = Buffer.from(envelope.iv, 'hex');
  const authTag = Buffer.from(envelope.authTag, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  try {
    let decrypted = decipher.update(envelope.ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
  } catch (err: any) {
    throw new Error(
      'Unable to decrypt session. The encryption key may be incorrect or the session file may have been modified.',
    );
  }
}
