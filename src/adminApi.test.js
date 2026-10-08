import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ADMIN_QUERIES, createAdminApi } from './adminApi.js';
import { EventStore } from './events.js';
import { FormulaLibrary } from './formulaLibrary.js';
import { UnknownIndicatorStore } from './indicatorLookup.js';
import { JsonStore } from './storage.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';

const quiet = { warn() {}, error() {}, info() {} };
const TOKEN = 'admin-token-for-tests';

// Boots the admin API on a real http server (cookies, headers and JSON bodies behave exactly as in server.js).
async function boot(env) {
  const dir = await mkdtemp(join(tmpdir(), 'admin-api-'));
  const events = await new EventStore(join(dir, 'events.jsonl'), { log: quiet }).load();
  const unknownIndicators = await new UnknownIndicatorStore(join(dir, 'unknown.json'), { log: quiet }).load();
  const formulaLibrary = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
  const store = new JsonStore(join(dir, 'watch365.json')); await store.load();
  const api = createAdminApi({ events, store, formulaLibrary, unknownIndicators, env, secret: 'process-secret', log: quiet });
  const server = createServer(async (request, response) => {
    request.visitor = 'tester';
    const handled = await api.handle(request, response, new URL(request.url, 'http://localhost'));
    if (!handled) { response.writeHead(404); response.end('{"error":"Not found"}'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, raw, headers = {} } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, cookie: response.headers.get('set-cookie') };
  };
  const close = async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); };
  return { api, events, unknownIndicators, formulaLibrary, store, call, close };
}

test('ADMIN_TOKEN 未設定（或太短）→ 所有 /api/admin/* 回 503 ADMIN_DISABLED', async () => {
  for (const env of [{}, { ADMIN_TOKEN: 'short' }]) {
    const { api, call, close } = await boot(env);
    try {
      assert.equal(api.enabled, false);
      for (const path of ['/api/admin/overview', '/api/admin/events', '/api/admin/unknown-indicators']) { const result = await call(path); assert.equal(result.status, 503); assert.equal(result.body.error, 'ADMIN_DISABLED'); }
      const login = await call('/api/admin/login', { method: 'POST', body: { token: 'short' } }); assert.equal(login.status, 503);
    } finally { await close(); }
  }
});

test('驗證：無憑證 401；login 錯 401；login 對設 HttpOnly cookie（8 小時）後 200；header x-admin-token 也可；logout 清 cookie', async () => {
  const { events, call, close } = await boot({ ADMIN_TOKEN: TOKEN });
  try {
    const anonymous = await call('/api/admin/overview'); assert.equal(anonymous.status, 401); assert.equal(anonymous.body.error, 'ADMIN_UNAUTHORIZED');
    const badHeader = await call('/api/admin/overview', { headers: { 'x-admin-token': 'nope' } }); assert.equal(badHeader.status, 401);
    const badLogin = await call('/api/admin/login', { method: 'POST', body: { token: 'nope' } }); assert.equal(badLogin.status, 401); assert.equal(badLogin.cookie, null);
    const badJson = await call('/api/admin/login', { method: 'POST', raw: 'not json' }); assert.equal(badJson.status, 400); assert.equal(badJson.body.error, 'INVALID_JSON');
    const login = await call('/api/admin/login', { method: 'POST', body: { token: TOKEN } });
    assert.equal(login.status, 200); assert.equal(login.body.expiresInSeconds, 8 * 60 * 60);
    assert.match(login.cookie, /^w365admin=[A-Za-z0-9_-]+; Max-Age=28800; Path=\/api\/admin; HttpOnly; SameSite=Strict$/);
    assert.ok(!login.cookie.includes(TOKEN), 'cookie never carries the token');
    const cookie = login.cookie.split(';')[0];
    const viaCookie = await call('/api/admin/overview?days=7', { headers: { cookie } }); assert.equal(viaCookie.status, 200);
    const viaHeader = await call('/api/admin/overview', { headers: { 'x-admin-token': TOKEN } }); assert.equal(viaHeader.status, 200);
    const forged = await call('/api/admin/overview', { headers: { cookie: 'w365admin=forged' } }); assert.equal(forged.status, 401);
    const logout = await call('/api/admin/logout', { method: 'POST', headers: { cookie } }); assert.equal(logout.status, 200); assert.match(logout.cookie, /Max-Age=0/);
    const missing = await call('/api/admin/nothing-here', { headers: { cookie } }); assert.equal(missing.status, 404);
    await events.flush();
    const logins = await events.query({ type: 'admin_login' });
    assert.deepEqual(logins.items.map((row) => row.payload.ok).sort(), [false, true], 'both login attempts are recorded');
  } finally { await close(); }
});

test('overview / events / visitors / unknown-indicators / indicators 的回傳形狀符合前端契約；status 修改生效並記事件', async () => {
  const { events, unknownIndicators, formulaLibrary, call, close } = await boot({ ADMIN_TOKEN: TOKEN });
  const auth = { headers: { 'x-admin-token': TOKEN } };
  try {
    const macd = formulaLibrary.list().find((formula) => formula.name === FORMULA_RECIPES[0].name);
    const now = Date.now();
    await events.record('page_view', { ua: { browser: 'Chrome', os: 'macOS', mobile: false } }, { visitor: 'v1', ts: new Date(now - 60_000) });
    await events.record('page_view', { ua: { browser: 'Safari', os: 'iOS', mobile: true } }, { visitor: 'v2', ts: new Date(now - 50_000) });
    await events.record('parse', { text: 'MACD金叉', status: 'formula', provider: 'library', library: true }, { visitor: 'v1', ts: new Date(now - 40_000) });
    await events.record('parse', { text: '神奇飛天指標', status: 'unknown_indicator', provider: 'rules' }, { visitor: 'v2', ts: new Date(now - 30_000) });
    await events.record('template_instantiate', { label: 'MACD(12,26,9) DIF 向上穿越 DEA', labels: ['MACD(12,26,9) DIF 向上穿越 DEA'], shapeKey: 'shape-macd', fingerprint: macd.fingerprint }, { visitor: 'v1', ts: new Date(now - 20_000) });
    await events.record('monitor_configure', { purpose: 'watchlist', symbols: 3, strategyName: 'MACD(12,26,9) DIF 向上穿越 DEA', label: 'MACD(12,26,9) DIF 向上穿越 DEA', fingerprint: macd.fingerprint }, { visitor: 'v1', ts: new Date(now - 10_000) });
    await events.record('vet_blocked', { code: 'no_triggers' }, { visitor: 'v2', ts: new Date(now - 5_000) });
    await unknownIndicators.record({ text: '神奇飛天指標 上穿 50', candidates: ['神奇飛天指標'] });

    const overview = await call('/api/admin/overview?days=7', auth);
    assert.equal(overview.status, 200);
    const body = overview.body;
    assert.deepEqual(Object.keys(body.visitors).sort(), ['active', 'total']); assert.equal(body.visitors.total, 2); assert.equal(body.visitors.active.length, 1); assert.deepEqual(Object.keys(body.visitors.active[0]), ['day', 'count']); assert.equal(body.visitors.active[0].count, 2);
    assert.deepEqual(body.pageViews, [{ day: body.pageViews[0].day, count: 2 }]); assert.deepEqual(Object.keys(body.monitors.configured[0]), ['day', 'count']); assert.match(body.pageViews[0].day, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.parses.total, 2); assert.deepEqual(body.parses.byStatus, [{ key: 'formula', count: 1 }, { key: 'unknown_indicator', count: 1 }]); assert.deepEqual(body.parses.byProvider, [{ key: 'library', count: 1 }, { key: 'rules', count: 1 }]);
    assert.deepEqual(body.monitors.configured.map((item) => item.count), [1]); assert.deepEqual(Object.keys(body.monitors.current).sort(), ['enabled', 'lastRunAt', 'scopeMode', 'strategyName', 'symbols']); assert.equal(body.monitors.current.enabled, false);
    assert.deepEqual(body.topIndicators[0], { label: 'MACD(12,26,9) DIF 向上穿越 DEA', count: 2 });
    assert.equal(body.unknownIndicators.total, 1); assert.deepEqual(Object.keys(body.unknownIndicators.recent[0]).sort(), ['count', 'lastSeen', 'norm', 'text']);
    assert.deepEqual(Object.keys(body.library).sort(), ['active', 'aliases', 'disabled', 'formulas', 'pending']); assert.equal(body.library.formulas, FORMULA_RECIPES.length);
    assert.deepEqual(body.vetBlocked, [{ key: 'no_triggers', count: 1 }]);

    const list = await call('/api/admin/events?type=parse&limit=1&offset=0', auth);
    assert.equal(list.status, 200); assert.equal(list.body.total, 2); assert.equal(list.body.items.length, 1);
    assert.deepEqual(Object.keys(list.body.items[0]).sort(), ['id', 'payload', 'ts', 'type', 'visitor']); assert.equal(list.body.items[0].payload.status, 'unknown_indicator', 'newest first');
    const byVisitor = await call('/api/admin/events?visitor=v2', auth); assert.equal(byVisitor.body.total, 3);
    const windowed = await call(`/api/admin/events?from=${encodeURIComponent(new Date(now - 25_000).toISOString())}`, auth); assert.equal(windowed.body.total, 3);

    const visitors = await call('/api/admin/visitors?days=30&limit=100', auth);
    assert.equal(visitors.status, 200); assert.equal(visitors.body.items.length, 2);
    const v1 = visitors.body.items.find((item) => item.visitor === 'v1');
    assert.deepEqual({ ...v1, firstSeen: 'x', lastSeen: 'x' }, { visitor: 'v1', firstSeen: 'x', lastSeen: 'x', pageViews: 1, parses: 1, monitors: 1, backtests: 0, indicators: ['MACD(12,26,9) DIF 向上穿越 DEA'] });

    const unknown = await call('/api/admin/unknown-indicators?limit=200', auth);
    assert.equal(unknown.status, 200); assert.equal(unknown.body.items.length, 1);
    assert.deepEqual(Object.keys(unknown.body.items[0]).sort(), ['candidates', 'count', 'firstSeen', 'lastSeen', 'norm', 'text']);

    const indicators = await call('/api/admin/indicators', auth);
    assert.equal(indicators.status, 200); assert.ok(Array.isArray(indicators.body.items) && indicators.body.items.length > 0);
    for (const item of indicators.body.items) {
      for (const key of ['shapeKey', 'family', 'name', 'presets', 'members', 'uses']) assert.ok(key in item, `${key} missing on ${item.shapeKey}`);
      assert.ok(Array.isArray(item.presets) && Array.isArray(item.members) && Number.isInteger(item.uses));
      for (const member of item.members) for (const key of ['fingerprint', 'name', 'status', 'source', 'hitCount']) assert.ok(key in member, `${key} missing on member`);
    }
    const macdGroup = indicators.body.items.find((item) => item.members.some((member) => member.fingerprint === macd.fingerprint));
    assert.equal(macdGroup.family, 'MACD'); assert.equal(macdGroup.uses, 2, 'one instantiation + one configure');
    const everyFingerprint = new Set(indicators.body.items.flatMap((item) => item.members.map((member) => member.fingerprint)));
    assert.equal(everyFingerprint.size, FORMULA_RECIPES.length, 'every library formula is listed exactly once');

    // Status change: 400 on an unknown status, 404 on an unknown fingerprint, 200 otherwise; disabled formulas vanish from match().
    const bad = await call(`/api/admin/indicators/${macd.fingerprint}/status`, { method: 'POST', body: { status: 'bogus' }, ...auth }); assert.equal(bad.status, 400); assert.equal(bad.body.error, 'FORMULA_LIBRARY_STATUS_INVALID');
    const gone = await call(`/api/admin/indicators/${'0'.repeat(64)}/status`, { method: 'POST', body: { status: 'disabled' }, ...auth }); assert.equal(gone.status, 404);
    const malformed = await call(`/api/admin/indicators/not-a-fingerprint/status`, { method: 'POST', body: { status: 'disabled' }, ...auth }); assert.equal(malformed.status, 404);
    const disabled = await call(`/api/admin/indicators/${macd.fingerprint}/status`, { method: 'POST', body: { status: 'disabled' }, ...auth });
    assert.equal(disabled.status, 200); assert.equal(disabled.body.formula.status, 'disabled');
    assert.equal(await formulaLibrary.match('MACD金叉'), null, 'a disabled preset is no longer served');
    const after = await call('/api/admin/indicators', auth);
    assert.equal(after.body.items.flatMap((item) => item.members).find((member) => member.fingerprint === macd.fingerprint).status, 'disabled', 'still listed so it can be re-enabled');
    const restored = await call(`/api/admin/indicators/${macd.fingerprint}/status`, { method: 'POST', body: { status: 'active' }, ...auth }); assert.equal(restored.body.formula.status, 'active');
    assert.notEqual(await formulaLibrary.match('MACD金叉'), null);
    const unauthorized = await call(`/api/admin/indicators/${macd.fingerprint}/status`, { method: 'POST', body: { status: 'disabled' } }); assert.equal(unauthorized.status, 401);
    await events.flush();
    const changes = await events.query({ type: 'admin_status_change' });
    assert.deepEqual(changes.items.map((row) => row.payload.status), ['active', 'disabled']);
    assert.ok(Object.keys(ADMIN_QUERIES).length >= 10);
  } finally { await close(); }
});

test('GET /api/admin/conditions reports the shared condition layer (off when not wired)', async () => {
  const { call, close } = await boot({ ADMIN_TOKEN: TOKEN });
  try {
    assert.equal((await call('/api/admin/conditions')).status, 401);
    const response = await call('/api/admin/conditions', { headers: { 'x-admin-token': TOKEN } });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { mode: 'off', lastRun: null, rules: [], conditions: [], recentFlips: [], ruleStates: null });
  } finally { await close(); }
});
