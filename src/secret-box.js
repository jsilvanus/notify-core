// AES-256-GCM envelope for data at rest (provider secrets, contact details).
// Envelope text: "v1.<iv>.<tag>.<ciphertext>", each part base64url. A fresh random IV per
// message; the optional `aad` string is authenticated but not stored (bind a value to its place).
// The key comes from the host's environment and is never stored by this package.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

/** Accept 32 bytes as 64 hex characters or as base64/base64url. */
export function parseKey(text) {
  const s = typeof text === 'string' ? text.trim() : '';
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 32) return buf;
  }
  throw new SecretBoxError('key must be 32 bytes, given as 64 hex characters or base64');
}

/**
 * @param {string|Buffer} key 32 bytes (hex or base64 text, or a Buffer)
 */
export function createSecretBox(key) {
  const k = Buffer.isBuffer(key) ? key : parseKey(key);
  if (k.length !== 32) throw new SecretBoxError('key must be 32 bytes');

  return {
    /** @param {string} plaintext @param {string} [aad] */
    encrypt(plaintext, aad = '') {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', k, iv);
      if (aad) cipher.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv, tag, ct].map((p, i) => (i === 0 ? p : p.toString('base64url'))).join('.');
    },
    /** @param {string} envelope @param {string} [aad] */
    decrypt(envelope, aad = '') {
      const parts = String(envelope).split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new SecretBoxError('unknown envelope format');
      const [, iv, tag, ct] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, 'base64url')));
      try {
        const decipher = createDecipheriv('aes-256-gcm', k, iv);
        if (aad) decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      } catch {
        // Wrong key, changed data or wrong aad all look the same; say nothing more.
        throw new SecretBoxError('decryption failed');
      }
    },
  };
}
