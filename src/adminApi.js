// Admin API (PM decision: a basic, easy-to-extend, queryable back office: unknown indicators, visitor volume,
// logins, popular indicators, who uses what). The /admin page is built by another RD against this contract.
//
// Access: env ADMIN_TOKEN; requests carry header x-admin-token or the cookie set by POST /api/admin/login.
// Without ADMIN_TOKEN every /api/admin/* answers 503 ADMIN_DISABLED; a bad or missing credential answers 401.
//
// Every statistic is one entry in ADMIN_QUERIES, run through adminQuery(name, range): adding a number to the
// overview is adding one entry here and one key in the overview object.

import { EventStore } from './events.js';
import { adminCookie, adminCookieValue, isAdminRequest, parseCookies, ADMIN_COOKIE, safeEqual } from './visitor.js';

export const ADMIN_QUERIES = Object.freeze({
  pageViewsByDay: { type: 'page_view', groupBy: 'day' },
  activeVisitorsByDay: { groupBy: 'day', distinct: 'visitor' },
  visitorsTotal: { groupBy: 'visitor' },
  parsesByStatus: { type: 'parse', groupBy: 'payload.status' },
  parsesByProvider: { type: 'parse', groupBy: 'payload.provider' },
  parsesByDay: { type: 'parse', groupBy: 'day' },
  monitorsConfiguredByDay: { type: 'monitor_configure', groupBy: 'day' },
  templateLabels: { type: 'template_instantiate', groupBy: 'payload.label' },
  monitorStrategyNames: { type: 'monitor_configure', groupBy: 'payload.strategyName' },
  templateShapeKeys: { type: 'template_instantiate', groupBy: 'payload.shapeKey' },
  templateFingerprints: { type: 'template_instantiate', groupBy: 'payload.fingerprint' },
  monitorFingerprints: { type: 'monitor_configure', groupBy: 'payload.fingerprint' },
  backtestsByDay: { type: 'backtest', groupBy: 'day' },
  vetBlockedByCode: { type: 'vet_blocked', groupBy: 'payload.code' },
  unknownIndicatorsByDay: { type: 'unknown_indicator', groupBy: 'day' },
  adminLoginsByDay: { type: 'admin_login', groupBy: 'day' }
});

export function createAdminApi({ events, store, formulaLibrary, unknownIndicators, conditionStates = null, ruleStates = null, notifyEngine = 'legacy', legacySignalsToday = () => null, env = process.env, secret, log = console, now = () => Date.now() }) {
  if (!(events instanceof EventStore)) throw new Error('createAdminApi needs an EventStore');
  const adminToken = typeof env.ADMIN_TOKEN === 'string' && env.ADMIN_TOKEN.trim().length >= 8 ? env.ADMIN_TOKEN.trim() : null;

  // One statistic. range = { from, to }. 'distinct' counts distinct values of that field per group (file mode and
  // SQL mode both go through aggregate, so distinct is derived from a secondary grouping).
  async function adminQuery(name, range = {}, extra = {}) {
    const spec = ADMIN_QUERIES[name]; if (!spec) throw Object.assign(new Error('ADMIN_QUERY_UNKNOWN'), { code: 'ADMIN_QUERY_UNKNOWN', statusCode: 500 });
    const filter = { type: spec.type ?? null, from: range.from ?? null, to: range.to ?? null, ...extra };
    if (spec.distinct) {
      // distinct visitors per day: list the (day, visitor) pairs from the raw events of the window.
      const rows = await pageAll(events, filter);
      const perDay = new Map();
      for (const row of rows) { if (!row[spec.distinct]) continue; const day = taipeiDay(row.ts); if (!perDay.has(day)) perDay.set(day, new Set()); perDay.get(day).add(row[spec.distinct]); }
      return [...perDay].map(([key, set]) => ({ key, count: set.size })).sort((a, b) => a.key.localeCompare(b.key));
    }
    return events.aggregate({ ...filter, groupBy: spec.groupBy });
  }

  function rangeFromDays(url, fallback = 7) {
    const days = clamp(url.searchParams.get('days'), 1, 365, fallback);
    return { from: new Date(now() - days * 86_400_000).toISOString(), to: null, days };
  }

  // Returns true when the request was handled.
  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/api/admin/') && url.pathname !== '/api/admin') return false;
    const method = request.method || 'GET';
    if (!adminToken) { sendJson(response, 503, { error: 'ADMIN_DISABLED', message: '未設定 ADMIN_TOKEN，後台停用。' }); return true; }

    if (method === 'POST' && url.pathname === '/api/admin/login') {
      let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error: 'INVALID_JSON' }); return true; }
      if (typeof body?.token !== 'string' || !safeEqual(body.token, adminToken)) { events.record('admin_login', { ok: false }, { visitor: request.visitor ?? null }); sendJson(response, 401, { error: 'ADMIN_UNAUTHORIZED' }); return true; }
      response.setHeader('Set-Cookie', appendCookie(response, adminCookie(adminCookieValue(adminToken, secret), { secure: isSecure(request) })));
      events.record('admin_login', { ok: true }, { visitor: request.visitor ?? null });
      sendJson(response, 200, { ok: true, expiresInSeconds: 8 * 60 * 60 }); return true;
    }
    if (!isAdminRequest(request, adminToken, secret)) { sendJson(response, 401, { error: 'ADMIN_UNAUTHORIZED' }); return true; }

    if (method === 'POST' && url.pathname === '/api/admin/logout') {
      response.setHeader('Set-Cookie', appendCookie(response, adminCookie('', { clear: true })));
      sendJson(response, 200, { ok: true }); return true;
    }

    if (method === 'GET' && url.pathname === '/api/admin/overview') {
      const range = rangeFromDays(url, 7);
      const [pageViews, active, allVisitors, byStatus, byProvider, configured, templateLabels, strategyNames, vetBlocked] = await Promise.all([
        adminQuery('pageViewsByDay', range), adminQuery('activeVisitorsByDay', range), adminQuery('visitorsTotal'), adminQuery('parsesByStatus', range), adminQuery('parsesByProvider', range), adminQuery('monitorsConfiguredByDay', range), adminQuery('templateLabels', range), adminQuery('monitorStrategyNames', range), adminQuery('vetBlockedByCode', range)
      ]);
      const parsesTotal = byStatus.reduce((sum, item) => sum + item.count, 0);
      const state = store.getState();
      const unknown = unknownIndicators.list({ limit: 10 }).map(({ norm, text, count, lastSeen }) => ({ norm, text, count, lastSeen }));
      // Day series are [{ day, count }] (contract); categorical breakdowns stay [{ key, count }].
      sendJson(response, 200, {
        days: range.days, from: range.from, generatedAt: new Date(now()).toISOString(),
        visitors: { total: allVisitors.length, active: daySeries(active) },
        pageViews: daySeries(pageViews),
        parses: { total: parsesTotal, byStatus, byProvider },
        monitors: { configured: daySeries(configured), current: { strategyName: state.settings.strategy?.name ?? null, enabled: Boolean(state.settings.enabled), symbols: state.settings.watchlist.length, scopeMode: state.settings.scopeMode ?? 'watchlist', lastRunAt: state.runtime.lastRunAt } },
        topIndicators: mergeCounts([templateLabels, strategyNames]).slice(0, 20).map(({ key, count }) => ({ label: key, count })),
        vetBlocked,
        unknownIndicators: { total: unknownIndicators.count(), recent: unknown },
        library: formulaLibrary.stats()
      });
      return true;
    }

    if (method === 'GET' && url.pathname === '/api/admin/events') {
      const type = url.searchParams.get('type') || null, visitor = url.searchParams.get('visitor') || null;
      const from = parseDate(url.searchParams.get('from')), to = parseDate(url.searchParams.get('to'));
      const result = await events.query({ type, visitor, from, to, limit: clamp(url.searchParams.get('limit'), 1, 1000, 200), offset: clamp(url.searchParams.get('offset'), 0, 1e9, 0) });
      sendJson(response, 200, result); return true;
    }

    if (method === 'GET' && url.pathname === '/api/admin/visitors') {
      const range = rangeFromDays(url, 30); const limit = clamp(url.searchParams.get('limit'), 1, 1000, 100);
      const visitors = await events.visitors({ from: range.from, limit });
      // Indicator labels per visitor: one query over the two naming events for the listed visitors.
      const labels = new Map();
      for (const visitor of visitors) {
        const { items } = await events.query({ visitor: visitor.visitor, types: ['template_instantiate', 'monitor_configure'], from: range.from, limit: 200 });
        labels.set(visitor.visitor, [...new Set(items.map((row) => row.payload?.label ?? row.payload?.strategyName).filter(Boolean))]);
      }
      sendJson(response, 200, { days: range.days, items: visitors.map((item) => ({ visitor: item.visitor, firstSeen: item.firstSeen, lastSeen: item.lastSeen, pageViews: item.counts.page_view || 0, parses: item.counts.parse || 0, monitors: item.counts.monitor_configure || 0, backtests: item.counts.backtest || 0, indicators: labels.get(item.visitor) || [] })) });
      return true;
    }

    // Shared condition layer (src/conditionState.js): which conditions are computed, for how many stocks, how many
    // are true now, flips today, and the most recent flips. mode is 'shadow' until rules drive notifications.
    if (method === 'GET' && url.pathname === '/api/admin/conditions') {
      // ruleStates: layer 2 (per-rule idle/triggered/cooldown) with today's shadow triggers next to the signals the
      // current engine created, so the two can be compared before notifications switch over.
      if (!conditionStates) { sendJson(response, 200, { mode: 'off', lastRun: null, rules: [], conditions: [], recentFlips: [], ruleStates: null }); return true; }
      const limit = clamp(url.searchParams.get('flips'), 1, 300, 50);
      let legacy = null; try { legacy = legacySignalsToday(); } catch { legacy = null; }
      sendJson(response, 200, { ...conditionStates.snapshot({ flips: limit }), ruleStates: ruleStates ? ruleStates.snapshot({ events: limit, now: new Date(now()), legacySignalsToday: legacy, mode: notifyEngine === 'state' ? 'live' : 'shadow' }) : null }); return true;
    }

    if (method === 'GET' && url.pathname === '/api/admin/unknown-indicators') {
      sendJson(response, 200, { items: unknownIndicators.list({ limit: clamp(url.searchParams.get('limit'), 1, 2000, 200) }) }); return true;
    }

    if (method === 'GET' && url.pathname === '/api/admin/indicators') {
      const [byShape, byTemplateFingerprint, byMonitorFingerprint] = await Promise.all([adminQuery('templateShapeKeys'), adminQuery('templateFingerprints'), adminQuery('monitorFingerprints')]);
      const shapeCounts = new Map(byShape.map((item) => [item.key, item.count]));
      const fingerprintCounts = new Map(mergeCounts([byTemplateFingerprint, byMonitorFingerprint]).map((item) => [item.key, item.count]));
      // Contract for the admin page: items:[{ shapeKey, family, name, presets, members:[{ fingerprint, name, status,
      // source, hitCount }], uses }]. uses = template instantiations + monitor configurations of any member.
      // Disabled formulas are listed too (they are what an operator comes here to re-enable), under their template
      // when they have one, otherwise under a synthetic「其他」group keyed by fingerprint.
      const grouped = formulaLibrary.templates({ includePending: true }).map((template) => ({
        shapeKey: template.shapeKey, family: template.family, category: template.category, name: template.name, presets: template.presets, params: template.params, direction: template.direction,
        members: template.members.map(({ fingerprint, name, summary, status, source, hitCount, aliases }) => ({ fingerprint, name, summary, status, source, hitCount, aliases, uses: fingerprintCounts.get(fingerprint) || 0 })),
        hitCount: template.hitCount, source: template.source,
        uses: (shapeCounts.get(template.shapeKey) || 0) + template.members.reduce((sum, member) => sum + (fingerprintCounts.get(member.fingerprint) || 0), 0)
      }));
      const listed = new Set(grouped.flatMap((item) => item.members.map((member) => member.fingerprint)));
      for (const formula of formulaLibrary.list().filter((item) => !listed.has(item.fingerprint))) {
        grouped.push({ shapeKey: `formula:${formula.fingerprint}`, family: '其他', category: '其他', name: formula.name, presets: [], params: [], direction: null, members: [{ fingerprint: formula.fingerprint, name: formula.name, summary: formula.summary, status: formula.status, source: formula.source, hitCount: formula.hitCount, aliases: formula.aliases, uses: fingerprintCounts.get(formula.fingerprint) || 0 }], hitCount: formula.hitCount, source: formula.source, uses: fingerprintCounts.get(formula.fingerprint) || 0 });
      }
      sendJson(response, 200, { items: grouped, library: formulaLibrary.stats() }); return true;
    }

    const statusMatch = url.pathname.match(/^\/api\/admin\/indicators\/([a-f0-9]{64})\/status$/);
    if (method === 'POST' && statusMatch) {
      let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error: 'INVALID_JSON' }); return true; }
      try {
        const formula = await formulaLibrary.setStatus(statusMatch[1], body?.status);
        events.record('admin_status_change', { fingerprint: statusMatch[1], status: body.status }, { visitor: request.visitor ?? null });
        sendJson(response, 200, { formula });
      } catch (error) { sendJson(response, error.statusCode || 500, { error: error.code || 'ADMIN_STATUS_FAILED' }); }
      return true;
    }

    sendJson(response, 404, { error: 'Not found' }); return true;
  }

  return { handle, adminQuery, enabled: Boolean(adminToken) };
}

async function pageAll(events, filter) {
  const rows = [];
  for (let offset = 0; offset < 200_000; offset += 1000) { const { items } = await events.query({ ...filter, limit: 1000, offset }); rows.push(...items); if (items.length < 1000) break; }
  return rows;
}
function mergeCounts(lists) {
  const counts = new Map();
  for (const list of lists) for (const { key, count } of list) counts.set(key, (counts.get(key) || 0) + count);
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'zh-Hant'));
}
function daySeries(rows) { return rows.map(({ key, count }) => ({ day: key, count })); }
function taipeiDay(iso) { return new Date(new Date(iso).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function parseDate(value) { if (!value) return null; const time = new Date(value).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : null; }
function clamp(value, min, max, fallback) { const number = Number(value); if (value == null || value === '' || !Number.isFinite(number)) return fallback; return Math.min(max, Math.max(min, Math.trunc(number))); }
function isSecure(request) { return request.headers?.['x-forwarded-proto'] === 'https' || Boolean(request.socket?.encrypted); }
function appendCookie(response, cookie) { const existing = response.getHeader('Set-Cookie'); return existing ? [].concat(existing, cookie) : cookie; }
async function readJson(request) { const chunks = []; for await (const chunk of request) chunks.push(chunk); const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {}; }
function sendJson(response, status, payload) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(payload)); }
export { parseCookies, ADMIN_COOKIE };
