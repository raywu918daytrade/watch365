// 30-trading-day M1 history lookup: replays a strategy over the HF daily one-minute files
// (db/m1_live/YYYY-MM-DD.parquet) with the same rules as the live engine:
// regular session only, no warm-up across days, data gaps > 2 minutes restart the series,
// and a 30-minute cooldown per stock per day.
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { downloadHfAsset, loadHfConfig } from './hfAdapter.js';
import { evaluateFormulaSeries } from './formulaEngine.js';
import { wilderRsi } from './indicatorEngine.js';

export const HISTORY_DAYS = 30;
const COOLDOWN_MS = 30 * 60 * 1000;
const GAP_MS = 120_000;
const MAX_EVENTS = 300;
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const SESSION_OPEN = 9 * 60, SESSION_CLOSE = 13 * 60 + 30;
const DATE_FILE = /^db\/m1_live\/(\d{4}-\d{2}-\d{2})\.parquet$/;

export async function listHfM1Dates({ config, fetchImpl = fetch } = {}) {
  const credentials = config || await loadHfConfig();
  const encodedRepo = credentials.repoId.split('/').map(encodeURIComponent).join('/');
  let next = `https://huggingface.co/api/datasets/${encodedRepo}/tree/main/${encodeURIComponent('db/m1_live')}?limit=1000`;
  const files = [];
  for (let page = 0; next && page < 20; page++) {
    let response;
    try { response = await fetchImpl(next, { headers: { Authorization: `Bearer ${credentials.token}` } }); }
    catch { throw historyError('HISTORY_SOURCE_FAILED', 503); }
    if (response.status === 401 || response.status === 403) throw historyError('HF_UNAUTHORIZED', 503);
    if (!response.ok) throw historyError('HISTORY_SOURCE_FAILED', 503);
    const entries = await response.json().catch(() => { throw historyError('HISTORY_SOURCE_FAILED', 503); });
    for (const entry of entries) {
      const match = typeof entry?.path === 'string' && entry.path.match(DATE_FILE);
      if (match) files.push({ date: match[1], path: entry.path, size: entry.size ?? null });
    }
    next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] || null;
  }
  return files.sort((a, b) => a.date.localeCompare(b.date));
}

// Minutes since midnight in Taipei (UTC+8, no DST) and weekday, without Intl per bar.
function taipeiMinute(ms) {
  const local = ms + TAIPEI_OFFSET_MS;
  const minute = Math.floor(local / 60000) % 1440;
  const weekday = new Date(local).getUTCDay();
  return { minute, weekday };
}

function parseBarStart(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value);
  return (text.includes('T') ? new Date(text) : new Date(`${text.replace(' ', 'T')}+08:00`)).getTime();
}

// Returns Map<symbol, [{barEnd, close, volume}]> restricted to the regular session.
export async function readDayBars(file, symbols, { today, downloadImpl = downloadHfAsset } = {}) {
  const downloaded = await downloadImpl(file.path, { maxAgeSeconds: file.date === today ? 60 : 7 * 86400 });
  const buffer = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file: buffer, compressors, columns: ['stock_id', 'date', 'close', 'volume'] });
  return groupRows(rows, symbols);
}

export function groupRows(rows, symbols) {
  const bySymbol = new Map();
  for (const row of rows) {
    const symbol = String(row.stock_id);
    if (!symbols.has(symbol)) continue;
    const start = parseBarStart(row.date);
    if (!Number.isFinite(start)) continue;
    const { minute, weekday } = taipeiMinute(start);
    if (weekday === 0 || weekday === 6 || minute < SESSION_OPEN || minute > SESSION_CLOSE) continue;
    const close = Number(row.close), volume = Number(row.volume);
    if (!Number.isFinite(close)) continue;
    let list = bySymbol.get(symbol);
    if (!list) bySymbol.set(symbol, list = []);
    list.push({ barEnd: start + 60_000, close, volume: Number.isFinite(volume) ? volume : null });
  }
  for (const list of bySymbol.values()) list.sort((a, b) => a.barEnd - b.barEnd);
  return bySymbol;
}

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

export async function runHistory(strategy, watchlist, { days = HISTORY_DAYS, listImpl = listHfM1Dates, readImpl = readDayBars, now = new Date() } = {}) {
  const started = Date.now();
  const today = new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);
  const files = (await listImpl()).filter((file) => file.date <= today).slice(-days);
  const names = new Map(watchlist.map((item) => [item.symbol, item.name || item.symbol]));
  const symbols = new Set(names.keys());
  const summary = [], events = [];
  let total = 0, failedDays = 0;
  for (const file of files) {
    let bySymbol;
    try { bySymbol = await readImpl(file, symbols, { today }); }
    catch { failedDays++; summary.push({ date: file.date, count: null }); continue; }
    let count = 0;
    for (const [symbol, bars] of bySymbol) {
      for (const bar of dayEvents(strategy, bars)) {
        count++;
        events.push({ date: file.date, at: new Date(bar.barEnd).toISOString(), symbol, name: names.get(symbol), price: bar.close });
      }
    }
    total += count;
    summary.push({ date: file.date, count });
  }
  events.sort((a, b) => b.at.localeCompare(a.at) || a.symbol.localeCompare(b.symbol));
  return {
    strategyName: strategy.name,
    symbolsCount: symbols.size,
    days: summary.reverse(),
    availableDays: files.length,
    failedDays,
    totalEvents: total,
    truncated: events.length > MAX_EVENTS,
    events: events.slice(0, MAX_EVENTS),
    elapsedMs: Date.now() - started
  };
}

function historyError(code, statusCode = 500) { return Object.assign(new Error(code), { code, statusCode }); }
