import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicConditions, ConditionStateStore, conditionKind, describeCondition, groupSessionBars, rulesFromSettings } from './conditionState.js';
import { planConditionStrategy } from './monitorConditions.js';
import { wilderRsi } from './formulaRecipes.js';

const quiet = { error() {}, warn() {}, info() {} };
const close = { op:'source', field:'close' };
const gte = (value) => ({ op:'gte', left:close, right:{ op:'constant', value } });
const crossAboveSma = (period) => ({ op:'crosses_above', left:close, right:{ op:'sma', input:close, period } });

// 1-minute bars for one symbol starting 09:00 Taipei (01:00Z) on 2026-10-08.
function bars(symbol, closes, { date = '2026-10-08', startMinute = 0 } = {}) {
  return closes.map((price, index) => {
    const start = new Date(`${date}T01:00:00.000Z`); start.setUTCMinutes(start.getUTCMinutes() + startMinute + index);
    const end = new Date(start.getTime() + 60_000);
    return { symbol, market:'TWSE', tradingDate:date, barStart:start.toISOString(), barEnd:end.toISOString(), open:price, high:price, low:price, close:price, volume:1000, complete:true, providerEventAt:end.toISOString() };
  });
}
const rule = (ruleId, ...asts) => ({ ruleId, conditions:asts.map(describeCondition) });

test('the same condition gets the same key regardless of key order or who built it', () => {
  const a = describeCondition({ op:'gte', left:close, right:{ op:'constant', value:100 } });
  const b = describeCondition({ right:{ value:100, op:'constant' }, op:'gte', left:{ field:'close', op:'source' } });
  assert.equal(a.key, b.key);
  // The structured UI path (formula) and the registry SMA strategy describe the same condition.
  const registry = atomicConditions({ executor:'sma_cross', params:{ period:20 } });
  const ui = atomicConditions(planConditionStrategy([{ indicator:'sma', direction:'above', period:20 }, { indicator:'ema', direction:'below', period:10 }]).strategy);
  assert.equal(ui.length, 2);
  assert.equal(registry[0].key, ui[0].key);
  // Registry RSI maps onto the Wilder RSI recipe the formula path uses.
  const rsi = atomicConditions({ executor:'rsi_wilder_cross', params:{ period:14, threshold:30 } })[0];
  assert.equal(rsi.key, describeCondition({ op:'crosses_above', left:wilderRsi(14), right:{ op:'constant', value:30 } }).key);
  assert.deepEqual(atomicConditions({ executor:'high_volume_breakout', params:{} }), []);
});

test('condition kind: crosses are events, comparisons are levels', () => {
  assert.equal(conditionKind(crossAboveSma(5)), 'event');
  assert.equal(conditionKind(gte(1)), 'level');
  assert.equal(conditionKind({ op:'any', items:[gte(1), crossAboveSma(5)] }), 'event');
});

test('first sight of a day is a baseline; later bars emit flips for every new bar, not just the latest', () => {
  const store = new ConditionStateStore('/dev/null', { log:quiet });
  const condition = describeCondition(gte(100));
  store.syncRules([{ ruleId:'r1', conditions:[condition] }]);
  const day = bars('2330', [99, 101, 99, 99, 99, 101, 102, 98, 97, 101]);
  const first = store.evaluate(day.slice(0, 5));
  assert.equal(first.baselines, 1);
  assert.equal(first.flips.length, 0);                       // history before we started watching is not news
  assert.deepEqual({ value:store.getState(condition.key, '2330').value, flips:store.getState(condition.key, '2330').flipsToday }, { value:false, flips:2 });
  // Two polls' worth of bars arrive at once: 101(↑) 102 98(↓) 97 101(↑) → three flips, in bar order.
  const second = store.evaluate(day);
  assert.deepEqual(second.flips.map((flip) => [flip.to, flip.barEnd]), [[true, day[5].barEnd], [false, day[7].barEnd], [true, day[9].barEnd]]);
  assert.equal(store.getState(condition.key, '2330').since, day[9].barEnd);
  assert.equal(store.getState(condition.key, '2330').flipsToday, 5);
  // Same bars again (the HF file did not move between polls) → nothing new.
  assert.equal(store.evaluate(day).flips.length, 0);
});

test('one computation per (condition, symbol) is shared by every rule that references it', () => {
  const store = new ConditionStateStore('/dev/null', { log:quiet });
  store.syncRules([rule('userA', gte(100), crossAboveSma(3)), rule('userB', gte(100)), rule('userC', crossAboveSma(3))]);
  assert.equal(store.conditions.size, 2);
  const key = describeCondition(gte(100)).key;
  assert.deepEqual(store.rulesFor(key).sort(), ['userA', 'userB']);
  const result = store.evaluate([...bars('2330', [99, 101]), ...bars('2317', [101, 102])]);
  assert.equal(result.symbols, 2);
  assert.equal(store.states.size, 4);                         // 2 conditions × 2 symbols, not × 3 rules
  // Dropping a rule keeps a condition alive while someone still references it; the last reference removes it.
  store.syncRules([rule('userA', gte(100), crossAboveSma(3)), rule('userC', crossAboveSma(3))]);
  assert.deepEqual(store.rulesFor(key), ['userA']);
  store.syncRules([rule('userC', crossAboveSma(3))]);
  assert.equal(store.conditions.has(key), false);
  assert.equal(store.states.size, 2);
});

test('unknown values (warm-up, gaps) never count as a flip and keep the last known value', () => {
  const store = new ConditionStateStore('/dev/null', { log:quiet });
  const condition = describeCondition({ op:'gte', left:close, right:{ op:'sma', input:close, period:3 } });
  store.syncRules([{ ruleId:'r', conditions:[condition] }]);
  store.evaluate(bars('2330', [10]));                          // warm-up: value unknown
  assert.equal(store.getState(condition.key, '2330').value, null);
  const result = store.evaluate(bars('2330', [10, 11, 12, 13]));
  assert.equal(result.flips.length, 0);                        // null → true is the end of warm-up, not a flip
  assert.equal(store.getState(condition.key, '2330').value, true);
});

test('a new trading day starts a new baseline', () => {
  const store = new ConditionStateStore('/dev/null', { log:quiet });
  const condition = describeCondition(gte(100));
  store.syncRules([{ ruleId:'r', conditions:[condition] }]);
  store.evaluate(bars('2330', [99, 99]));
  const next = store.evaluate(bars('2330', [101, 101], { date:'2026-10-09' }));
  assert.equal(next.flips.length, 0);
  assert.equal(next.baselines, 1);
  assert.deepEqual([store.getState(condition.key, '2330').tradingDate, store.getState(condition.key, '2330').flipsToday], ['2026-10-09', 0]);
});

test('bars outside the regular session, incomplete or duplicated are ignored', () => {
  const day = bars('2330', [1, 2, 3]);
  const early = bars('2330', [9], { startMinute:-30 });       // 08:30
  const grouped = groupSessionBars([...day, day[1], { ...day[2], barEnd:'2026-10-08T01:10:00.000Z', complete:false }, ...early]);
  assert.deepEqual(grouped.get('2330').map((bar) => bar.close), [1, 2, 3]);
});

test('state survives a restart through the file backend and resumes from the last bar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cond-state-'));
  try {
    const file = join(dir, 'condition-state.json');
    const condition = describeCondition(gte(100));
    const day = bars('2330', [99, 99, 101, 99]);
    const first = new ConditionStateStore(file, { log:quiet });
    first.syncRules([{ ruleId:'r', conditions:[condition] }]);
    first.evaluate(day.slice(0, 2));
    assert.deepEqual(await first.flush(), { states:1, definitions:1 });
    assert.deepEqual(await first.flush(), { states:0, definitions:0 });   // nothing changed → no write
    const restarted = await new ConditionStateStore(file, { log:quiet }).load();
    restarted.syncRules([{ ruleId:'r', conditions:[condition] }]);
    // Bars that arrived while the process was down are walked, not skipped.
    assert.deepEqual(restarted.evaluate(day).flips.map((flip) => flip.to), [true, false]);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('rulesFromSettings: one rule for an enabled strategy, none when paused or legacy', () => {
  const strategy = planConditionStrategy([{ indicator:'ema', direction:'above', period:10 }]).strategy;
  assert.equal(rulesFromSettings({ enabled:true, strategy })[0].conditions.length, 1);
  assert.deepEqual(rulesFromSettings({ enabled:false, strategy }), []);
  assert.deepEqual(rulesFromSettings({ enabled:true, strategy:{ executor:'high_volume_breakout', params:{} } }), []);
});

test('snapshot reports per-condition counts and recent flips for the admin page', () => {
  const store = new ConditionStateStore('/dev/null', { log:quiet });
  store.syncRules([rule('r', gte(100))]);
  store.evaluate([...bars('2330', [99]), ...bars('2317', [101])]);
  store.evaluate([...bars('2330', [99, 101]), ...bars('2317', [101, 102])]);
  const snapshot = store.snapshot();
  assert.equal(snapshot.mode, 'shadow');
  assert.deepEqual(snapshot.conditions.map(({ symbols, trueNow, flipsToday, rules }) => ({ symbols, trueNow, flipsToday, rules })), [{ symbols:2, trueNow:2, flipsToday:1, rules:1 }]);
  assert.equal(snapshot.recentFlips[0].symbol, '2330');
  assert.ok(snapshot.recentFlips[0].label);
});
