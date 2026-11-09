// Browser-side API for the static site (GitHub Pages). public/app.js calls request(url, body) instead of fetch: the
// compute routes the Node server used to answer (daily condition index, example chart, stock lists) run here on
// public/data/* (built by scripts/build-data.mjs) in a Web Worker; everything that stores state (monitors, LINE,
// AI, indicator requests) goes to the Cloudflare Worker (worker/index.js) at WATCH365_API.
import { FormulaLibrary } from '../src/formulaLibrary.js';
import { formulaFingerprint } from '../src/formulaEngine.js';
import { dailyCapable } from '../src/dailyIndex.js';
import { resolveWatchlistInput } from '../src/watchlist.js';
import { calculateUniverseCoverage } from '../src/universeCoverage.js';
import { parseWatchlist } from '../src/rules.js';

const API_BASE = (globalThis.WATCH365_API || '').replace(/\/$/, '');
const MAX_INDEX_FILTERS = 3;
const VISITOR_KEY = 'watch365_visitor';

// Anonymous visitor id (was the w365v cookie): kept in this browser, sent to the Worker on every call.
export function visitorId() {
  let id = null;
  try { id = localStorage.getItem(VISITOR_KEY); } catch {}
  // Same shape as the old cookie id (src/monitors.js OWNER_ID): 16 random bytes, base64url, 22 characters.
  if (!id || !/^[A-Za-z0-9_-]{22}$/.test(id)) { id = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); try { localStorage.setItem(VISITOR_KEY, id); } catch {} }
  return id;
}

// ---- remote (Cloudflare Worker) ----
export async function remote(url, body, { method } = {}) {
  if (!API_BASE) throw Object.assign(new Error('API_NOT_CONFIGURED'), { code:'API_NOT_CONFIGURED', status:503 });
  const response = await fetch(API_BASE + url, { method:method || (body === undefined ? 'GET' : 'POST'), headers:{ 'Content-Type':'application/json', 'X-W365-Visitor':visitorId() }, body:body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({}));
  return { status:response.status, payload };
}

// ---- engine worker ----
let worker = null, nextId = 1; const pending = new Map();
function engine(message) {
  if (!worker) {
    worker = new Worker(new URL('./engine-worker.js', import.meta.url), { type:'module' });
    worker.onmessage = ({ data }) => { const done = pending.get(data.id); if (!done) return; pending.delete(data.id); if (data.error) done.reject(Object.assign(new Error(data.error), { code:data.error })); else done.resolve(data.result); };
  }
  const id = nextId++;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...message, id }); });
}

// ---- static data ----
let universePromise = null;
function universeData() {
  universePromise ??= fetch(new URL('../data/universe.json', import.meta.url), { cache:'no-cache' }).then((response) => { if (!response.ok) throw Object.assign(new Error('HF_UNIVERSE_SOURCE_FAILED'), { code:'HF_UNIVERSE_SOURCE_FAILED' }); return response.json(); }).catch((error) => { universePromise = null; throw error; });
  return universePromise;
}
async function masterMap() { const data = await universeData(); return new Map(Object.entries(data.master).map(([symbol, [name, market]]) => [symbol, { symbol, name, market, supported:true }])); }
async function universeWatchlist() {
  const [data, master] = await Promise.all([universeData(), masterMap()]);
  return data.universe.items.flatMap((item) => { const meta = master.get(item.symbol); return meta && ['TWSE', 'TPEx'].includes(meta.market) ? [{ symbol:item.symbol, name:meta.name || item.name || item.symbol, market:meta.market }] : []; });
}

// ---- formula library (presets from code + AI formulas stored by the Worker) ----
let libraryPromise = null;
export function library() {
  libraryPromise ??= (async () => {
    let stored = { formulas:[], aliases:[] };
    try { const { status, payload } = await remote('/api/formula-library/full'); if (status === 200) stored = payload; } catch {}
    const backend = { loadAll:async () => stored, upsertFormula:async () => {}, upsertAlias:async () => {} };
    return new FormulaLibrary(null, { backend, log:{ warn() {}, info() {}, error() {} } }).load();
  })();
  return libraryPromise;
}
export function resetLibrary() { libraryPromise = null; }

// A signed token's payload (the Worker checks the signature whenever it matters; here it only feeds the local index).
function tokenPayload(token) {
  const encoded = String(token || '').split('.')[0];
  const json = new TextDecoder().decode(Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)));
  return JSON.parse(json);
}
async function resolveIndexCondition(spec) {
  if (!spec || typeof spec !== 'object') throw httpError('TEMPLATE_REQUEST_INVALID', 422);
  let ast;
  if (typeof spec.proposalToken === 'string') ast = tokenPayload(spec.proposalToken).ast;
  else if (typeof spec.shapeKey === 'string' || typeof spec.fingerprint === 'string') ast = (await library()).compose([spec.shapeKey ? { shapeKey:spec.shapeKey, values:spec.values ?? {}, direction:spec.direction ?? null } : { fingerprint:spec.fingerprint }]).proposal.ast;
  else throw httpError('HISTORY_INDEX_CONDITION_MISSING', 409);
  return { key:formulaFingerprint(ast), ast };
}
const httpError = (code, status) => Object.assign(new Error(code), { code, status });

// ---- routes ----
const LOCAL = {
  'GET /api/version': async () => { const data = await universeData().catch(() => null); return { version:data?.builtAt ? `data ${data.builtAt.slice(0, 16).replace('T', ' ')}` : 'static', deployedAt:data?.builtAt ?? null, commit:null }; },

  'GET /api/system-universe': async (url) => {
    const data = await universeData(); const universe = data.universe;
    const query = String(url.searchParams.get('q') || '').trim().toLocaleLowerCase('zh-Hant'), group = String(url.searchParams.get('group') || '').trim();
    const pageSize = Math.trunc(clamp(url.searchParams.get('pageSize'), 10, group ? 1000 : 100, 50));
    const filtered = universe.items.filter((item) => (!group || item.group === group) && (!query || item.symbol.includes(query) || String(item.name || '').toLocaleLowerCase('zh-Hant').includes(query)));
    const counts = new Map(); for (const item of universe.items) if (item.group) counts.set(item.group, (counts.get(item.group) || 0) + 1);
    const groups = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize)), page = Math.trunc(clamp(url.searchParams.get('page'), 1, pages, 1)), start = (page - 1) * pageSize;
    return { ...universe, items:filtered.slice(start, start + pageSize), filteredTotal:filtered.length, page, pageSize, pages, groups };
  },

  'POST /api/system-universe/coverage': async (url, body) => {
    const watchlist = parseWatchlist(body?.watchlist, { allowEmpty:true });
    const data = await universeData();
    return { status:'available', updatedDate:data.universe.updatedDate, universeTotal:data.universe.total, ...calculateUniverseCoverage(watchlist, data.universe.items) };
  },

  'POST /api/watchlist/resolve': async (url, body) => {
    try { return { metadataStatus:'available', ...resolveWatchlistInput(body?.input, await masterMap()) }; }
    catch (error) { return { metadataStatus:'unavailable', metadataErrorCode:error.code || 'HF_METADATA_UNAVAILABLE', ...resolveWatchlistInput(body?.input, null) }; }
  },

  'GET /api/indicator-templates': async (url) => ({ items:(await library()).templates({ includePending:url.searchParams.get('includePending') !== 'false' }) }),

  // Daily step only (盤中觸發 is 即將推出): minute filters get an empty answer.
  'POST /api/history/index': async (url, body) => {
    const purpose = body?.purpose === 'screen' ? 'screen' : body?.purpose === 'watchlist' ? 'watchlist' : null;
    if (!purpose) throw httpError('MONITOR_PURPOSE_INVALID', 400);
    const watchlist = purpose === 'watchlist' ? parseWatchlist(body.watchlist) : null;
    const dailyBody = body.daily && typeof body.daily === 'object' ? body.daily : null;
    const dailyFilters = await Promise.all((Array.isArray(dailyBody?.filters) ? dailyBody.filters.slice(0, MAX_INDEX_FILTERS) : []).map(resolveIndexCondition));
    const dailyCandidates = await Promise.all((Array.isArray(dailyBody?.candidates) ? dailyBody.candidates.slice(0, 200) : []).map((spec) => resolveIndexCondition(spec).catch((error) => ({ error:error.code || 'TEMPLATE_REQUEST_INVALID' }))));
    const usable = dailyCandidates.filter((item) => !item.error);
    const names = new Map((watchlist || await universeWatchlist().catch(() => [])).map((item) => [item.symbol, item.name]));
    const base = { status:'ready', availableDays:0, dates:[], symbolsCount:watchlist ? watchlist.length : names.size, refreshedAt:null, filterKeys:[], steps:[], candidates:[], verdict:null };
    if (!dailyBody) return { ...base, daily:null };
    const result = await engine({ type:'query', conditions:[...dailyFilters, ...usable], filters:dailyFilters.map((item) => item.key), candidates:usable.map((item) => item.key), symbols:watchlist ? watchlist.map((item) => item.symbol) : null, list:Boolean(dailyBody.list), events:Boolean(dailyBody.events) });
    if (result.loading) return result.status === 'failed' ? { ...base, daily:{ status:'failed' } } : { ...base, daily:{ status:'loading' } };
    return { ...base, daily:{ status:'ready', dates:result.dates, latestDate:result.latestDate, filterKeys:dailyFilters.map((item) => item.key),
      steps:result.steps.map((step) => step.symbols ? { ...step, symbols:step.symbols.map((symbol) => ({ symbol, name:names.get(symbol) || '' })) } : step),
      candidates:dailyCandidates.map((item, index) => { if (item.error) return { index, error:item.error }; const found = result.candidates.find((entry) => entry.key === item.key); return { index, latestCount:found?.latestCount ?? 0, forward:found?.forward ?? null }; }) } };
  },

  'POST /api/history/example': async (url, body) => {
    const filters = Array.isArray(body?.filters) ? body.filters : [];
    if (!filters.length) throw httpError('CONDITIONS_REQUIRED', 422);
    if (filters.length > MAX_INDEX_FILTERS) throw httpError('CONDITIONS_TOO_MANY', 422);
    const result = await engine({ type:'example', filters:await Promise.all(filters.map(resolveIndexCondition)) });
    if (result.loading) return { status:'loading', progress:result.progress || '準備資料' };
    return { status:'ready', example:result.example ?? null };
  },

  // The monitor's daily filters replayed over the last trading days (what the 13:00 notification would have sent).
  'GET /api/monitor/history': async () => {
    const { payload:state } = await remote('/api/state');
    const settings = state?.settings || {};
    if (settings.strategy?.executor !== 'daily_close' || !settings.daily?.filters?.length) return { status:'unsupported' };
    const watchlist = settings.scopeMode === 'universe' ? null : settings.watchlist || [];
    const conditions = settings.daily.filters.map(({ key, ast }) => ({ key, ast }));
    const result = await engine({ type:'query', conditions, filters:conditions.map((item) => item.key), candidates:[], symbols:watchlist ? watchlist.map((item) => item.symbol) : null, events:true });
    if (result.loading) return { status:'loading', progress:'準備歷史資料' };
    const names = new Map((watchlist || await universeWatchlist().catch(() => [])).map((item) => [item.symbol, item.name]));
    const step = result.steps.at(-1), events = step.events || [];
    return { status:'ready', timeframe:'1d', availableDays:result.dates.length - 1, triggeredSymbols:new Set(events.map((event) => event.symbol)).size, totalEvents:events.length, days:step.days.slice(1).map((day) => ({ date:day.date, count:day.newCount })), truncated:false, events:events.map((event) => ({ date:event.date, at:`${event.date}T05:30:00.000Z`, symbol:event.symbol, price:event.price, name:names.get(event.symbol) || '' })) };
  },

  // Daily step AI formula: vetted here on the daily index (the Worker has no market data), then stored by the Worker.
  'POST /api/formula/save': async (url, body) => {
    if (body?.timeframe === 'd1') {
      const payload = tokenPayload(body.proposalToken);
      const known = (await library()).get(payload.fingerprint);
      if (!known) {
        if (!dailyCapable(payload.ast)) throw httpError('DAILY_CONDITION_UNSUPPORTED', 422);
        const verdict = await dailyVerdict({ key:payload.fingerprint, ast:payload.ast });
        if (!verdict) return { __status:202, status:'loading' };
        if (!verdict.ok) return { __status:409, error:'FORMULA_NOT_VETTED', verdict };
      }
    }
    const { status, payload } = await remote('/api/formula/save', { ...body, vetted:true });
    if (status === 200) resetLibrary();
    return { __status:status, ...payload };
  }
};

async function dailyVerdict(condition) {
  const result = await engine({ type:'query', conditions:[condition], filters:[condition.key], candidates:[], symbols:null });
  if (result.loading) return null;
  const days = result.steps[0]?.days ?? [], counts = days.map((day) => day.count);
  const symbolsCount = (await universeWatchlist().catch(() => [])).length || 0;
  const totalEvents = counts.reduce((sum, count) => sum + count, 0), most = Math.max(0, ...counts), least = counts.length ? Math.min(...counts) : 0;
  const base = { totalEvents, symbolsCount:most, availableDays:days.length, latestCount:result.steps[0]?.latestCount ?? 0 };
  if (!days.length) return { ok:false, code:'no_data', message:'沒有可用的日 K 資料，無法驗證這個條件。', ...base };
  if (!most) return { ok:false, code:'no_triggers', message:`過去 ${days.length} 個交易日沒有任何一檔符合，這個條件可能太嚴格。`, ...base };
  if (symbolsCount && least >= symbolsCount * 0.9) return { ok:false, code:'too_many', message:'幾乎每一檔每天都符合，加了也篩不掉股票。', ...base };
  return { ok:true, code:'ok', ...base };
}

function clamp(value, min, max, fallback) { const number = Number(value); return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback; }

// Same contract as the old fetch wrapper in app.js: resolves with the JSON body, throws { code, payload } on an error status.
export async function request(path, body) {
  const url = new URL(path, location.origin), method = body === undefined ? 'GET' : 'POST';
  const local = LOCAL[`${method} ${url.pathname}`];
  let status, payload;
  if (local) {
    try { payload = await local(url, body); status = payload?.__status ?? 200; if (payload && '__status' in payload) delete payload.__status; }
    catch (error) { status = error.status || (error.statusCode) || 500; payload = { error:error.code || error.message || 'LOCAL_API_FAILED' }; }
  } else ({ status, payload } = await remote(url.pathname + url.search, body));
  if (status >= 400) throw Object.assign(new Error(payload.error || `HTTP ${status}`), { code:payload.error, payload });
  return payload;
}
