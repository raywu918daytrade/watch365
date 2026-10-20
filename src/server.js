import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMarketBars } from './marketData.js';
import { readHfAssetVersion, readHfSystemUniverse, readHfTickerMaster } from './hfAdapter.js';
import { parseWatchlist, providerFailureDecision, RULE_NAME } from './rules.js';
import { appendLog, JsonStore, publicState } from './storage.js';
import { resolveWatchlistInput } from './watchlist.js';
import { calculateUniverseCoverage } from './universeCoverage.js';
import { applyMonitorScope, buildMonitorScope, filterBarsToMonitorScope, markMonitorScopeUnknown, notificationEligibility, signalMatchesCurrentStrategy } from './monitorScope.js';
import { applyDailyClose, applyScopedMarketBars, STATE_SIGNAL_MAX_AGE_MS } from './signalEngine.js';
import { dailyCapable } from './dailyIndex.js';
import { IndicatorRegistry, strategyIdentity, validateFormulaStrategy, validateStrategy } from './indicatorRegistry.js';
import { indicatorAgentStatus, validateAgentProposal } from './indicatorAgent.js';
import { loadProjectEnv } from './env.js';
import { createConditionStateBackend, createRuleStateBackend, createDocumentBackend, createEventBackend, createFormulaLibraryBackend, createUnknownIndicatorBackend, dbConfigFromEnv } from './db.js';
import { ConditionStateStore, rulesFromSettings } from './conditionState.js';
import { HistoryIndexClient } from './historyIndexClient.js';
import { RuleStateStore, taipeiDate } from './ruleState.js';
import { HISTORY_DAYS, historyVerdict, listHfM1Dates, listHfM1Months } from './history.js';
import { EventStore } from './events.js';
import { classifyUserAgent, visitorCookie, visitorFromRequest } from './visitor.js';
import { UnknownIndicatorStore, lookupIndicator } from './indicatorLookup.js';
import { createAdminApi } from './adminApi.js';
import { fork } from 'node:child_process';
import { IndicatorRequestStore } from './indicatorRequests.js';
import { formulaFingerprint, issueFormulaToken, verifyFormulaToken } from './formulaEngine.js';
import { FormulaLibrary, resolveMonitorCondition } from './formulaLibrary.js';
import { conditionsName, parseConditions, planConditionStrategy } from './monitorConditions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadProjectEnv(join(ROOT, '.env'));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = process.env.WATCH365_DATA_FILE || join(ROOT, 'data', 'watch365.json');
const INDICATOR_REQUESTS_FILE = process.env.WATCH365_INDICATOR_REQUESTS_FILE || join(ROOT, 'data', 'indicator-requests.json');
const FORMULA_LIBRARY_FILE = process.env.WATCH365_FORMULA_LIBRARY_FILE || join(ROOT, 'data', 'formula-library.json');
const EVENTS_FILE = process.env.WATCH365_EVENTS_FILE || join(ROOT, 'data', 'events.jsonl');
const UNKNOWN_INDICATORS_FILE = process.env.WATCH365_UNKNOWN_INDICATORS_FILE || join(ROOT, 'data', 'unknown-indicators.json');
const CONDITION_STATE_FILE = process.env.WATCH365_CONDITION_STATE_FILE || join(ROOT, 'data', 'condition-state.json');
const RULE_STATE_FILE = process.env.WATCH365_RULE_STATE_FILE || join(ROOT, 'data', 'rule-state.json');
// Monitoring state machine: layer 1 shared condition state (src/conditionState.js) and layer 2 per-rule
// state idle/triggered/cooldown (src/ruleState.js). CONDITION_LAYER=off disables both (and forces NOTIFY_ENGINE=legacy).
const CONDITION_LAYER_ENABLED = process.env.CONDITION_LAYER !== 'off';
// Which engine creates indicator signals/notifications: 'state' (default) = the state machine above (one
// notification when a rule becomes met, cooldown + re-arm); 'legacy' = the old per-bar engine (instant rollback).
const NOTIFY_ENGINE = CONDITION_LAYER_ENABLED && process.env.NOTIFY_ENGINE !== 'legacy' ? 'state' : 'legacy';
// PM decision: the indicator reality check (indicatorLookup.js) runs before the AI formula stage unless disabled.
const INDICATOR_LOOKUP_ENABLED = process.env.INDICATOR_LOOKUP !== 'off';
const PORT = Number(process.env.PORT || 3650);
const indicatorRegistry = new IndicatorRegistry();
const formulaTokenSecret=randomBytes(32).toString('base64url');
// Deploy-time version: Railway starts a fresh process for every deployment, so boot time ≈ deploy time.
const BOOTED_AT = new Date();
const APP_VERSION = formatVersion(BOOTED_AT);
const APP_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null;

const documentBackend = await createDocumentBackend(dbConfigFromEnv());
console.log(documentBackend ? `Storage: database ${documentBackend.label}` : `Storage: local files under ${join(ROOT, 'data')}`);
const store = new JsonStore(DATA_FILE, { backend: documentBackend, key: 'state' });
const indicatorRequests = new IndicatorRequestStore(INDICATOR_REQUESTS_FILE, { backend: documentBackend, key: 'indicator-requests' });
// Formula library: DB tables when DB_HOST is set, otherwise data/formula-library.json. Seeded from FORMULA_RECIPES on boot.
const formulaLibrary = new FormulaLibrary(FORMULA_LIBRARY_FILE, { backend: await createFormulaLibraryBackend(dbConfigFromEnv()) });
// Event log (admin dashboard) and blocked-indicator list: DB tables when DB_HOST is set, otherwise data/ files.
const events = new EventStore(EVENTS_FILE, { backend: await createEventBackend(dbConfigFromEnv()) });
const unknownIndicators = new UnknownIndicatorStore(UNKNOWN_INDICATORS_FILE, { backend: await createUnknownIndicatorBackend(dbConfigFromEnv()) });
const conditionStates = new ConditionStateStore(CONDITION_STATE_FILE, { backend: CONDITION_LAYER_ENABLED ? await createConditionStateBackend(dbConfigFromEnv()) : null });
const ruleStates = new RuleStateStore(RULE_STATE_FILE, { backend: CONDITION_LAYER_ENABLED ? await createRuleStateBackend(dbConfigFromEnv()) : null });
const adminApi = createAdminApi({ events, store, formulaLibrary, unknownIndicators, conditionStates: CONDITION_LAYER_ENABLED ? conditionStates : null, ruleStates: CONDITION_LAYER_ENABLED ? ruleStates : null, notifyEngine: NOTIFY_ENGINE, legacySignalsToday: () => { const state = store.getState(); if (NOTIFY_ENGINE === 'state') return state.runtime.legacyShadow?.day === taipeiDate() ? state.runtime.legacyShadow.count : 0; return state.signals.filter((signal) => signal.tradingDate === taipeiDate()).length; }, secret: formulaTokenSecret });
// 7-day condition index in a long-lived worker (src/historyIndexWorker.js). HISTORY_INDEX=off disables it.
const HISTORY_INDEX_ENABLED = process.env.HISTORY_INDEX !== 'off';
const MAX_INDEX_FILTERS = 3;
// Fingerprints that passed the 7-day vet in this process (POST /api/formula/save requires it).
const vettedFormulas = new Set();
const historyIndex = new HistoryIndexClient({ getSymbols: async () => (await getUniverseWatchlist()).map((item) => item.symbol), heapMb: Number(process.env.HISTORY_INDEX_HEAP_MB || 640) });
let monitorTimer = null;
let isRunning = false;
let universeCache = null;
// History lookups read up to HISTORY_DAYS daily files each, so they run one at a time and results are cached briefly.
const historyCache = new Map();
let historyQueue = Promise.resolve();
const HISTORY_CACHE_MS = 10 * 60 * 1000;
const historyJobs = new Map();
const HISTORY_JOB_TTL_MS = 30 * 60 * 1000;
// One job per (strategy, watchlist) key; a second request for the same key joins the running job.
function startHistoryJob(key, strategy, watchlist) {
  const running = historyJobs.get(key);
  if (running && running.status !== 'failed') return running;
  const job = { id: randomUUID(), key, status: 'queued', progress: { stage: 'queued', message: '排隊中' }, startedAt: Date.now(), finishedAt: null, result: null, error: null };
  historyJobs.set(key, job); historyJobs.set(job.id, job);
  job.promise = historyQueue.then(async () => {
    job.status = 'running';
    const result = await runHistoryInWorker(strategy, watchlist, (progress) => { job.progress = progress; });
    historyCache.set(key, { at: Date.now(), result });
    if (historyCache.size > 20) historyCache.delete(historyCache.keys().next().value);
    job.result = result; job.status = 'done';
    console.log(`history: ${watchlist.length} symbols, ${result.availableDays} days, ${result.totalEvents} events in ${result.elapsedMs} ms`);
  }).catch((error) => {
    job.error = error; job.status = 'failed';
    console.error('history: job failed', error.code || error.message);
  }).finally(() => {
    job.finishedAt = Date.now();
    setTimeout(() => { if (historyJobs.get(job.id) === job) { historyJobs.delete(job.id); if (historyJobs.get(key) === job) historyJobs.delete(key); } }, HISTORY_JOB_TTL_MS).unref?.();
  });
  historyQueue = job.promise.catch(() => {});
  return job;
}
// Child heap cap: the container has ~1 GB and the monitor itself needs a share of it.
// (worker_threads resourceLimits proved unreliable on Node 22; a forked process with a V8 flag is not.)
const HISTORY_WORKER_HEAP_MB = Number(process.env.HISTORY_WORKER_HEAP_MB || 640);
const HISTORY_WORKER_TIMEOUT_MS = Number(process.env.HISTORY_WORKER_TIMEOUT_MS || 10 * 60 * 1000);
function runHistoryInWorker(strategy, watchlist, onProgress) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./historyWorker.js', import.meta.url)), [JSON.stringify({ strategy, watchlist })], { execArgv: [`--max-old-space-size=${HISTORY_WORKER_HEAP_MB}`], stdio: ['ignore', 'inherit', 'pipe', 'ipc'] });
    let settled = false, stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail('HISTORY_TIMEOUT', 'history worker timed out', 504); }, HISTORY_WORKER_TIMEOUT_MS);
    const fail = (code, message, statusCode = 503) => { if (settled) return; settled = true; clearTimeout(timer); reject(Object.assign(new Error(message), { code, statusCode })); };
    child.on('message', (message) => {
      if (message.type === 'progress') onProgress(message.progress);
      else if (message.type === 'done') { settled = true; clearTimeout(timer); resolve(message.result); }
      else if (message.type === 'error') fail(message.code || 'HISTORY_FAILED', message.message, message.statusCode || 500);
    });
    child.on('error', (error) => fail('HISTORY_FAILED', error.message));
    child.on('exit', (code, signal) => {
      if (settled) return;
      const oom = /heap out of memory/i.test(stderr) || signal === 'SIGABRT';
      if (!oom) console.error('history worker exited', code, signal, stderr.slice(-500));
      fail(oom ? 'HISTORY_OUT_OF_MEMORY' : 'HISTORY_FAILED', `history worker exited (${signal || code})`);
    });
  });
}
// Every done result carries a verdict (no_data / no_triggers / too_many / ok) so the backtest UI and the vet
// flow share one shape.
function withVerdict(result) { return { ...result, verdict: historyVerdict(result) }; }
function historyJobView(job) {
  if (job.status === 'done') return { status: 'done', jobId: job.id, cached: false, ...withVerdict(job.result) };
  if (job.status === 'failed') return { status: 'failed', jobId: job.id, error: job.error?.code || 'HISTORY_FAILED' };
  return { status: job.status, jobId: job.id, progress: job.progress, elapsedMs: Date.now() - job.startedAt };
}

await Promise.all([store.load(),indicatorRequests.load(),formulaLibrary.load(),events.load(),unknownIndicators.load(),CONDITION_LAYER_ENABLED?conditionStates.load():null,CONDITION_LAYER_ENABLED?ruleStates.load():null]);
{ const before = store.getState().signals.length; await store.update((state) => { dropEarlierSignals(state); }); const dropped = before - store.getState().signals.length; if (dropped) console.log(`Dropped ${dropped} trigger records of earlier monitor conditions`); }
console.log(`Formula library: ${formulaLibrary.list().length} formulas, ${formulaLibrary.aliases.size} aliases`);
console.log(`Admin API: ${adminApi.enabled ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}; indicator lookup: ${INDICATOR_LOOKUP_ENABLED ? 'on' : 'off'}; notify engine: ${NOTIFY_ENGINE}`);
syncMonitorTimer();
// Start the index worker in the background and precompute every indicator-list row once.
if (HISTORY_INDEX_ENABLED) historyIndex.start().then(() => historyIndex.ensure(libraryConditions())).then((result) => console.log(`history-index: ${result?.loading ? 'loading 7-day data' : `ready, ${result?.conditions} conditions`}`)).catch((error) => console.error('history-index: start failed', error.code || error.message));

const server = createServer(async (request, response) => {
  try {
    // Anonymous visitor id: read from the w365v cookie, issued on the first API call (and on the page itself).
    const { visitor, isNew } = visitorFromRequest(request);
    request.visitor = visitor;
    const pathname = request.url.split('?')[0];
    if (isNew && (pathname.startsWith('/api/') || pathname === '/' || pathname === '/index.html')) response.setHeader('Set-Cookie', visitorCookie(visitor, { secure: request.headers['x-forwarded-proto'] === 'https' }));
    if (request.url.startsWith('/api/')) {
      if (await adminApi.handle(request, response, new URL(request.url, `http://${request.headers.host}`))) return;
      await routeApi(request, response);
      return;
    }
    if ((request.method || 'GET') === 'GET' && (pathname === '/' || pathname === '/index.html')) events.record('page_view', { ua: classifyUserAgent(request.headers['user-agent']) }, { visitor });
    await serveStatic(request, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: error.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`Watch365 MVP running at http://localhost:${PORT}`);
});

async function routeApi(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const method = request.method || 'GET';

  const visitor = request.visitor ?? null;
  if (method === 'GET' && url.pathname === '/api/me') {
    const range = await events.visitorRange(visitor);
    sendJson(response, 200, { visitor, firstSeen: range?.firstSeen ?? null });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/version') {
    sendJson(response, 200, { version: APP_VERSION, deployedAt: BOOTED_AT.toISOString(), commit: APP_COMMIT });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/history/availability') {
    try {
      const [live, months] = await Promise.all([listHfM1Dates(), listHfM1Months()]);
      sendJson(response, 200, { historyDays:HISTORY_DAYS, liveDays:live.map((file) => ({ date:file.date, size:file.size })), months:months.slice(-4).map((file) => ({ month:file.month, size:file.size })), totalMonths:months.length });
    } catch (error) {
      sendJson(response, error.statusCode || 503, { error:error.code || 'HISTORY_SOURCE_FAILED' });
    }
    return;
  }

  // POST with the same body as /api/monitor/configure; GET ?spec=<json> is accepted for quick checks.
  // History lookups can take minutes on a cold cache (two months of M1 parquet). The request returns
  // right away with a job id and the client polls /api/history/jobs/:id, so no gateway timeout can cut it.
  if (method === 'GET' && url.pathname.startsWith('/api/history/jobs/')) {
    const job = historyJobs.get(decodeURIComponent(url.pathname.slice('/api/history/jobs/'.length)));
    if (!job) { sendJson(response, 404, { error:'HISTORY_JOB_NOT_FOUND' }); return; }
    sendJson(response, 200, historyJobView(job));
    return;
  }
  // 7-day condition index (src/historyIndex.js): every filter is precomputed once; this only combines stored results.
  // body { purpose, watchlist?, filters:[spec], candidates?:[spec], events? }, spec = { shapeKey, values, direction } |
  // { fingerprint } | { proposalToken } (an AI filter not in the library yet) | { conditionKey } (already computed).
  // → 200 { status:'ready', steps:[{ triggeredSymbols, totalEvents, days, events? }], candidates:[{ index,
  // triggeredSymbols, totalEvents } | { index, error }], filterKeys, verdict, … } or 202 { status:'loading', progress }.
  // The running monitor's condition replayed over the 7-day index (owner decision 2026-10: the monitor page shows what
  // this condition would have triggered over the past 7 trading days, next to today's records).
  if (method === 'GET' && url.pathname === '/api/monitor/history') {
    const settings = store.getState().settings;
    const ast = settings.strategy?.formula?.ast, dailyOnly = settings.strategy?.executor === 'daily_close';
    if (!ast && !dailyOnly) { sendJson(response, 200, { status:'unsupported' }); return; }
    if (!HISTORY_INDEX_ENABLED) { sendJson(response, 503, { error:'HISTORY_INDEX_DISABLED' }); return; }
    try {
      const watchlist = settings.scopeMode === 'universe' ? null : settings.watchlist || [];
      const dailyFilters = (settings.daily?.filters || []).map(({ key, ast: filterAst }) => ({ key, ast:filterAst }));
      const result = await historyIndex.query({ filters:dailyOnly ? [] : [{ key:formulaFingerprint(ast), ast }], candidates:[], symbols:watchlist ? watchlist.map((item) => item.symbol) : null, events:true, daily:dailyFilters.length ? { filters:dailyFilters, events:dailyOnly } : null });
      if (result.loading || result.daily?.loading) { sendJson(response, 202, { status:'loading', progress:result.progress || '準備歷史資料' }); return; }
      const names = new Map((watchlist || await getUniverseWatchlist().catch(() => [])).map((item) => [item.symbol, item.name]));
      if (dailyOnly) {
        // D1 only: what the after-close notification would have sent on each of the last trading days (13:30 close).
        const step = result.daily.steps.at(-1), events = step.events || [];
        sendJson(response, 200, { status:'ready', timeframe:'1d', availableDays:result.daily.dates.length - 1, triggeredSymbols:new Set(events.map((event) => event.symbol)).size, totalEvents:events.length, days:step.days.slice(1).map((day) => ({ date:day.date, count:day.newCount })), truncated:false, events:events.map((event) => ({ date:event.date, at:`${event.date}T05:30:00.000Z`, symbol:event.symbol, price:event.price, name:names.get(event.symbol) || '' })) });
        return;
      }
      const last = result.steps.at(-1) || { triggeredSymbols:0, totalEvents:0, days:[], events:[] };
      sendJson(response, 200, { status:'ready', availableDays:result.availableDays, triggeredSymbols:last.triggeredSymbols, totalEvents:last.totalEvents, days:last.days, truncated:Boolean(last.truncated), events:(last.events || []).map((event) => ({ ...event, name:names.get(event.symbol) || '' })) });
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'HISTORY_INDEX_FAILED' });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/history/index') {
    let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) { sendJson(response, 400, { error:'MONITOR_PURPOSE_INVALID' }); return; }
    const filters = Array.isArray(body.filters) ? body.filters : [], candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 200) : [];
    if (filters.length > MAX_INDEX_FILTERS) { sendJson(response, 422, { error:'CONDITIONS_TOO_MANY' }); return; }
    try {
      const resolvedFilters = filters.map((spec) => resolveIndexCondition(spec));
      const resolvedCandidates = candidates.map((spec) => { try { return resolveIndexCondition(spec); } catch (error) { return { error:error.code || 'TEMPLATE_REQUEST_INVALID' }; } });
      const usable = resolvedCandidates.filter((item) => !item.error);
      const watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : null;
      if (!HISTORY_INDEX_ENABLED) { sendJson(response, 503, { error:'HISTORY_INDEX_DISABLED' }); return; }
      // Daily step (D1 filters): body.daily = { filters:[spec], candidates:[spec], list }.
      const dailyBody = body.daily && typeof body.daily === 'object' ? body.daily : null;
      const dailyFilters = Array.isArray(dailyBody?.filters) ? dailyBody.filters.slice(0, MAX_INDEX_FILTERS).map((spec) => resolveIndexCondition(spec)) : [];
      const dailyCandidates = Array.isArray(dailyBody?.candidates) ? dailyBody.candidates.slice(0, 200).map((spec) => { try { return resolveIndexCondition(spec); } catch (error) { return { error:error.code || 'TEMPLATE_REQUEST_INVALID' }; } }) : [];
      const dailyUsable = dailyCandidates.filter((item) => !item.error);
      const result = await historyIndex.query({ filters:resolvedFilters, candidates:usable, symbols:watchlist ? watchlist.map((item) => item.symbol) : null, events:body.events !== false, daily:dailyBody ? { filters:dailyFilters, candidates:dailyUsable, list:Boolean(dailyBody.list) } : null });
      if (result.loading) { sendJson(response, 202, { status:'loading', progress:result.progress || (result.status === 'failed' ? '資料讀取失敗，重新嘗試中' : '準備 7 日資料'), error:result.error ?? null }); return; }
      const names = new Map((watchlist || await getUniverseWatchlist().catch(() => [])).map((item) => [item.symbol, item.name]));
      const symbolsCount = watchlist ? watchlist.length : names.size;
      const byKey = new Map(result.candidates.map((item) => [item.key, item]));
      const last = result.steps.at(-1);
      if (last?.events) last.events = last.events.map((event) => ({ ...event, name:names.get(event.symbol) || event.symbol }));
      sendJson(response, 200, {
        status:'ready', availableDays:result.availableDays, dates:result.dates, symbolsCount, refreshedAt:result.refreshedAt ?? result.loadedAt ?? null,
        filterKeys:resolvedFilters.map((item) => item.key),
        steps:result.steps,
        candidates:resolvedCandidates.map((item, index) => item.error ? { index, error:item.error } : { index, triggeredSymbols:byKey.get(item.key)?.triggeredSymbols ?? 0, totalEvents:byKey.get(item.key)?.totalEvents ?? 0 }),
        verdict:last ? historyVerdict({ totalEvents:last.totalEvents, symbolsCount, availableDays:result.availableDays }) : null,
        daily:result.daily ? (result.daily.loading ? { status:'loading' } : { status:'ready', dates:result.daily.dates, latestDate:result.daily.latestDate, filterKeys:dailyFilters.map((item) => item.key), steps:result.daily.steps, candidates:dailyCandidates.map((item, index) => { if (item.error) return { index, error:item.error }; const found = result.daily.candidates.find((entry) => entry.key === item.key); return { index, latestCount:found?.latestCount ?? 0, forward:found?.forward ?? null }; }) }) : null
      });
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'HISTORY_INDEX_FAILED' });
    }
    return;
  }

  // One candlestick example of what a stock looks like when ALL the given filters hold (any stock, not named).
  // body { filters:[spec] } (same specs as /api/history/index) → 200 { status:'ready', example:{ timeframe:'d1'|'m1',
  // candles, price:[line], panels:[{ lines, thresholds }], markers } | null } or 202 { status:'loading' }.
  if (method === 'POST' && url.pathname === '/api/history/example') {
    let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    const filters = Array.isArray(body?.filters) ? body.filters : [];
    if (!filters.length) { sendJson(response, 422, { error:'CONDITIONS_REQUIRED' }); return; }
    if (filters.length > MAX_INDEX_FILTERS) { sendJson(response, 422, { error:'CONDITIONS_TOO_MANY' }); return; }
    if (!HISTORY_INDEX_ENABLED) { sendJson(response, 503, { error:'HISTORY_INDEX_DISABLED' }); return; }
    try {
      const result = await historyIndex.example(filters.map((spec) => resolveIndexCondition(spec)), { timeframe:body.timeframe === 'd1' ? 'd1' : null });
      if (result.loading) { sendJson(response, 202, { status:'loading', progress:result.progress || '準備資料' }); return; }
      sendJson(response, 200, { status:'ready', example:result.example ?? null });
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'HISTORY_EXAMPLE_FAILED' });
    }
    return;
  }

  if ((method === 'POST' || method === 'GET') && url.pathname === '/api/history/backtest') {
    let body;
    try { body = method === 'POST' ? await readJson(request) : url.searchParams.has('c') ? await compactHistorySpec(url.searchParams) : JSON.parse(url.searchParams.get('spec') || 'null'); }
    catch (error) { sendJson(response, 400, { error:error.code || 'INVALID_JSON' }); return; }
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) { sendJson(response, 400, { error:'MONITOR_PURPOSE_INVALID' }); return; }
    try {
      const { strategy } = await strategyFromRequest(body, null);
      const watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : await getUniverseWatchlist();
      const key = `${strategyIdentity(strategy)}|${watchlist.map((item) => item.symbol).sort().join(',')}`;
      const cached = historyCache.get(key);
      if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) { sendJson(response, 200, { ...withVerdict(cached.result), cached:true, status:'done' }); return; }
      const job = startHistoryJob(key, strategy, watchlist);
      recordHistoryOutcome(job, 'backtest', { strategy, watchlist, visitor });
      // ?wait=1 keeps the old synchronous behaviour for scripts; the UI polls instead.
      if (url.searchParams.get('wait') === '1') { await job.promise.catch(() => {}); sendJson(response, job.error ? (job.error.statusCode || 500) : 200, job.error ? { error:job.error.code || 'HISTORY_FAILED' } : { ...withVerdict(job.result), cached:false, status:'done' }); return; }
      sendJson(response, 202, historyJobView(job));
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'HISTORY_FAILED' });
    }
    return;
  }

  // Vet (PM decision 1: a condition that triggers 0 times or far too often in the 7-day replay is blocked before it
  // is applied). Same job machinery as the backtest; the done result's `verdict` says ok / no_triggers / too_many /
  // no_data. The client applies only when verdict.ok.
  // Owner decision (2026-10): an AI-built indicator is kept as soon as it is built and has passed the 7-day vet, not
  // only when a monitor is created — otherwise losing the draft loses the indicator. body { proposalToken } →
  // 200 { fingerprint, name, summary, status } (pending_review until promoted); 409 FORMULA_NOT_VETTED when this
  // formula has not passed /api/formula/vet in this process. Saving twice is harmless (hitCount +1, same row).
  if (method === 'POST' && url.pathname === '/api/formula/save') {
    let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    try {
      const payload = verifyFormulaToken(body?.proposalToken, formulaTokenSecret);
      if (!vettedFormulas.has(payload.fingerprint) && !formulaLibrary.get(payload.fingerprint)) {
        // Not vetted in this process (e.g. vetted before a restart): check it now on the 7-day index, same verdict rule.
        const verdict = HISTORY_INDEX_ENABLED ? await indexVerdict(payload) : null;
        if (!verdict?.ok) { sendJson(response, 409, { error:'FORMULA_NOT_VETTED', verdict:verdict ?? null }); return; }
        vettedFormulas.add(payload.fingerprint);
      }
      const existing = formulaLibrary.get(payload.fingerprint);
      const saved = existing && existing.status !== 'disabled' ? existing : (await formulaLibrary.recordActivation({ ast:payload.ast, name:payload.name, sourceText:payload.sourceText ?? null })).formula;
      if (HISTORY_INDEX_ENABLED) historyIndex.ensure([{ key:payload.fingerprint, ast:payload.ast }]).catch(() => {});
      if (!saved) { sendJson(response, 422, { error:'FORMULA_IS_COMBINATION' }); return; }
      events.record('formula_saved', { fingerprint:saved.fingerprint, name:saved.name, text:payload.sourceText?.slice(0, 200) ?? null, existing:Boolean(existing) }, { visitor });
      sendJson(response, 200, { fingerprint:saved.fingerprint, name:saved.name, summary:saved.summary, status:saved.status });
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'FORMULA_SAVE_FAILED' });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/formula/vet') {
    let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) { sendJson(response, 400, { error:'MONITOR_PURPOSE_INVALID' }); return; }
    if (typeof body?.proposalToken !== 'string') { sendJson(response, 422, { error:'FORMULA_TOKEN_INVALID' }); return; }
    try {
      const { strategy, formulaPayload } = await strategyFromRequest({ formulaToken: body.proposalToken }, null);
      const watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : await getUniverseWatchlist();
      const key = `${strategyIdentity(strategy)}|${watchlist.map((item) => item.symbol).sort().join(',')}`;
      const cached = historyCache.get(key);
      if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) { const view = { ...withVerdict(cached.result), cached:true, status:'done', vet:true }; if (!view.verdict.ok) recordVetBlocked(view.verdict, { strategy, formulaPayload, watchlist, visitor }); else vettedFormulas.add(formulaPayload.fingerprint); sendJson(response, 200, view); return; }
      const job = startHistoryJob(key, strategy, watchlist);
      recordHistoryOutcome(job, 'vet', { strategy, formulaPayload, watchlist, visitor });
      sendJson(response, job.status === 'done' ? 200 : 202, { ...historyJobView(job), vet:true });
    } catch (error) {
      if (!error.statusCode) console.error(error);
      sendJson(response, error.statusCode || 500, { error:error.code || 'HISTORY_FAILED' });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/state') {
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/indicators') {
    try { sendJson(response, 200, await indicatorRegistry.load()); }
    catch (error) { sendJson(response, error.statusCode || 503, { error:error.code || 'INDICATOR_REGISTRY_UNAVAILABLE' }); }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/indicator-agent/status') {
    sendJson(response, 200, indicatorAgentStatus());
    return;
  }

  if (method === 'POST' && url.pathname === '/api/indicator-agent/parse') {
    const body=await readJson(request);
    const startedAt=Date.now();const text=typeof body?.text==='string'?body.text.slice(0,200):'';
    try {
      const registry=await indicatorRegistry.load();
      // Library first (exact alias match, active formulas only), then the indicator reality check (indicatorLookup.js),
      // then the AI planner. All paths return the same shape.
      const result=await resolveMonitorCondition(body.text,registry.items,{library:formulaLibrary,context:body.context,lookupImpl:INDICATOR_LOOKUP_ENABLED?lookupIndicator:null});
      if(result.status==='formula'){result.proposalId=randomUUID();result.proposalToken=issueFormulaToken({...result.proposal,proposalId:result.proposalId,sourceText:typeof body.text==='string'?body.text:undefined},formulaTokenSecret);}
      if(result.status==='unknown_indicator'){events.record('unknown_indicator',{text,candidates:result.lookup?.candidates??[],indicatorName:result.lookup?.indicatorName??null},{visitor});unknownIndicators.record({text:body.text,candidates:result.lookup?.candidates??[]});}
      delete result.proposal?.ast;
      events.record('parse',{text,status:result.status,provider:result.provider?.provider??null,model:result.provider?.model??null,library:Boolean(result.library),fingerprint:result.proposal?.fingerprint??null,ms:Date.now()-startedAt},{visitor});
      sendJson(response,200,result);
    } catch(error) {
      events.record('parse',{text,status:'error',code:error.code||'INDICATOR_AGENT_FAILED',provider:null,model:null,library:false,ms:Date.now()-startedAt},{visitor});
      sendJson(response,error.statusCode||500,{error:error.code||'INDICATOR_AGENT_FAILED',...(error.retryAfterSeconds?{retryAfterSeconds:error.retryAfterSeconds}:{})});
    }
    return;
  }

  if(method==='POST'&&url.pathname==='/api/formula/activate'){
    let body;try{body=await readJson(request);}catch{sendJson(response,400,{error:'INVALID_JSON'});return;}
    try{
      if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).sort().join(',')!=='proposalToken,watchlist'||typeof body.proposalToken!=='string'||!Array.isArray(body.watchlist))throw Object.assign(new Error('FORMULA_ACTIVATION_INVALID'),{code:'FORMULA_ACTIVATION_INVALID',statusCode:422});
      const payload=verifyFormulaToken(body.proposalToken,formulaTokenSecret);const current=store.getState().settings.strategy;
      const strategy=validateFormulaStrategy({id:'formula.custom',version:payload.capabilityRevision,executor:'formula_v1',name:payload.name,timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:payload.fingerprint,params:{},formula:{ast:payload.ast}},current?.definitionFingerprint===payload.fingerprint?current.activatedAt:new Date().toISOString());
      const watchlist=parseWatchlist(body.watchlist,{allowEmpty:true});
      await store.update((state)=>{const changed=strategyIdentity(state.settings.strategy)!==strategyIdentity(strategy);state.settings.watchlist=watchlist;state.settings.strategy=strategy;state.settings.daily=null;state.settings.formulaActivationId=payload.proposalId;state.settings.enabled=true;state.settings.provider='hf_dataset';state.settings.monitorTask={name:`${strategy.name}監控`,onboardingCompleted:true,completedAt:new Date().toISOString()};if(changed){revokePendingDeliveryAuthorizations(state);dropEarlierSignals(state);}appendLog(state,'info','套用並啟用公式監控',{formulaFingerprint:strategy.definitionFingerprint,symbols:watchlist.map((item)=>item.symbol)});});
      syncMonitorTimer();await recordFormulaActivation(payload);sendJson(response,200,publicState(store.getState()));
    }catch(error){sendJson(response,error.statusCode||400,{error:error.code||'FORMULA_ACTIVATION_FAILED'});}return;
  }

  if (method === 'POST' && url.pathname === '/api/indicator-agent/confirm') {
    const body=await readJson(request);
    try {
      const registry=await indicatorRegistry.load();
      sendJson(response,200,{proposal:validateAgentProposal(body.proposal,registry.items)});
    } catch(error) {
      sendJson(response,error.statusCode||422,{error:error.code||'INDICATOR_AGENT_PROPOSAL_INVALID'});
    }
    return;
  }

  // Formulas people apply, without the AST (for a "commonly used formulas" list). ?status=active|pending_review|disabled
  if (method === 'GET' && url.pathname === '/api/formula-library') {
    const status = url.searchParams.get('status');
    if (status && !['active','pending_review','disabled'].includes(status)) { sendJson(response, 400, { error:'FORMULA_LIBRARY_STATUS_INVALID' }); return; }
    sendJson(response, 200, { items: formulaLibrary.list({ status }).map(({ fingerprint, name, summary, source, status, hitCount, aliases }) => ({ fingerprint, name, summary, source, status, hitCount, aliases })) });
    return;
  }

  // Indicator templates: library formulas grouped into "indicator + adjustable parameters" (no AST).
  if (method === 'GET' && url.pathname === '/api/indicator-templates') {
    sendJson(response, 200, { items: formulaLibrary.templates({ includePending: url.searchParams.get('includePending') !== 'false' }) });
    return;
  }

  // Pick an indicator, set parameters (and direction), get a signed proposal in the same shape as
  // /api/indicator-agent/parse so the existing activate / history flows apply unchanged.
  if (method === 'POST' && url.pathname === '/api/indicator-templates/instantiate') {
    let body; try { body = await readJson(request); } catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    try {
      if (!body || typeof body !== 'object' || Array.isArray(body) || (typeof body.shapeKey !== 'string' && !Array.isArray(body.items))) throw Object.assign(new Error('TEMPLATE_REQUEST_INVALID'), { code:'TEMPLATE_REQUEST_INVALID', statusCode:422 });
      // Single template ({ shapeKey, values, direction }) or 1–3 filters ({ items:[{ shapeKey|fingerprint, values, direction }] }) joined with `all`.
      // An item may be a signed proposalToken from /api/indicator-agent/parse: verify it and compose its AST.
      const items = (Array.isArray(body.items) ? body.items : [{ shapeKey: body.shapeKey, values: body.values ?? {}, direction: body.direction ?? null }]).map((item) => {
        if (item && typeof item === 'object' && typeof item.proposalToken === 'string') { const payload = verifyFormulaToken(item.proposalToken, formulaTokenSecret); return { ast: payload.ast, name: payload.name }; }
        return item;
      });
      const result = formulaLibrary.compose(items);
      result.proposalId = randomUUID();
      result.proposalToken = issueFormulaToken({ ...result.proposal, proposalId: result.proposalId, sourceText: typeof body.text === 'string' && body.text.trim() ? body.text : result.proposal.name }, formulaTokenSecret);
      const labels = result.items ? result.items.map((item) => item.formulaSummary) : [result.formulaSummary];
      events.record('template_instantiate', { items: items.map((item, index) => ({ shapeKey: item.shapeKey ?? null, fingerprint: item.fingerprint ?? null, label: labels[index] ?? null })), labels, label: result.proposal.name, shapeKey: result.shapeKey ?? items[0]?.shapeKey ?? null, fingerprint: result.proposal.fingerprint, count: items.length }, { visitor });
      delete result.proposal.ast;
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, error.statusCode || 500, { error: error.code || 'TEMPLATE_INSTANTIATE_FAILED', ...(error.detail ? { detail: error.detail } : {}) });
    }
    return;
  }

  if (method === 'GET' && url.pathname === '/api/indicator-requests') {
    sendJson(response,200,{items:indicatorRequests.list()});
    return;
  }

  if (method === 'POST' && url.pathname === '/api/indicator-requests') {
    let body;
    try { body=await readJson(request); }
    catch { sendJson(response,400,{error:'INVALID_JSON'}); return; }
    try { const result=await indicatorRequests.submit(body); events.record('indicator_request',{id:result.request.id,indicatorName:result.request.indicatorName,timeframe:result.request.timeframe,duplicate:result.duplicate},{visitor}); sendJson(response,result.duplicate?200:201,result); }
    catch(error){sendJson(response,error.statusCode||500,{error:error.code||'INDICATOR_REQUEST_SAVE_FAILED'});}
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/indicator-requests/')) {
    const id=decodeURIComponent(url.pathname.slice('/api/indicator-requests/'.length)); const item=indicatorRequests.get(id);
    sendJson(response,item?200:404,item||{error:'INDICATOR_REQUEST_NOT_FOUND'});
    return;
  }

  if (method === 'GET' && url.pathname === '/api/system-universe') {
    try {
      const requestedRevision = String(url.searchParams.get('revision') || '');
      const universe = requestedRevision && universeCache?.revision === requestedRevision ? universeCache.data : await getLatestSystemUniverse();
      const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-Hant');
      const group = String(url.searchParams.get('group') || '').trim();
      // A whole sector is returned in one page (largest is ~110 stocks) so it can be selected at once.
      const pageSize = Math.trunc(clampNumber(url.searchParams.get('pageSize'), 10, group ? 1000 : 100, 50));
      const filtered = universe.items.filter((item) => (!group || item.group === group) && (!query || item.symbol.includes(query) || String(item.name || '').toLocaleLowerCase('zh-Hant').includes(query)));
      const groupCounts = new Map();
      for (const item of universe.items) if (item.group) groupCounts.set(item.group, (groupCounts.get(item.group) || 0) + 1);
      const groups = [...groupCounts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.trunc(clampNumber(url.searchParams.get('page'), 1, pages, 1));
      const start = (page - 1) * pageSize;
      sendJson(response, 200, { ...universe, items: filtered.slice(start, start + pageSize), filteredTotal: filtered.length, page, pageSize, pages, groups });
    } catch (error) {
      const code = error.code || 'HF_UNIVERSE_SOURCE_FAILED';
      const status = code === 'HF_UNIVERSE_NOT_FOUND' ? 'missing' : 'error';
      sendJson(response, 503, { status, error: code });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/system-universe/coverage') {
    const body = await readJson(request);
    let watchlist;
    try {
      watchlist = parseWatchlist(body.watchlist, { allowEmpty: true });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.code || 'WATCHLIST_INVALID' });
      return;
    }
    try {
      const universe = await getLatestSystemUniverse();
      sendJson(response, 200, { status:'available', updatedDate:universe.updatedDate, universeTotal:universe.total, ...calculateUniverseCoverage(watchlist, universe.items) });
    } catch (error) {
      sendJson(response, 503, { status:'unknown', updatedDate:null, universeTotal:null, counts:{ selected:watchlist.length, covered:null, uncovered:null }, items:watchlist.map((item)=>({...item,coverage:'unknown'})), error:error.code||'HF_UNIVERSE_SOURCE_FAILED' });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/watchlist/resolve') {
    const body = await readJson(request);
    try {
      const master = await readHfTickerMaster();
      sendJson(response, 200, { metadataStatus: 'available', ...resolveWatchlistInput(body.input, master.metadata) });
    } catch (error) {
      const result = resolveWatchlistInput(body.input, null);
      sendJson(response, 200, { metadataStatus: 'unavailable', metadataErrorCode: error.code || 'HF_METADATA_UNAVAILABLE', ...result });
    }
    return;
  }

  if (method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(request);
    let watchlist;
    try {
      watchlist = parseWatchlist(body.watchlist, { allowEmpty: true });
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error: error.code || 'WATCHLIST_INVALID' });
      return;
    }
    let strategy;
    try {
      const requested = body.strategy || store.getState().settings.strategy;
      const definition = await indicatorRegistry.resolve(requested.id, requested.version);
      const current = store.getState().settings.strategy;
      const sameIdentity = current?.id === requested.id && current?.version === requested.version && JSON.stringify(current.params || {}) === JSON.stringify(requested.params || {});
      strategy = validateStrategy(requested, definition, sameIdentity ? current.activatedAt : new Date().toISOString());
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error:error.code || 'INDICATOR_STRATEGY_INVALID' });
      return;
    }
    await store.update((state) => {
      const strategyChanged = strategyIdentity(state.settings.strategy) !== strategyIdentity(strategy);
      state.settings.trialUser.name = String(body.trialUserName || '內部試用者').trim();
      state.settings.provider = 'hf_dataset';
      state.settings.enabled = Boolean(body.enabled);
      if (!state.settings.enabled) revokePendingDeliveryAuthorizations(state);
      state.settings.pollIntervalSeconds = clampNumber(body.pollIntervalSeconds, 15, 3600, 60);
      state.settings.watchlist = watchlist;
      state.settings.strategy = strategy;
      if (strategyChanged) revokePendingDeliveryAuthorizations(state);
      state.settings.rule.volumeBaselineBars = 20;
      state.settings.rule.volumeMultiplier = 2;
      state.settings.rule.cooldownMinutes = 30;
      state.settings.notification.target = '本機瀏覽器';
      if (body.monitorTask && typeof body.monitorTask === 'object') {
        state.settings.monitorTask.name = `${strategy.name}監控`;
        state.settings.monitorTask.onboardingCompleted = Boolean(body.monitorTask.onboardingCompleted);
        state.settings.monitorTask.completedAt = body.monitorTask.onboardingCompleted
          ? body.monitorTask.completedAt || new Date().toISOString()
          : null;
      }
      appendLog(state, 'info', '管理者更新試用設定', {
        symbols: state.settings.watchlist.map((item) => item.symbol)
      });
    });
    syncMonitorTimer();
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/configure') {
    let body;
    try { body = await readJson(request); }
    catch { sendJson(response, 400, { error:'INVALID_JSON' }); return; }
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) { sendJson(response, 400, { error:'MONITOR_PURPOSE_INVALID' }); return; }
    let conditions, strategy, watchlist, taskName, formulaPayload, daily;
    try {
      daily = dailyFromRequest(body);
      const current = store.getState().settings;
      // D1 only (no intraday condition): notified once after the close (owner decision 2026-10).
      if (daily && typeof body.formulaToken !== 'string' && !(Array.isArray(body.conditions) && body.conditions.length)) ({ strategy, conditions, name: taskName } = dailyCloseStrategy(daily, current.strategy));
      else ({ strategy, conditions, name: taskName, formulaPayload } = await strategyFromRequest(body, current.strategy));
      // A different daily filter is a different monitor even when the intraday part is the same.
      if (dailySignature(daily) !== dailySignature(current.daily)) strategy = { ...strategy, activatedAt:new Date().toISOString() };
      if (daily && strategy.executor !== 'daily_close') taskName = `${daily.name}（日 K）→ ${taskName}`;
      watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : await getUniverseWatchlist();
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error:error.code || 'MONITOR_CONFIGURE_FAILED' });
      return;
    }
    await store.update((state) => {
      const changed = strategyIdentity(state.settings.strategy) !== strategyIdentity(strategy) || state.settings.strategy?.activatedAt !== strategy.activatedAt;
      state.settings.provider = 'hf_dataset';
      state.settings.daily = daily;
      state.runtime.dailyList = null; state.runtime.dailyClose = null;
      state.settings.scopeMode = purpose === 'screen' ? 'universe' : 'watchlist';
      state.settings.watchlist = watchlist;
      state.settings.strategy = strategy;
      state.settings.conditions = conditions;
      state.settings.enabled = true;
      state.settings.monitorTask = { name:`${taskName}監控`, onboardingCompleted:true, completedAt:new Date().toISOString() };
      if (changed) { revokePendingDeliveryAuthorizations(state); dropEarlierSignals(state); }
      appendLog(state, 'info', '建立並啟用監控', { purpose, conditions:taskName, symbols:watchlist.length });
    });
    syncMonitorTimer();
    if (formulaPayload) await recordFormulaActivation(formulaPayload);
    events.record('monitor_configure', { purpose, symbols: watchlist.length, strategyName: strategy.name, fingerprint: strategy.definitionFingerprint ?? null, label: strategy.name, formula: Boolean(formulaPayload) }, { visitor });
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/start') {
    await store.update((state) => {
      state.settings.enabled = true;
      appendLog(state, 'info', '啟動監控');
    });
    syncMonitorTimer();
    events.record('monitor_start', { strategyName: store.getState().settings.strategy?.name ?? null }, { visitor });
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/stop') {
    await store.update((state) => {
      state.settings.enabled = false;
      state.runtime.isMonitoring = false;
      revokePendingDeliveryAuthorizations(state);
      appendLog(state, 'info', '停止監控');
    });
    syncMonitorTimer();
    events.record('monitor_stop', { strategyName: store.getState().settings.strategy?.name ?? null }, { visitor });
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/run') {
    const result = await runMonitor('manual-run');
    events.record('monitor_run', { skipped: Boolean(result.skipped), reason: result.reason ?? null, signals: result.signals?.length ?? 0, error: result.error ?? null }, { visitor });
    sendJson(response, 200, result);
    return;
  }

  const validateMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/validate$/);
  if (method === 'POST' && validateMatch) {
    const id = decodeURIComponent(validateMatch[1]);
    const currentState = store.getState();
    const currentNotification = currentState.notifications.find((item) => item.id === id);
    const pausedResult = notificationEligibility(currentState, currentNotification, { items:[] });
    if (pausedResult.reason === 'monitor_paused') {
      await store.update((state) => revokePendingDeliveryAuthorizations(state));
      sendJson(response, 200, pausedResult);
      return;
    }
    if (pausedResult.reason === 'strategy_mismatch') {
      await store.update((state) => {
        const notification = state.notifications.find((item) => item.id === id);
        if (!notification || notification.status !== 'pending') return;
        notification.status = 'suppressed'; notification.suppressedAt = new Date().toISOString(); notification.suppressedReason = 'strategy_mismatch';
        notification.deliveryAuthorizedAt = null; notification.deliveryAuthorizedRevision = null;
        appendLog(state, 'info', '通知已停止送出', { notificationId:id, reason:'strategy_mismatch' });
      });
      sendJson(response, 200, pausedResult);
      return;
    }
    try {
      const universe = await getLatestSystemUniverse();
      let result;
      await store.update((state) => {
        const notification = state.notifications.find((item) => item.id === id);
        result = notificationEligibility(state, notification, universe);
        if (notification && result.deliver) {
          notification.deliveryAuthorizedAt = new Date().toISOString();
          notification.deliveryAuthorizedRevision = universe.sourceRevision;
        }
        if (notification && !result.deliver && ['not_selected','not_covered','signal_missing','strategy_mismatch'].includes(result.reason)) {
          notification.status = 'suppressed'; notification.suppressedAt = new Date().toISOString(); notification.suppressedReason = result.reason;
          notification.deliveryAuthorizedAt = null; notification.deliveryAuthorizedRevision = null;
          appendLog(state, 'info', '通知已停止送出', { notificationId:id, reason:result.reason });
        }
      });
      sendJson(response, 200, result || { deliver:false, reason:'not_found' });
    } catch (error) {
      sendJson(response, 503, { deliver:false, reason:'coverage_unknown', error:error.code||'HF_UNIVERSE_SOURCE_FAILED' });
    }
    return;
  }

  const ackMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/ack$/);
  if (method === 'POST' && ackMatch) {
    const id = decodeURIComponent(ackMatch[1]);
    let result = { acknowledged:false, reason:'not_found' };
    await store.update((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      const signal = state.signals.find((item) => item.id === notification?.signalId);
      const authorizedAt = new Date(notification?.deliveryAuthorizedAt || 0).getTime();
      const authorizationValid = Number.isFinite(authorizedAt) && Date.now() - authorizedAt <= 30_000;
      const strategyValid = signalMatchesCurrentStrategy(state, signal);
      if (notification?.status === 'pending' && state.settings.enabled && authorizationValid && strategyValid) {
        notification.status = 'sent';
        notification.sentAt = new Date().toISOString();
        notification.deliveryAuthorizedAt = null;
        appendLog(state, 'info', '瀏覽器通知已送出', { notificationId: id });
        result = { acknowledged:true, reason:null };
      } else if (notification) {
        result = { acknowledged:false, reason:notification.status !== 'pending' ? 'not_pending' : !state.settings.enabled ? 'monitor_paused' : !strategyValid ? 'strategy_mismatch' : 'authorization_required' };
      }
    });
    sendJson(response, 200, result);
    return;
  }

  // The browser reports a delivery it could not complete (permission revoked, Notification() threw),
  // so the dashboard can offer a retry instead of the notification silently staying pending.
  const failMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/fail$/);
  if (method === 'POST' && failMatch) {
    const id = decodeURIComponent(failMatch[1]);
    let body = {};
    try { body = await readJson(request); } catch {}
    const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 80) : 'browser_delivery_failed';
    let result = { failed:false, reason:'not_found' };
    await store.update((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      if (notification?.status === 'pending') {
        notification.status = 'failed';
        notification.failedAt = new Date().toISOString();
        notification.failedReason = reason;
        notification.deliveryAuthorizedAt = null; notification.deliveryAuthorizedRevision = null;
        appendLog(state, 'warn', '瀏覽器通知送出失敗', { notificationId: id, reason });
        result = { failed:true, reason:null };
      } else if (notification) {
        result = { failed:false, reason:'not_pending' };
      }
    });
    sendJson(response, 200, result);
    return;
  }

  const retryMatch = url.pathname.match(/^\/api\/notifications\/([^/]+)\/retry$/);
  if (method === 'POST' && retryMatch) {
    const id = decodeURIComponent(retryMatch[1]);
    let result = { retried:false, reason:'not_found' };
    await store.update((state) => {
      const notification = state.notifications.find((item) => item.id === id);
      if (notification?.status === 'failed') {
        notification.status = 'pending';
        notification.retryCount = (notification.retryCount || 0) + 1;
        notification.deliveryAuthorizedAt = null; notification.deliveryAuthorizedRevision = null;
        appendLog(state, 'info', '通知重送排入待送', { notificationId: id });
        result = { retried:true, reason:null };
      } else if (notification) {
        result = { retried:false, reason:'retry_not_allowed' };
      }
    });
    sendJson(response, 200, result);
    return;
  }

  sendJson(response, 404, { error: 'Not found' });
}

// Short GET form for quick checks: ?symbols=2330,2317&c=sma.above.20,ema.below.60 (or ?scope=screen&c=rsi.above.14.30)
async function compactHistorySpec(params) {
  const conditions = String(params.get('c')).split(',').map((item) => {
    const [indicator, direction, period, threshold] = item.split('.');
    return { indicator, direction, period:Number(period), threshold:threshold === undefined ? null : Number(threshold) };
  });
  if (params.get('scope') === 'screen') return { purpose:'screen', conditions };
  const symbols = String(params.get('symbols') || '').split(',').filter(Boolean);
  const master = await readHfTickerMaster();
  const watchlist = symbols.map((symbol) => { const item = master.metadata.get(symbol); if (!item) throw Object.assign(new Error('WATCHLIST_MARKET_REQUIRED'), { code:'WATCHLIST_MARKET_REQUIRED' }); return { symbol, name:item.name, market:item.market }; });
  return { purpose:'watchlist', watchlist, conditions };
}

// Builds the strategy for a monitor or a history lookup from either the structured UI conditions
// or an AI-planned formula (signed proposal token from /api/indicator-agent/parse).
// Daily filters of a monitor (D1 step): body.daily = { filters:[{ spec, label }] } from the indicator list.
function dailyFromRequest(body) {
  const items = Array.isArray(body?.daily?.filters) ? body.daily.filters : [];
  if (!items.length) return null;
  if (items.length > MAX_INDEX_FILTERS) throw Object.assign(new Error('CONDITIONS_TOO_MANY'), { code:'CONDITIONS_TOO_MANY', statusCode:422 });
  const filters = items.map((item) => {
    const { key, ast } = resolveIndexCondition(item?.spec);
    if (!dailyCapable(ast)) throw Object.assign(new Error('DAILY_CONDITION_UNSUPPORTED'), { code:'DAILY_CONDITION_UNSUPPORTED', statusCode:422 });
    return { key, ast, label:String(item.label || '').slice(0, 80) || key.slice(0, 8) };
  });
  return { filters, name:filters.map((item) => item.label).join(' 且 ') };
}
function dailySignature(daily) { return (daily?.filters || []).map((item) => item.key).sort().join('|'); }
function dailyCloseStrategy(daily, current) {
  const fingerprint = formulaFingerprint(daily.filters.length === 1 ? daily.filters[0].ast : { op:'all', items:daily.filters.map((item) => item.ast) });
  return { strategy:{ id:'daily.close', version:'1', executor:'daily_close', name:daily.name, timeframe:'1d', source:'db/d1', definitionFingerprint:fingerprint, params:{}, activatedAt:current?.definitionFingerprint === fingerprint && current?.executor === 'daily_close' ? current.activatedAt : new Date().toISOString() }, conditions:[], name:daily.name };
}
// Today's daily list, cached per day in runtime (the previous close does not change during the day).
async function dailyListToday(settings) {
  const today = taipeiDate();
  const cached = store.getState().runtime.dailyList;
  if (cached?.day === today && cached.signature === dailySignature(settings.daily)) return cached;
  if (!HISTORY_INDEX_ENABLED) return null;
  const result = await historyIndex.dailyList({ conditions:settings.daily.filters.map(({ key, ast }) => ({ key, ast })), date:today, symbols:settings.watchlist.map((item) => item.symbol) }).catch(() => null);
  if (!result || result.loading || !result.listDate) return null;
  const list = { day:today, signature:dailySignature(settings.daily), listDate:result.listDate, symbols:result.symbols, count:result.symbols.length };
  await store.update((state) => { state.runtime.dailyList = list; appendLog(state, 'info', `日 K 名單 ${list.count} 檔（${list.listDate} 收盤）`); });
  return list;
}
// D1-only monitors: once per trading day at 13:00 Taipei, before the close so users can still order the same day. Today's
// daily bar is built from the minute bars so far (the 13:00 price stands in for the close; volume covers 09:00-13:00 only)
// and the stocks that newly meet the daily filters are notified.
const DAILY_CLOSE_AT_MINUTES = 13 * 60;
async function runDailyClose(source) {
  const now = new Date(), settings = store.getState().settings, today = taipeiDate(now);
  const taipei = new Date(now.getTime() + 8 * 3_600_000), minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes(), weekday = taipei.getUTCDay();
  const done = store.getState().runtime.dailyClose?.day === today;
  if (done || weekday === 0 || weekday === 6 || minutes < DAILY_CLOSE_AT_MINUTES || !HISTORY_INDEX_ENABLED) {
    await store.update((state) => { state.runtime.lastRunAt = now.toISOString(); state.runtime.lastProviderStatus = done ? 'daily_done' : 'daily_wait'; state.runtime.lastError = null; });
    return { signals:[], skipped:true, reason:done ? 'daily_done' : 'daily_wait', state:publicState(store.getState()) };
  }
  await historyIndex.refresh({ force:true }).catch(() => {});   // queued before the check in the worker
  const result = await historyIndex.dailyClose({ conditions:settings.daily.filters.map(({ key, ast }) => ({ key, ast })), date:today, symbols:settings.watchlist.map((item) => item.symbol) }).catch((error) => ({ error:error.code || 'HISTORY_INDEX_FAILED' }));
  if (result.loading || result.error) {
    await store.update((state) => { state.runtime.lastRunAt = now.toISOString(); state.runtime.lastProviderStatus = 'daily_wait'; state.runtime.lastError = result.error ?? null; });
    return { signals:[], skipped:true, reason:'daily_pending', state:publicState(store.getState()) };
  }
  let applied;
  await store.update((state) => {
    state.runtime.lastRunAt = now.toISOString(); state.runtime.lastError = null;
    if (result.noSession) { state.runtime.lastProviderStatus = 'daily_no_session'; state.runtime.dailyClose = { day:today, noSession:true, count:0 }; applied = { signals:[] }; return; }
    applied = applyDailyClose(state, result, state.settings.strategy, now);
    state.runtime.lastProviderStatus = 'ok';
    state.runtime.dailyClose = { day:today, count:applied.signals.length, met:result.met.length };
    appendLog(state, 'info', `13:00 日 K 判斷：新符合 ${applied.signals.length} 檔（共符合 ${result.met.length} 檔）`, { source });
  });
  return { signals:applied.signals, skipped:false, reason:null, state:publicState(store.getState()) };
}

async function strategyFromRequest(body, current) {
  if (typeof body?.formulaToken === 'string') {
    const payload = verifyFormulaToken(body.formulaToken, formulaTokenSecret);
    const strategy = validateFormulaStrategy({ id:'formula.custom', version:payload.capabilityRevision, executor:'formula_v1', name:payload.name, timeframe:'1m', source:'db/m1_live/{tradingDate}.parquet', definitionFingerprint:payload.fingerprint, params:{}, formula:{ ast:payload.ast } }, current?.definitionFingerprint === payload.fingerprint ? current.activatedAt : new Date().toISOString());
    return { strategy, conditions:[], name:payload.name, formulaPayload:payload };
  }
  const conditions = parseConditions(body?.conditions);
  const plan = planConditionStrategy(conditions);
  let strategy;
  if (plan.kind === 'registry') {
    const definition = await indicatorRegistry.resolve(plan.request.id, plan.request.version);
    const sameIdentity = current?.id === plan.request.id && JSON.stringify(current.params || {}) === JSON.stringify(plan.request.params);
    strategy = validateStrategy(plan.request, definition, sameIdentity ? current.activatedAt : new Date().toISOString());
  } else {
    strategy = validateFormulaStrategy(plan.strategy, current?.definitionFingerprint === plan.strategy.definitionFingerprint ? current.activatedAt : new Date().toISOString());
  }
  return { strategy, conditions, name:conditionsName(conditions) };
}

// Records the outcome of a history job as a `backtest` event, and a `vet_blocked` event when a vet verdict is not ok.
// Attached once per request (a joined job records once per requester, which is what the dashboard wants).
function recordHistoryOutcome(job, kind, { strategy, formulaPayload = null, watchlist, visitor }) {
  const startedAt = Date.now();
  const base = { kind, fingerprint: strategy.definitionFingerprint ?? strategyIdentity(strategy), strategyName: strategy.name, symbols: watchlist.length };
  job.promise.then(() => {
    const result = job.result; if (!result) return;
    const verdict = historyVerdict(result);
    events.record('backtest', { ...base, days: result.availableDays, totalEvents: result.totalEvents, perSymbolPerDay: verdict.perSymbolPerDay, verdict: verdict.code, ms: result.elapsedMs ?? Date.now() - startedAt, status: 'done' }, { visitor });
    if (kind === 'vet' && !verdict.ok) recordVetBlocked(verdict, { strategy, formulaPayload, watchlist, visitor });
    if (kind === 'vet' && verdict.ok && formulaPayload?.fingerprint) vettedFormulas.add(formulaPayload.fingerprint);
  }).catch(() => {});
  job.promise.catch((error) => { events.record('backtest', { ...base, days: 0, totalEvents: 0, ms: Date.now() - startedAt, status: 'failed', error: error?.code || 'HISTORY_FAILED' }, { visitor }); });
}
function recordVetBlocked(verdict, { strategy, formulaPayload = null, watchlist, visitor }) {
  events.record('vet_blocked', { name: strategy.name, text: formulaPayload?.sourceText?.slice(0, 200) ?? null, fingerprint: strategy.definitionFingerprint ?? null, code: verdict.code, totalEvents: verdict.totalEvents, symbolsCount: verdict.symbolsCount ?? watchlist.length, availableDays: verdict.availableDays, perSymbolPerDay: verdict.perSymbolPerDay }, { visitor });
}

// A formula the user applied goes into the library (AI formulas start as pending_review). Never fails the request.
async function recordFormulaActivation(payload) {
  try { await formulaLibrary.recordActivation({ ast:payload.ast, name:payload.name, sourceText:payload.sourceText ?? null }); }
  catch (error) { console.error('formula-library: record activation failed', error.code || error.message); }
}

async function runMonitor(source = 'scheduler') {
  if (isRunning) {
    return { skipped: true, reason: 'monitor already running', state: publicState(store.getState()) };
  }

  isRunning = true;
  let scope;
  try {
    const settings = store.getState().settings;
    if (settings.strategy?.executor === 'daily_close') return await runDailyClose(source);
    if(settings.strategy.executor==='formula_v1')validateFormulaStrategy(settings.strategy,settings.strategy.activatedAt);
    else {const activeDefinition=await indicatorRegistry.resolve(settings.strategy.id,settings.strategy.version);if(settings.strategy.definitionFingerprint&&settings.strategy.definitionFingerprint!==activeDefinition.fingerprint)throw Object.assign(new Error('INDICATOR_VERSION_MUTATED'),{code:'INDICATOR_VERSION_MUTATED'});}
    let universe;
    try {
      universe = await getLatestSystemUniverse();
    } catch (error) {
      const errorCode=error.code||'HF_UNIVERSE_SOURCE_FAILED';
      await store.update((state)=>{state.runtime.lastRunAt=new Date().toISOString();state.runtime.lastProviderStatus='coverage_unknown';state.runtime.lastError=errorCode;markMonitorScopeUnknown(state,errorCode);state.decisions.unshift(providerFailureDecision(errorCode));appendLog(state,'error','系統監控範圍無法確認，本輪停止',{source,errorCode});});
      return { skipped:true, reason:'coverage_unknown', error:errorCode, state:publicState(store.getState()) };
    }
    if (settings.scopeMode === 'universe') {
      const watchlist = await getUniverseWatchlist(universe);
      await store.update((state) => { state.settings.watchlist = watchlist; });
      settings.watchlist = watchlist;
    }
    scope = buildMonitorScope(settings.watchlist, universe);
    if (settings.daily?.filters?.length) {
      // D1 + M1: only today's daily list (met on the previous daily close) is watched intraday.
      const list = await dailyListToday(settings);
      if (!list) {
        await store.update((state)=>{state.runtime.lastRunAt=new Date().toISOString();state.runtime.lastProviderStatus='daily_list_pending';state.runtime.lastError=null;appendLog(state,'info','日 K 名單準備中，本輪不判斷',{source});});
        return { signals:[], skipped:true, reason:'daily_list_pending', state:publicState(store.getState()) };
      }
      const allowed = new Set(list.symbols);
      const effectiveWatchlist = scope.effectiveWatchlist.filter((item) => allowed.has(item.symbol));
      scope = { ...scope, effectiveWatchlist, effectiveCount:effectiveWatchlist.length };
      if (!scope.effectiveWatchlist.length) {
        await store.update((state)=>{state.runtime.lastRunAt=new Date().toISOString();state.runtime.lastProviderStatus='daily_list_empty';state.runtime.lastError=null;});
        return { signals:[], skipped:true, reason:'daily_list_empty', state:publicState(store.getState()) };
      }
    }
    await store.update((state)=>{applyMonitorScope(state,scope);appendLog(state,'info','本輪系統監控範圍已確認',{source,revision:scope.revision,selected:scope.selectedCount,effective:scope.effectiveCount,uncovered:scope.uncoveredCount});});
    if (!scope.effectiveCount) {
      await store.update((state)=>{state.runtime.lastRunAt=new Date().toISOString();state.runtime.lastProviderStatus='empty_scope';state.runtime.lastError=null;appendLog(state,'info','本輪無系統名單涵蓋股票，未執行行情判定',{source});});
      return { signals:[], skipped:true, reason:'empty_scope', state:publicState(store.getState()) };
    }
    const bars = filterBarsToMonitorScope(await fetchMarketBars({ ...settings, watchlist:scope.effectiveWatchlist }), scope);
    const ruleTriggers = await runConditionLayer(settings, bars);
    return await applyBars(bars, source, scope, NOTIFY_ENGINE === 'state' ? ruleTriggers : null);
  } catch (error) {
    await store.update((state) => {
      state.runtime.lastRunAt = new Date().toISOString();
      state.runtime.lastProviderStatus = 'error';
      const errorCode = error.code || 'PROVIDER_ERROR';
      state.runtime.lastError = errorCode;
      state.decisions.unshift(providerFailureDecision(errorCode));
      appendLog(state, 'error', '行情更新或規則判斷失敗', { source, errorCode });
    });
    return { error: error.message, state: publicState(store.getState()) };
  } finally {
    isRunning = false;
  }
}

// Runs the state machine on the same bars and returns this run's rule triggers (null when off or failed, in which
// case applyBars creates no indicator signals this run rather than falling back to a different engine mid-day).
async function runConditionLayer(settings, bars) {
  if (!CONDITION_LAYER_ENABLED) return null;
  try {
    const rules = rulesFromSettings(settings);
    conditionStates.syncRules(rules);
    ruleStates.syncRules(rules);
    const now = new Date();
    ruleStates.beginRun();
    const result = conditionStates.evaluate(bars, now, { onSymbol: (ctx) => ruleStates.onSymbol(ctx, conditionStates, now) });
    const ruleRun = ruleStates.endRun(now);
    await Promise.all([conditionStates.flush(), ruleStates.flush()]);
    if (result.flips.length || result.errors.length || ruleRun.triggers.length) console.log(`condition-layer: ${result.flips.length} flips, ${result.errors.length} errors over ${result.symbols} symbols × ${result.conditions} conditions; rules: ${ruleRun.triggers.length} shadow triggers, ${ruleRun.suppressed} suppressed, ${ruleRun.walked} walked / ${ruleRun.skipped} skipped (${conditionStates.lastRun.ms} ms)`);
    return ruleRun.triggers;
  } catch (error) {
    console.error('condition-layer: run failed', error.code || error.message);
    return [];
  }
}

async function applyBars(bars, source, scope, ruleTriggers = null) {
  const now = new Date();
  let result;

  await store.update((state) => {
    result = applyScopedMarketBars(state,bars,scope,source,now,{ruleTriggers});
    if(result.late?.length)appendLog(state,'info',`${result.late.length} 筆觸發發現時已超過 ${STATE_SIGNAL_MAX_AGE_MS/60000} 分鐘，只記錄不通知`,{source,symbols:result.late.map((item)=>item.symbol).slice(0,20)});
    for (const decision of result.decisions) appendLog(state,decision.triggered?'signal':'info',`${decision.symbol||'-'} ${decision.reasonCode}`,{source,ruleVersion:decision.ruleVersion});
    for (const signal of result.signals) appendLog(state,'signal',`${signal.symbol} 建立觸發事件並排入通知`,{rule:signal.ruleName||RULE_NAME,price:signal.price,volume:signal.volume});
    if(result.skipped)appendLog(state,'info','本輪結果未提交：監控已暫停或設定已變更',{source,reason:result.reason});
  });

  return {
    signals: result.signals,
    skipped: result.skipped,
    reason: result.reason,
    state: publicState(store.getState())
  };
}

function syncMonitorTimer() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }

  const state = store.getState();
  state.runtime.isMonitoring = Boolean(state.settings.enabled);

  if (!state.settings.enabled) {
    store.save().catch(console.error);
    return;
  }

  const intervalMs = clampNumber(state.settings.pollIntervalSeconds, 15, 3600, 60) * 1000;
  monitorTimer = setInterval(() => {
    runMonitor('scheduler').catch(console.error);
  }, intervalMs);
  store.save().catch(console.error);
}

async function getLatestSystemUniverse() {
  const assetPath = 'db/tickers/tick_universe.parquet';
  const version = await readHfAssetVersion(assetPath);
  if (universeCache?.revision === version.revision) return universeCache.data;
  const data = await readHfSystemUniverse({ version });
  universeCache = { revision:version.revision, data };
  return data;
}

// 條件選股 uses the latest HF system universe every run; markets come from the ticker master.
async function getUniverseWatchlist(universe) {
  const [items, master] = await Promise.all([universe ? universe.items : getLatestSystemUniverse().then((data) => data.items), readHfTickerMaster()]);
  return items.flatMap((item) => {
    const metadata = master.metadata.get(item.symbol);
    if (!metadata || !['TWSE', 'TPEx'].includes(metadata.market) || metadata.supported === false) return [];
    return [{ symbol:item.symbol, name:metadata.name || item.name || item.symbol, market:metadata.market }];
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const file = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': contentType(filePath) });
    response.end(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendText(response, 404, 'Not found');
      return;
    }
    throw error;
  }
}

function contentType(filePath) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml'
  }[extname(filePath)] || 'application/octet-stream';
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function sendText(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(text);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

// Owner decision (2026-10): trigger records of an earlier monitor condition mean nothing once it is replaced, so they are
// deleted (with their notifications) rather than kept: a record belongs to the current monitor when it triggered after
// the current strategy was activated.
function dropEarlierSignals(state) {
  const since = state.settings.strategy?.activatedAt; if (!since) return;
  const removed = new Set(state.signals.filter((signal) => !(signal.triggeredAt >= since)).map((signal) => signal.id));
  if (!removed.size) return;
  state.signals = state.signals.filter((signal) => !removed.has(signal.id));
  state.notifications = state.notifications.filter((item) => !removed.has(item.signalId));
}
function revokePendingDeliveryAuthorizations(state) {
  for (const notification of state.notifications) {
    if (notification.status !== 'pending') continue;
    notification.deliveryAuthorizedAt = null;
    notification.deliveryAuthorizedRevision = null;
  }
}

function formatVersion(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `v${parts.year}.${parts.month}.${parts.day}-${parts.hour}${parts.minute}`;
}

// A filter spec → { key, ast } for the history index. Library templates and formulas resolve through the library,
// an AI filter through its signed token, and a key the index already computed is used as is.
function resolveIndexCondition(spec) {
  if (!spec || typeof spec !== 'object') throw Object.assign(new Error('TEMPLATE_REQUEST_INVALID'), { code:'TEMPLATE_REQUEST_INVALID', statusCode:422 });
  if (typeof spec.conditionKey === 'string') { const known = historyIndex.known(spec.conditionKey); if (known) return known; }
  let ast;
  if (typeof spec.proposalToken === 'string') ast = verifyFormulaToken(spec.proposalToken, formulaTokenSecret).ast;
  else if (typeof spec.shapeKey === 'string' || typeof spec.fingerprint === 'string') ast = formulaLibrary.compose([spec.shapeKey ? { shapeKey:spec.shapeKey, values:spec.values ?? {}, direction:spec.direction ?? null } : { fingerprint:spec.fingerprint }]).proposal.ast;
  else throw Object.assign(new Error('HISTORY_INDEX_CONDITION_MISSING'), { code:'HISTORY_INDEX_CONDITION_MISSING', statusCode:409 });
  return { key:formulaFingerprint(ast), ast };
}

// Every row of the indicator list (each preset of each template, and AI-built members) as index conditions.
function libraryConditions() {
  const out = [];
  for (const template of formulaLibrary.templates({ includePending:true })) {
    if (template.source !== 'ai') for (const preset of template.presets || []) { try { out.push(resolveIndexCondition({ shapeKey:template.shapeKey, values:preset.values || {}, direction:preset.direction ?? null })); } catch {} }
    for (const member of template.members || []) if (member.source === 'ai') { try { out.push(resolveIndexCondition({ fingerprint:member.fingerprint })); } catch {} }
  }
  return out;
}

// Vet verdict of one formula over the whole universe from the 7-day index (null while the index is loading).
async function indexVerdict(payload) {
  const result = await historyIndex.query({ filters:[{ key:payload.fingerprint, ast:payload.ast }], events:false });
  if (result.loading) return null;
  const step = result.steps[0];
  return historyVerdict({ totalEvents:step.totalEvents, symbolsCount:(await getUniverseWatchlist().catch(() => [])).length || step.triggeredSymbols, availableDays:result.availableDays });
}
