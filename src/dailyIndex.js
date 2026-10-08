// Daily (D1) condition index (owner decision 2026-10: a monitor may filter on daily candles, on 1-minute candles, or
// both, in that order). Every daily condition is evaluated ONCE per stock over its recent daily history and the result
// of the last DAYS trading dates is kept as met / not met; picking daily filters is then an AND of stored results.
//
// Meaning of "met on date D": the condition holds on D's daily close. With D1 + M1, the stocks met on the last daily
// date BEFORE a minute-bar day form that day's list (yesterday's close → today's list). A D1-only monitor notifies once
// after the close, on the days where the combination becomes met (not met the trading day before).
import { evaluateFormulaSet, formulaChildren, validateFormula } from './formulaEngine.js';

export const DAILY_DAYS = 7;
const EVAL_BARS = 400;   // enough history for the longest preset (60-day averages, 52-day Ichimoku) plus warmup

// Session-only blocks (VWAP's cumulative sums, the day's first bar) have no meaning on daily candles.
export function dailyCapable(ast) { return !usesSessionBlocks(ast); }
function usesSessionBlocks(node) { return node.op === 'cumsum' || node.op === 'first' || formulaChildren(node).some(usesSessionBlocks); }

export class DailyIndex {
  constructor({ days = DAILY_DAYS } = {}) {
    this.days = days;
    this.series = null;          // Map(symbol → { dates, o, h, l, c, v }) from DailyStore.finalize()
    this.dates = [];             // the last `days` trading dates (ascending)
    this.conditions = new Map(); // key → { key, ast, met: Map(symbol → Uint8Array(days)) }  1 met, 0 not, 2 unknown
  }

  // series: Map(symbol → { dates, o, h, l, c, v }). Recomputes every known condition on the new data.
  setSeries(series) {
    this.series = series;
    const all = new Set();
    for (const item of series.values()) for (const date of item.dates.slice(-this.days)) all.add(date);
    this.dates = [...all].sort().slice(-this.days);
    const known = [...this.conditions.values()];
    this.conditions.clear();
    this.ensure(known);
  }
  ready() { return Boolean(this.series); }
  latestDate() { return this.dates.at(-1) ?? null; }

  ensure(conditions) {
    if (!this.series) return 0;
    const missing = [];
    for (const { key, ast } of conditions) {
      if (this.conditions.has(key) || missing.some((item) => item.key === key)) continue;
      const validated = validateFormula(ast);
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
        const row = new Uint8Array(this.dates.length).fill(2);
        this.dates.forEach((date, slot) => { const at = position.get(date); if (at === undefined) return; const value = values[which][at]; if (typeof value === 'boolean') row[slot] = value ? 1 : 0; });
        condition.met.set(symbol, row);
      });
    }
    for (const condition of missing) this.conditions.set(condition.key, condition);
    return missing.length;
  }

  // Symbols where every key is met on `date` (one of this.dates), optionally within `symbols`.
  metOn(keys, date, symbols = null) {
    const slot = this.dates.indexOf(date), out = new Set();
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

  // filters: keys in pick order; each step = filters[0..i] all met. Per step: stocks met on the latest date, per-day
  // counts, and "new" = stocks that became met that day (what a D1-only monitor notifies after the close).
  // candidates: keys tried as the next filter (stocks met on the latest date with it added).
  query({ filters = [], candidates = [], symbols = null, list = false } = {}) {
    for (const key of [...filters, ...candidates]) this.#condition(key);
    const latest = this.latestDate();
    const steps = filters.map((_, index) => {
      const keys = filters.slice(0, index + 1);
      const perDay = this.dates.map((date) => this.metOn(keys, date, symbols));
      const days = this.dates.map((date, slot) => ({ date, count:perDay[slot].size, newCount:slot ? [...perDay[slot]].filter((symbol) => !perDay[slot - 1].has(symbol)).length : null }));
      const step = { latestCount:perDay.at(-1)?.size ?? 0, days, newEvents:days.reduce((sum, day) => sum + (day.newCount ?? 0), 0) };
      if (list && index === filters.length - 1) step.symbols = [...(perDay.at(-1) || [])].sort();
      return step;
    });
    const candidateResults = candidates.map((key) => ({ key, latestCount:latest ? this.metOn([...filters, key], latest, symbols).size : 0 }));
    return { dates:[...this.dates], latestDate:latest, steps, candidates:candidateResults };
  }

  stats() { return { dates:[...this.dates], conditions:this.conditions.size, symbols:this.series?.size ?? 0 }; }

  #condition(key) {
    const condition = this.conditions.get(key);
    if (!condition) throw Object.assign(new Error('DAILY_INDEX_CONDITION_MISSING'), { code:'DAILY_INDEX_CONDITION_MISSING', key });
    return condition;
  }
}

function num(value) { return Number.isNaN(value) ? null : value; }
