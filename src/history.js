// HISTORY_DAYS-trading-day M1 history lookup. Replays a strategy with the same rules as the live engine:
// regular session only, no warm-up across days, data gaps > 2 minutes restart the series,
// and a 30-minute cooldown per stock per day.
//
// Data sources on the HF dataset:
//   db/m1_live/YYYY-MM-DD.parquet  one file per day, only the most recent few days are kept
//   db/m1/YYYY_MM.parquet          one file per month, full history
// Recent days come from m1_live; older days are filled from the monthly files, newest month first,
// until HISTORY_DAYS trading days are covered.
import { asyncBufferFromFile, parquetMetadataAsync, parquetRead, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { downloadHfAsset, loadHfConfig } from './hfAdapter.js';
import { evaluateFormulaSeries } from './formulaEngine.js';
import { wilderRsi } from './indicatorEngine.js';
import { roundPrice } from './marketBar.js';

// Trading days of minute bars kept by the condition index. 7 fits the 1 GB service; HISTORY_DAYS=30 (with more
// memory) gives the intraday step triggers old enough to carry a 7-day forward outcome.
export const HISTORY_DAYS = Math.max(1, Number(process.env.HISTORY_DAYS) || 7);
const COOLDOWN_MS = 30 * 60 * 1000;
const GAP_MS = 120_000;
const MAX_EVENTS = 300;
const MAX_MONTHS = 3;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SESSION_OPEN = 9 * 60, SESSION_CLOSE = 13 * 60 + 30;
const COLUMNS = ['stock_id', 'date', 'open', 'high', 'low', 'close', 'volume'];

async function listHfTree(directory, pattern, { config, fetchImpl = fetch } = {}) {
  const credentials = config || await loadHfConfig();
  const encodedRepo = credentials.repoId.split('/').map(encodeURIComponent).join('/');
  let next = `https://huggingface.co/api/datasets/${encodedRepo}/tree/main/${encodeURIComponent(directory)}?limit=1000`;
  const files = [];
  for (let page = 0; next && page < 20; page++) {
    let response;
    try { response = await fetchImpl(next, { headers: { Authorization: `Bearer ${credentials.token}` } }); }
    catch { throw historyError('HISTORY_SOURCE_FAILED', 503); }
    if (response.status === 401 || response.status === 403) throw historyError('HF_UNAUTHORIZED', 503);
    if (response.status === 404) return [];
    if (!response.ok) throw historyError('HISTORY_SOURCE_FAILED', 503);
    let entries;
    try { entries = await response.json(); } catch { throw historyError('HISTORY_SOURCE_FAILED', 503); }
    for (const entry of entries) {
      const match = typeof entry?.path === 'string' && entry.path.match(pattern);
      if (match) files.push({ key: match[1], path: entry.path, size: entry.size ?? null });
    }
    next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return files.sort((a, b) => a.key.localeCompare(b.key));
}

export async function listHfM1Dates(options) {
  return (await listHfTree('db/m1_live', /^db\/m1_live\/(\d{4}-\d{2}-\d{2})\.parquet$/, options)).map((file) => ({ date: file.key, path: file.path, size: file.size }));
}

export async function listHfD1Months(options) {
  return (await listHfTree('db/d1', /^db\/d1\/(\d{4}_\d{2})\.parquet$/, options)).map((file) => ({ month: file.key.replace('_', '-'), path: file.path, size: file.size }));
}

// Daily bars of one monthly D1 file → rows { symbol, date (YYYY-MM-DD), open, high, low, close, volume }.
export async function readD1Rows(path, { maxAgeSeconds = 7 * 86400, symbols = null, downloadImpl = downloadHfAsset } = {}) {
  const downloaded = await downloadImpl(path, { maxAgeSeconds });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file, compressors, columns: COLUMNS });
  const out = [];
  for (const row of rows) {
    const symbol = String(row.stock_id);
    if (symbols && !symbols.has(symbol)) continue;
    const date = dailyDate(row.date);
    const close = roundPrice(row.close);
    if (!date || !Number.isFinite(close)) continue;
    if (!readD1Rows.sampled) { readD1Rows.sampled = true; console.log(`history: D1 date column sample ${typeof row.date} ${String(row.date).slice(0, 40)} → ${date}`); }
    out.push({ symbol, date, open: finitePrice(row.open), high: finitePrice(row.high), low: finitePrice(row.low), close, volume: row.volume == null ? null : Number(row.volume) });
  }
  return out;
}

// A daily bar's trading date (YYYY-MM-DD, Taipei) from whatever the D1 file stores: a Date, an ISO / 'YYYY-MM-DD'
// string, a parquet DATE (days since 1970), a YYYYMMDD integer, or epoch seconds / ms / µs / ns.
export function dailyDate(value) {
  if (value == null) return null;
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (Number.isInteger(value) && value >= 19_000_101 && value <= 29_991_231) { const text = String(value); return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`; }
    if (Math.abs(value) < 200_000) return new Date(value * 86_400_000).toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (typeof value === 'string' && /^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 10) : null;
}

export async function listHfM1Months(options) {
  return (await listHfTree('db/m1', /^db\/m1\/(\d{4}_\d{2})\.parquet$/, options)).map((file) => ({ month: file.key.replace('_', '-'), path: file.path, size: file.size }));
}

// ---- Bar collection -------------------------------------------------------------------------
// Bars are kept as flat number arrays per (trading date, symbol) to keep memory low when the
// scope is the whole system universe (hundreds of stocks × 30 days × 270 bars).

export class BarCollector {
  // fromDate (YYYY-MM-DD, optional) drops bars before that day at ingest, so a whole month file
  // doesn't have to sit in memory when only the last few trading days are wanted.
  constructor(symbols, { fromDate = null } = {}) { this.symbols = symbols; this.days = new Map(); this.fromDate = fromDate; }
  // open/high/low are optional (formula blocks read them; missing values evaluate as null).
  add(symbol, startMs, close, volume, open = null, high = null, low = null) {
    const local = startMs + TAIPEI_OFFSET_MS;
    const minute = Math.floor(local / 60000) % 1440;
    const weekday = new Date(local).getUTCDay();
    if (weekday === 0 || weekday === 6 || minute < SESSION_OPEN || minute > SESSION_CLOSE) return;
    const date = new Date(local).toISOString().slice(0, 10);
    if (this.fromDate && date < this.fromDate) return;
    let bySymbol = this.days.get(date);
    if (!bySymbol) this.days.set(date, bySymbol = new Map());
    let series = bySymbol.get(symbol);
    if (!series) bySymbol.set(symbol, series = { t: [], o: [], h: [], l: [], c: [], v: [] });
    series.t.push(startMs + 60_000); series.o.push(open); series.h.push(high); series.l.push(low); series.c.push(close); series.v.push(volume);
  }
  dates() { return [...this.days.keys()].sort(); }
  // Materialises sorted, de-duplicated bar objects for one day.
  barsFor(date) {
    const result = new Map();
    for (const [symbol, series] of this.days.get(date) || []) {
      const order = series.t.map((_, index) => index).sort((a, b) => series.t[a] - series.t[b]);
      const bars = [];
      for (const index of order) {
        if (bars.length && bars.at(-1).barEnd === series.t[index]) continue;
        bars.push({ barEnd: series.t[index], open: series.o[index], high: series.h[index], low: series.l[index], close: series.c[index], volume: series.v[index] });
      }
      result.set(symbol, bars);
    }
    return result;
  }
  drop(date) { this.days.delete(date); }
}

// Timestamps may arrive as Date, string (naive strings are Taipei time) or epoch numbers.
export function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'bigint') value = Number(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return NaN;
    if (value > 1e17) return value / 1e6;
    if (value > 1e14) return value / 1e3;
    if (value > 1e11) return value;
    return value * 1000;
  }
  const text = String(value);
  if (/[T]/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/.test(text)) return new Date(text).getTime();
  return new Date(`${text.replace(' ', 'T')}+08:00`).getTime();
}

// Some exports store Taipei wall-clock time as if it were UTC. Detect that from a sample:
// if almost nothing lands in the 09:00–13:30 session but shifting by -8h fixes it, shift.
export function detectShift(samples) {
  if (samples.length < 50) return 0;
  const inSession = (ms) => { const minute = Math.floor((ms + TAIPEI_OFFSET_MS) / 60000) % 1440; return minute >= SESSION_OPEN && minute <= SESSION_CLOSE; };
  const raw = samples.filter(inSession).length / samples.length;
  const shifted = samples.filter((ms) => inSession(ms - TAIPEI_OFFSET_MS)).length / samples.length;
  return raw < 0.5 && shifted > 0.8 ? -TAIPEI_OFFSET_MS : 0;
}

export function collectRows(rows, collector, state = { shift: null, samples: [] }) {
  for (const row of rows) collectRow(row.stock_id, row.date, row.open, row.high, row.low, row.close, row.volume, collector, state);
  return state;
}
function collectRow(stockId, dateValue, openValue, highValue, lowValue, closeValue, volumeValue, collector, state) {
  {
    const symbol = String(stockId);
    if (!collector.symbols.has(symbol)) return;
    const start = toMs(dateValue);
    const close = roundPrice(closeValue);
    if (!Number.isFinite(start) || !Number.isFinite(close)) return;
    const volume = volumeValue == null ? null : Number(volumeValue);
    const open = finitePrice(openValue), high = finitePrice(highValue), low = finitePrice(lowValue);
    if (state.shift === null) {
      state.samples.push({ symbol, start, close, volume, open, high, low });
      if (state.samples.length < 500) return;
      flushSamples(collector, state);
      return;
    }
    collector.add(symbol, start + state.shift, close, volume, open, high, low);
  }
}

function flushSamples(collector, state) {
  if (state.shift === null) state.shift = detectShift(state.samples.map((item) => item.start));
  for (const item of state.samples) collector.add(item.symbol, item.start + state.shift, item.close, item.volume, item.open, item.high, item.low);
  state.samples = [];
}

function finitePrice(value) { const price = roundPrice(value); return Number.isFinite(price) ? price : null; }

function statValue(stats, key) {
  let value = stats?.[`${key}_value`] ?? stats?.[key];
  if (value instanceof Uint8Array) value = new TextDecoder().decode(value);
  if (typeof value === 'bigint') value = Number(value);
  return value ?? null;
}

// Uses row-group min/max statistics on stock_id to skip groups that cannot hold a wanted symbol.
export function rowGroupRanges(metadata, symbols) {
  const ranges = [];
  let start = 0;
  const wanted = [...symbols];
  for (const group of metadata.row_groups || []) {
    const rows = Number(group.num_rows);
    const column = group.columns?.find((item) => (item.meta_data?.path_in_schema || []).join('.') === 'stock_id');
    const min = statValue(column?.meta_data?.statistics, 'min');
    const max = statValue(column?.meta_data?.statistics, 'max');
    let keep = true;
    if (min !== null && max !== null) {
      const numeric = typeof min === 'number';
      keep = wanted.some((symbol) => {
        const value = numeric ? Number(symbol) : symbol;
        return numeric && !Number.isFinite(value) ? true : value >= min && value <= max;
      });
    }
    if (keep && rows > 0) ranges.push({ rowStart: start, rowEnd: start + rows });
    start += rows;
  }
  return ranges;
}

// Reads one row group at a time as columns (hyparquet onChunk, no onComplete) instead of materialising
// millions of row objects: a month file for the whole universe used to exhaust the heap.
export async function readParquetInto(path, collector, { maxAgeSeconds, downloadImpl = downloadHfAsset } = {}) {
  const downloaded = await downloadImpl(path, { maxAgeSeconds });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const metadata = await parquetMetadataAsync(file);
  const state = { shift: null, samples: [] };
  for (const range of rowGroupRanges(metadata, collector.symbols)) {
    const chunks = new Map(COLUMNS.map((name) => [name, []]));
    await parquetRead({ file, metadata, compressors, columns: COLUMNS, ...range, onChunk: (chunk) => { chunks.get(chunk.columnName)?.push(chunk); } });
    const column = Object.fromEntries(COLUMNS.map((name) => [name, columnAccessor(chunks.get(name), range.rowStart)]));
    for (let row = range.rowStart; row < range.rowEnd; row++) {
      collectRow(column.stock_id(row), column.date(row), column.open(row), column.high(row), column.low(row), column.close(row), column.volume(row), collector, state);
    }
    chunks.clear();
  }
  flushSamples(collector, state);
}
// Sequential reader over a column's chunks (each {rowStart,rowEnd,columnData}); chunk.rowStart is file-absolute.
function columnAccessor(chunkList, rangeStart) {
  const sorted = [...(chunkList || [])].sort((a, b) => a.rowStart - b.rowStart);
  let index = 0;
  return (row) => {
    while (index < sorted.length && row >= sorted[index].rowEnd) index++;
    while (index > 0 && row < sorted[index - 1].rowEnd && row >= sorted[index - 1].rowStart) index--;
    const chunk = sorted[index];
    if (!chunk || row < chunk.rowStart) return undefined;
    return chunk.columnData[row - chunk.rowStart];
  };
}

// ---- Evaluation ---------------------------------------------------------------------------

// Indexes of bars where the strategy fires, before cooldown.
export function crossingIndexes(strategy, bars) {
  if (strategy.executor === 'rsi_wilder_cross') {
    const { period, threshold } = strategy.params;
    const values = wilderRsi(bars.map((bar) => bar.close), period);
    const hits = [];
    for (let index = 1; index < values.length; index++) {
      if (values[index - 1] != null && values[index] != null && values[index - 1] <= threshold && values[index] > threshold) hits.push(index);
    }
    return hits;
  }
  let ast;
  if (strategy.executor === 'formula_v1') ast = strategy.formula.ast;
  else if (strategy.executor === 'sma_cross') ast = { op: 'crosses_above', left: { op: 'source', field: 'close' }, right: { op: 'sma', input: { op: 'source', field: 'close' }, period: strategy.params.period } };
  else throw historyError('HISTORY_EXECUTOR_UNSUPPORTED', 422);
  const values = evaluateFormulaSeries(ast, bars);
  const hits = [];
  values.forEach((value, index) => { if (value === true) hits.push(index); });
  return hits;
}

// Splits at data gaps like the live engine, then applies the per-day cooldown.
export function dayEvents(strategy, bars) {
  const segments = [];
  let current = [];
  for (const bar of bars) {
    if (current.length && bar.barEnd - current.at(-1).barEnd > GAP_MS) { segments.push(current); current = []; }
    current.push(bar);
  }
  if (current.length) segments.push(current);
  const events = [];
  let lastSignal = -Infinity;
  for (const segment of segments) {
    for (const index of crossingIndexes(strategy, segment)) {
      const bar = segment[index];
      if (bar.barEnd - lastSignal < COOLDOWN_MS) continue;
      lastSignal = bar.barEnd;
      events.push(bar);
    }
  }
  return events;
}

function taipeiDate(date) { return new Date(date.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10); }

export async function collectHistory(symbols, { days = HISTORY_DAYS, now = new Date(), listDates = listHfM1Dates, listMonths = listHfM1Months, readImpl = readParquetInto, onProgress = () => {} } = {}) {
  const today = taipeiDate(now);
  const collector = new BarCollector(symbols);
  const failed = [];
  onProgress({ stage: 'list', message: '取得資料清單' });
  const liveDays = (await listDates()).filter((file) => file.date <= today);
  const liveDates = new Set();
  for (const file of liveDays) {
    const day = new BarCollector(symbols);
    onProgress({ stage: 'day', message: `讀取 ${file.date} 盤中資料`, sizeBytes: file.size });
    try { await readImpl(file.path, day, { maxAgeSeconds: file.date === today ? 60 : 7 * 86400 }); }
    catch { failed.push(file.date); continue; }
    liveDates.add(file.date);
    for (const [date, bySymbol] of day.days) if (date === file.date) collector.days.set(date, bySymbol);
  }
  const months = (await listMonths()).filter((file) => file.month <= today.slice(0, 7)).reverse().slice(0, MAX_MONTHS);
  const monthsRead = [];
  // Only the trailing window can matter: 7 trading days fit in ~3 calendar weeks even around holidays.
  const fromDate = taipeiDate(new Date(now.getTime() - (days * 3 + 7) * 86_400_000));
  for (const file of months) {
    if (collector.days.size >= days) break;
    const month = new BarCollector(symbols, { fromDate });
    onProgress({ stage: 'month', message: `讀取 ${file.month} 月資料（約 ${Math.max(1, Math.round((file.size || 0) / 1048576))} MB）`, sizeBytes: file.size });
    try { await readImpl(file.path, month, { maxAgeSeconds: file.month === today.slice(0, 7) ? 3600 : 7 * 86400 }); }
    catch { failed.push(file.month); continue; }
    monthsRead.push(file.month);
    for (const [date, bySymbol] of month.days) if (!liveDates.has(date) && date <= today && !collector.days.has(date)) collector.days.set(date, bySymbol);
  }
  const dates = collector.dates();
  for (const date of dates.slice(0, Math.max(0, dates.length - days))) collector.drop(date);
  return { collector, failed, sources: { liveDays: [...liveDates].sort(), months: monthsRead } };
}

export async function runHistory(strategy, watchlist, options = {}) {
  const started = Date.now();
  const names = new Map(watchlist.map((item) => [item.symbol, item.name || item.symbol]));
  const { collector, failed, sources } = await collectHistory(new Set(names.keys()), options);
  options.onProgress?.({ stage: 'evaluate', message: '套用條件計算觸發點' });
  const summary = [], events = [];
  let total = 0;
  for (const date of collector.dates()) {
    let count = 0;
    for (const [symbol, bars] of collector.barsFor(date)) {
      for (const bar of dayEvents(strategy, bars)) {
        count++;
        events.push({ date, at: new Date(bar.barEnd).toISOString(), symbol, name: names.get(symbol), price: bar.close });
      }
    }
    total += count;
    summary.push({ date, count });
    collector.drop(date);
  }
  events.sort((a, b) => b.at.localeCompare(a.at) || a.symbol.localeCompare(b.symbol));
  return {
    strategyName: strategy.name,
    symbolsCount: names.size,
    days: summary.reverse(),
    availableDays: summary.length,
    failedDays: failed.length,
    failedSources: failed,
    sources,
    totalEvents: total,
    truncated: events.length > MAX_EVENTS,
    events: events.slice(0, MAX_EVENTS),
    elapsedMs: Date.now() - started
  };
}

function historyError(code, statusCode = 500) { return Object.assign(new Error(code), { code, statusCode }); }

// Verdict on a history result (PM decision: a condition that never triggers, or triggers far too often, is not
// usable for notifications and is blocked before it is applied). Attached to every done history result so the
// backtest and the vet flow share one shape. Threshold: VET_MAX_PER_SYMBOL_DAY average triggers per symbol per
// trading day (default 10).
export const VET_MAX_PER_SYMBOL_DAY_DEFAULT = 10;
export function vetMaxPerSymbolDay(env = process.env) { const value = Number(env.VET_MAX_PER_SYMBOL_DAY); return Number.isFinite(value) && value > 0 ? value : VET_MAX_PER_SYMBOL_DAY_DEFAULT; }
export function historyVerdict(result, { maxPerSymbolDay = vetMaxPerSymbolDay() } = {}) {
  const totalEvents = Number(result?.totalEvents) || 0, symbolsCount = Number(result?.symbolsCount) || 0, availableDays = Number(result?.availableDays) || 0;
  const perSymbolPerDay = symbolsCount && availableDays ? Number((totalEvents / (symbolsCount * availableDays)).toFixed(2)) : 0;
  const base = { perSymbolPerDay, totalEvents, symbolsCount, availableDays, maxPerSymbolDay };
  if (availableDays === 0) return { ok: false, code: 'no_data', ...base, message: `過去 ${HISTORY_DAYS} 個交易日沒有可用的歷史資料，無法確認這個條件的觸發頻率。` };
  if (totalEvents === 0) return { ok: false, code: 'no_triggers', ...base, message: `過去 ${availableDays} 個交易日沒有任何觸發，這個條件可能太嚴格或定義有誤。` };
  if (perSymbolPerDay > maxPerSymbolDay) return { ok: false, code: 'too_many', ...base, message: `平均每檔每天觸發 ${perSymbolPerDay} 次，太頻繁，無法用來通知。` };
  return { ok: true, code: 'ok', ...base, message: `過去 ${availableDays} 個交易日共觸發 ${totalEvents} 次，平均每檔每天 ${perSymbolPerDay} 次。` };
}
