// Layer 2 of the monitoring state machine: per-rule, per-stock state.
//
// A rule is a subscription to shared conditions (layer 1, conditionState.js): "all of these conditions on these
// stocks". It reads the conditions' per-bar values, never recomputes indicators, and keeps its own state per stock:
//
//   idle       not met (or not met long enough to re-arm). Met on a bar → triggered, and that is the ONE moment a
//              notification would go out ('trigger').
//   triggered  met. Staying met does nothing — no repeat notification every bar.
//   cooldown   was triggered, now not met. If it stays not met for `rearmBars` completed bars it goes back to idle
//              (armed again); if it is met again before that, it returns to triggered silently ('suppressed').
//              rearmBars: 3 for level rules (≥, ≤ …: absorbs flicker around a threshold), 30 for event rules
//              (crosses: a one-bar event, so this is the old 30-minute cooldown expressed in bars).
//
// Unknown (warm-up, data gap) changes nothing. Session reset: the 1m (當沖) monitor works one trading day at a
// time, so the first bar of a new trading day starts every (rule, stock) over; after 13:30 the day's state stays as
// it was and is reported as closed. A (rule, stock) seen for the first time on a day is a baseline: if the rule is
// already met it starts as triggered *without* a notification ("already true when monitoring began"), matching the
// existing baseline_only behaviour.
//
// Only affected rules are walked: a rule is touched on a stock when one of its conditions changed there this run
// (layer 1's changedKeys + rulesFor), when it is not idle (cooldown counts bars), or when it has no state yet.
// An idle rule with no changed condition just moves its last-bar marker in memory (re-walking it later is harmless).
//
// This version runs in shadow mode: triggers are recorded and compared with the current signals, nothing is sent.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const RULE_STATES = Object.freeze(['idle', 'triggered', 'cooldown']);
export const REARM_BARS = Object.freeze({ level:3, event:30 });
const EVENT_HISTORY = 300;
const KEEP_DAYS = 7;
const SESSION_CLOSE_MINUTES = 13 * 60 + 30;

export class RuleStateStore {
  constructor(filePath, { backend = null, log = console, rearmBars = REARM_BARS } = {}) {
    this.filePath = filePath;
    this.backend = backend;
    this.log = log;
    this.rearmBars = { ...REARM_BARS, ...rearmBars };
    this.rules = new Map();     // ruleId → { ruleId, name, conditionKeys:[...], kind, rearmBars }
    this.states = new Map();    // `${ruleId}|${symbol}` → state
    this.dirty = new Set();
    this.events = [];           // newest first: { type:'trigger'|'suppressed'|'rearm', ruleId, symbol, barEnd, … }
    this.lastRun = null;
  }

  async load() {
    try {
      const rows = this.backend ? await this.backend.loadStates({ since:daysAgo(KEEP_DAYS) }) : await this.#readFile();
      for (const row of rows) this.states.set(stateKey(row.ruleId, row.symbol), normalizeState(row));
    } catch (error) {
      this.log.error?.('rule-state: load failed, starting empty', error.code || error.message);
    }
    return this;
  }

  // rules: the same objects ConditionStateStore.syncRules takes ({ ruleId, name, conditions:[describeCondition()] }).
  // A removed rule's in-memory states are dropped, so re-adding it starts from a new baseline.
  syncRules(rules) {
    const next = new Map();
    for (const rule of rules) {
      const kind = rule.conditions.some((condition) => condition.kind === 'event') ? 'event' : 'level';
      next.set(rule.ruleId, { ruleId:rule.ruleId, name:rule.name ?? null, conditionKeys:rule.conditions.map((condition) => condition.key), kind, rearmBars:this.rearmBars[kind] });
    }
    for (const ruleId of this.rules.keys()) if (!next.has(ruleId)) for (const id of [...this.states.keys()]) if (id.startsWith(`${ruleId}|`)) { this.states.delete(id); this.dirty.delete(id); }
    this.rules = next;
    return { rules:this.rules.size };
  }

  beginRun() { this.run = { symbols:0, walked:0, skipped:0, baselines:0, triggers:[], suppressed:0, rearmed:0, started:Date.now() }; }
  endRun(now = new Date()) {
    const run = this.run || { symbols:0, walked:0, skipped:0, baselines:0, triggers:[], suppressed:0, rearmed:0, started:Date.now() };
    this.lastRun = { at:now.toISOString(), symbols:run.symbols, walked:run.walked, skipped:run.skipped, baselines:run.baselines, triggers:run.triggers.length, suppressed:run.suppressed, rearmed:run.rearmed, ms:Date.now() - run.started };
    this.run = null;
    return { ...this.lastRun, triggers:run.triggers };
  }

  // Called by ConditionStateStore.evaluate once per symbol (ctx = { symbol, tradingDate, bars, values, changedKeys }).
  // conditionStore supplies rulesFor(); without it every rule is walked.
  onSymbol(ctx, conditionStore = null, now = new Date()) {
    if (!this.run) this.beginRun();
    this.run.symbols += 1;
    const affected = new Set();
    if (conditionStore) for (const key of ctx.changedKeys) for (const ruleId of conditionStore.rulesFor(key)) affected.add(ruleId);
    for (const rule of this.rules.values()) {
      if (rule.conditionKeys.some((key) => !ctx.values.has(key))) continue;   // a condition not computed this run
      const id = stateKey(rule.ruleId, ctx.symbol);
      const state = this.states.get(id);
      const lastBar = ctx.bars.at(-1).barEnd;
      if (!state || state.tradingDate !== ctx.tradingDate) { this.#baseline(rule, ctx, now); continue; }
      if (conditionStore && !affected.has(rule.ruleId) && state.state === 'idle') { if (lastBar > state.lastBar) state.lastBar = lastBar; this.run.skipped += 1; continue; }
      this.#walk(rule, state, ctx, now);
    }
  }

  getState(ruleId, symbol) { const state = this.states.get(stateKey(ruleId, symbol)); return state ? { ...state } : null; }

  async flush() {
    if (!this.dirty.size) return { states:0 };
    const states = [...this.dirty].map((id) => this.states.get(id)).filter(Boolean);
    this.dirty.clear();
    try {
      if (this.backend) await this.backend.upsertStates(states);
      else await this.#writeFile();
    } catch (error) {
      for (const state of states) this.dirty.add(stateKey(state.ruleId, state.symbol));
      this.log.error?.('rule-state: flush failed', error.code || error.message);
    }
    return { states:states.length };
  }

  // legacySignalsToday: how many signals the current engine created today, so the admin page can compare.
  snapshot({ events = 50, now = new Date(), legacySignalsToday = null } = {}) {
    const today = taipeiDate(now);
    const rules = [...this.rules.values()].map((rule) => {
      const counts = { idle:0, triggered:0, cooldown:0 };
      let triggersToday = 0, suppressedToday = 0, symbols = 0, tradingDate = null;
      for (const state of this.states.values()) {
        if (state.ruleId !== rule.ruleId) continue;
        symbols += 1; counts[state.state] += 1; triggersToday += state.tradingDate === today ? state.triggersToday : 0; suppressedToday += state.tradingDate === today ? state.suppressedToday : 0;
        if (!tradingDate || state.tradingDate > tradingDate) tradingDate = state.tradingDate;
      }
      return { ruleId:rule.ruleId, name:rule.name, kind:rule.kind, rearmBars:rule.rearmBars, conditions:rule.conditionKeys.length, symbols, states:counts, triggersToday, suppressedToday, tradingDate, sessionClosed:tradingDate ? sessionClosed(tradingDate, now) : null };
    });
    return {
      mode:'shadow',
      lastRun:this.lastRun,
      rules,
      comparison:{ day:today, shadowTriggers:rules.reduce((sum, rule) => sum + rule.triggersToday, 0), suppressed:rules.reduce((sum, rule) => sum + rule.suppressedToday, 0), legacySignals:legacySignalsToday },
      recentEvents:this.events.slice(0, events).map((event) => ({ ...event, ruleName:this.rules.get(event.ruleId)?.name ?? null }))
    };
  }

  #baseline(rule, ctx, now) {
    const truth = ctx.bars.map((_, index) => ruleTruth(rule, ctx.values, index));
    let latest = null, since = null;
    truth.forEach((value, index) => { if (typeof value !== 'boolean') return; if (value !== latest) since = ctx.bars[index].barEnd; latest = value; });
    const state = { ruleId:rule.ruleId, symbol:ctx.symbol, tradingDate:ctx.tradingDate, state:latest === true ? 'triggered' : 'idle', since, lastBar:ctx.bars.at(-1).barEnd, falseBars:0, triggersToday:0, suppressedToday:0, lastTriggerBar:null, baseline:latest === true, updatedAt:now.toISOString() };
    this.states.set(stateKey(rule.ruleId, ctx.symbol), state);
    this.dirty.add(stateKey(rule.ruleId, ctx.symbol));
    this.run.baselines += 1;
  }

  #walk(rule, state, ctx, now) {
    const start = ctx.bars.findIndex((bar) => bar.barEnd > state.lastBar);
    if (start < 0) return;
    this.run.walked += 1;
    const before = JSON.stringify([state.state, state.since, state.falseBars, state.triggersToday, state.suppressedToday]);
    for (let index = start; index < ctx.bars.length; index++) {
      const met = ruleTruth(rule, ctx.values, index);
      if (typeof met !== 'boolean') continue;
      const barEnd = ctx.bars[index].barEnd;
      if (state.state === 'idle') {
        if (!met) continue;
        Object.assign(state, { state:'triggered', since:barEnd, falseBars:0, lastTriggerBar:barEnd, baseline:false });
        state.triggersToday += 1;
        this.#event({ type:'trigger', ruleId:rule.ruleId, symbol:ctx.symbol, barEnd, tradingDate:ctx.tradingDate, detectedAt:now.toISOString() });
      } else if (state.state === 'triggered') {
        if (met) continue;
        Object.assign(state, { state:'cooldown', since:barEnd, falseBars:1 });
        if (state.falseBars >= rule.rearmBars) this.#rearm(rule, state, ctx, barEnd, now);
      } else {
        if (met) { Object.assign(state, { state:'triggered', since:barEnd, falseBars:0 }); state.suppressedToday += 1; this.run.suppressed += 1; this.#event({ type:'suppressed', ruleId:rule.ruleId, symbol:ctx.symbol, barEnd, tradingDate:ctx.tradingDate, detectedAt:now.toISOString() }); continue; }
        state.falseBars += 1;
        if (state.falseBars >= rule.rearmBars) this.#rearm(rule, state, ctx, barEnd, now);
      }
    }
    state.lastBar = ctx.bars.at(-1).barEnd;
    if (JSON.stringify([state.state, state.since, state.falseBars, state.triggersToday, state.suppressedToday]) !== before) { state.updatedAt = now.toISOString(); this.dirty.add(stateKey(rule.ruleId, ctx.symbol)); }
  }

  #rearm(rule, state, ctx, barEnd, now) {
    Object.assign(state, { state:'idle', since:barEnd, falseBars:0 });
    this.run.rearmed += 1;
    this.#event({ type:'rearm', ruleId:rule.ruleId, symbol:ctx.symbol, barEnd, tradingDate:ctx.tradingDate, detectedAt:now.toISOString() });
  }

  #event(event) {
    if (event.type === 'trigger') this.run.triggers.push(event);
    this.events.unshift(event);
    if (this.events.length > EVENT_HISTORY) this.events.length = EVENT_HISTORY;
  }

  async #readFile() {
    try { const parsed = JSON.parse(await readFile(this.filePath, 'utf8')); const since = daysAgo(KEEP_DAYS); return (parsed.states || []).filter((row) => row.tradingDate >= since); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }

  async #writeFile() {
    await mkdir(dirname(this.filePath), { recursive:true });
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try { await writeFile(temporary, `${JSON.stringify({ version:1, states:[...this.states.values()] })}\n`, 'utf8'); await rename(temporary, this.filePath); }
    catch (error) { await rm(temporary, { force:true }).catch(() => {}); throw error; }
  }
}

// AND of the rule's conditions on one bar; null when any of them is unknown there.
export function ruleTruth(rule, values, index) {
  let all = true;
  for (const key of rule.conditionKeys) {
    const value = values.get(key)?.[index];
    if (typeof value !== 'boolean') return null;
    if (!value) all = false;
  }
  return all;
}

export function sessionClosed(tradingDate, now = new Date()) {
  const today = taipeiDate(now);
  if (tradingDate < today) return true;
  if (tradingDate > today) return false;
  const taipei = new Date(now.getTime() + 8 * 3_600_000);
  return taipei.getUTCHours() * 60 + taipei.getUTCMinutes() >= SESSION_CLOSE_MINUTES;
}

export function taipeiDate(now = new Date()) { return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10); }
function normalizeState(row) {
  return { ruleId:row.ruleId, symbol:String(row.symbol), tradingDate:row.tradingDate, state:RULE_STATES.includes(row.state) ? row.state : 'idle', since:row.since ?? null, lastBar:row.lastBar, falseBars:Number(row.falseBars) || 0, triggersToday:Number(row.triggersToday) || 0, suppressedToday:Number(row.suppressedToday) || 0, lastTriggerBar:row.lastTriggerBar ?? null, baseline:Boolean(row.baseline), updatedAt:row.updatedAt ?? null };
}
function stateKey(ruleId, symbol) { return `${ruleId}|${symbol}`; }
function daysAgo(days) { return new Date(Date.now() + 8 * 3_600_000 - days * 86_400_000).toISOString().slice(0, 10); }
