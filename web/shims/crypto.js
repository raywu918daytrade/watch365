// Browser stand-in for the node:crypto calls the shared modules make (synchronous sha256 / HMAC).
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
const enc = new TextEncoder();
const bytes = (value) => (typeof value === 'string' ? enc.encode(value) : value instanceof Uint8Array ? value : enc.encode(String(value)));
const hex = (data) => [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const b64url = (data) => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function digester(make) {
  const parts = [];
  const api = { update(value) { parts.push(bytes(value)); return api; }, digest(encoding) {
    const total = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let at = 0; for (const part of parts) { total.set(part, at); at += part.length; }
    const out = make(total); return encoding === 'hex' ? hex(out) : encoding === 'base64url' ? b64url(out) : out; } };
  return api;
}
export function createHash(algorithm) { if (algorithm !== 'sha256') throw new Error(`hash ${algorithm} unsupported`); return digester((data) => sha256(data)); }
export function createHmac(algorithm, key) { if (algorithm !== 'sha256') throw new Error(`hmac ${algorithm} unsupported`); return digester((data) => hmac(sha256, bytes(key), data)); }
export function randomUUID() { return crypto.randomUUID(); }
export function randomBytes(size) { return crypto.getRandomValues(new Uint8Array(size)); }
export function randomInt(min, max) { if (max === undefined) { max = min; min = 0; } return min + Math.floor(Math.random() * (max - min)); }
export function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]; return diff === 0; }
export default { createHash, createHmac, randomUUID, randomBytes, randomInt, timingSafeEqual };
