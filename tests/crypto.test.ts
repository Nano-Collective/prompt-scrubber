import * as crypto from 'node:crypto';
import test from 'ava';
import {
  SCRYPT_PARAMS,
  SessionDecryptionError,
  SessionFormatError,
  clearDerivedKeyCache,
  decryptSession,
  deriveSessionKey,
  encryptSession,
  isEncryptedEnvelope,
} from '../src/core/crypto.js';

test.beforeEach(() => {
  clearDerivedKeyCache();
});

test('encryptSession and decryptSession round-trip correctly', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';

  const envelope = encryptSession(data, passphrase);
  t.true(isEncryptedEnvelope(envelope));
  t.is(envelope.version, 1);
  t.is(envelope.encrypted, true);
  t.deepEqual(envelope.kdfParams, { ...SCRYPT_PARAMS });

  const decrypted = decryptSession(envelope, passphrase);
  t.deepEqual(decrypted, data);
});

test('decryptSession fails with wrong passphrase', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const envelope = encryptSession(data, 'right-password');

  t.throws(() => decryptSession(envelope, 'wrong-password'), {
    instanceOf: SessionDecryptionError,
  });
});

test('decryptSession fails when ciphertext is tampered with', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  // Flip a character in the base64 ciphertext
  const chars = envelope.ciphertext.split('');
  chars[0] = chars[0] === 'A' ? 'B' : 'A';
  envelope.ciphertext = chars.join('');

  t.throws(() => decryptSession(envelope, passphrase), {
    instanceOf: SessionDecryptionError,
  });
});

test('decryptSession fails when authTag is tampered with', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  // Flip a character in the hex auth tag
  const chars = envelope.authTag.split('');
  chars[0] = chars[0] === '0' ? '1' : '0';
  envelope.authTag = chars.join('');

  t.throws(() => decryptSession(envelope, passphrase), {
    instanceOf: SessionDecryptionError,
  });
});

test('decryptSession surfaces malformed authTag as SessionDecryptionError (no quarantine)', (t) => {
  // An auth tag of the wrong length would previously have escaped
  // `decipher.setAuthTag`'s try/catch and fallen through to the file-level
  // corrupt-quarantine branch. Verify it is caught and re-thrown as the
  // typed error instead.
  const envelope = encryptSession({ '«Secret_1»': 'sk-1234' }, 'k');
  envelope.authTag = 'deadbeef'; // valid hex but wrong length (4 bytes)

  t.throws(() => decryptSession(envelope, 'k'), {
    instanceOf: SessionDecryptionError,
    message: /Unable to decrypt session/,
  });
});

test('decryptSession surfaces authenticated-but-invalid-JSON as SessionFormatError', (t) => {
  // Hand-craft an envelope whose plaintext is *not* valid JSON. GCM will
  // authenticate it fine, but JSON.parse should fail — and that must be
  // reported as a format error, not a "wrong key" message.
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync('format-test', salt, 32, SCRYPT_PARAMS);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ciphertext = cipher.update('not-a-json-payload', 'utf8', 'base64');
  ciphertext += cipher.final('base64');
  const authTag = cipher.getAuthTag();

  const envelope = {
    version: 1 as const,
    encrypted: true as const,
    algorithm: 'aes-256-gcm' as const,
    kdf: 'scrypt' as const,
    kdfParams: { ...SCRYPT_PARAMS },
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext,
  };

  t.throws(() => decryptSession(envelope, 'format-test'), {
    instanceOf: SessionFormatError,
    message: /not valid JSON/,
  });
});

test('decryptSession fails on unsupported version', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  (envelope as unknown as { version: number }).version = 2;

  t.throws(() => decryptSession(envelope, passphrase), {
    instanceOf: SessionDecryptionError,
    message: /Unsupported encryption version/,
  });
});

test('isEncryptedEnvelope correctly identifies envelopes', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  t.true(isEncryptedEnvelope(envelope));
  t.false(isEncryptedEnvelope(null));
  t.false(isEncryptedEnvelope({}));
  t.false(isEncryptedEnvelope({ encrypted: true }));
  t.false(
    isEncryptedEnvelope({ version: 1, encrypted: true, algorithm: 'aes-128-gcm', kdf: 'scrypt' }),
  );
});

test('isEncryptedEnvelope rejects envelopes with missing required fields', (t) => {
  t.false(
    isEncryptedEnvelope({
      version: 1,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      iv: '00',
      authTag: '00',
      ciphertext: 'AA',
      // salt missing
    }),
  );
});

test('isEncryptedEnvelope rejects envelopes with out-of-bounds kdfParams', (t) => {
  t.false(
    isEncryptedEnvelope({
      version: 1,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: '00',
      iv: '00',
      authTag: '00',
      ciphertext: 'AA',
      kdfParams: { N: 4, r: 8, p: 1 }, // N below minimum (1024)
    }),
  );

  t.false(
    isEncryptedEnvelope({
      version: 1,
      encrypted: true,
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      salt: '00',
      iv: '00',
      authTag: '00',
      ciphertext: 'AA',
      kdfParams: { N: 16384, r: 8, p: 999 }, // p above maximum (16)
    }),
  );
});

test('decryptSession is backward-compatible with envelopes missing kdfParams', (t) => {
  // An envelope written before KDF params were embedded in the envelope
  // should still decrypt successfully using the current default parameters.
  const data = { '«Secret_1»': 'legacy-sk' };
  const passphrase = 'legacy-pass';
  const envelope = encryptSession(data, passphrase);
  const legacy = { ...envelope };
  delete (legacy as { kdfParams?: unknown }).kdfParams;
  // Must still be recognized as an envelope.
  t.true(isEncryptedEnvelope(legacy));
  // And decrypt cleanly.
  const decrypted = decryptSession(legacy as Parameters<typeof decryptSession>[0], passphrase);
  t.deepEqual(decrypted, data);
});

test('encryptSession emits a fresh salt and IV per call', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'same-passphrase';

  const envA = encryptSession(data, passphrase);
  const envB = encryptSession(data, passphrase);

  t.not(envA.salt, envB.salt);
  t.not(envA.iv, envB.iv);
  t.not(envA.ciphertext, envB.ciphertext);
});

test('deriveSessionKey is cached by salt', (t) => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const k1 = deriveSessionKey('pass', salt);
  const k2 = deriveSessionKey('pass', salt);
  t.is(k1, k2); // Same buffer instance proves cache hit
});

test('deriveSessionKey returns a fresh key after clearDerivedKeyCache', (t) => {
  const salt = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const k1 = deriveSessionKey('pass', salt);
  clearDerivedKeyCache();
  const k2 = deriveSessionKey('pass', salt);
  t.deepEqual(k1, k2);
  t.not(k1, k2, 'cache miss should produce a new Buffer instance');
});

test('decryptSession after deriveSessionKey cache pollution still works', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  // Force a cache miss to ensure decrypt works without prior state.
  clearDerivedKeyCache();
  const decrypted = decryptSession(envelope, passphrase);
  t.deepEqual(decrypted, data);
});
