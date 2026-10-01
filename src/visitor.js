// Anonymous visitor cookie and request helpers shared by the API and the admin API.
// The visitor id is 22 random base64url characters (132 bits), HttpOnly, SameSite=Lax, one year. It identifies a
// browser, not a person: there is no account, and nothing else about the client is kept (see classifyUserAgent).

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const VISITOR_COOKIE = 'w365v';
export const ADMIN_COOKIE = 'w365admin';
const VISITOR_MAX_AGE = 365 * 24 * 60 * 60;
const ADMIN_MAX_AGE = 8 * 60 * 60;
const VISITOR_ID = /^[A-Za-z0-9_-]{22}$/;

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    const name = part.slice(0, index).trim(); if (!name || name in out) continue;
    let value = part.slice(index + 1).trim(); if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { out[name] = decodeURIComponent(value); } catch { out[name] = value; }
  }
  return out;
}

export function newVisitorId() { return randomBytes(17).toString('base64url').slice(0, 22); }

// Reads the visitor id from the request cookie, or issues a new one. isNew tells the caller to set the cookie.
export function visitorFromRequest(request) {
  const cookies = parseCookies(request.headers?.cookie);
  const existing = cookies[VISITOR_COOKIE];
  if (typeof existing === 'string' && VISITOR_ID.test(existing)) return { visitor: existing, isNew: false };
  return { visitor: newVisitorId(), isNew: true };
}

export function visitorCookie(visitor, { secure = false } = {}) {
  return `${VISITOR_COOKIE}=${visitor}; Max-Age=${VISITOR_MAX_AGE}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

// Coarse browser / OS classification; the full user agent string is never stored.
export function classifyUserAgent(userAgent) {
  const ua = String(userAgent || '');
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung' : /Line\//i.test(ua) ? 'LINE' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ua ? 'Other' : 'Unknown';
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : ua ? 'Other' : 'Unknown';
  const mobile = /Mobi|iPhone|iPad|Android/.test(ua);
  return { browser, os, mobile };
}

// Admin session: the cookie carries HMAC(secret, ADMIN_TOKEN) rather than the token itself, so a leaked
// cookie expires with the server secret (a fresh random secret per process) and never reveals the token.
export function adminCookieValue(adminToken, secret) { return createHmac('sha256', secret).update(String(adminToken)).digest('base64url'); }
export function adminCookie(value, { secure = false, clear = false } = {}) {
  return `${ADMIN_COOKIE}=${clear ? '' : value}; Max-Age=${clear ? 0 : ADMIN_MAX_AGE}; Path=/api/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? '')), right = Buffer.from(String(b ?? ''));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
// true when the request carries the admin token (header) or a valid admin cookie.
export function isAdminRequest(request, adminToken, secret) {
  if (!adminToken) return false;
  const header = request.headers?.['x-admin-token'];
  if (typeof header === 'string' && safeEqual(header, adminToken)) return true;
  const cookie = parseCookies(request.headers?.cookie)[ADMIN_COOKIE];
  return typeof cookie === 'string' && safeEqual(cookie, adminCookieValue(adminToken, secret));
}
