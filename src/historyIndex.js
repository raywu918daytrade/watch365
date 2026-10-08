// 7-day condition index (owner decision 2026-10: "do not recompute every time a filter is picked").
//
// The last HISTORY_DAYS trading days of 1-minute bars stay in memory, and every condition (each preset variant of
// the indicator list, plus any AI-built filter once it is first used) is evaluated ONCE per (stock, day): for every
// bar, met / not met / unknown, stored as two bitsets. Past days never change, so they are computed once; today's
// day is replaced as new bars arrive (setDay). Picking filters is then only a bitwise AND of stored results plus the
// same idle → triggered → cooldown walk the live state machine uses (ruleState.ruleTriggerIndexes) — no indicator is
// recomputed, which is what makes "how many stocks would have triggered" instant for every row of the list.
//
// Bars of one (stock, day) are split at data gaps > 2 minutes like the live engine, each run evaluated on its own.

import { evaluateFormulaSet, validateFormula } from './formulaEngine.js';
import { conditionKind } from './conditionState.js';
import { REARM_BARS, ruleTriggerIndexes } from './ruleState.js';

const GAP_MS = 120_000;
const MAX_EVENTS = 300;

export class HistoryIndex {
  constructor({ maxDays = 7, rearmBars = REARM_BARS } = {}) {
    this.maxDays = maxDays;
    this.rearmBars = { ...REARM_BARS, ...rearmBars };
    this.days = new Map();        // date → Map(symbol → { t, o, h, l, c, v: Float64Array per field, segments:[[start,end)] })
    this.conditions = new Map();  // key → { key, ast, kind, truth: Map(date → Map(symbol → { known, value })) }
  }

  dates() { return [...this.days.keys()].sort(); }
  has(key) { return this.conditions.has(key); }
  stats() {
    let cells = 0, bars = 0;
    for (const day of this.days.values()) for (const series of day.values()) { cells += 1; bars += series.t.length; }
    return { dates:this.dates(), symbolDays:cells, bars, conditions:this.conditions.size };
  }

  // bySymbol: Map(symbol → bars [{ barEnd(ms), open, high, low, close, volume }] sorted, one trading day).
  // Replaces that day and computes every known condition for it. Days beyond maxDays (oldest first) are dropped.
  setDay(date, bySymbol) {
    const day = new Map();
    for (const [symbol, bars] of bySymbol) {
      if (!bars.length) continue;
      const field = (name) => Float64Array.from(bars, (bar) => (Number.isFinite(bar[name]) ? bar[name] : NaN));
      day.set(symbol, { t:field('barEnd'), o:field('open'), h:field('high'), l:field('low'), c:field('close'), v:field('volume'), segments:segmentsOf(bars) });
    }
    this.days.set(date, day);
    for (const condition of this.conditions.values()) condition.truth.delete(date);
    this.#computeDay(date, [...this.conditions.values()]);
    for (const old of this.dates().slice(0, Math.max(0, this.days.size - this.maxDays))) {
      this.days.delete(old);
      for (const condition of this.conditions.values()) condition.truth.delete(old);
    }
  }

  // conditions: [{ key, ast }]. Computes only the ones not stored yet, over all days in memory. Returns how many.
  ensure(conditions) {
    const missing = [];
    for (const { key, ast } of conditions) {
      if (this.conditions.has(key) || missing.some((item) => item.key === key)) continue;
      const validated = validateFormula(ast);
      missing.push({ key, ast:validated.ast, kind:conditionKind(validated.ast), truth:new Map() });
    }
    if (!missing.length) return 0;
    for (const condition of missing) this.conditions.set(condition.key, condition);
    for (const date of this.dates()) this.#computeDay(date, missing);
    return missing.length;
  }

  forget(keys) { for (const key of keys) this.conditions.delete(key); }

  // filters: condition keys in the order the user picked them. Each step i = filters[0..i] all met.
  // candidates: condition keys to try as "the next filter" on top of all filters (the list rows).
  // symbols: Set to restrict to (a watchlist), or null for every stock in memory.
  // symbolsByDate: Map(date → Set) further restricts each day (the daily-filter list of that day), or null.
  query({ filters = [], candidates = [], symbols = null, symbolsByDate = null, events = true } = {}) {
    for (const key of [...filters, ...candidates]) if (!this.conditions.has(key)) throw Object.assign(new Error('HISTORY_INDEX_CONDITION_MISSING'), { code:'HISTORY_INDEX_CONDITION_MISSING', key });
    const dates = this.dates();
    const steps = filters.map((_, index) => this.#combine(filters.slice(0, index + 1), dates, symbols, events && index === filters.length - 1, symbolsByDate));
    const candidateResults = candidates.map((key) => {
      const result = this.#combine([...filters, key], dates, symbols, false, symbolsByDate);
      return { key, triggeredSymbols:result.triggeredSymbols, totalEvents:result.totalEvents };
    });
    return { dates, availableDays:dates.length, steps, candidates:candidateResults };
  }

  #computeDay(date, conditions) {
    const day = this.days.get(date);
    if (!day || !conditions.length) return;
    const asts = conditions.map((condition) => condition.ast);
    const perCondition = conditions.map(() => new Map());
    for (const [symbol, series] of day) {
      const n = series.t.length, bytes = Math.ceil(n / 8);
      const sets = conditions.map(() => ({ known:new Uint8Array(bytes), value:new Uint8Array(bytes) }));
      for (const [start, end] of series.segments) {
        let values;
        try { values = evaluateFormulaSet(asts, barObjects(series, start, end)); } catch { continue; }
        values.forEach((list, index) => {
          const { known, value } = sets[index];
          for (let offset = 0; offset < list.length; offset++) {
            const item = list[offset];
            if (typeof item !== 'boolean') continue;
            const bar = start + offset;
            known[bar >> 3] |= 1 << (bar & 7);
            if (item) value[bar >> 3] |= 1 << (bar & 7);
          }
        });
      }
      sets.forEach((set, index) => perCondition[index].set(symbol, set));
    }
    conditions.forEach((condition, index) => condition.truth.set(date, perCondition[index]));
  }

  #combine(keys, dates, symbols, withEvents, symbolsByDate = null) {
    const conditions = keys.map((key) => this.conditions.get(key));
    const kind = conditions.some((condition) => condition.kind === 'event') ? 'event' : 'level';
    const rearm = this.rearmBars[kind];
    const days = [], events = [], triggered = new Set();
    let total = 0;
    for (const date of dates) {
      const day = this.days.get(date);
      let count = 0;
      for (const [symbol, series] of day) {
        if (symbols && !symbols.has(symbol)) continue;
        if (symbolsByDate && !symbolsByDate.get(date)?.has(symbol)) continue;
        const sets = conditions.map((condition) => condition.truth.get(date)?.get(symbol));
        if (sets.some((set) => !set)) continue;
        // Fast skip: no bar where every condition is met → nothing can trigger.
        const bytes = sets[0].value.length;
        let any = false;
        for (let byte = 0; byte < bytes && !any; byte++) { let all = 0xff; for (const set of sets) all &= set.value[byte]; any = all !== 0; }
        if (!any) continue;
        const n = series.t.length, truth = new Array(n);
        for (let bar = 0; bar < n; bar++) {
          const byte = bar >> 3, bit = 1 << (bar & 7);
          let met = true, known = true;
          for (const set of sets) { if (!(set.known[byte] & bit)) { known = false; break; } if (!(set.value[byte] & bit)) met = false; }
          truth[bar] = known ? met : null;
        }
        const hits = ruleTriggerIndexes(truth, rearm, kind, series.t);
        if (!hits.length) continue;
        count += hits.length; triggered.add(symbol);
        if (withEvents) for (const bar of hits) events.push({ date, at:new Date(series.t[bar]).toISOString(), symbol, price:series.c[bar] });
      }
      total += count;
      days.push({ date, count });
    }
    const result = { triggeredSymbols:triggered.size, totalEvents:total, days:days.reverse() };
    if (withEvents) {
      events.sort((a, b) => b.at.localeCompare(a.at) || a.symbol.localeCompare(b.symbol));
      result.truncated = events.length > MAX_EVENTS;
      result.events = events.slice(0, MAX_EVENTS);
    }
    return result;
  }
}

// [start, end) index ranges of uninterrupted bars (gap ≤ 2 minutes).
function segmentsOf(bars) {
  const segments = [];
  let start = 0;
  for (let index = 1; index <= bars.length; index++) {
    if (index === bars.length || bars[index].barEnd - bars[index - 1].barEnd > GAP_MS) { segments.push([start, index]); start = index; }
  }
  return segments;
}

// Bar objects for the formula engine, built on demand from the typed arrays (NaN → null, which the engine treats as
// missing).
function barObjects(series, start, end) {
  const out = new Array(end - start);
  const num = (value) => (Number.isNaN(value) ? null : value);
  for (let index = start; index < end; index++) out[index - start] = { barEnd:series.t[index], open:num(series.o[index]), high:num(series.h[index]), low:num(series.l[index]), close:num(series.c[index]), volume:num(series.v[index]) };
  return out;
}
