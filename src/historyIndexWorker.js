// Long-lived child process that owns the 7-day condition index (src/historyIndex.js). It runs in its own process
// with its own heap cap, so the bars it keeps in memory (and the large monthly parquet reads at load) can never take
// the live monitor down. Talks to the parent (historyIndexClient.js) over IPC:
//
//   { type:'load', symbols }                     read the last 7 trading days for these stocks, then compute every
//                                                 condition already known (sent again after a crash/restart)
//   { type:'refresh', symbols }                  re-read today's (and any new) m1_live day; past days are not touched
//   { type:'query', id, conditions, filters, candidates, symbols, events }
//                                                 conditions [{key, ast}] are computed once if new, then combined
//   { type:'ensure', id, conditions }             compute these now (prewarm the indicator list)
//   { type:'example', id, filters:[{key, ast}] }    one candlestick example where all filters hold (conditionExample.js);
//                                                 searches all daily history, then the 7-day minute index; cached
//   { type:'status', id }
import { BarCollector, collectHistory, HISTORY_DAYS, listHfD1Months, listHfM1Dates, readD1Rows, readParquetInto } from './history.js';
import { DailyStore, findExample } from './conditionExample.js';
import { readFile } from 'node:fs/promises';
import { HistoryIndex } from './historyIndex.js';
import { DailyIndex, dailyBarsFromMinutes, fillDailyGap } from './dailyIndex.js';

const index = new HistoryIndex({ maxDays:HISTORY_DAYS });
let status = 'idle', progress = null, error = null, loadedAt = null, refreshedAt = null, symbols = new Set();
let queue = Promise.resolve();
const daily = new DailyStore();
const dailyIndex = new DailyIndex();   // daily filters (D1 step), recomputed whenever the daily history is (re)loaded
let dailyStatus = 'idle', dailyLoadedDay = null;
const examples = new Map();   // sorted filter keys → { day, example }
const send = (message) => { if (process.send) process.send(message); };
const run = (task) => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
const info = () => ({ status, progress, error, loadedAt, refreshedAt, daily:{ status:dailyStatus, ...(dailyStatus === 'ready' ? daily.stats() : {}) }, ...index.stats(), heapMb:Math.round(process.memoryUsage().heapUsed / 1048576) });

async function load(list) {
  status = 'loading'; error = null; symbols = new Set(list);
  const started = Date.now();
  try {
    // Tests (no HF access): WATCH365_HISTORY_FIXTURE = JSON { "YYYY-MM-DD": { "2330": [bar…] } }.
    if (process.env.WATCH365_HISTORY_FIXTURE) {
      const fixture = JSON.parse(await readFile(process.env.WATCH365_HISTORY_FIXTURE, 'utf8'));
      for (const date of Object.keys(fixture).sort()) index.setDay(date, new Map(Object.entries(fixture[date])));
    } else {
      const { collector } = await collectHistory(symbols, { days:HISTORY_DAYS, onProgress:(item) => { progress = item.message; } });
      for (const date of collector.dates()) { progress = `建立索引 ${date}`; index.setDay(date, collector.barsFor(date)); collector.drop(date); }
    }
    status = 'ready'; progress = null; loadedAt = new Date().toISOString();
    loadDaily();
    console.log(`history-index: loaded ${index.stats().dates.length} days × ${symbols.size} symbols, ${index.stats().conditions} conditions in ${Date.now() - started} ms, heap ${info().heapMb} MB`);
  } catch (failure) {
    status = 'failed'; error = failure.code || failure.message; progress = null;
    console.error('history-index: load failed', error);
  }
}

// All daily history, read month by month in the background (not through the query queue, so picking filters is
// never blocked behind it). Examples asked before it is ready use the minute index. Re-read once a day for the
// current month.
async function loadDaily() {
  if (dailyStatus === 'loading') return;
  // Tests: WATCH365_DAILY_FIXTURE = JSON { "2330": [{ date, open, high, low, close, volume }…] }.
  if (process.env.WATCH365_DAILY_FIXTURE) {
    const fixture = JSON.parse(await readFile(process.env.WATCH365_DAILY_FIXTURE, 'utf8'));
    daily.add('fixture', Object.entries(fixture).flatMap(([symbol, rows]) => rows.map((row) => ({ ...row, symbol }))));
    dailyIndex.setSeries(daily.finalize()); dailyStatus = 'ready'; dailyLoadedDay = taipeiDay(); examples.clear(); return;
  }
  if (process.env.WATCH365_HISTORY_FIXTURE) return;
  dailyStatus = 'loading';
  const started = Date.now(), today = taipeiDay();
  try {
    const months = await listHfD1Months();
    const current = today.slice(0, 7);
    for (const file of months) {
      if (daily.months.has(file.month) && file.month !== current) continue;
      daily.add(file.month, await readD1Rows(file.path, { maxAgeSeconds:file.month === current ? 3600 : 30 * 86400, symbols:symbols.size ? symbols : null }));
    }
    daily.finalize();
    const stats = daily.stats();
    // Sanity: months of data must give many bars per stock; a handful means dates were not read correctly.
    if (stats.symbols && stats.bars / stats.symbols < Math.min(20, stats.months * 5)) throw Object.assign(new Error(`daily data looks wrong: ${stats.bars} bars for ${stats.symbols} symbols over ${stats.months} months`), { code:'HISTORY_D1_IMPLAUSIBLE' });
    dailyStatus = 'ready'; dailyLoadedDay = today; examples.clear(); dailyGapKey = null; syncDailyIndex();
    console.log(`history-index: daily ${stats.months} months × ${stats.symbols} symbols (${stats.bars} bars) in ${Date.now() - started} ms, heap ${info().heapMb} MB`);
  } catch (failure) {
    dailyStatus = failure.code === 'HISTORY_D1_IMPLAUSIBLE' || !daily.months.size ? 'failed' : 'ready';
    console.error('history-index: daily load failed', failure.code || failure.message, failure.code === 'HISTORY_D1_IMPLAUSIBLE' ? failure.message : '');
  }
}
// The daily index = daily history + completed minute days the daily source does not have yet (fillDailyGap).
// Recomputed only when that set of days changes (a new daily load, or a new minute day).
let dailyGapKey = null;
function syncDailyIndex() {
  if (dailyStatus !== 'ready' || process.env.WATCH365_DAILY_FIXTURE) return;
  // After 14:00 Taipei today's minute file is final, so today's close counts too (until then it is still moving).
  const now = new Date(Date.now() + 8 * 3_600_000), after = now.getUTCHours() >= 14;
  const today = after ? new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10) : taipeiDay();
  const key = `${dailyLoadedDay}|${today}|${index.dates().join(',')}`;
  if (key === dailyGapKey) return;
  const { series, filled } = fillDailyGap(daily.series, index.days, today);
  dailyIndex.setSeries(series); dailyGapKey = key;
  if (filled.length) console.log(`history-index: daily filled from minute bars: ${filled.join(', ')}`);
}
function dailyBaseLast() { let last = ''; for (const item of daily.series.values()) { const date = item.dates.at(-1); if (date > last) last = date; } return last; }
function taipeiDay() { return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); }

// Today's file grows during the session; a new trading day appears as a new file. Older days are fixed.
async function refresh(list) {
  if (status !== 'ready' || process.env.WATCH365_HISTORY_FIXTURE) return;
  if (list?.length) for (const symbol of list) symbols.add(symbol);
  const known = new Set(index.dates());
  const files = (await listHfM1Dates()).slice(-2);
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  for (const file of files) {
    if (file.date > today || (known.has(file.date) && file.date !== today)) continue;
    const collector = new BarCollector(symbols);
    await readParquetInto(file.path, collector, { maxAgeSeconds:file.date === today ? 60 : 7 * 86400 });
    if (collector.days.has(file.date)) index.setDay(file.date, collector.barsFor(file.date));
  }
  refreshedAt = new Date().toISOString();
  syncDailyIndex();
  if (dailyLoadedDay && dailyLoadedDay !== taipeiDay()) loadDaily();
}

process.on('message', (message) => {
  const reply = (body) => send({ id:message.id, ...body });
  if (message.type === 'load') { run(() => load(message.symbols || [])); return; }
  if (message.type === 'refresh') { run(() => refresh(message.symbols).catch((failure) => console.error('history-index: refresh failed', failure.code || failure.message))); return; }
  if (message.type === 'status') { reply({ type:'result', result:info() }); return; }
  // A query during the initial load answers right away (the UI shows progress and asks again) instead of waiting.
  if ((message.type === 'query' || message.type === 'example') && status !== 'ready') { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
  run(async () => {
    try {
      if (status !== 'ready') { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
      // Monitor engine, daily step: today's list (met on the previous daily close) / after-close check for D1-only.
      if (message.type === 'daily_list' || message.type === 'daily_close') {
        if (dailyStatus !== 'ready' || !dailyIndex.ready()) { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
        dailyIndex.ensure(message.conditions || []);
        const keys = (message.conditions || []).map((item) => item.key), symbolSet = Array.isArray(message.symbols) ? new Set(message.symbols) : null;
        if (message.type === 'daily_list') {
          const listDate = dailyIndex.dates.filter((date) => date < message.date).at(-1) ?? null;
          reply({ type:'result', result:{ listDate, symbols:listDate ? [...dailyIndex.metOn(keys, listDate, symbolSet)].sort() : [] } }); return;
        }
        const minuteDay = index.days.get(message.date);
        if (!minuteDay?.size) { reply({ type:'result', result:{ noSession:true } }); return; }
        const baseLast = dailyBaseLast(), overlapDate = index.dates().filter((date) => date < message.date && date <= baseLast).at(-1) ?? null;
        const bars = dailyBarsFromMinutes(minuteDay, message.date, { series:daily.series, overlapDate, overlapDay:overlapDate ? index.days.get(overlapDate) : null });
        reply({ type:'result', result:{ date:message.date, ...dailyIndex.closeCheck(keys, bars, symbolSet) } }); return;
      }
      const computed = index.ensure(message.conditions || []);
      if (message.type === 'ensure') { reply({ type:'result', result:{ computed, ...info() } }); return; }
      if (message.type === 'example') {
        if (message.timeframe === 'd1' && dailyStatus !== 'ready') { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
        const cacheKey = `${message.timeframe || ''}:${(message.filters || []).map((item) => item.key).sort().join('|')}`;
        const day = `${taipeiDay()}|${dailyStatus}`;
        const cached = examples.get(cacheKey);
        if (cached && cached.day === day) { reply({ type:'result', result:{ example:cached.example, cached:true } }); return; }
        const example = findExample({ filters:message.filters || [], daily:dailyStatus === 'ready' ? daily : null, index:message.timeframe === 'd1' ? null : index });
        examples.set(cacheKey, { day, example }); if (examples.size > 500) examples.delete(examples.keys().next().value);
        reply({ type:'result', result:{ example, cached:false, dailyReady:dailyStatus === 'ready' } }); return;
      }
      const symbolSet = Array.isArray(message.symbols) ? new Set(message.symbols) : null;
      // Daily filters (D1 step): answered from the daily index; each minute-bar day then only counts the stocks on that
      // day's daily list (met on the previous daily close).
      let dailyResult = null, symbolsByDate = null;
      const dailyFilters = message.daily?.filters || [];
      if (message.daily && (dailyFilters.length || message.daily.candidates?.length)) {
        if (dailyStatus !== 'ready' || !dailyIndex.ready()) dailyResult = { loading:true, status:dailyStatus };
        else {
          dailyIndex.ensure((message.daily.conditions || []).filter((item) => dailyFilters.includes(item.key)));
          dailyIndex.ensure(message.daily.conditions || [], { skipUnsupported:true });
          dailyResult = dailyIndex.query({ filters:dailyFilters, candidates:message.daily.candidates || [], symbols:symbolSet, list:Boolean(message.daily.list), events:Boolean(message.daily.events) });
          if (dailyFilters.length) symbolsByDate = new Map(index.dates().map((date) => [date, dailyIndex.listFor(dailyFilters, date, symbolSet)]));
        }
      }
      const result = dailyResult?.loading && dailyFilters.length ? { dates:index.dates(), availableDays:index.dates().length, steps:[], candidates:[] } : index.query({ filters:message.filters || [], candidates:message.candidates || [], symbols:symbolSet, symbolsByDate, events:message.events !== false });
      reply({ type:'result', result:{ ...result, daily:dailyResult, computed, loadedAt, refreshedAt } });
    } catch (failure) {
      reply({ type:'error', code:failure.code || 'HISTORY_INDEX_FAILED', message:failure.message });
    }
  });
});
send({ type:'ready' });
