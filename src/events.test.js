import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventStore, taipeiDay } from './events.js';
import { ADMIN_COOKIE, VISITOR_COOKIE, adminCookie, adminCookieValue, classifyUserAgent, isAdminRequest, parseCookies, visitorCookie, visitorFromRequest } from './visitor.js';
import { historyVerdict, vetMaxPerSymbolDay } from './history.js';

const quiet = { warn() {}, error() {}, info() {} };
async function tempStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'events-'));
  const filePath = join(dir, 'events.jsonl');
  const events = await new EventStore(filePath, { log: quiet, ...options }).load();
  return { dir, filePath, events };
}

test('EventStore（JSONL）：record 不拒絕、依序寫檔、query 新→舊含 total 與分頁、重啟後讀回', async () => {
  const { dir, filePath, events } = await tempStore();
  try {
    const t0 = new Date('2026-10-01T01:00:00.000Z');
    const rows = await Promise.all([
      events.record('page_view', { ua: { browser: 'Chrome', os: 'macOS' } }, { visitor: 'v1', ts: t0 }),
      events.record('parse', { status: 'formula', provider: 'groq' }, { visitor: 'v1', ts: new Date(t0.getTime() + 1000) }),
      events.record('parse', { status: 'unknown_indicator', provider: null }, { visitor: 'v2', ts: new Date(t0.getTime() + 2000) }),
      events.record('not a type!', {}, { visitor: 'v2' })
    ]);
    assert.deepEqual(rows.map((row) => row?.id ?? null), [1, 2, 3, null], 'ids are sequential; an invalid type is dropped, not thrown');
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 3); assert.equal(JSON.parse(lines[1]).type, 'parse');
    const all = await events.query();
    assert.equal(all.total, 3); assert.deepEqual(all.items.map((row) => row.id), [3, 2, 1], 'newest first');
    const parses = await events.query({ type: 'parse', limit: 1, offset: 1 });
    assert.equal(parses.total, 2); assert.deepEqual(parses.items.map((row) => row.id), [2]);
    const v2 = await events.query({ visitor: 'v2' }); assert.equal(v2.total, 1);
    const window = await events.query({ from: new Date(t0.getTime() + 1000).toISOString(), to: new Date(t0.getTime() + 2000).toISOString() });
    assert.deepEqual(window.items.map((row) => row.id), [2], 'from inclusive, to exclusive');
    // Payload bounding and scalars.
    const big = await events.record('parse', { text: 'x'.repeat(5000) }); assert.equal(big.payload.truncated, true);
    const scalar = await events.record('parse', 'plain'); assert.deepEqual(scalar.payload, { value: 'plain' });
    // Restart: the file is the source of truth and the id counter continues.
    const reloaded = await new EventStore(filePath, { log: quiet }).load();
    assert.equal((await reloaded.query()).total, 5);
    const next = await reloaded.record('parse', null); assert.equal(next.id, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('EventStore.aggregate：day（台北日、升冪）、visitor、payload.<key>（陣列逐項計）、無效 groupBy 400；visitors 彙總', async () => {
  const { dir, events } = await tempStore();
  try {
    // 2026-10-01T16:30Z is already 2026-10-02 in Taipei.
    await events.record('page_view', null, { visitor: 'a', ts: '2026-10-01T02:00:00.000Z' });
    await events.record('page_view', null, { visitor: 'b', ts: '2026-10-01T16:30:00.000Z' });
    await events.record('parse', { status: 'formula' }, { visitor: 'a', ts: '2026-10-01T03:00:00.000Z' });
    await events.record('parse', { status: 'formula' }, { visitor: 'b', ts: '2026-10-01T04:00:00.000Z' });
    await events.record('parse', { status: 'discussion' }, { visitor: 'a', ts: '2026-10-01T05:00:00.000Z' });
    await events.record('template_instantiate', { labels: ['MACD', 'KD'] }, { visitor: 'a', ts: '2026-10-01T06:00:00.000Z' });
    await events.record('template_instantiate', { labels: ['MACD'] }, { visitor: 'b', ts: '2026-10-01T07:00:00.000Z' });
    assert.equal(taipeiDay('2026-10-01T16:30:00.000Z'), '2026-10-02');
    assert.deepEqual(await events.aggregate({ type: 'page_view', groupBy: 'day' }), [{ key: '2026-10-01', count: 1 }, { key: '2026-10-02', count: 1 }]);
    assert.deepEqual(await events.aggregate({ type: 'parse', groupBy: 'payload.status' }), [{ key: 'formula', count: 2 }, { key: 'discussion', count: 1 }]);
    assert.deepEqual(await events.aggregate({ type: 'parse', groupBy: 'visitor' }), [{ key: 'a', count: 2 }, { key: 'b', count: 1 }]);
    assert.deepEqual(await events.aggregate({ type: 'template_instantiate', groupBy: 'payload.labels' }), [{ key: 'MACD', count: 2 }, { key: 'KD', count: 1 }]);
    await assert.rejects(() => events.aggregate({ groupBy: 'payload.bad key' }), { code: 'EVENT_GROUP_INVALID', statusCode: 400 });
    await assert.rejects(() => events.aggregate({ groupBy: 'hour' }), { code: 'EVENT_GROUP_INVALID' });
    const visitors = await events.visitors();
    assert.deepEqual(visitors.map((item) => item.visitor), ['b', 'a'], 'latest activity first');
    assert.deepEqual(visitors[1].counts, { page_view: 1, parse: 2, template_instantiate: 1 });
    assert.deepEqual(await events.visitorRange('a'), { firstSeen: '2026-10-01T02:00:00.000Z', lastSeen: '2026-10-01T06:00:00.000Z' });
    assert.equal(await events.visitorRange('nobody'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('訪客 cookie：w365v HttpOnly/SameSite=Lax/一年；格式不符就重新發；UA 只留瀏覽器／OS 粗分類；admin cookie 為 HMAC', () => {
  const fresh = visitorFromRequest({ headers: {} });
  assert.equal(fresh.isNew, true); assert.match(fresh.visitor, /^[A-Za-z0-9_-]{22}$/);
  const cookie = visitorCookie(fresh.visitor);
  assert.match(cookie, new RegExp(`^${VISITOR_COOKIE}=${fresh.visitor}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax$`));
  assert.match(visitorCookie(fresh.visitor, { secure: true }), /; Secure$/);
  const again = visitorFromRequest({ headers: { cookie: `${cookie.split(';')[0]}; other=1` } });
  assert.deepEqual(again, { visitor: fresh.visitor, isNew: false });
  assert.equal(visitorFromRequest({ headers: { cookie: `${VISITOR_COOKIE}=../etc/passwd` } }).isNew, true, 'malformed id is replaced');
  assert.deepEqual(parseCookies('a=1; b="two"; a=dup; =x'), { a: '1', b: 'two' });
  const ua = classifyUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual(ua, { browser: 'Safari', os: 'iOS', mobile: true });
  assert.deepEqual(classifyUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 Edg/128.0'), { browser: 'Edge', os: 'Windows', mobile: false });
  assert.equal(classifyUserAgent('').browser, 'Unknown');
  // Admin: header token or HMAC cookie; the cookie never carries the token itself.
  const token = 'super-secret-admin-token', secret = 'process-secret';
  const value = adminCookieValue(token, secret);
  assert.notEqual(value, token);
  assert.match(adminCookie(value), new RegExp(`^${ADMIN_COOKIE}=${value}; Max-Age=28800; Path=/api/admin; HttpOnly; SameSite=Strict$`));
  assert.match(adminCookie('', { clear: true }), /Max-Age=0/);
  assert.equal(isAdminRequest({ headers: { 'x-admin-token': token } }, token, secret), true);
  assert.equal(isAdminRequest({ headers: { 'x-admin-token': 'wrong' } }, token, secret), false);
  assert.equal(isAdminRequest({ headers: { cookie: `${ADMIN_COOKIE}=${value}` } }, token, secret), true);
  assert.equal(isAdminRequest({ headers: { cookie: `${ADMIN_COOKIE}=${adminCookieValue(token, 'other-secret')}` } }, token, secret), false, 'cookie from another process secret is rejected');
  assert.equal(isAdminRequest({ headers: { 'x-admin-token': token } }, null, secret), false, 'no token configured → never admin');
});

test('historyVerdict：no_data / no_triggers / too_many / ok 四種，閾值來自 VET_MAX_PER_SYMBOL_DAY（預設 10）', () => {
  assert.equal(vetMaxPerSymbolDay({}), 10); assert.equal(vetMaxPerSymbolDay({ VET_MAX_PER_SYMBOL_DAY: '3' }), 3); assert.equal(vetMaxPerSymbolDay({ VET_MAX_PER_SYMBOL_DAY: 'abc' }), 10);
  const noData = historyVerdict({ totalEvents: 0, symbolsCount: 5, availableDays: 0 });
  assert.equal(noData.ok, false); assert.equal(noData.code, 'no_data');
  const none = historyVerdict({ totalEvents: 0, symbolsCount: 5, availableDays: 7 });
  assert.equal(none.ok, false); assert.equal(none.code, 'no_triggers'); assert.equal(none.perSymbolPerDay, 0);
  const tooMany = historyVerdict({ totalEvents: 5 * 7 * 11, symbolsCount: 5, availableDays: 7 });
  assert.equal(tooMany.ok, false); assert.equal(tooMany.code, 'too_many'); assert.equal(tooMany.perSymbolPerDay, 11);
  const okay = historyVerdict({ totalEvents: 5 * 7 * 10, symbolsCount: 5, availableDays: 7 });
  assert.equal(okay.ok, true); assert.equal(okay.code, 'ok'); assert.equal(okay.perSymbolPerDay, 10, 'exactly the threshold passes');
  assert.deepEqual(Object.keys(okay).sort(), ['availableDays', 'code', 'maxPerSymbolDay', 'message', 'ok', 'perSymbolPerDay', 'symbolsCount', 'totalEvents']);
  assert.equal(historyVerdict({ totalEvents: 5 * 7 * 4, symbolsCount: 5, availableDays: 7 }, { maxPerSymbolDay: 3 }).code, 'too_many', 'threshold override');
  for (const verdict of [noData, none, tooMany, okay]) assert.equal(typeof verdict.message, 'string');
});
