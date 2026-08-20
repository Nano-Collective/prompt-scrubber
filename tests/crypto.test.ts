import test from 'ava';
import { decryptSession, encryptSession, isEncryptedEnvelope } from '../src/core/crypto.js';

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
    message: /Unable to decrypt session/,
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
    message: /Unable to decrypt session/,
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
    message: /Unable to decrypt session/,
  });
});

test('decryptSession fails on unsupported version', (t) => {
  const data = { '«Secret_1»': 'sk-1234' };
  const passphrase = 'test-password';
  const envelope = encryptSession(data, passphrase);

  (envelope as any).version = 2;

  t.throws(() => decryptSession(envelope, passphrase), {
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
