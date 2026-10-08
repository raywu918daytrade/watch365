import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyStore, findExample } from './conditionExample.js';
import { HistoryIndex } from './historyIndex.js';
import { describeCondition } from './conditionState.js';
import { wilderRsi } from './formulaRecipes.js';

const close = { op:'source', field:'close' };
const cond = (ast) => ({ key:describeCondition(ast).key, ast });
const crossSma = (period) => ({ op:'crosses_above', left:close, right:{ op:'sma', input:close, period } });
const rsiBelow = (value) => ({ op:'lt', left:wilderRsi(14), right:{ op:'constant', value } });
const days = (count, price) => Array.from({ length:count }, (_, index) => { const date = new Date(Date.UTC(2024, 0, 1) + index * 86_400_000).toISOString().slice(0, 10); const value = price(index); return { date, open:value, high:value + 0.5, low:value - 0.5, close:value, volume:1000 }; });

test('daily example: latest day where every filter holds, unnamed, with lines, thresholds and markers', () => {
  const daily = new DailyStore();
  // A dip then a recovery: price crosses back above SMA(5) around day 50 while RSI(14) is still low.
  const shape = (index) => (index < 40 ? 100 : index < 50 ? 100 - (index - 40) * 2 : 80 + (index - 50) * 3);
  const rows = (symbol) => days(70, shape).map((row) => ({ ...row, symbol }));
  daily.add('2024-01', rows('1101')); daily.add('2024-01', rows('2330').map((row) => ({ ...row, volume:9000 })));
  const example = findExample({ filters:[cond(crossSma(5))], daily });
  assert.equal(example.timeframe, 'd1');
  assert.equal(example.symbol, undefined);                         // the stock is not named
  assert.ok(example.markers.length >= 1);
  assert.equal(example.price.length, 1);                           // SMA(5) drawn on the price panel
  assert.match(example.price[0].label, /SMA/);
  assert.ok(example.candles.length <= 76);
  // RSI goes to a sub panel with its threshold line.
  const both = findExample({ filters:[cond(crossSma(5)), cond(rsiBelow(60))], daily });
  assert.equal(both.panels.length, 1);
  assert.deepEqual(both.panels[0].thresholds, [60]);
});

test('falls back to the one-minute index when daily bars never meet it, and session blocks skip daily', () => {
  const daily = new DailyStore();
  daily.add('2024-01', days(30, () => 100).map((row) => ({ ...row, symbol:'2330' })));   // flat: never crosses
  const index = new HistoryIndex();
  const filter = cond(crossSma(3));
  index.ensure([filter]);
  const t0 = Date.parse('2026-10-08T01:01:00.000Z');
  index.setDay('2026-10-08', new Map([['2317', [10, 10, 10, 10, 12, 12].map((price, bar) => ({ barEnd:t0 + bar * 60_000, open:price, high:price, low:price, close:price, volume:1 }))]]));
  const example = findExample({ filters:[filter], daily, index });
  assert.equal(example.timeframe, 'm1');
  assert.deepEqual(example.markers, [4]);
  // VWAP (cumsum) only makes sense within a session → straight to minutes.
  const vwapAst = { op:'gt', left:close, right:{ op:'div', left:{ op:'cumsum', input:{ op:'mul', left:close, right:{ op:'source', field:'volume' } } }, right:{ op:'cumsum', input:{ op:'source', field:'volume' } } } };
  const vwap = cond(vwapAst);
  index.ensure([vwap]);
  assert.equal(findExample({ filters:[vwap], daily:null, index })?.timeframe ?? 'm1', 'm1');
  assert.equal(findExample({ filters:[cond({ op:'lt', left:close, right:{ op:'constant', value:1 } })], daily, index:null }), null);
});

test('daily dates are read from every storage format', async () => {
  const { dailyDate } = await import('./history.js');
  assert.equal(dailyDate(20553), '2026-04-10');                    // parquet DATE: days since 1970
  assert.equal(dailyDate(20261008), '2026-10-08');                 // YYYYMMDD integer
  assert.equal(dailyDate('2026-10-08'), '2026-10-08');
  assert.equal(dailyDate('20261008'), '2026-10-08');
  assert.equal(dailyDate(new Date('2026-10-07T16:00:00Z')), '2026-10-08');   // midnight Taipei
  assert.equal(dailyDate(Date.parse('2026-10-08T00:00:00+08:00')), '2026-10-08');
  assert.equal(dailyDate(null), null);
});
