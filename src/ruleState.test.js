import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConditionStateStore, describeCondition } from './conditionState.js';
import { RuleStateStore, ruleTruth, sessionClosed } from './ruleState.js';

const quiet = { error() {}, warn() {}, info() {} };
const close = { op:'source', field:'close' };
const vol = { op:'source', field:'volume' };
const gte = (left, value) => ({ op:'gte', left, right:{ op:'constant', value } });
const crossAboveSma = (period) => ({ op:'crosses_above', left:close, right:{ op:'sma', input:close, period } });

function bars(symbol, closes, { date = '2026-10-08', volumes = null } = {}) {
  return closes.map((price, index) => {
    const start = new Date(`${date}T01:00:00.000Z`); start.setUTCMinutes(start.getUTCMinutes() + index);
    const end = new Date(start.getTime() + 60_000);
    return { symbol, market:'TWSE', tradingDate:date, barStart:start.toISOString(), barEnd:end.toISOString(), open:price, high:price, low:price, close:price, volume:volumes?.[index] ?? 1000, complete:true, providerEventAt:end.toISOString() };
  });
}

// Both layers wired exactly as server.js does it.
function engine(rules, options = {}) {
  const conditions = new ConditionStateStore('/dev/null', { log:quiet });
  const ruleStates = new RuleStateStore('/dev/null', { log:quiet, ...options });
  const described = rules.map(({ ruleId, asts, name = null }) => ({ ruleId, name, conditions:asts.map(describeCondition) }));
  conditions.syncRules(described); ruleStates.syncRules(described);
  const run = (input, now = new Date('2026-10-08T03:00:00Z')) => {
    ruleStates.beginRun();
    conditions.evaluate(input, now, { onSymbol:(ctx) => ruleStates.onSymbol(ctx, conditions, now) });
    return ruleStates.endRun(now);
  };
  return { conditions, ruleStates, run };
}

test('a level rule notifies once on entering, not on every bar it stays met', () => {
  const { ruleStates, run } = engine([{ ruleId:'r', asts:[gte(close, 100)] }]);
  const day = bars('2330', [99, 99, 101, 102, 103, 104, 105]);
  run(day.slice(0, 2));                                       // baseline: not met
  const result = run(day);
  assert.deepEqual(result.triggers.map((event) => event.barEnd), [day[2].barEnd]);
  assert.equal(ruleStates.getState('r', '2330').state, 'triggered');
  assert.equal(run(day).triggers.length, 0);                  // same bars again: nothing
});

test('flicker around the threshold is suppressed until the rule has been off for rearmBars', () => {
  const { ruleStates, run } = engine([{ ruleId:'r', asts:[gte(close, 100)] }]);
  //            base  ↑T   ↓C   ↑(supp) ↓C  ×   ×  → idle  ↑T
  const closes = [99, 101, 99, 101,    99, 98, 97, 101];
  const day = bars('2330', closes);
  run(day.slice(0, 1));
  const result = run(day);
  assert.deepEqual(result.triggers.map((event) => event.barEnd), [day[1].barEnd, day[7].barEnd]);
  assert.equal(result.suppressed, 1);
  assert.equal(result.rearmed, 1);                            // 99, 98, 97 = three bars off → armed again
  const state = ruleStates.getState('r', '2330');
  assert.deepEqual([state.state, state.triggersToday, state.suppressedToday], ['triggered', 2, 1]);
});

test('an event rule (cross) uses the longer re-arm: a re-cross within 30 bars is suppressed', () => {
  const { run } = engine([{ ruleId:'r', asts:[crossAboveSma(2)] }], { rearmBars:{ event:4 } });
  // SMA(2) crosses: up at 10→12 (index 2), down, up again soon (index 5) → suppressed; later after 4 off bars → trigger.
  const day = bars('2330', [10, 10, 12, 9, 9, 12, 12, 12, 12, 8, 8, 8, 8, 8, 12]);
  run(day.slice(0, 2));
  const result = run(day);
  assert.equal(result.triggers.length, 2);
  assert.deepEqual([result.triggers.map((event) => event.barEnd), result.suppressed], [[day[2].barEnd, day[14].barEnd], 1]);
});

test('AND across conditions: triggers only on the bar where all are met', () => {
  const { run } = engine([{ ruleId:'r', asts:[gte(close, 100), gte(vol, 5000)] }]);
  const day = bars('2330', [99, 101, 101, 101], { volumes:[1000, 1000, 6000, 6000] });
  run(day.slice(0, 1));
  const result = run(day);
  assert.deepEqual(result.triggers.map((event) => event.barEnd), [day[2].barEnd]);
});

test('already met when monitoring begins: starts as triggered without a notification', () => {
  const { ruleStates, run } = engine([{ ruleId:'r', asts:[gte(close, 100)] }]);
  const result = run(bars('2330', [101, 102]));
  assert.equal(result.triggers.length, 0);
  assert.equal(result.baselines, 1);
  const state = ruleStates.getState('r', '2330');
  assert.deepEqual([state.state, state.baseline], ['triggered', true]);
});

test('a new trading day resets every rule (當沖 session reset)', () => {
  const { ruleStates, run } = engine([{ ruleId:'r', asts:[gte(close, 100)] }]);
  run(bars('2330', [99])); run(bars('2330', [99, 101]));
  assert.equal(ruleStates.getState('r', '2330').triggersToday, 1);
  run(bars('2330', [99], { date:'2026-10-09' }));
  const state = ruleStates.getState('r', '2330');
  assert.deepEqual([state.tradingDate, state.state, state.triggersToday], ['2026-10-09', 'idle', 0]);
});

test('only rules whose conditions changed are walked; idle rules with no change are skipped', () => {
  const { run } = engine([{ ruleId:'price', asts:[gte(close, 100)] }, { ruleId:'volume', asts:[gte(vol, 5000)] }]);
  run(bars('2330', [99]));
  const result = run(bars('2330', [99, 101]));                // price changed, volume did not
  assert.deepEqual([result.walked, result.skipped, result.triggers.map((event) => event.ruleId)], [1, 1, ['price']]);
});

test('two rules sharing a condition keep separate states', () => {
  const { ruleStates, run } = engine([{ ruleId:'userA', asts:[gte(close, 100)] }, { ruleId:'userB', asts:[gte(close, 100), gte(vol, 5000)] }]);
  run(bars('2330', [99]));
  const result = run(bars('2330', [99, 101]));
  assert.deepEqual(result.triggers.map((event) => event.ruleId), ['userA']);
  assert.equal(ruleStates.getState('userB', '2330').state, 'idle');
});

test('unknown (warm-up) never triggers; the end of warm-up does', () => {
  const sma3 = { op:'gte', left:close, right:{ op:'sma', input:close, period:3 } };
  const { run } = engine([{ ruleId:'r', asts:[sma3] }]);
  assert.equal(run(bars('2330', [10])).triggers.length, 0);
  assert.equal(run(bars('2330', [10, 11, 12])).triggers.length, 1);
});

test('state survives a restart through the file backend', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rule-state-'));
  try {
    const file = join(dir, 'rule-state.json');
    const rule = { ruleId:'r', name:'價格 ≥ 100', conditions:[describeCondition(gte(close, 100))] };
    const first = new RuleStateStore(file, { log:quiet });
    const conditions = new ConditionStateStore('/dev/null', { log:quiet });
    conditions.syncRules([rule]); first.syncRules([rule]);
    first.beginRun(); conditions.evaluate(bars('2330', [99, 101], { date:recentTradingDate() }), new Date(), { onSymbol:(ctx) => first.onSymbol(ctx, conditions) }); first.endRun();
    assert.deepEqual(await first.flush(), { states:1 });
    const restarted = await new RuleStateStore(file, { log:quiet }).load();
    assert.deepEqual([restarted.getState('r', '2330').state, restarted.getState('r', '2330').baseline], ['triggered', true]);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('snapshot compares shadow triggers with the current engine and reports session close', () => {
  const { ruleStates, run } = engine([{ ruleId:'r', name:'價格 ≥ 100', asts:[gte(close, 100)] }]);
  run(bars('2330', [99])); run(bars('2330', [99, 101]));
  const snapshot = ruleStates.snapshot({ now:new Date('2026-10-08T06:00:00Z'), legacySignalsToday:7 });   // 14:00 Taipei
  assert.deepEqual(snapshot.comparison, { day:'2026-10-08', shadowTriggers:1, suppressed:0, legacySignals:7 });
  assert.deepEqual(snapshot.rules[0].states, { idle:0, triggered:1, cooldown:0 });
  assert.equal(snapshot.rules[0].sessionClosed, true);
  assert.equal(snapshot.recentEvents[0].ruleName, '價格 ≥ 100');
  assert.equal(sessionClosed('2026-10-08', new Date('2026-10-08T03:00:00Z')), false);
  assert.equal(ruleTruth({ conditionKeys:['a', 'b'] }, new Map([['a', [true]], ['b', [null]]]), 0), null);
});

test('event rules re-arm 30 minutes after the last notification, even if they keep re-crossing', async () => {
  const { ruleTriggerIndexes } = await import('./ruleState.js');
  // A cross every 10 minutes for 100 minutes: notify at 0, 30, 60, 90 (re-crosses in between are suppressed).
  const truth = Array.from({ length:100 }, (_, index) => index % 10 === 0);
  assert.deepEqual(ruleTriggerIndexes(truth, 30, 'event'), [0, 30, 60, 90]);
  // A level rule that never goes off for 3 bars notifies once.
  assert.deepEqual(ruleTriggerIndexes(Array(100).fill(true), 3, 'level'), [0]);
  // Unknown bars are skipped; time comes from barEnds when given.
  const ends = [0, 60_000, 40 * 60_000].map((ms) => ms + 1_000_000);
  assert.deepEqual(ruleTriggerIndexes([true, true, true], 30, 'event', ends), [0, 2]);
});

// Taipei calendar date of today: restart tests load files through the 7-day retention filter.
function recentTradingDate() { return new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10); }
