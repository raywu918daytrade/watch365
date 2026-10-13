// Daily (D1) condition index (owner decision 2026-10: a monitor may filter on daily candles, on 1-minute candles, or
// both, in that order). Every daily condition is evaluated ONCE per stock over its recent daily history and the result
// of the last DAYS trading dates is kept as met / not met; picking daily filters is then an AND of stored results.
//
// Meaning of "met on date D": the condition holds on D's daily close. With D1 + M1, the stocks met on the last daily
// date BEFORE a minute-bar day form that day's list (yesterday's close → today's list). A D1-only monitor notifies once
// after the close, on the days where the combination becomes met (not met the trading day before).
import { evaluateFormulaSet, formulaChildren, validateFormula } from './formulaEngine.js';

export const DAILY_DAYS = 7;
// Forward return shown while picking daily filters (owner ask 2026-10-13): over the last STAT_DAYS trading dates, every
// (stock, date) where the combination was met is a sample; its return is the close FORWARD_DAYS trading days later
// against that day's close. The last FORWARD_DAYS dates have no outcome yet, so met/not met is kept for a window of
// STAT_DAYS + FORWARD_DAYS dates, of which the last DAILY_DAYS are the monitor's view.
export const FORWARD_DAYS = 7;
export const STAT_DAYS = 60;
const EVAL_BARS = 400;   // enough history for the longest preset (60-day averages, 52-day Ichimoku) plus warmup

// Session-only blocks (VWAP's cumulative sums, the day's first bar) have no meaning on daily candles.
export function dailyCapable(ast) { return !usesSessionBlocks(ast); }
function usesSessionBlocks(node) { return node.op === 'cumsum' || node.op === 'first' || formulaChildren(node).some(usesSessionBlocks); }

export class DailyIndex {
  constructor({ days = DAILY_DAYS } = {}) {
    this.days = days;
    this.series = null;          // Map(symbol → { dates, o, h, l, c, v }) from DailyStore.finalize()
    this.window = [];            // the last STAT_DAYS + FORWARD_DAYS trading dates (ascending); met/not met is kept for these
    this.dates = [];             // the last `days` of them: the monitor's view
    this.forwardReturns = new Map(); // symbol → Float64Array(window): close FORWARD_DAYS bars later / close − 1, NaN when unknown
    this.conditions = new Map(); // key → { key, ast, met: Map(symbol → Uint8Array(window)) }  1 met, 0 not, 2 unknown
  }

  // series: Map(symbol → { dates, o, h, l, c, v }). Recomputes every known condition on the new data.
  setSeries(series) {
    this.series = series;
    const size = Math.max(this.days, STAT_DAYS + FORWARD_DAYS), all = new Set();
    for (const item of series.values()) for (const date of item.dates.slice(-size)) all.add(date);
    this.window = [...all].sort().slice(-size);
    this.dates = this.window.slice(-this.days);
    this.forwardReturns = new Map();
    for (const [symbol, item] of series) {
      const position = new Map(item.dates.map((date, index) => [date, index]));
      const out = new Float64Array(this.window.length).fill(NaN);
      this.window.forEach((date, slot) => {
        const at = position.get(date); if (at === undefined || at + FORWARD_DAYS >= item.dates.length) return;
        const from = item.c[at], to = item.c[at + FORWARD_DAYS];
        if (Number.isFinite(from) && from > 0 && Number.isFinite(to)) out[slot] = to / from - 1;
      });
      this.forwardReturns.set(symbol, out);
    }
    const known = [...this.conditions.values()];
    this.conditions.clear();
    this.ensure(known);
  }
  ready() { return Boolean(this.series); }
  latestDate() { return this.dates.at(-1) ?? null; }

  // skipUnsupported: leave session-only conditions out instead of failing (list candidates; they count as 0).
  ensure(conditions, { skipUnsupported = false } = {}) {
    if (!this.series) return 0;
    const missing = [];
    for (const { key, ast } of conditions) {
      if (this.conditions.has(key) || missing.some((item) => item.key === key)) continue;
      const validated = validateFormula(ast);
      if (!dailyCapable(validated.ast) && skipUnsupported) continue;
      if (!dailyCapable(validated.ast)) throw Object.assign(new Error('DAILY_CONDITION_UNSUPPORTED'), { code:'DAILY_CONDITION_UNSUPPORTED', key, statusCode:422 });
      missing.push({ key, ast:validated.ast, met:new Map() });
    }
    if (!missing.length) return 0;
    const asts = missing.map((item) => item.ast);
    for (const [symbol, item] of this.series) {
      const end = item.dates.length, start = Math.max(0, end - EVAL_BARS);
      const bars = [];
      for (let index = start; index < end; index++) bars.push({ barEnd:Date.parse(`${item.dates[index]}T05:30:00Z`), open:num(item.o[index]), high:num(item.h[index]), low:num(item.l[index]), close:num(item.c[index]), volume:num(item.v[index]) });
      let values; try { values = evaluateFormulaSet(asts, bars); } catch { continue; }
      const position = new Map(); for (let index = start; index < end; index++) position.set(item.dates[index], index - start);
      missing.forEach((condition, which) => {
        const row = new Uint8Array(this.window.length).fill(2);
        this.window.forEach((date, slot) => { const at = position.get(date); if (at === undefined) return; const value = values[which][at]; if (typeof value === 'boolean') row[slot] = value ? 1 : 0; });
        condition.met.set(symbol, row);
      });
    }
    for (const condition of missing) this.conditions.set(condition.key, condition);
    return missing.length;
  }

  // Symbols where every key is met on `date` (one of this.dates), optionally within `symbols`.
  metOn(keys, date, symbols = null) {
    const slot = this.dates.includes(date) ? this.window.indexOf(date) : -1, out = new Set();
    if (slot < 0 || !keys.length) return out;
    const conditions = keys.map((key) => this.#condition(key));
    for (const symbol of this.series.keys()) {
      if (symbols && !symbols.has(symbol)) continue;
      if (conditions.every((condition) => condition.met.get(symbol)?.[slot] === 1)) out.add(symbol);
    }
    return out;
  }

  // The list a minute-bar day uses: stocks met on the last daily date strictly before that day.
  listFor(keys, minuteDate, symbols = null) {
    const before = this.dates.filter((date) => date < minuteDate).at(-1);
    return before ? this.metOn(keys, before, symbols) : new Set();
  }

  // What happened after the combination was met: every (stock, window date) where all keys were met and the close
  // FORWARD_DAYS trading days later is known. { days, samples, dates, mean, winRate } or null without a sample.
  forward(keys, symbols = null) {
    if (!keys.length) return null;
    const conditions = keys.map((key) => this.#condition(key));
    let samples = 0, sum = 0, wins = 0; const dates = new Set();
    for (const symbol of this.series.keys()) {
      if (symbols && !symbols.has(symbol)) continue;
      const returns = this.forwardReturns.get(symbol), rows = conditions.map((condition) => condition.met.get(symbol));
      if (!returns || rows.some((row) => !row)) continue;
      for (let slot = 0; slot < this.window.length; slot++) {
        const value = returns[slot];
        if (Number.isNaN(value) || rows.some((row) => row[slot] !== 1)) continue;
        samples++; sum += value; if (value > 0) wins++; dates.add(slot);
      }
    }
    if (!samples) return null;
    return { days:FORWARD_DAYS, samples, dates:dates.size, mean:sum / samples, winRate:wins / samples };
  }

  // filters: keys in pick order; each step = filters[0..i] all met. Per step: stocks met on the latest date, per-day
  // counts, and "new" = stocks that became met that day (what a D1-only monitor notifies after the close).
  // candidates: keys tried as the next filter (stocks met on the latest date with it added).
  // events: the last step also lists every newly met stock per day ({ date, symbol, price } newest first).
  query({ filters = [], candidates = [], symbols = null, list = false, events = false } = {}) {
    for (const key of filters) this.#condition(key);
    const latest = this.latestDate();
    const steps = filters.map((_, index) => {
      const keys = filters.slice(0, index + 1);
      const perDay = this.dates.map((date) => this.metOn(keys, date, symbols));
      const days = this.dates.map((date, slot) => ({ date, count:perDay[slot].size, newCount:slot ? [...perDay[slot]].filter((symbol) => !perDay[slot - 1].has(symbol)).length : null }));
      const step = { latestCount:perDay.at(-1)?.size ?? 0, days, newEvents:days.reduce((sum, day) => sum + (day.newCount ?? 0), 0), forward:this.forward(keys, symbols) };
      if (list && index === filters.length - 1) step.symbols = [...(perDay.at(-1) || [])].sort();
      if (events && index === filters.length - 1) step.events = this.dates.flatMap((date, slot) => slot ? [...perDay[slot]].filter((symbol) => !perDay[slot - 1].has(symbol)).sort().map((symbol) => ({ date, symbol, price:this.#closeOn(symbol, date) })) : []).reverse();
      return step;
    });
    const candidateResults = candidates.map((key) => { const known = latest && this.conditions.has(key), keys = [...filters, key]; return { key, latestCount:known ? this.metOn(keys, latest, symbols).size : 0, forward:known ? this.forward(keys, symbols) : null }; });
    return { dates:[...this.dates], latestDate:latest, steps, candidates:candidateResults };
  }

  // After the close (D1-only monitors): today's daily bar is not in the history yet, so it is built from today's minute
  // bars (extraBars: Map(symbol → { date, open, high, low, close, volume })) and appended. Returns the stocks where every
  // key is met on that bar but not on the previous daily close (newly met: notified once), with their close.
  closeCheck(keys, extraBars, symbols = null) {
    const conditions = keys.map((key) => this.#condition(key));
    const asts = conditions.map((condition) => condition.ast);
    const newly = [], met = [];
    for (const [symbol, extra] of extraBars) {
      if (symbols && !symbols.has(symbol)) continue;
      const item = this.series.get(symbol); if (!item || !Number.isFinite(extra.close)) continue;
      const end = item.dates.findLastIndex((date) => date < extra.date) + 1;   // the history may already hold today's bar
      const start = Math.max(0, end - EVAL_BARS);
      const bars = [];
      for (let index = start; index < end; index++) bars.push({ barEnd:Date.parse(`${item.dates[index]}T05:30:00Z`), open:num(item.o[index]), high:num(item.h[index]), low:num(item.l[index]), close:num(item.c[index]), volume:num(item.v[index]) });
      bars.push({ barEnd:Date.parse(`${extra.date}T05:30:00Z`), open:extra.open, high:extra.high, low:extra.low, close:extra.close, volume:extra.volume });
      let values; try { values = evaluateFormulaSet(asts, bars); } catch { continue; }
      const now = values.every((list) => list.at(-1) === true), before = bars.length > 1 && values.every((list) => list.at(-2) === true);
      if (now) { met.push(symbol); if (!before) newly.push({ symbol, close:extra.close }); }
    }
    return { met, newly };
  }

  stats() { return { dates:[...this.dates], window:this.window.length, conditions:this.conditions.size, symbols:this.series?.size ?? 0 }; }

  #closeOn(symbol, date) { const item = this.series.get(symbol), at = item ? item.dates.lastIndexOf(date) : -1; return at < 0 ? null : num(item.c[at]); }

  #condition(key) {
    const condition = this.conditions.get(key);
    if (!condition) throw Object.assign(new Error('DAILY_INDEX_CONDITION_MISSING'), { code:'DAILY_INDEX_CONDITION_MISSING', key });
    return condition;
  }
}

function num(value) { return Number.isNaN(value) ? null : value; }

// Today's daily bars from today's minute bars. Minute volume may be counted in other units than daily volume, so it is
// scaled by the median daily/minute volume ratio of the latest day both sources have (1 when none overlap).
export function dailyBarsFromMinutes(minuteDay, date, { series = null, overlapDate = null, overlapDay = null } = {}) {
  let scale = 1;
  if (series && overlapDay && overlapDate) {
    const ratios = [];
    for (const [symbol, minutes] of overlapDay) {
      const item = series.get(symbol); if (!item) continue;
      const at = item.dates.lastIndexOf(overlapDate); if (at < 0) continue;
      let sum = 0; for (const value of minutes.v) if (Number.isFinite(value)) sum += value;
      if (sum > 0 && Number.isFinite(item.v[at]) && item.v[at] > 0) ratios.push(item.v[at] / sum);
    }
    if (ratios.length >= Math.min(5, series.size)) { ratios.sort((a, b) => a - b); scale = ratios[Math.floor(ratios.length / 2)]; }
  }
  const out = new Map();
  for (const [symbol, minutes] of minuteDay) {
    let open = null, high = -Infinity, low = Infinity, close = null, volume = 0;
    for (let index = 0; index < minutes.t.length; index++) {
      const o = minutes.o[index], h = minutes.h[index], l = minutes.l[index], c = minutes.c[index], v = minutes.v[index];
      if (open === null && Number.isFinite(o ?? c)) open = Number.isFinite(o) ? o : c;
      if (Number.isFinite(h)) high = Math.max(high, h); else if (Number.isFinite(c)) high = Math.max(high, c);
      if (Number.isFinite(l)) low = Math.min(low, l); else if (Number.isFinite(c)) low = Math.min(low, c);
      if (Number.isFinite(c)) close = c;
      if (Number.isFinite(v)) volume += v;
    }
    if (close === null) continue;
    out.set(symbol, { date, open, high, low, close, volume:volume * scale });
  }
  return out;
}

// The daily source can lag the minute files by days (2026-10: daily ended 10/02 while minute files had 10/08). Completed
// minute days after the last daily date (before `today`) are turned into daily bars and appended, so "yesterday's
// close" really is yesterday. Volume is scaled against the latest day both sources have. Returns a new Map (the source
// series is not changed) and the dates that were filled.
export function fillDailyGap(series, minuteDays, today) {
  let last = '';
  for (const item of series.values()) { const date = item.dates.at(-1); if (date > last) last = date; }
  const minuteDates = [...minuteDays.keys()].sort();
  const gap = minuteDates.filter((date) => date > last && date < today);
  if (!last || !gap.length) return { series, filled:[] };
  const overlapDate = minuteDates.filter((date) => date <= last).at(-1) ?? null;
  const built = gap.map((date) => dailyBarsFromMinutes(minuteDays.get(date), date, { series, overlapDate, overlapDay:overlapDate ? minuteDays.get(overlapDate) : null }));
  const out = new Map();
  for (const [symbol, item] of series) {
    const extras = built.map((bars) => bars.get(symbol)).filter((bar) => bar && bar.date > (item.dates.at(-1) || ''));
    if (!extras.length) { out.set(symbol, item); continue; }
    const field = (key, name) => Float64Array.from([...item[key], ...extras.map((bar) => bar[name] ?? NaN)]);
    out.set(symbol, { dates:[...item.dates, ...extras.map((bar) => bar.date)], o:field('o', 'open'), h:field('h', 'high'), l:field('l', 'low'), c:field('c', 'close'), v:field('v', 'volume') });
  }
  return { series:out, filled:gap };
}
