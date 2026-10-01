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
import { applyScopedMarketBars } from './signalEngine.js';
import { IndicatorRegistry, strategyIdentity, validateFormulaStrategy, validateStrategy } from './indicatorRegistry.js';
import { indicatorAgentStatus, validateAgentProposal } from './indicatorAgent.js';
import { loadProjectEnv } from './env.js';
import { createDocumentBackend, createFormulaLibraryBackend, dbConfigFromEnv } from './db.js';
import { HISTORY_DAYS, listHfM1Dates, listHfM1Months } from './history.js';
import { fork } from 'node:child_process';
import { IndicatorRequestStore } from './indicatorRequests.js';
import { issueFormulaToken, verifyFormulaToken } from './formulaEngine.js';
import { FormulaLibrary, resolveMonitorCondition } from './formulaLibrary.js';
import { conditionsName, parseConditions, planConditionStrategy } from './monitorConditions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadProjectEnv(join(ROOT, '.env'));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = process.env.WATCH365_DATA_FILE || join(ROOT, 'data', 'watch365.json');
const INDICATOR_REQUESTS_FILE = process.env.WATCH365_INDICATOR_REQUESTS_FILE || join(ROOT, 'data', 'indicator-requests.json');
const FORMULA_LIBRARY_FILE = process.env.WATCH365_FORMULA_LIBRARY_FILE || join(ROOT, 'data', 'formula-library.json');
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
function historyJobView(job) {
  if (job.status === 'done') return { status: 'done', jobId: job.id, cached: false, ...job.result };
  if (job.status === 'failed') return { status: 'failed', jobId: job.id, error: job.error?.code || 'HISTORY_FAILED' };
  return { status: job.status, jobId: job.id, progress: job.progress, elapsedMs: Date.now() - job.startedAt };
}

await Promise.all([store.load(),indicatorRequests.load(),formulaLibrary.load()]);
console.log(`Formula library: ${formulaLibrary.list().length} formulas, ${formulaLibrary.aliases.size} aliases`);
syncMonitorTimer();

const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/api/')) {
      await routeApi(request, response);
      return;
    }
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
      if (cached && Date.now() - cached.at < HISTORY_CACHE_MS) { sendJson(response, 200, { ...cached.result, cached:true, status:'done' }); return; }
      const job = startHistoryJob(key, strategy, watchlist);
      // ?wait=1 keeps the old synchronous behaviour for scripts; the UI polls instead.
      if (url.searchParams.get('wait') === '1') { await job.promise.catch(() => {}); sendJson(response, job.error ? (job.error.statusCode || 500) : 200, job.error ? { error:job.error.code || 'HISTORY_FAILED' } : { ...job.result, cached:false, status:'done' }); return; }
      sendJson(response, 202, historyJobView(job));
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
    try {
      const registry=await indicatorRegistry.load();
      // Library first (exact alias match, active formulas only), AI planner on a miss. Both paths return the same shape.
      const result=await resolveMonitorCondition(body.text,registry.items,{library:formulaLibrary,context:body.context});
      if(result.status==='formula'){result.proposalId=randomUUID();result.proposalToken=issueFormulaToken({...result.proposal,proposalId:result.proposalId,sourceText:typeof body.text==='string'?body.text:undefined},formulaTokenSecret);}
      delete result.proposal?.ast;
      sendJson(response,200,result);
    } catch(error) {
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
      await store.update((state)=>{const changed=strategyIdentity(state.settings.strategy)!==strategyIdentity(strategy);state.settings.watchlist=watchlist;state.settings.strategy=strategy;state.settings.formulaActivationId=payload.proposalId;state.settings.enabled=true;state.settings.provider='hf_dataset';state.settings.monitorTask={name:`${strategy.name}監控`,onboardingCompleted:true,completedAt:new Date().toISOString()};if(changed)revokePendingDeliveryAuthorizations(state);appendLog(state,'info','套用並啟用公式監控',{formulaFingerprint:strategy.definitionFingerprint,symbols:watchlist.map((item)=>item.symbol)});});
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
      // Single template ({ shapeKey, values, direction }) or 1–2 filters ({ items:[{ shapeKey|fingerprint, values, direction }] }) joined with `all`.
      // An item may be a signed proposalToken from /api/indicator-agent/parse: verify it and compose its AST.
      const items = (Array.isArray(body.items) ? body.items : [{ shapeKey: body.shapeKey, values: body.values ?? {}, direction: body.direction ?? null }]).map((item) => {
        if (item && typeof item === 'object' && typeof item.proposalToken === 'string') { const payload = verifyFormulaToken(item.proposalToken, formulaTokenSecret); return { ast: payload.ast, name: payload.name }; }
        return item;
      });
      const result = formulaLibrary.compose(items);
      result.proposalId = randomUUID();
      result.proposalToken = issueFormulaToken({ ...result.proposal, proposalId: result.proposalId, sourceText: typeof body.text === 'string' && body.text.trim() ? body.text : result.proposal.name }, formulaTokenSecret);
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
    try { const result=await indicatorRequests.submit(body); sendJson(response,result.duplicate?200:201,result); }
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
    let conditions, strategy, watchlist, taskName, formulaPayload;
    try {
      ({ strategy, conditions, name: taskName, formulaPayload } = await strategyFromRequest(body, store.getState().settings.strategy));
      watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : await getUniverseWatchlist();
    } catch (error) {
      sendJson(response, error.statusCode || 400, { error:error.code || 'MONITOR_CONFIGURE_FAILED' });
      return;
    }
    await store.update((state) => {
      const changed = strategyIdentity(state.settings.strategy) !== strategyIdentity(strategy);
      state.settings.provider = 'hf_dataset';
      state.settings.scopeMode = purpose === 'screen' ? 'universe' : 'watchlist';
      state.settings.watchlist = watchlist;
      state.settings.strategy = strategy;
      state.settings.conditions = conditions;
      state.settings.enabled = true;
      state.settings.monitorTask = { name:`${taskName}監控`, onboardingCompleted:true, completedAt:new Date().toISOString() };
      if (changed) revokePendingDeliveryAuthorizations(state);
      appendLog(state, 'info', '建立並啟用監控', { purpose, conditions:taskName, symbols:watchlist.length });
    });
    syncMonitorTimer();
    if (formulaPayload) await recordFormulaActivation(formulaPayload);
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/start') {
    await store.update((state) => {
      state.settings.enabled = true;
      appendLog(state, 'info', '啟動監控');
    });
    syncMonitorTimer();
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
    sendJson(response, 200, publicState(store.getState()));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/monitor/run') {
    const result = await runMonitor('manual-run');
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
    await store.update((state)=>{applyMonitorScope(state,scope);appendLog(state,'info','本輪系統監控範圍已確認',{source,revision:scope.revision,selected:scope.selectedCount,effective:scope.effectiveCount,uncovered:scope.uncoveredCount});});
    if (!scope.effectiveCount) {
      await store.update((state)=>{state.runtime.lastRunAt=new Date().toISOString();state.runtime.lastProviderStatus='empty_scope';state.runtime.lastError=null;appendLog(state,'info','本輪無系統名單涵蓋股票，未執行行情判定',{source});});
      return { signals:[], skipped:true, reason:'empty_scope', state:publicState(store.getState()) };
    }
    const bars = await fetchMarketBars({ ...settings, watchlist:scope.effectiveWatchlist });
    return await applyBars(filterBarsToMonitorScope(bars, scope), source, scope);
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

async function applyBars(bars, source, scope) {
  const now = new Date();
  let result;

  await store.update((state) => {
    result = applyScopedMarketBars(state,bars,scope,source,now);
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
