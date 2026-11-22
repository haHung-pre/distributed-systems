'use strict';
/**
 * Minimal JWT-like token + password hashing.
 * Deliberately implemented on top of node:crypto only (no external deps) so
 * the mechanism is fully explainable during the oral examination.
 *
 * Password storage:  PBKDF2-HMAC-SHA256, 120_000 iterations, 16-byte salt.
 *                    Format:  pbkdf2$<iter>$<saltB64>$<hashB64>   (no plaintext)
 * Token:             base64url(header).base64url(payload).base64url(HMAC-SHA256)
 *                    Secret comes from env COEDIT_JWT_SECRET (never committed).
 */
const crypto = require('crypto');

const ITER = 120000;
const KEYLEN = 32;
const DIGEST = 'sha256';

function b64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function ub64(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, ITER, KEYLEN, DIGEST);
  return `pbkdf2$${ITER}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, iter, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.pbkdf2Sync(password, salt, parseInt(iter, 10), expected.length, DIGEST);
    return crypto.timingSafeEqual(expected, actual);   // constant time
  } catch {
    return false;
  }
}

function sign(payload, secret, ttlSec = 3600) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSec };
  const p1 = b64u(JSON.stringify(header));
  const p2 = b64u(JSON.stringify(body));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`${p1}.${p2}`).digest());
  return `${p1}.${p2}.${sig}`;
}

function verify(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [p1, p2, sig] = parts;
  const expect = crypto.createHmac('sha256', secret).update(`${p1}.${p2}`).digest();
  let given;
  try { given = ub64(sig); } catch { return null; }
  if (given.length !== expect.length || !crypto.timingSafeEqual(given, expect)) return null;
  let body;
  try { body = JSON.parse(ub64(p2).toString('utf8')); } catch { return null; }
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;   // expired
  return body;
}

module.exports = { hashPassword, verifyPassword, sign, verify };
