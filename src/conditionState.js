// Layer 1 of the monitoring state machine: shared condition state.
//
// Owner decision (2026-10): many users will reuse the same indicators, so a condition is a *fact* about a stock that
// is computed once, no matter how many rules or users watch it. A rule (layer 2, next version) is a subscription:
// "A and B on these stocks", and keeps its own armed / triggered / cooldown state by reading these facts.
//
//   condition  = one boolean formula_v1 node (e.g. close crosses above SMA(20)), keyed by its canonical fingerprint,
//                so the same condition entered by two users, or built from a template vs. typed, has one key.
//   state      = per (condition, symbol): last known value, the bar it became that value (since), the last bar seen
//                and how many times it flipped today. Persisted in watch365_condition_state (JSON file without DB).
//   flip       = the value changed false→true or true→false on a completed bar. Unknown (null: warm-up, data gap)
//                never counts as a flip; the last known value is kept across it.
//   reference  = a condition is only computed while at least one rule references it (rulesFor = inverse index).
//
// The HF m1_live file holds the whole trading day, so every run sees every bar of the day. Flips are therefore found
// for *every* new bar since the last one processed, not just the latest (a one-bar cross between two polls is not
// missed), and after a restart the persisted last bar lets the walk resume where it stopped. A condition seen for
// the first time on a day is a baseline: its current value is recorded and no flip is emitted for earlier bars.
//
// This version runs in shadow mode: it records state and flips but does not create signals or notifications.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { evaluateFormulaSet, formulaFingerprint, formulaSummary, validateFormula } from './formulaEngine.js';
import { wilderRsi } from './formulaRecipes.js';
import { strategyIdentity } from './indicatorRegistry.js';
import { isRegularSession } from './marketBar.js';

const MAX_SESSION_BARS = 512;
const FLIP_HISTORY = 300;
const KEEP_DAYS = 7;

// Splits a strategy into its atomic conditions. formula_v1 `all` is split into its items (each is a filter the user
// picked); any other boolean root is one condition. The registry executors map onto the same AST the structured UI
// builds (monitorConditions.js), so a registry SMA cross and a formula SMA cross share one key. The legacy
// breakout+volume rule (median-volume baseline) has no formula form and is not part of this layer.
export function atomicConditions(strategy) {
  if (!strategy) return [];
  let nodes;
  if (strategy.executor === 'formula_v1') {
    const root = strategy.formula?.ast;
    if (!root) return [];
    nodes = root.op === 'all' ? root.items : [root];
  } else if (strategy.executor === 'sma_cross') {
    nodes = [{ op:'crosses_above', left:{ op:'source', field:'close' }, right:{ op:'sma', input:{ op:'source', field:'close' }, period:strategy.params.period } }];
  } else if (strategy.executor === 'rsi_wilder_cross') {
    nodes = [{ op:'crosses_above', left:wilderRsi(strategy.params.period), right:{ op:'constant', value:strategy.params.threshold } }];
  } else return [];
  const seen = new Set();
  return nodes.map(describeCondition).filter((condition) => !seen.has(condition.key) && seen.add(condition.key));
}

export function describeCondition(ast) {
  const validated = validateFormula(ast);
  return { key:validated.fingerprint, ast:validated.ast, kind:conditionKind(validated.ast), label:safeSummary(validated.ast), warmupBars:validated.warmupBars };
}

// event: true on a single bar (a cross); level: stays true while it holds (≥, ≤, and/or of levels).
export function conditionKind(ast) {
  if (ast.op === 'crosses_above' || ast.op === 'crosses_below') return 'event';
  if (ast.op === 'all' || ast.op === 'any') return ast.items.some((item) => conditionKind(item) === 'event') ? 'event' : 'level';
  return 'level';
}

export class ConditionStateStore {
  constructor(filePath, { backend = null, log = console } = {}) {
    this.filePath = filePath;
    this.backend = backend;
    this.log = log;
    this.conditions = new Map();   // key → { key, ast, kind, label, warmupBars, rules:Set }
    this.rules = new Map();        // ruleId → Set(condition key)
    this.states = new Map();       // `${key}|${symbol}` → state
    this.dirty = new Set();
    this.dirtyDefinitions = new Set();
    this.flips = [];               // newest first, in-memory ring buffer for the admin page
    this.lastRun = null;
  }

  async load() {
    try {
      const rows = this.backend ? await this.backend.loadStates({ since:daysAgo(KEEP_DAYS) }) : await this.#readFile();
      for (const row of rows) this.states.set(stateKey(row.conditionKey, row.symbol), normalizeState(row));
    } catch (error) {
      this.log.error?.('condition-state: load failed, starting empty', error.code || error.message);
    }
    return this;
  }

  // Replaces the full set of rules. Each rule: { ruleId, conditions:[describeCondition()] }. Conditions no rule
  // references any more stop being computed and their in-memory states are dropped, so a condition re-added later
  // starts from a new baseline instead of replaying flips from the time nobody watched it. States loaded at boot are
  // kept, so a restart resumes from the last processed bar.
  syncRules(rules) {
    const next = new Map(rules.map((rule) => [rule.ruleId, rule]));
    for (const ruleId of [...this.rules.keys()]) if (!next.has(ruleId)) this.#removeRule(ruleId);
    for (const rule of next.values()) {
      const keys = new Set(rule.conditions.map((condition) => condition.key));
      const previous = this.rules.get(rule.ruleId);
      if (previous && previous.size === keys.size && [...keys].every((key) => previous.has(key))) continue;
      if (previous) this.#removeRule(rule.ruleId);
      this.rules.set(rule.ruleId, keys);
      for (const condition of rule.conditions) {
        const entry = this.conditions.get(condition.key) || { ...condition, rules:new Set() };
        entry.rules.add(rule.ruleId);
        if (!this.conditions.has(condition.key)) { this.conditions.set(condition.key, entry); this.dirtyDefinitions.add(condition.key); }
      }
    }
    return { rules:this.rules.size, conditions:this.conditions.size };
  }

  // Inverse index for layer 2: which rules must be re-checked when this condition flips.
  rulesFor(conditionKey) { return [...(this.conditions.get(conditionKey)?.rules || [])]; }
  getState(conditionKey, symbol) { const state = this.states.get(stateKey(conditionKey, symbol)); return state ? { ...state } : null; }

  // bars: completed 1m bars of the current run (any symbols, any order). Returns the flips found on new bars.
  // onSymbol(ctx) is called once per symbol after its conditions advanced, with { symbol, tradingDate, bars,
  // values: Map(conditionKey → per-bar series), changedKeys: Set(keys whose value changed this run, warm-up end
  // included) } — layer 2 (ruleState.js) uses changedKeys with rulesFor() to touch only the affected rules.
  evaluate(bars, now = new Date(), { onSymbol = null } = {}) {
    const started = Date.now();
    const conditions = [...this.conditions.values()];
    const result = { flips:[], symbols:0, conditions:conditions.length, baselines:0, newBars:0, errors:[] };
    if (!conditions.length) { this.lastRun = { at:now.toISOString(), ...summary(result, started) }; return result; }
    for (const [symbol, series] of groupSessionBars(bars)) {
      result.symbols += 1;
      let values;
      try { values = evaluateFormulaSet(conditions.map((condition) => condition.ast), series); }
      catch (error) { result.errors.push({ symbol, code:error.code || error.message }); continue; }
      const tradingDate = series.at(-1).tradingDate;
      const changedKeys = new Set();
      conditions.forEach((condition, index) => { if (this.#advance(condition, symbol, tradingDate, series, values[index], result, now)) changedKeys.add(condition.key); });
      if (onSymbol) {
        try { onSymbol({ symbol, tradingDate, bars:series, values:new Map(conditions.map((condition, index) => [condition.key, values[index]])), changedKeys }); }
        catch (error) { result.errors.push({ symbol, code:error.code || error.message, layer:'rule' }); }
      }
    }
    if (result.flips.length) this.flips = result.flips.slice().reverse().concat(this.flips).slice(0, FLIP_HISTORY);
    this.lastRun = { at:now.toISOString(), ...summary(result, started) };
    return result;
  }

  // Persists changed states and new condition definitions. Never throws: monitoring must not depend on it.
  async flush() {
    if (!this.dirty.size && !this.dirtyDefinitions.size) return { states:0, definitions:0 };
    const states = [...this.dirty].map((key) => this.states.get(key)).filter(Boolean);
    const definitions = [...this.dirtyDefinitions].map((key) => this.conditions.get(key)).filter(Boolean).map(({ key, ast, kind, label }) => ({ key, ast, kind, label }));
    this.dirty.clear(); this.dirtyDefinitions.clear();
    try {
      if (this.backend) {
        if (definitions.length) await this.backend.upsertDefinitions(definitions);
        if (states.length) await this.backend.upsertStates(states);
      } else await this.#writeFile();
    } catch (error) {
      for (const state of states) this.dirty.add(stateKey(state.conditionKey, state.symbol));
      for (const definition of definitions) this.dirtyDefinitions.add(definition.key);
      this.log.error?.('condition-state: flush failed', error.code || error.message);
    }
    return { states:states.length, definitions:definitions.length };
  }

  snapshot({ flips = 50 } = {}) {
    const bySymbolCount = new Map();
    for (const state of this.states.values()) {
      if (!this.conditions.has(state.conditionKey)) continue;
      const entry = bySymbolCount.get(state.conditionKey) || { symbols:0, trueNow:0, flipsToday:0, tradingDate:null };
      entry.symbols += 1; if (state.value === true) entry.trueNow += 1; entry.flipsToday += state.flipsToday;
      if (!entry.tradingDate || state.tradingDate > entry.tradingDate) entry.tradingDate = state.tradingDate;
      bySymbolCount.set(state.conditionKey, entry);
    }
    return {
      mode:'shadow',
      lastRun:this.lastRun,
      rules:[...this.rules].map(([ruleId, keys]) => ({ ruleId, conditions:[...keys] })),
      conditions:[...this.conditions.values()].map(({ key, kind, label, warmupBars, rules }) => ({ key, kind, label, warmupBars, rules:rules.size, ...(bySymbolCount.get(key) || { symbols:0, trueNow:0, flipsToday:0, tradingDate:null }) })),
      recentFlips:this.flips.slice(0, flips).map((flip) => ({ ...flip, label:this.conditions.get(flip.conditionKey)?.label ?? null }))
    };
  }

  #advance(condition, symbol, tradingDate, bars, values, result, now) {
    const id = stateKey(condition.key, symbol);
    let state = this.states.get(id);
    const lastIndex = bars.length - 1;
    if (!state || state.tradingDate !== tradingDate) {
      // Baseline: record where the condition stands now; earlier bars of the day are history, not news.
      const { value, since, flips } = scanBaseline(values, bars);
      state = { conditionKey:condition.key, symbol, tradingDate, value, since, lastBar:bars[lastIndex].barEnd, flipsToday:flips, updatedAt:now.toISOString() };
      this.states.set(id, state); this.dirty.add(id); result.baselines += 1;
      return true;
    }
    let start = bars.findIndex((bar) => bar.barEnd > state.lastBar);
    if (start < 0) return false;
    let changed = false;
    result.newBars += lastIndex - start + 1;
    for (let index = start; index <= lastIndex; index++) {
      const value = values[index];
      if (typeof value !== 'boolean') continue;             // unknown keeps the last known value
      if (state.value === null) { state.value = value; state.since = bars[index].barEnd; changed = true; continue; }
      if (value === state.value) continue;
      const flip = { conditionKey:condition.key, symbol, from:state.value, to:value, kind:condition.kind, barEnd:bars[index].barEnd, tradingDate, detectedAt:now.toISOString() };
      state.value = value; state.since = bars[index].barEnd; state.flipsToday += 1;
      result.flips.push(flip); changed = true;
    }
    state.lastBar = bars[lastIndex].barEnd; state.updatedAt = now.toISOString();
    this.dirty.add(id);
    return changed;
  }

  #removeRule(ruleId) {
    for (const key of this.rules.get(ruleId) || []) {
      const condition = this.conditions.get(key);
      if (!condition) continue;
      condition.rules.delete(ruleId);
      if (!condition.rules.size) {
        this.conditions.delete(key);
        for (const id of [...this.states.keys()]) if (id.startsWith(`${key}|`)) { this.states.delete(id); this.dirty.delete(id); }
      }
    }
    this.rules.delete(ruleId);
  }

  async #readFile() {
    try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')); const since = daysAgo(KEEP_DAYS); return (parsed.states || []).filter((row) => row.tradingDate >= since); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async #writeFile() {
    await mkdir(dirname(this.filePath), { recursive:true });
    const body = { version:1, states:[...this.states.values()], conditions:[...this.conditions.values()].map(({ key, ast, kind, label }) => ({ key, ast, kind, label })) };
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify(body)}\n`, 'utf8'); await rename(temporary, this.filePath); }
    catch (error) { await rm(temporary, { force:true }).catch(() => {}); throw error; }
  }
}

// Builds the condition rules for the current single-monitor setup: one rule per enabled strategy.
export function rulesFromSettings(settings) {
  if (!settings?.enabled || !settings.strategy) return [];
  const conditions = atomicConditions(settings.strategy);
  return conditions.length ? [{ ruleId:strategyIdentity(settings.strategy), name:settings.strategy.name || null, conditions }] : [];
}

// Groups bars per symbol to one trading day of completed regular-session bars, in time order, de-duplicated.
export function groupSessionBars(bars) {
  const bySymbol = new Map();
  for (const bar of bars || []) {
    if (!bar || bar.complete === false || !bar.symbol || !bar.barEnd || !bar.tradingDate) continue;
    if (!isRegularSession(bar.barStart)) continue;
    const list = bySymbol.get(bar.symbol) || [];
    list.push(bar); bySymbol.set(bar.symbol, list);
  }
  const out = new Map();
  for (const [symbol, list] of bySymbol) {
    list.sort((a, b) => a.barEnd.localeCompare(b.barEnd));
    const tradingDate = list.at(-1).tradingDate;
    const day = []; let previous = null;
    for (const bar of list) { if (bar.tradingDate !== tradingDate || bar.barEnd === previous) continue; day.push(bar); previous = bar.barEnd; }
    out.set(symbol, day.slice(-MAX_SESSION_BARS));
  }
  return out;
}

function scanBaseline(values, bars) {
  let value = null, since = null, flips = 0;
  values.forEach((item, index) => {
    if (typeof item !== 'boolean') return;
    if (value === null) { value = item; since = bars[index].barEnd; return; }
    if (item !== value) { flips += 1; value = item; since = bars[index].barEnd; }
  });
  return { value, since, flips };
}

function normalizeState(row) {
  return { conditionKey:row.conditionKey, symbol:String(row.symbol), tradingDate:row.tradingDate, value:typeof row.value === 'boolean' ? row.value : row.value == null ? null : Boolean(Number(row.value)), since:row.since ?? null, lastBar:row.lastBar, flipsToday:Number(row.flipsToday) || 0, updatedAt:row.updatedAt ?? null };
}
function stateKey(conditionKey, symbol) { return `${conditionKey}|${symbol}`; }
function summary(result, started) { return { symbols:result.symbols, conditions:result.conditions, baselines:result.baselines, newBars:result.newBars, flips:result.flips.length, errors:result.errors.length, ms:Date.now() - started }; }
function safeSummary(ast) { try { return formulaSummary(ast); } catch { return null; } }
function daysAgo(days) { return new Date(Date.now() + 8 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10); }
