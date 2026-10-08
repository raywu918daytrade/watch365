import test from 'node:test';
import assert from 'node:assert/strict';
import { applyScopedMarketBars, STATE_SIGNAL_MAX_AGE_MS } from './signalEngine.js';
import { planConditionStrategy } from './monitorConditions.js';
import { strategyIdentity } from './indicatorRegistry.js';

const strategy = { ...planConditionStrategy([{ indicator:'ema', direction:'above', period:5 }]).strategy, activatedAt:'2026-10-08T00:00:00.000Z' };
const bar = (symbol, barEnd, close = 100) => ({ symbol, market:'TWSE', provider:'hf_dataset', timeframe:'1m', tradingDate:'2026-10-08', barStart:new Date(new Date(barEnd).getTime() - 60_000).toISOString(), barEnd, open:close, high:close, low:close, close, volume:1000, complete:true, providerEventAt:barEnd, receivedAt:barEnd });
function freshState() {
  return { settings:{ enabled:true, strategy, watchlist:[{ symbol:'2330', name:'台積電', market:'TWSE' }, { symbol:'2317', name:'鴻海', market:'TWSE' }], notification:{ channel:'browser', target:'本機瀏覽器' } }, runtime:{}, quotes:[], decisions:[], signals:[], notifications:[], dedupe:{} };
}
const scope = { effectiveWatchlist:[{ symbol:'2330' }, { symbol:'2317' }] };
const now = new Date('2026-10-08T02:00:30.000Z');
const ruleId = strategyIdentity(strategy);
const trigger = (symbol, barEnd) => ({ type:'trigger', ruleId, symbol, barEnd, tradingDate:'2026-10-08' });

test('state engine: one signal + notification per rule trigger, deduplicated across runs', () => {
  const state = freshState();
  const bars = [bar('2330', '2026-10-08T02:00:00.000Z', 612), bar('2317', '2026-10-08T02:00:00.000Z')];
  const first = applyScopedMarketBars(state, bars, scope, 'test', now, { ruleTriggers:[trigger('2330', '2026-10-08T02:00:00.000Z')] });
  assert.equal(first.signals.length, 1);
  assert.deepEqual([state.signals[0].symbol, state.signals[0].engine, state.signals[0].price, state.signals[0].name], ['2330', 'state_machine', 612, '台積電']);
  assert.equal(state.notifications.length, 1);
  assert.match(state.notifications[0].message, /2330 台積電 條件成立/);
  const again = applyScopedMarketBars(state, bars, scope, 'test', now, { ruleTriggers:[trigger('2330', '2026-10-08T02:00:00.000Z')] });
  assert.equal(again.signals.length, 0);
  assert.equal(state.notifications.length, 1);
});

test('state engine: late triggers, other rules and unselected stocks are not notified', () => {
  const state = freshState();
  const old = '2026-10-08T01:50:00.000Z';
  const bars = [bar('2330', old), bar('2330', '2026-10-08T02:00:00.000Z'), bar('9999', '2026-10-08T02:00:00.000Z')];
  const result = applyScopedMarketBars(state, bars, scope, 'test', now, { ruleTriggers:[trigger('2330', old), { ...trigger('2330', '2026-10-08T02:00:00.000Z'), ruleId:'other' }, trigger('9999', '2026-10-08T02:00:00.000Z')] });
  assert.equal(result.signals.length, 0);
  assert.equal(result.late.length, 1);
  assert.ok(now - new Date(old) > STATE_SIGNAL_MAX_AGE_MS);
});

test('state engine: the old per-bar engine still logs decisions but its would-be signals are only counted', () => {
  const state = freshState();
  const closes = [10, 10, 10, 10, 10, 10, 12];
  // providerEventAt = just now for every bar, so the old engine's 120 s staleness check lets all of them through.
  const bars = closes.map((close, index) => ({ ...bar('2330', new Date(Date.parse('2026-10-08T01:54:00.000Z') + index * 60_000).toISOString(), close), providerEventAt:'2026-10-08T02:00:20.000Z' }));
  const result = applyScopedMarketBars(state, bars, scope, 'test', now, { ruleTriggers:[] });
  assert.equal(result.signals.length, 0);
  assert.ok(result.decisions.some((decision) => decision.reasonCode === 'superseded_by_state_machine'));
  assert.deepEqual(state.runtime.legacyShadow, { day:'2026-10-08', count:1 });
});

test('legacy engine (no ruleTriggers) keeps the old behaviour', () => {
  const state = freshState();
  const closes = [10, 10, 10, 10, 10, 10, 12];
  // providerEventAt = just now for every bar, so the old engine's 120 s staleness check lets all of them through.
  const bars = closes.map((close, index) => ({ ...bar('2330', new Date(Date.parse('2026-10-08T01:54:00.000Z') + index * 60_000).toISOString(), close), providerEventAt:'2026-10-08T02:00:20.000Z' }));
  const result = applyScopedMarketBars(state, bars, scope, 'test', now);
  assert.equal(result.signals.length, 1);
  assert.equal(result.signals[0].engine, undefined);
});
