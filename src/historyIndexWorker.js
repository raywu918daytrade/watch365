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
//   { type:'status', id }
import { BarCollector, collectHistory, HISTORY_DAYS, listHfM1Dates, readParquetInto } from './history.js';
import { readFile } from 'node:fs/promises';
import { HistoryIndex } from './historyIndex.js';

const index = new HistoryIndex({ maxDays:HISTORY_DAYS });
let status = 'idle', progress = null, error = null, loadedAt = null, refreshedAt = null, symbols = new Set();
let queue = Promise.resolve();
const send = (message) => { if (process.send) process.send(message); };
const run = (task) => { const next = queue.then(task); queue = next.catch(() => {}); return next; };
const info = () => ({ status, progress, error, loadedAt, refreshedAt, ...index.stats(), heapMb:Math.round(process.memoryUsage().heapUsed / 1048576) });

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
    console.log(`history-index: loaded ${index.stats().dates.length} days × ${symbols.size} symbols, ${index.stats().conditions} conditions in ${Date.now() - started} ms, heap ${info().heapMb} MB`);
  } catch (failure) {
    status = 'failed'; error = failure.code || failure.message; progress = null;
    console.error('history-index: load failed', error);
  }
}

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
}

process.on('message', (message) => {
  const reply = (body) => send({ id:message.id, ...body });
  if (message.type === 'load') { run(() => load(message.symbols || [])); return; }
  if (message.type === 'refresh') { run(() => refresh(message.symbols).catch((failure) => console.error('history-index: refresh failed', failure.code || failure.message))); return; }
  if (message.type === 'status') { reply({ type:'result', result:info() }); return; }
  // A query during the initial load answers right away (the UI shows progress and asks again) instead of waiting.
  if (message.type === 'query' && status !== 'ready') { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
  run(async () => {
    try {
      if (status !== 'ready') { reply({ type:'result', result:{ loading:true, ...info() } }); return; }
      const computed = index.ensure(message.conditions || []);
      if (message.type === 'ensure') { reply({ type:'result', result:{ computed, ...info() } }); return; }
      const result = index.query({ filters:message.filters || [], candidates:message.candidates || [], symbols:Array.isArray(message.symbols) ? new Set(message.symbols) : null, events:message.events !== false });
      reply({ type:'result', result:{ ...result, computed, loadedAt, refreshedAt } });
    } catch (failure) {
      reply({ type:'error', code:failure.code || 'HISTORY_INDEX_FAILED', message:failure.message });
    }
  });
});
send({ type:'ready' });
