import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyStore } from './conditionExample.js';
import { DailyIndex, dailyBarsFromMinutes, dailyCapable } from './dailyIndex.js';

const close = { op:'source', field:'close' };
const above = (period) => ({ op:'gt', left:close, right:{ op:'sma', input:close, period } });
const gtConst = (value) => ({ op:'gt', left:close, right:{ op:'constant', value } });
const rows = (symbol, prices) => prices.map((price, index) => ({ symbol, date:new Date(Date.UTC(2026, 8, 1) + index * 86_400_000).toISOString().slice(0, 10), open:price, high:price + 1, low:price - 1, close:price, volume:1000 }));

function store() {
  const daily = new DailyStore();
  // 1101 climbs the whole time; 2330 falls; 2303 is flat then jumps on the last day.
  daily.add('m', rows('1101', Array.from({ length:40 }, (_, i) => 100 + i)));
  daily.add('m', rows('2330', Array.from({ length:40 }, (_, i) => 200 - i)));
  daily.add('m', rows('2303', Array.from({ length:40 }, (_, i) => (i === 39 ? 70 : 50))));
  return daily.finalize();
}

test('daily index: stocks met on the latest close, per-day counts, new entries, candidates and lists', () => {
  const index = new DailyIndex({ days:7 });
  index.setSeries(store());
  index.ensure([{ key:'sma5', ast:above(5) }, { key:'gt60', ast:gtConst(60) }]);
  assert.equal(index.dates.length, 7);
  const result = index.query({ filters:['sma5'], candidates:['gt60'], list:true });
  assert.equal(result.steps[0].latestCount, 2);                       // 1101 (rising) and 2303 (jumped)
  assert.deepEqual(result.steps[0].symbols, ['1101', '2303']);
  assert.equal(result.steps[0].days.at(-1).newCount, 1);              // 2303 became met on the last day
  assert.equal(result.candidates[0].latestCount, 2);                  // both also close above 60
  assert.deepEqual(index.query({ filters:['sma5'], events:true }).steps[0].events, [{ date:index.dates.at(-1), symbol:'2303', price:70 }]);
  const both = index.query({ filters:['sma5', 'gt60'] });
  assert.equal(both.steps[1].latestCount, 2);
  // The list a minute-bar day uses is the previous daily close.
  const last = index.dates.at(-1), previous = index.dates.at(-2);
  assert.deepEqual([...index.listFor(['sma5'], last)], ['1101']);
  assert.deepEqual([...index.metOn(['sma5'], previous)], ['1101']);
  assert.equal(index.listFor(['sma5'], '2026-12-31').size, 2);
});

test('daily index rejects session-only conditions (VWAP) and recomputes on new data', () => {
  const vwap = { op:'gt', left:close, right:{ op:'div', left:{ op:'cumsum', input:{ op:'mul', left:close, right:{ op:'source', field:'volume' } } }, right:{ op:'cumsum', input:{ op:'source', field:'volume' } } } };
  assert.equal(dailyCapable(vwap), false);
  assert.equal(dailyCapable(above(20)), true);
  const index = new DailyIndex();
  index.setSeries(store());
  assert.throws(() => index.ensure([{ key:'vwap', ast:vwap }]), (error) => error.code === 'DAILY_CONDITION_UNSUPPORTED');
  index.ensure([{ key:'sma5', ast:above(5) }]);
  index.setSeries(store());
  assert.equal(index.query({ filters:['sma5'] }).steps[0].latestCount, 2);
});

test('after the close: today is built from minute bars and only newly met stocks are reported', () => {
  const series = store(), index = new DailyIndex();
  index.setSeries(series);
  index.ensure([{ key:'gt65', ast:gtConst(65) }]);
  const last = index.dates.at(-1);
  const today = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const minutes = (prices, volume) => ({ t:Float64Array.from(prices, (_, i) => i), o:Float64Array.from(prices), h:Float64Array.from(prices), l:Float64Array.from(prices), c:Float64Array.from(prices), v:Float64Array.from(prices, () => volume) });
  // Volume scale: on `last`, every stock's daily volume 1000 vs minute volume 2 × 5 = 10 → ×100.
  const overlapDay = new Map(['1101', '2330', '2303', '9999', '8888'].map((symbol) => [symbol, minutes([1, 1], 5)]));
  const bars = dailyBarsFromMinutes(new Map([['1101', minutes([140, 142, 141], 1)], ['2330', minutes([150, 160], 1)], ['2303', minutes([69, 72], 1)]]), today, { series, overlapDate:last, overlapDay });
  assert.deepEqual(bars.get('1101'), { date:today, open:140, high:142, low:140, close:141, volume:300 });
  const result = index.closeCheck(['gt65'], bars);
  // 1101 met yesterday too (not new); 2303 was 70 yesterday (met, not new); 2330 was 161 yesterday → still met, not new.
  assert.deepEqual(result.newly, []);
  const drop = dailyBarsFromMinutes(new Map([['2303', minutes([60, 66], 1)]]), today);
  assert.deepEqual(index.closeCheck(['gt65'], drop).newly, []);   // met yesterday (70) as well
  index.ensure([{ key:'gt71', ast:gtConst(71) }]);
  assert.deepEqual(index.closeCheck(['gt71'], bars).newly, [{ symbol:'2303', close:72 }]);
  assert.deepEqual(index.closeCheck(['gt71'], bars, new Set(['1101'])).newly, []);
});
