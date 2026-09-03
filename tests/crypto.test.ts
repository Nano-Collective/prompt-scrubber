import test from 'ava';
import {
  SessionDecryptionError,
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

test('decryptSession after deriveSessionKey cache pollution still works', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  // Force a cache miss to ensure decrypt works without prior state.
  clearDerivedKeyCache();
  const decrypted = decryptSession(envelope, passphrase);
  t.deepEqual(decrypted, data);
});
