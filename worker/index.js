// watch365 API on Cloudflare Workers (free plan), replacing the stateful half of src/server.js after the move off
// Railway (2026-11). The static site (GitHub Pages) computes the daily index itself (web/localApi.js) and calls this
// Worker for what has to be stored or kept secret: each person's monitor, LINE linking + webhook, the AI indicator
// parser, the formula library and indicator requests. Storage is KV (binding W365). The 13:00 check runs in GitHub
// Actions (jobs/daily-close.mjs), which reads and writes the same documents through /admin/doc/*.
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { JsonStore, appendLog, publicState } from '../src/storage.js';
import { LineNotifier, lineConfigFromEnv, verifySignature } from '../src/line.js';
import { FormulaLibrary, resolveMonitorCondition } from '../src/formulaLibrary.js';
import { IndicatorRegistry, strategyIdentity, validateFormulaStrategy, validateStrategy } from '../src/indicatorRegistry.js';
import { IndicatorRequestStore } from '../src/indicatorRequests.js';
import { lookupIndicator } from '../src/indicatorLookup.js';
import { dailyCapable } from '../src/dailyIndex.js';
import { formulaFingerprint, issueFormulaToken, verifyFormulaToken } from '../src/formulaEngine.js';
import { conditionsName, parseConditions, planConditionStrategy } from '../src/monitorConditions.js';
import { parseWatchlist } from '../src/rules.js';
import { notificationEligibility, signalMatchesCurrentStrategy } from '../src/monitorScope.js';
import { documentBackend, formulaBackend } from './kv.js';

const OWNER_ID = /^[A-Za-z0-9_-]{22}$/;
const MAX_INDEX_FILTERS = 3;
const CODES_KEY = 'line-codes';

export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status:204, headers:cors });
    let response;
    try { response = await route(request, env, context, url); }
    catch (error) { if (!error.statusCode) console.error(error); response = json({ error:error.code || 'INTERNAL_ERROR' }, error.statusCode || 500); }
    for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    return response;
  }
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || 'https://watch365.just1stock.com').split(',').map((item) => item.trim());
  const headers = { 'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type, X-W365-Visitor', 'Access-Control-Max-Age':'86400', Vary:'Origin' };
  if (allowed.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers:{ 'Content-Type':'application/json; charset=utf-8' } });
const fail = (code, statusCode) => Object.assign(new Error(code), { code, statusCode });
async function readJson(request) { const raw = await request.text(); if (!raw) return {}; try { return JSON.parse(raw); } catch { throw fail('INVALID_JSON', 400); } }

// Per-request context: the shared document (accounts, LINE users), this person's monitor, the library.
function makeContext(env, visitor) {
  const backend = documentBackend(env.W365);
  const shared = new JsonStore(null, { backend, key:'state' });
  const ctx = { env, backend, shared, visitor, loaded:false };
  ctx.load = async () => { if (!ctx.loaded) { await shared.load(); ctx.loaded = true; } return ctx; };
  ctx.ownerOf = (id) => shared.getState().accounts?.owners?.[id] || id;
  ctx.monitor = async (owner = ctx.ownerOf(visitor)) => { if (!OWNER_ID.test(String(owner))) throw fail('VISITOR_INVALID', 400); const store = new JsonStore(null, { backend, key:`monitor:${owner}` }); await store.load(); store.owner = owner; return store; };
  ctx.library = async () => { if (!ctx.formulas) { ctx.formulaBackend = formulaBackend(env.W365); ctx.formulas = await new FormulaLibrary(null, { backend:ctx.formulaBackend }).load(); } return ctx.formulas; };
  ctx.registry = new IndicatorRegistry('/config/indicators', '/config/indicator-registry-lock.json');
  ctx.secret = () => { if (!env.FORMULA_TOKEN_SECRET || env.FORMULA_TOKEN_SECRET.length < 32) throw fail('FORMULA_TOKEN_SECRET_MISSING', 503); return env.FORMULA_TOKEN_SECRET; };
  ctx.line = new LineNotifier({ config:{ ...lineConfigFromEnv(env), siteUrl:env.SITE_URL || 'https://watch365.just1stock.com' }, store:shared, ownerOf:ctx.ownerOf, onLinked:({ visitor:id, earlierVisitor }) => joinBrowsers(ctx, id, earlierVisitor) });
  return ctx;
}

async function route(request, env, context, url) {
  const method = request.method, path = url.pathname;
  if (path === '/' || path === '/api/health') return json({ ok:true, service:'watch365-api' });
  if (path.startsWith('/admin/')) return admin(request, env, url);
  if (method === 'POST' && path === '/api/line/webhook') return lineWebhook(request, env, context);

  const visitor = request.headers.get('X-W365-Visitor') || '';
  if (!OWNER_ID.test(visitor)) throw fail('VISITOR_INVALID', 400);
  const ctx = await makeContext(env, visitor).load();
  try { return await api(request, ctx, method, path, url); }
  finally { await ctx.formulaBackend?.flush(); }
}

async function api(request, ctx, method, path, url) {
  if (method === 'GET' && path === '/api/state') return json(publicState((await ctx.monitor()).getState()));

  if (path.startsWith('/api/line/')) return lineRoutes(request, ctx, method, path);

  if (method === 'GET' && path === '/api/formula-library/full') {
    const library = await ctx.library();
    return json({ formulas:[...library.formulas.values()].filter((item) => item.source === 'ai'), aliases:[...library.aliases.values()].filter((item) => item.source !== 'preset') });
  }
  if (method === 'GET' && path === '/api/indicator-templates') return json({ items:(await ctx.library()).templates({ includePending:url.searchParams.get('includePending') !== 'false' }) });

  if (method === 'POST' && path === '/api/indicator-agent/parse') {
    const body = await readJson(request);
    const registry = await ctx.registry.load(), library = await ctx.library();
    const timeframe = body?.timeframe === 'd1' ? 'd1' : '1m';
    const lookupImpl = ctx.env.INDICATOR_LOOKUP === 'off' ? null : lookupIndicator;
    try {
      let result = await resolveMonitorCondition(body.text, registry.items, { library, context:body.context, lookupImpl, timeframe });
      if (timeframe === 'd1' && result.library && result.proposal?.ast && !dailyCapable(result.proposal.ast)) result = await resolveMonitorCondition(body.text, registry.items, { context:body.context, lookupImpl, timeframe });
      if (timeframe === 'd1' && result.library) result.summary = `${result.proposal?.name || String(result.summary || '').replace(/ · .*$/, '')} · 日 K`;
      if (result.status === 'formula') { result.proposalId = randomUUID(); result.proposalToken = issueFormulaToken({ ...result.proposal, proposalId:result.proposalId, sourceText:typeof body.text === 'string' ? body.text : undefined }, ctx.secret()); }
      delete result.proposal?.ast;
      return json(result);
    } catch (error) { return json({ error:error.code || 'INDICATOR_AGENT_FAILED', ...(error.retryAfterSeconds ? { retryAfterSeconds:error.retryAfterSeconds } : {}) }, error.statusCode || 500); }
  }

  if (method === 'POST' && path === '/api/indicator-templates/instantiate') {
    const body = await readJson(request);
    if (!body || typeof body !== 'object' || (typeof body.shapeKey !== 'string' && !Array.isArray(body.items))) throw fail('TEMPLATE_REQUEST_INVALID', 422);
    const items = (Array.isArray(body.items) ? body.items : [{ shapeKey:body.shapeKey, values:body.values ?? {}, direction:body.direction ?? null }]).map((item) => {
      if (item && typeof item === 'object' && typeof item.proposalToken === 'string') { const payload = verifyFormulaToken(item.proposalToken, ctx.secret()); return { ast:payload.ast, name:payload.name }; }
      return item;
    });
    try {
      const result = (await ctx.library()).compose(items);
      result.proposalId = randomUUID();
      result.proposalToken = issueFormulaToken({ ...result.proposal, proposalId:result.proposalId, sourceText:typeof body.text === 'string' && body.text.trim() ? body.text : result.proposal.name }, ctx.secret());
      delete result.proposal.ast;
      return json(result);
    } catch (error) { return json({ error:error.code || 'TEMPLATE_INSTANTIATE_FAILED', ...(error.detail ? { detail:error.detail } : {}) }, error.statusCode || 500); }
  }

  // AI formula kept in the library. The daily vet ran in the browser (the Worker has no market data); an unvetted
  // formula only ever lands as pending_review, which other people do not get.
  if (method === 'POST' && path === '/api/formula/save') {
    const body = await readJson(request);
    const payload = verifyFormulaToken(body?.proposalToken, ctx.secret());
    if (!body?.vetted) throw fail('FORMULA_NOT_VETTED', 409);
    const library = await ctx.library(), existing = library.get(payload.fingerprint);
    const saved = existing && existing.status !== 'disabled' ? existing : (await library.recordActivation({ ast:payload.ast, name:payload.name, sourceText:payload.sourceText ?? null })).formula;
    if (!saved) throw fail('FORMULA_IS_COMBINATION', 422);
    return json({ fingerprint:saved.fingerprint, name:saved.name, summary:saved.summary, status:saved.status });
  }

  if (path === '/api/indicator-requests' || path.startsWith('/api/indicator-requests/')) {
    const requests = new IndicatorRequestStore(null, { backend:ctx.backend, key:'indicator-requests' }); await requests.load();
    if (method === 'GET' && path === '/api/indicator-requests') return json({ items:requests.list() });
    if (method === 'POST' && path === '/api/indicator-requests') { const result = await requests.submit(await readJson(request)); return json(result, result.duplicate ? 200 : 201); }
    const item = requests.get(decodeURIComponent(path.slice('/api/indicator-requests/'.length)));
    return json(item || { error:'INDICATOR_REQUEST_NOT_FOUND' }, item ? 200 : 404);
  }

  if (method === 'POST' && path === '/api/monitor/configure') {
    const body = await readJson(request);
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) throw fail('MONITOR_PURPOSE_INVALID', 400);
    const store = await ctx.monitor();
    const current = store.getState().settings;
    const daily = await dailyFromRequest(ctx, body);
    let strategy, conditions, taskName, formulaPayload;
    if (daily && typeof body.formulaToken !== 'string' && !(Array.isArray(body.conditions) && body.conditions.length)) ({ strategy, conditions, name:taskName } = dailyCloseStrategy(daily, current.strategy));
    else ({ strategy, conditions, name:taskName, formulaPayload } = await strategyFromRequest(ctx, body, current.strategy));
    if (dailySignature(daily) !== dailySignature(current.daily)) strategy = { ...strategy, activatedAt:new Date().toISOString() };
    if (daily && strategy.executor !== 'daily_close') taskName = `${daily.name}（日 K）→ ${taskName}`;
    // Whole market: today's system universe (the 13:00 job refreshes it to that day's universe before each check).
    const watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : await universeWatchlist(ctx.env);
    await store.update((state) => {
      const changed = strategyIdentity(state.settings.strategy) !== strategyIdentity(strategy) || state.settings.strategy?.activatedAt !== strategy.activatedAt;
      Object.assign(state.settings, { provider:'hf_dataset', daily, scopeMode:purpose === 'screen' ? 'universe' : 'watchlist', watchlist, strategy, conditions, enabled:true, monitorTask:{ name:`${taskName}監控`, onboardingCompleted:true, completedAt:new Date().toISOString() } });
      state.runtime.dailyList = null; state.runtime.dailyClose = null; state.runtime.isMonitoring = true;
      if (changed) { revokePending(state); dropEarlierSignals(state); }
      appendLog(state, 'info', '建立並啟用監控', { purpose, conditions:taskName, symbols:watchlist.length });
    });
    if (formulaPayload) await (await ctx.library()).recordActivation({ ast:formulaPayload.ast, name:formulaPayload.name, sourceText:formulaPayload.sourceText ?? null }).catch(() => {});
    return json(publicState(store.getState()));
  }

  if (method === 'POST' && (path === '/api/monitor/start' || path === '/api/monitor/stop')) {
    const store = await ctx.monitor(), start = path.endsWith('start');
    await store.update((state) => { state.settings.enabled = start; state.runtime.isMonitoring = start; if (!start) revokePending(state); appendLog(state, 'info', start ? '啟動監控' : '停止監控'); });
    return json(publicState(store.getState()));
  }
  // "Check now": the 13:00 check runs in GitHub Actions; this only reports the state.
  if (method === 'POST' && path === '/api/monitor/run') { const store = await ctx.monitor(); return json({ signals:[], skipped:true, reason:'daily_wait', state:publicState(store.getState()) }); }

  const match = path.match(/^\/api\/notifications\/([^/]+)\/(validate|ack|fail|retry)$/);
  if (method === 'POST' && match) return notifications(request, ctx, decodeURIComponent(match[1]), match[2]);

  return json({ error:'Not found' }, 404);
}

// ---- monitor helpers (same rules as src/server.js) ----
async function resolveIndexCondition(ctx, spec) {
  if (!spec || typeof spec !== 'object') throw fail('TEMPLATE_REQUEST_INVALID', 422);
  let ast;
  if (typeof spec.proposalToken === 'string') ast = verifyFormulaToken(spec.proposalToken, ctx.secret()).ast;
  else if (typeof spec.shapeKey === 'string' || typeof spec.fingerprint === 'string') ast = (await ctx.library()).compose([spec.shapeKey ? { shapeKey:spec.shapeKey, values:spec.values ?? {}, direction:spec.direction ?? null } : { fingerprint:spec.fingerprint }]).proposal.ast;
  else throw fail('HISTORY_INDEX_CONDITION_MISSING', 409);
  return { key:formulaFingerprint(ast), ast };
}
async function dailyFromRequest(ctx, body) {
  const items = Array.isArray(body?.daily?.filters) ? body.daily.filters : [];
  if (!items.length) return null;
  if (items.length > MAX_INDEX_FILTERS) throw fail('CONDITIONS_TOO_MANY', 422);
  const filters = [];
  for (const item of items) {
    const { key, ast } = await resolveIndexCondition(ctx, item?.spec);
    if (!dailyCapable(ast)) throw fail('DAILY_CONDITION_UNSUPPORTED', 422);
    filters.push({ key, ast, label:String(item.label || '').slice(0, 80) || key.slice(0, 8) });
  }
  return { filters, name:filters.map((item) => item.label).join(' 且 ') };
}
const dailySignature = (daily) => (daily?.filters || []).map((item) => item.key).sort().join('|');
function dailyCloseStrategy(daily, current) {
  const fingerprint = formulaFingerprint(daily.filters.length === 1 ? daily.filters[0].ast : { op:'all', items:daily.filters.map((item) => item.ast) });
  return { strategy:{ id:'daily.close', version:'1', executor:'daily_close', name:daily.name, timeframe:'1d', source:'db/d1', definitionFingerprint:fingerprint, params:{}, activatedAt:current?.definitionFingerprint === fingerprint && current?.executor === 'daily_close' ? current.activatedAt : new Date().toISOString() }, conditions:[], name:daily.name };
}
async function strategyFromRequest(ctx, body, current) {
  if (typeof body?.formulaToken === 'string') {
    const payload = verifyFormulaToken(body.formulaToken, ctx.secret());
    const strategy = validateFormulaStrategy({ id:'formula.custom', version:payload.capabilityRevision, executor:'formula_v1', name:payload.name, timeframe:'1m', source:'db/m1_live/{tradingDate}.parquet', definitionFingerprint:payload.fingerprint, params:{}, formula:{ ast:payload.ast } }, current?.definitionFingerprint === payload.fingerprint ? current.activatedAt : new Date().toISOString());
    return { strategy, conditions:[], name:payload.name, formulaPayload:payload };
  }
  const conditions = parseConditions(body?.conditions);
  const plan = planConditionStrategy(conditions);
  let strategy;
  if (plan.kind === 'registry') {
    const definition = await ctx.registry.resolve(plan.request.id, plan.request.version);
    const same = current?.id === plan.request.id && JSON.stringify(current.params || {}) === JSON.stringify(plan.request.params);
    strategy = validateStrategy(plan.request, definition, same ? current.activatedAt : new Date().toISOString());
  } else strategy = validateFormulaStrategy(plan.strategy, current?.definitionFingerprint === plan.strategy.definitionFingerprint ? current.activatedAt : new Date().toISOString());
  return { strategy, conditions, name:conditionsName(conditions) };
}
function dropEarlierSignals(state) {
  const since = state.settings.strategy?.activatedAt; if (!since) return;
  const removed = new Set(state.signals.filter((signal) => !(signal.triggeredAt >= since)).map((signal) => signal.id));
  if (!removed.size) return;
  state.signals = state.signals.filter((signal) => !removed.has(signal.id));
  state.notifications = state.notifications.filter((item) => !removed.has(item.signalId));
}
function revokePending(state) { for (const item of state.notifications) if (item.status === 'pending') { item.deliveryAuthorizedAt = null; item.deliveryAuthorizedRevision = null; } }

// Two browsers linked to the same LINE account become one person (src/monitors.js join, on KV).
async function joinBrowsers(ctx, visitor, earlierVisitor) {
  const mine = ctx.ownerOf(visitor), theirs = ctx.ownerOf(earlierVisitor);
  if (mine === theirs) return { owner:mine, recovered:false };
  const [a, b] = await Promise.all([ctx.monitor(mine), ctx.monitor(theirs)]);
  const configuredAt = (store) => { const task = store.getState().settings.monitorTask; return task?.onboardingCompleted ? Date.parse(task.completedAt) || 1 : 0; };
  const keep = configuredAt(a) > configuredAt(b) ? mine : theirs, drop = keep === mine ? theirs : mine;
  await ctx.shared.update((state) => {
    const owners = { ...(state.accounts?.owners || {}) };
    for (const [key, value] of Object.entries(owners)) if (value === drop) owners[key] = keep;
    owners[drop] = keep; delete owners[keep];
    state.accounts = { ...(state.accounts || {}), owners };
  });
  await ctx.env.W365.delete(`monitor:${drop}`);
  return { owner:keep, recovered:keep !== mine && configuredAt(keep === mine ? a : b) > 0 };
}

// ---- LINE ----
// Link codes live in KV (a Worker keeps no memory between requests), 10 minutes.
async function withCodes(ctx, task) {
  const stored = (await ctx.env.W365.get(CODES_KEY, 'json')) || {};
  ctx.line.codes = new Map(Object.entries(stored));
  const before = JSON.stringify(stored);
  try { return await task(); }
  finally {
    const now = Date.now(), after = Object.fromEntries([...ctx.line.codes].filter(([, entry]) => entry.expiresAt > now));
    if (JSON.stringify(after) !== before) await ctx.env.W365.put(CODES_KEY, JSON.stringify(after));
  }
}
async function lineWebhook(request, env, context) {
  const raw = new Uint8Array(await request.arrayBuffer());
  const ctx = makeContext(env, null);
  if (!ctx.line.enabled) return json({ error:'LINE_NOT_CONFIGURED' }, 503);
  if (!verifySignature(raw, request.headers.get('x-line-signature'), ctx.line.config.secret)) return json({ error:'LINE_SIGNATURE_INVALID' }, 401);
  let body; try { body = JSON.parse(new TextDecoder().decode(raw) || '{}'); } catch { return json({ error:'INVALID_JSON' }, 400); }
  context.waitUntil((async () => { await ctx.load(); await withCodes(ctx, () => ctx.line.handleWebhook(body)); })().catch((error) => console.error('line: webhook failed', error.code || error.message)));
  return json({ ok:true });
}
async function lineRoutes(request, ctx, method, path) {
  const { line, visitor } = ctx;
  if (method === 'GET' && path === '/api/line/status') return json(await line.status(visitor));
  if (!line.enabled) return json({ error:'LINE_NOT_CONFIGURED' }, 503);
  if (method === 'POST' && path === '/api/line/link-code') {
    const issued = await withCodes(ctx, async () => line.issueCode(visitor));
    const bot = await line.bot();
    const linkUrl = bot?.basicId ? `https://line.me/R/oaMessage/${encodeURIComponent(bot.basicId)}/?${encodeURIComponent(issued.code)}` : null;
    const qrSvg = await QRCode.toString(linkUrl || issued.code, { type:'svg', margin:1, width:180, errorCorrectionLevel:'M' });
    return json({ ...issued, linkUrl, qrSvg, addFriendUrl:bot?.basicId ? `https://line.me/R/ti/p/${encodeURIComponent(bot.basicId)}` : null, botName:bot?.displayName ?? null, basicId:bot?.basicId ?? null });
  }
  if (method === 'POST' && path === '/api/line/unlink') {
    const body = await readJson(request).catch(() => ({}));
    const result = await line.unlink(visitor, typeof body.id === 'string' ? body.id : null);
    return json({ ...result, status:await line.status(visitor) });
  }
  if (method === 'POST' && path === '/api/line/test') {
    try { return json(await line.sendTest(visitor)); } catch (error) { return json({ error:error.code || 'LINE_PUSH_FAILED' }, 502); }
  }
  return json({ error:'Not Found' }, 404);
}

// ---- browser notifications (dashboard) ----
async function universe(env) {
  const response = await fetch(`${env.SITE_URL || 'https://watch365.just1stock.com'}/data/universe.json`, { cf:{ cacheTtl:600 } });
  if (!response.ok) throw fail('HF_UNIVERSE_SOURCE_FAILED', 503);
  const data = await response.json();
  return { ...data.universe, sourceRevision:data.universe.sourceRevision };
}
// The site's universe.json (scripts/build-data.mjs) as a monitor watchlist: TWSE / TPEx stocks with names.
async function universeWatchlist(env) {
  const response = await fetch(`${env.SITE_URL || 'https://watch365.just1stock.com'}/data/universe.json`, { cf:{ cacheTtl:600 } });
  if (!response.ok) throw fail('HF_UNIVERSE_SOURCE_FAILED', 503);
  const data = await response.json();
  return data.universe.items.flatMap((item) => { const meta = data.master[item.symbol]; return meta && ['TWSE', 'TPEx'].includes(meta[1]) ? [{ symbol:item.symbol, name:meta[0] || item.name || item.symbol, market:meta[1] }] : []; });
}
async function notifications(request, ctx, id, action) {
  const store = await ctx.monitor();
  if (action === 'validate') {
    const current = store.getState();
    const paused = notificationEligibility(current, current.notifications.find((item) => item.id === id), { items:[] });
    if (paused.reason === 'monitor_paused') { await store.update((state) => revokePending(state)); return json(paused); }
    let result;
    try {
      const items = await universe(ctx.env);
      await store.update((state) => {
        const notification = state.notifications.find((item) => item.id === id);
        result = notificationEligibility(state, notification, items);
        if (notification && result.deliver) { notification.deliveryAuthorizedAt = new Date().toISOString(); notification.deliveryAuthorizedRevision = items.sourceRevision; }
        if (notification && !result.deliver && ['not_selected', 'not_covered', 'signal_missing', 'strategy_mismatch'].includes(result.reason)) {
          Object.assign(notification, { status:'suppressed', suppressedAt:new Date().toISOString(), suppressedReason:result.reason, deliveryAuthorizedAt:null, deliveryAuthorizedRevision:null });
          appendLog(state, 'info', '通知已停止送出', { notificationId:id, reason:result.reason });
        }
      });
      return json(result || { deliver:false, reason:'not_found' });
    } catch (error) { return json({ deliver:false, reason:'coverage_unknown', error:error.code || 'HF_UNIVERSE_SOURCE_FAILED' }, 503); }
  }
  if (action === 'ack') {
    let result = { acknowledged:false, reason:'not_found' };
    await store.update((state) => {
      const notification = state.notifications.find((item) => item.id === id), signal = state.signals.find((item) => item.id === notification?.signalId);
      const authorizedAt = new Date(notification?.deliveryAuthorizedAt || 0).getTime(), authorizationValid = Number.isFinite(authorizedAt) && Date.now() - authorizedAt <= 30_000, strategyValid = signalMatchesCurrentStrategy(state, signal);
      if (notification?.status === 'pending' && state.settings.enabled && authorizationValid && strategyValid) { Object.assign(notification, { status:'sent', sentAt:new Date().toISOString(), deliveryAuthorizedAt:null }); appendLog(state, 'info', '瀏覽器通知已送出', { notificationId:id }); result = { acknowledged:true, reason:null }; }
      else if (notification) result = { acknowledged:false, reason:notification.status !== 'pending' ? 'not_pending' : !state.settings.enabled ? 'monitor_paused' : !strategyValid ? 'strategy_mismatch' : 'authorization_required' };
    });
    return json(result);
  }
  if (action === 'fail') {
    const body = await readJson(request).catch(() => ({}));
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 80) : 'browser_delivery_failed';
    let result = { failed:false, reason:'not_found' };
    await store.update((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      if (notification?.status === 'pending') { Object.assign(notification, { status:'failed', failedAt:new Date().toISOString(), failedReason:reason, deliveryAuthorizedAt:null, deliveryAuthorizedRevision:null }); appendLog(state, 'warn', '瀏覽器通知送出失敗', { notificationId:id, reason }); result = { failed:true, reason:null }; }
      else if (notification) result = { failed:false, reason:'not_pending' };
    });
    return json(result);
  }
  let result = { retried:false, reason:'not_found' };
  await store.update((state) => {
    const notification = state.notifications.find((item) => item.id === id);
    if (notification?.status === 'failed') { Object.assign(notification, { status:'pending', retryCount:(notification.retryCount || 0) + 1, deliveryAuthorizedAt:null, deliveryAuthorizedRevision:null }); appendLog(state, 'info', '通知重送排入待送', { notificationId:id }); result = { retried:true, reason:null }; }
    else if (notification) result = { retried:false, reason:'retry_not_allowed' };
  });
  return json(result);
}

// ---- admin (GitHub Actions 13:00 job): raw documents, Bearer ADMIN_TOKEN ----
async function admin(request, env, url) {
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 24 || token !== env.ADMIN_TOKEN) return json({ error:'UNAUTHORIZED' }, 401);
  if (request.method === 'GET' && url.pathname === '/admin/monitors') {
    const owners = []; let cursor;
    do { const page = await env.W365.list({ prefix:'monitor:', cursor }); owners.push(...page.keys.map((key) => key.name.slice('monitor:'.length))); cursor = page.list_complete ? null : page.cursor; } while (cursor);
    return json({ owners });
  }
  const key = decodeURIComponent(url.pathname.slice('/admin/doc/'.length));
  if (!url.pathname.startsWith('/admin/doc/') || !key) return json({ error:'Not found' }, 404);
  if (request.method === 'GET') return json({ key, value:await env.W365.get(key, 'json') });
  if (request.method === 'PUT') { await env.W365.put(key, JSON.stringify((await readJson(request)).value)); return json({ ok:true }); }
  return json({ error:'Not found' }, 404);
}
