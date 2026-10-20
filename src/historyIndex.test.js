import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryIndex } from './historyIndex.js';
import { describeCondition } from './conditionState.js';

const close = { op:'source', field:'close' };
const gte = (value) => ({ op:'gte', left:close, right:{ op:'constant', value } });
const lte = (value) => ({ op:'lte', left:close, right:{ op:'constant', value } });
const volGte = (value) => ({ op:'gte', left:{ op:'source', field:'volume' }, right:{ op:'constant', value } });
const cond = (ast) => ({ key:describeCondition(ast).key, ast });

function day(date, closes, { volumes = null, gapAt = null } = {}) {
  let t = Date.parse(`${date}T01:01:00.000Z`);
  return closes.map((price, index) => { if (index && index === gapAt) t += 10 * 60_000; else if (index) t += 60_000; return { barEnd:t, open:price, high:price, low:price, close:price, volume:volumes?.[index] ?? 1000 }; });
}

test('a condition is computed once per stock-day; picking filters only combines stored results', () => {
  const index = new HistoryIndex();
  const a = cond(gte(100)), b = cond(volGte(5000));
  index.ensure([a, b]);
  index.setDay('2026-10-07', new Map([['2330', day('2026-10-07', [99, 101, 102, 99, 99, 99, 101], { volumes:[1, 1, 1, 1, 1, 1, 9000] })], ['2317', day('2026-10-07', [50, 50, 50])]]));
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [101, 102])], ['2317', day('2026-10-08', [100, 99, 99, 99, 100], { volumes:[1, 1, 1, 1, 6000] })]]));
  const stored = index.conditions.get(a.key).truth;
  const result = index.query({ filters:[a.key, b.key], candidates:[b.key] });
  // Step 1 (price ≥ 100 alone): 2330 on 10/07 at bar 1 and again at bar 6 (re-armed after 3 bars off); 10/08 bar 0;
  // 2317 on 10/08 at bar 0 and bar 4 → 5 notifications, 2 stocks.
  assert.deepEqual([result.steps[0].triggeredSymbols, result.steps[0].totalEvents], [2, 5]);
  // Step 2 (and volume ≥ 5000): only the bars where both hold.
  assert.deepEqual([result.steps[1].triggeredSymbols, result.steps[1].totalEvents], [2, 2]);
  assert.deepEqual(result.steps[1].days, [{ date:'2026-10-08', count:1 }, { date:'2026-10-07', count:1 }]);
  assert.equal(result.steps[1].events.length, 2);
  assert.equal(result.steps[0].events, undefined);            // only the last step carries the event list
  assert.equal(index.conditions.get(a.key).truth, stored);    // nothing recomputed by querying
  assert.equal(result.availableDays, 2);
});

test('forward stats: every trigger whose later close is known, on steps and candidates', () => {
  const index = new HistoryIndex();
  const a = cond(gte(100)), b = cond(volGte(5000));
  index.ensure([a, b]);
  index.setDay('2026-10-07', new Map([['2330', day('2026-10-07', [99, 101, 102, 99, 99, 99, 101], { volumes:[1, 1, 1, 1, 1, 1, 9000] })], ['2317', day('2026-10-07', [50, 50, 50])]]));
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [101, 102])], ['2317', day('2026-10-08', [100, 99, 99, 99, 100], { volumes:[1, 1, 1, 1, 6000] })]]));
  // 10/07 closes 7 days later are known (2330 → 110, 2317 unknown); 10/08 has no later close yet.
  const later = { '2330':110 };
  const forward = { days:7, value:(date, symbol, price) => (date === '2026-10-07' && later[symbol] ? later[symbol] / price - 1 : NaN) };
  const result = index.query({ filters:[a.key], candidates:[b.key], forward });
  // 2330 on 10/07 triggers at 101 and 101 → +8.9 % both times; 10/08 and 2317 contribute no sample.
  assert.equal(result.steps[0].forward.samples, 2);
  assert.equal(result.steps[0].forward.dates, 1);
  assert.equal(result.steps[0].forward.winRate, 1);
  assert.ok(Math.abs(result.steps[0].forward.mean - (110 / 101 - 1)) < 1e-12);
  assert.equal(result.candidates[0].forward.samples, 1);           // and volume ≥ 5000: only the bar-6 trigger
  assert.equal(index.query({ filters:[a.key], symbols:new Set(['2317']), forward }).steps[0].forward, null);
  assert.equal(index.query({ filters:[a.key] }).steps[0].forward, undefined);   // not asked for
});

test('the funnel shows which filter empties the result', () => {
  const index = new HistoryIndex();
  const a = cond(gte(100)), b = cond(lte(50));
  index.ensure([a, b]);
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99, 101, 102])]]));
  const result = index.query({ filters:[a.key, b.key] });
  assert.deepEqual(result.steps.map((step) => step.triggeredSymbols), [1, 0]);
});

test('candidates: each list row shows the result of adding it to the current filters', () => {
  const index = new HistoryIndex();
  const a = cond(gte(100)), b = cond(gte(101)), c = cond(lte(50));
  index.ensure([a, b, c]);
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99, 101, 102])], ['2317', day('2026-10-08', [100, 100])]]));
  const result = index.query({ filters:[a.key], candidates:[b.key, c.key] });
  assert.deepEqual(result.candidates.map((item) => item.triggeredSymbols), [1, 0]);
  // Without filters a candidate is just itself.
  assert.deepEqual(index.query({ candidates:[a.key] }).candidates[0], { key:a.key, triggeredSymbols:2, totalEvents:2 });
});

test('watchlist scope restricts the stocks counted', () => {
  const index = new HistoryIndex();
  const a = cond(gte(100));
  index.ensure([a]);
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99, 101])], ['2317', day('2026-10-08', [99, 101])]]));
  assert.equal(index.query({ filters:[a.key], symbols:new Set(['2317']) }).steps[0].triggeredSymbols, 1);
});

test('a condition added later is computed once over the days in memory; missing ones are an error', () => {
  const index = new HistoryIndex();
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99, 101])]]));
  const a = cond(gte(100));
  assert.throws(() => index.query({ filters:[a.key] }), /HISTORY_INDEX_CONDITION_MISSING/);
  assert.equal(index.ensure([a, a]), 1);
  assert.equal(index.ensure([a]), 0);
  assert.equal(index.query({ filters:[a.key] }).steps[0].totalEvents, 1);
});

test('replacing today recomputes only that day; old days roll off', () => {
  const index = new HistoryIndex({ maxDays:2 });
  const a = cond(gte(100));
  index.ensure([a]);
  index.setDay('2026-10-06', new Map([['2330', day('2026-10-06', [99, 101])]]));
  index.setDay('2026-10-07', new Map([['2330', day('2026-10-07', [99, 101])]]));
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99])]]));
  assert.deepEqual(index.dates(), ['2026-10-07', '2026-10-08']);
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [99, 101])]]));   // more bars of today
  assert.equal(index.query({ filters:[a.key] }).steps[0].totalEvents, 2);
});

test('a data gap restarts the indicator like the live engine', () => {
  const index = new HistoryIndex();
  const crossSma = { op:'crosses_above', left:close, right:{ op:'sma', input:close, period:2 } };
  const a = cond(crossSma);
  index.ensure([a]);
  // 10 10 | gap | 12 → after the gap SMA(2) has no history, so 12 is warm-up, not a cross.
  index.setDay('2026-10-08', new Map([['2330', day('2026-10-08', [10, 10, 12], { gapAt:2 })]]));
  assert.equal(index.query({ filters:[a.key] }).steps[0].totalEvents, 0);
});
