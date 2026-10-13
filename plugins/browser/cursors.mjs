import { createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.mjs';

export function encodeCursor(key, claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

export function decodeCursor(key, token, expected) {
  if (typeof token !== 'string' || token.length > 2048) fail('INVALID_CURSOR', 'Cursor is invalid; refresh without it.');
  const pieces = token.split('.');
  if (pieces.length !== 2 || pieces.some(piece => !/^[A-Za-z0-9_-]+$/.test(piece))) fail('INVALID_CURSOR', 'Cursor is invalid; refresh without it.');
  const actual = Buffer.from(pieces[1], 'base64url');
  const signature = createHmac('sha256', key).update(pieces[0]).digest();
  if (signature.length !== actual.length || !timingSafeEqual(signature, actual)) fail('INVALID_CURSOR', 'Cursor signature does not match.');
  let claims;
  try { claims = JSON.parse(Buffer.from(pieces[0], 'base64url').toString('utf8')); }
  catch { fail('INVALID_CURSOR', 'Cursor payload is invalid.'); }
  if (!Number.isSafeInteger(claims.offset) || claims.offset < 0 || !Number.isFinite(claims.expiresAt) || claims.expiresAt < Date.now() || Object.entries(expected).some(([key, value]) => claims[key] !== value)) fail('INVALID_CURSOR', 'Cursor owner, revision, filter or content changed; refresh without it.');
  return claims;
}
