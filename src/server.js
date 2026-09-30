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
import { IndicatorRequestStore } from './indicatorRequests.js';
import { issueFormulaToken, verifyFormulaToken } from './formulaEngine.js';
import { planMonitorCondition } from './formulaPlanner.js';
import { conditionsName, parseConditions, planConditionStrategy } from './monitorConditions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');
loadProjectEnv(join(ROOT, '.env'));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_FILE = process.env.WATCH365_DATA_FILE || join(ROOT, 'data', 'watch365.json');
const INDICATOR_REQUESTS_FILE = process.env.WATCH365_INDICATOR_REQUESTS_FILE || join(ROOT, 'data', 'indicator-requests.json');
const PORT = Number(process.env.PORT || 3650);
const indicatorRegistry = new IndicatorRegistry();
const formulaTokenSecret=randomBytes(32).toString('base64url');
// Deploy-time version: Railway starts a fresh process for every deployment, so boot time ≈ deploy time.
const BOOTED_AT = new Date();
const APP_VERSION = formatVersion(BOOTED_AT);
const APP_COMMIT = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null;

const store = new JsonStore(DATA_FILE);
const indicatorRequests = new IndicatorRequestStore(INDICATOR_REQUESTS_FILE);
let monitorTimer = null;
let isRunning = false;
let universeCache = null;

await Promise.all([store.load(),indicatorRequests.load()]);
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
      const result=await planMonitorCondition(body.text,registry.items,{context:body.context});
      if(result.status==='formula'){result.proposalId=randomUUID();result.proposalToken=issueFormulaToken({...result.proposal,proposalId:result.proposalId},formulaTokenSecret);}
      delete result.proposal?.ast;
      sendJson(response,200,result);
    } catch(error) {
      sendJson(response,error.statusCode||500,{error:error.code||'INDICATOR_AGENT_FAILED'});
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
      syncMonitorTimer();sendJson(response,200,publicState(store.getState()));
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
      const pageSize = Math.trunc(clampNumber(url.searchParams.get('pageSize'), 10, 100, 50));
      const filtered = query
        ? universe.items.filter((item) => item.symbol.includes(query) || String(item.name || '').toLocaleLowerCase('zh-Hant').includes(query))
        : universe.items;
      const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
      const page = Math.trunc(clampNumber(url.searchParams.get('page'), 1, pages, 1));
      const start = (page - 1) * pageSize;
      sendJson(response, 200, { ...universe, items: filtered.slice(start, start + pageSize), filteredTotal: filtered.length, page, pageSize, pages });
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
    let conditions, strategy, watchlist;
    try {
      conditions = parseConditions(body.conditions);
      const plan = planConditionStrategy(conditions);
      const current = store.getState().settings.strategy;
      if (plan.kind === 'registry') {
        const definition = await indicatorRegistry.resolve(plan.request.id, plan.request.version);
        const sameIdentity = current?.id === plan.request.id && JSON.stringify(current.params || {}) === JSON.stringify(plan.request.params);
        strategy = validateStrategy(plan.request, definition, sameIdentity ? current.activatedAt : new Date().toISOString());
      } else {
        strategy = validateFormulaStrategy(plan.strategy, current?.definitionFingerprint === plan.strategy.definitionFingerprint ? current.activatedAt : new Date().toISOString());
      }
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
      state.settings.monitorTask = { name:`${conditionsName(conditions)}監控`, onboardingCompleted:true, completedAt:new Date().toISOString() };
      if (changed) revokePendingDeliveryAuthorizations(state);
      appendLog(state, 'info', '建立並啟用監控', { purpose, conditions:conditionsName(conditions), symbols:watchlist.length });
    });
    syncMonitorTimer();
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
