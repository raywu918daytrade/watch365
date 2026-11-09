// Web Worker that owns the daily (D1) condition index in the browser (replaces the server's historyIndexWorker.js on
// GitHub Pages). Messages: { id, type:'query'|'example'|'status', ... } → { id, result } | { id, error }.
import { DailyIndex } from '../src/dailyIndex.js';
import { findExample } from '../src/conditionExample.js';
import { seriesFromDailyJson } from './dailyData.js';

const index = new DailyIndex();
const daily = { series:null, finalize() { return this.series; } };   // findExample calls daily.finalize()
let status = 'loading', error = null, builtAt = null, progress = '讀取日 K 資料';
const examples = new Map();

const ready = (async () => {
  try {
    const response = await fetch(new URL('../data/daily.json.gz', self.location.href), { cache:'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // GitHub Pages serves .gz as application/gzip without Content-Encoding, so it is decompressed here.
    const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
    const data = JSON.parse(text);
    progress = '建立索引';
    daily.series = seriesFromDailyJson(data); builtAt = data.builtAt;
    index.setSeries(daily.series);
    status = 'ready'; progress = null;
  } catch (failure) { status = 'failed'; error = failure.message; }
})();

self.onmessage = async ({ data:message }) => {
  const reply = (result) => self.postMessage({ id:message.id, result });
  try {
    if (message.type === 'status') { reply({ status, error, builtAt, progress, ...(status === 'ready' ? index.stats() : {}) }); return; }
    if (status !== 'ready') { reply({ loading:true, status, error, progress }); return; }
    await ready;
    if (message.type === 'query') {
      index.ensure(message.conditions.filter((item) => message.filters.includes(item.key)));
      index.ensure(message.conditions, { skipUnsupported:true });
      const symbols = Array.isArray(message.symbols) ? new Set(message.symbols) : null;
      reply(index.query({ filters:message.filters, candidates:message.candidates, symbols, list:Boolean(message.list), events:Boolean(message.events) }));
      return;
    }
    if (message.type === 'example') {
      const key = message.filters.map((item) => item.key).sort().join('|');
      if (!examples.has(key)) { examples.set(key, findExample({ filters:message.filters, daily, index:null })); if (examples.size > 300) examples.delete(examples.keys().next().value); }
      reply({ example:examples.get(key) }); return;
    }
    reply({ error:'UNKNOWN_MESSAGE' });
  } catch (failure) { self.postMessage({ id:message.id, error:failure.code || failure.message || 'ENGINE_FAILED' }); }
};
