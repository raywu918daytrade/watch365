// Condition example chart (owner decision 2026-10): one candlestick example of what the stock looks like when ALL
// selected filters hold, so a customer can check that the condition means what they think. Any stock, unnamed.
// Search order: the full daily (D1) history of every stock, newest first; if no stock ever met the combination on
// daily bars (or the condition only makes sense within a session: VWAP / first-bar blocks), the 7-day one-minute
// index. Only the bars where the whole combination becomes met are marked (same trigger walk as notifications).
import { evaluateFormulaSet, formulaChildren, formulaFingerprint, formulaSummary, validateFormula } from './formulaEngine.js';
import { conditionKind } from './conditionState.js';
import { REARM_BARS, ruleTriggerIndexes } from './ruleState.js';

const MAX_EVAL_BARS = 512;
const BEFORE = { d1:60, m1:60 }, AFTER = { d1:15, m1:20 };
const COMPARE = new Set(['crosses_above', 'crosses_below', 'gte', 'lte', 'gt', 'lt']);
const PRICE_FIELDS = new Set(['open', 'high', 'low', 'close']);

// All daily bars per stock as typed arrays, kept in the long-lived index worker.
export class DailyStore {
  constructor() { this.pending = new Map(); this.series = new Map(); this.months = new Set(); }
  // rows of one monthly file; a month read again (the current month as it grows) replaces nothing, duplicates by date
  // are dropped when merged (the newer row wins).
  add(month, rows) {
    this.months.add(month);
    for (const row of rows) { let list = this.pending.get(row.symbol); if (!list) this.pending.set(row.symbol, list = []); list.push(row); }
  }
  finalize() {
    if (!this.pending.size) return this.series;
    for (const [symbol, added] of this.pending) {
      const current = this.series.get(symbol);
      const byDate = new Map();
      if (current) current.dates.forEach((date, index) => byDate.set(date, { date, open:num(current.o[index]), high:num(current.h[index]), low:num(current.l[index]), close:num(current.c[index]), volume:num(current.v[index]) }));
      for (const row of added) byDate.set(row.date, row);
      const list = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
      const field = (name) => Float64Array.from(list, (row) => (Number.isFinite(row[name]) ? row[name] : NaN));
      this.series.set(symbol, { dates:list.map((row) => row.date), o:field('open'), h:field('high'), l:field('low'), c:field('close'), v:field('volume') });
    }
    this.pending.clear();
    return this.series;
  }
  stats() { const series = this.finalize(); let bars = 0; for (const item of series.values()) bars += item.dates.length; return { months:this.months.size, symbols:series.size, bars }; }
}

// filters: [{ key, ast }]. Returns the example or null.
export function findExample({ filters, daily = null, index = null, rearmBars = REARM_BARS }) {
  if (!filters.length) return null;
  const asts = filters.map((item) => validateFormula(item.ast).ast);
  const kind = asts.some((ast) => conditionKind(ast) === 'event') ? 'event' : 'level';
  const sessionOnly = asts.some(usesSessionBlocks);
  if (daily && !sessionOnly) { const found = searchDaily(daily, asts, kind, rearmBars[kind]); if (found) return found; }
  if (index) return searchMinute(index, filters, asts, kind, rearmBars[kind]);
  return null;
}

function searchDaily(daily, asts, kind, rearm) {
  const series = daily.finalize();
  const warmup = Math.max(...asts.map((ast) => validateFormula(ast).warmupBars));
  const step = Math.max(1, MAX_EVAL_BARS - warmup);
  const longest = Math.max(0, ...[...series.values()].map((item) => item.dates.length));
  let overall = null;
  for (let window = 0; window * step < longest; window++) {
    let best = null;
    for (const [symbol, item] of series) {
      const end = item.dates.length - window * step; if (end <= 0) continue;
      const start = Math.max(0, end - MAX_EVAL_BARS);
      const bars = barsOf(item, start, end);
      let values; try { values = evaluateFormulaSet(asts, bars); } catch { continue; }
      const truth = bars.map((_, bar) => allMet(values, bar));
      const minBar = start === 0 ? 0 : warmup;   // the overlap re-warms; earlier hits belong to the next window
      const hits = ruleTriggerIndexes(truth, rearm, kind, bars.map((_, bar) => bar * 60_000)).filter((bar) => bar >= minBar);
      if (!hits.length) continue;
      const pick = bestFocus(bars, hits, 'd1'); if (!pick) continue;
      const date = item.dates[start + pick.focus];
      if (better(pick, date, best)) best = { ...pick, symbol, date, start, end, hits, item };
    }
    if (best && better(best, best.date, overall)) overall = best;
    if (overall?.good) break;   // the newest window holding a readable example wins
  }
  if (!overall) return null;
  return chart({ timeframe:'d1', bars:barsOf(overall.item, overall.start, overall.end), labels:overall.item.dates.slice(overall.start, overall.end), hits:overall.hits, focus:overall.focus, asts });
}

function searchMinute(index, filters, asts, kind, rearm) {
  let best = null;
  for (const date of index.dates().reverse()) {
    const day = index.days.get(date);
    for (const [symbol, series] of day) {
      const sets = filters.map((item) => index.conditions.get(item.key)?.truth.get(date)?.get(symbol));
      if (sets.some((set) => !set)) continue;
      const n = series.t.length;
      const truth = Array.from({ length:n }, (_, bar) => { const byte = bar >> 3, bit = 1 << (bar & 7); let met = true; for (const set of sets) { if (!(set.known[byte] & bit)) return null; if (!(set.value[byte] & bit)) met = false; } return met; });
      const hits = ruleTriggerIndexes(truth, rearm, kind, series.t);
      if (!hits.length) continue;
      const bars = []; for (let bar = 0; bar < n; bar++) bars.push({ high:series.h[bar], low:series.l[bar], close:series.c[bar] });
      const pick = bestFocus(bars, hits, 'm1'); if (!pick) continue;
      if (better(pick, series.t[pick.focus], best)) best = { ...pick, at:series.t[pick.focus], series, hits };
    }
    if (best?.good) break;
  }
  if (!best) return null;
  const { series } = best, bars = [];
  for (let bar = 0; bar < series.t.length; bar++) bars.push({ barEnd:series.t[bar], open:num(series.o[bar]), high:num(series.h[bar]), low:num(series.l[bar]), close:num(series.c[bar]), volume:num(series.v[bar]) });
  const labels = bars.map((bar) => new Date(bar.barEnd + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '));
  return chart({ timeframe:'m1', bars, labels, hits:best.hits, focus:best.focus, asts });
}

// Readability (owner feedback 2026-10: a stock moving one tick at a time shows no shape, so the example says nothing).
// A display window is scored by how many TW price ticks its range spans and how few of its candles are flat
// (high = low). "good" = range ≥ GOOD_TICKS ticks and ≤ 20 % flat candles; among good windows the newest wins,
// otherwise the best-scoring one seen anywhere.
const GOOD_TICKS = { d1:25, m1:12 }, MAX_FLAT = 0.2, FOCUS_TRIES = 6;
export function tickSize(price) { return price < 10 ? 0.01 : price < 50 ? 0.05 : price < 100 ? 0.1 : price < 500 ? 0.5 : price < 1000 ? 1 : 5; }
export function readability(bars, from, to, timeframe) {
  let hi = -Infinity, lo = Infinity, flat = 0, n = 0;
  for (let bar = from; bar < to; bar++) {
    const { high, low } = bars[bar]; if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
    n++; if (high > hi) hi = high; if (low < lo) lo = low;
    if (high - low < tickSize(low) / 2) flat++;
  }
  if (n < 5) return { score:0, good:false };
  const ticks = (hi - lo) / tickSize((hi + lo) / 2), flatShare = flat / n, target = GOOD_TICKS[timeframe];
  return { score:Math.min(ticks / target, 2) * (1 - flatShare), good:ticks >= target && flatShare <= MAX_FLAT };
}
function windowOf(focus, length, timeframe) { return [Math.max(0, focus - BEFORE[timeframe]), Math.min(length, focus + AFTER[timeframe] + 1)]; }
function bestFocus(bars, hits, timeframe) {
  let best = null;
  for (const focus of hits.slice(-FOCUS_TRIES).reverse()) {
    const [from, to] = windowOf(focus, bars.length, timeframe);
    const quality = readability(bars, from, to, timeframe);
    if (!best || (quality.good && !best.good) || (quality.good === best.good && quality.score > best.score)) best = { focus, ...quality };
  }
  return best;
}
// good beats not good; among good the newer wins (score breaks ties); among not good the higher score wins.
function better(pick, when, best) {
  if (!best) return true;
  if (pick.good !== best.good) return pick.good;
  if (pick.good) { const was = best.date ?? best.at; return when > was || (when === was && pick.score > best.score); }
  return pick.score > best.score;
}

// Display window around the latest hit, candles, the operands of every comparison as lines (price panel or a sub
// panel by scale), constants as threshold lines, and markers on every hit in the window.
function chart({ timeframe, bars, labels, hits, focus = hits.at(-1), asts }) {
  const [from, to] = windowOf(focus, bars.length, timeframe);
  const shown = bars.slice(from, to);
  const operands = [], thresholds = [];
  const seen = new Set();
  for (const ast of asts) walkCompare(ast, (left, right) => {
    for (const [node, other] of [[left, right], [right, left]]) {
      if (node.op === 'constant') { if (other.op !== 'constant') thresholds.push({ value:node.value, against:formulaFingerprint(other) }); continue; }
      if (node.op === 'source' && PRICE_FIELDS.has(node.field)) continue;   // the candle itself
      const key = formulaFingerprint(node); if (seen.has(key)) continue; seen.add(key);
      operands.push({ key, node });
    }
  });
  let values = [];
  try { values = evaluateFormulaSet(operands.map((item) => item.node), bars.slice(Math.max(0, bars.length - MAX_EVAL_BARS))); } catch { values = operands.map(() => []); }
  const offset = Math.max(0, bars.length - MAX_EVAL_BARS);
  const priceMid = median(shown.map((bar) => bar.close).filter(Number.isFinite));
  const panels = { price:[] }, scales = [];
  operands.forEach((item, position) => {
    const series = shown.map((_, bar) => { const value = values[position]?.[from + bar - offset]; return Number.isFinite(value) ? round(value) : null; });
    const mid = median(series.filter(Number.isFinite).map(Math.abs));
    if (!Number.isFinite(mid)) return;
    const line = { key:item.key, label:safeSummary(item.node), values:series };
    if (priceMid && mid / priceMid > 0.6 && mid / priceMid < 1.6) { panels.price.push(line); return; }
    const scale = Math.round(Math.log10(Math.max(mid, 1e-9)));
    let panel = scales.find((entry) => entry.scale === scale);
    if (!panel) { if (scales.length >= 2) return; panel = { scale, lines:[], thresholds:[] }; scales.push(panel); }
    panel.lines.push(line);
  });
  for (const threshold of thresholds) {
    const panel = scales.find((entry) => entry.lines.some((line) => line.key === threshold.against));
    if (panel && !panel.thresholds.includes(threshold.value)) panel.thresholds.push(threshold.value);
  }
  return {
    timeframe,
    candles:shown.map((bar, position) => ({ label:labels[from + position], open:bar.open, high:bar.high, low:bar.low, close:bar.close })),
    price:panels.price,
    panels:scales.map(({ lines, thresholds:levels }) => ({ lines, thresholds:levels })),
    markers:hits.filter((bar) => bar >= from && bar < to).map((bar) => bar - from)
  };
}

function walkCompare(node, visit) {
  if (COMPARE.has(node.op)) { visit(node.left, node.right); return; }
  for (const child of formulaChildren(node)) walkCompare(child, visit);
}
function usesSessionBlocks(node) { return node.op === 'cumsum' || node.op === 'first' || formulaChildren(node).some(usesSessionBlocks); }
function allMet(values, bar) { let met = true; for (const list of values) { const value = list[bar]; if (typeof value !== 'boolean') return null; if (!value) met = false; } return met; }
function barsOf(item, start, end) { const out = []; for (let index = start; index < end; index++) out.push({ barEnd:index * 86_400_000, open:num(item.o[index]), high:num(item.h[index]), low:num(item.l[index]), close:num(item.c[index]), volume:num(item.v[index]) }); return out; }
function median(values) { if (!values.length) return NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function num(value) { return Number.isNaN(value) ? null : value; }
function round(value) { return Math.round(value * 10000) / 10000; }
function safeSummary(node) { try { return formulaSummary(node); } catch { return ''; } }
