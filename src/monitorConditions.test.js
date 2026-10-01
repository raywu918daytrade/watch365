import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConditions, planConditionStrategy } from './monitorConditions.js';
import { validateFormulaStrategy } from './indicatorRegistry.js';

test('single RSI upward cross maps to the rsi.cross registry strategy', () => {
  const plan = planConditionStrategy([{ indicator:'rsi', direction:'above', period:14, threshold:30 }]);
  assert.deepEqual(plan, { kind:'registry', request:{ id:'rsi.cross', version:'1.0.0', params:{ period:14, threshold:30 } } });
});

test('single SMA upward cross maps to the sma.cross registry strategy', () => {
  const plan = planConditionStrategy([{ indicator:'sma', direction:'above', period:20 }]);
  assert.deepEqual(plan, { kind:'registry', request:{ id:'sma.cross', version:'1.0.0', params:{ period:20 } } });
});

test('EMA and downward crosses become a valid formula strategy', () => {
  const plan = planConditionStrategy([{ indicator:'ema', direction:'below', period:10 }]);
  assert.equal(plan.kind, 'formula');
  assert.equal(plan.strategy.formula.ast.op, 'crosses_below');
  assert.equal(plan.strategy.formula.ast.right.op, 'ema');
  const strategy = validateFormulaStrategy(plan.strategy, '2026-09-30T00:00:00.000Z');
  assert.equal(strategy.executor, 'formula_v1');
});

test('two SMA/EMA conditions combine with formula all', () => {
  const plan = planConditionStrategy([{ indicator:'sma', direction:'above', period:5 }, { indicator:'ema', direction:'above', period:20 }]);
  assert.equal(plan.strategy.formula.ast.op, 'all');
  assert.equal(plan.strategy.formula.ast.items.length, 2);
  assert.equal(plan.strategy.name, 'SMA 5 上穿 ＋ EMA 20 上穿');
});

test('RSI downward cross and RSI combinations become Wilder RSI formulas', () => {
  const below = planConditionStrategy([{ indicator:'rsi', direction:'below', period:14, threshold:70 }]);
  assert.equal(below.kind, 'formula'); assert.equal(below.strategy.formula.ast.op, 'crosses_below'); assert.equal(below.strategy.formula.ast.right.value, 70);
  const combo = planConditionStrategy([{ indicator:'rsi', direction:'above', period:14, threshold:30 }, { indicator:'sma', direction:'above', period:20 }]);
  assert.equal(combo.kind, 'formula'); assert.equal(combo.strategy.formula.ast.op, 'all'); assert.equal(combo.strategy.formula.ast.items.length, 2);
  assert.equal(combo.strategy.name, 'RSI 14 上穿 30 ＋ SMA 20 上穿');
});

test('invalid condition input is rejected', () => {
  assert.throws(() => parseConditions([]), { code:'CONDITIONS_REQUIRED' });
  assert.throws(() => parseConditions([1, 2, 3].map(() => ({ indicator:'sma', direction:'above', period:20 }))), { code:'CONDITIONS_TOO_MANY' });
  assert.throws(() => parseConditions([{ indicator:'macd', direction:'above', period:20 }]), { code:'CONDITION_INDICATOR_UNSUPPORTED' });
  assert.throws(() => parseConditions([{ indicator:'sma', direction:'above', period:201 }]), { code:'CONDITION_PERIOD_INVALID' });
  assert.throws(() => parseConditions([{ indicator:'rsi', direction:'above', period:14, threshold:0 }]), { code:'CONDITION_THRESHOLD_INVALID' });
});
