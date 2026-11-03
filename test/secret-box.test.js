import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSecretBox, parseKey, SecretBoxError } from '../src/secret-box.js';

const key = randomBytes(32);

test('round trip, with a fresh IV each time', () => {
  const box = createSecretBox(key);
  const a = box.encrypt('hello');
  const b = box.encrypt('hello');
  assert.notEqual(a, b);
  assert.equal(box.decrypt(a), 'hello');
  assert.ok(!a.includes('hello'));
});

test('wrong key, changed data and wrong aad all fail with the same error', () => {
  const box = createSecretBox(key);
  const other = createSecretBox(randomBytes(32));
  const env = box.encrypt('secret', 'place-1');
  assert.throws(() => other.decrypt(env, 'place-1'), SecretBoxError);
  assert.throws(() => box.decrypt(env, 'place-2'), SecretBoxError);
  const parts = env.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.decrypt(parts.join('.'), 'place-1'), { message: 'decryption failed' });
  assert.throws(() => box.decrypt('garbage'), { message: 'unknown envelope format' });
});

test('keys are accepted as hex or base64 and must be 32 bytes', () => {
  assert.deepEqual(parseKey(key.toString('hex')), key);
  assert.deepEqual(parseKey(key.toString('base64')), key);
  assert.throws(() => parseKey('short'), SecretBoxError);
  assert.throws(() => createSecretBox(randomBytes(16)), SecretBoxError);
  assert.throws(() => createSecretBox(undefined), SecretBoxError);
});

test('errors never contain the key or the plaintext', () => {
  const box = createSecretBox(key);
  try {
    box.decrypt(createSecretBox(randomBytes(32)).encrypt('top-secret-text'));
  } catch (err) {
    assert.ok(!String(err.message).includes('top-secret-text'));
    assert.ok(!String(err.message).includes(key.toString('hex')));
  }
});
