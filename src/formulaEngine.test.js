import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormula, evaluateFormulaSeries, formulaSummary, validateFormula, FORMULA_OPS } from './formulaEngine.js';
import { FORMULA_RECIPES, kdD, kdK, wilderRsi as rsiFormula } from './formulaRecipes.js';
import { FORMULA_PLAN_SCHEMA, toGraph, validatePlan } from './formulaPlanner.js';
import { IndicatorRegistry, validateFormulaStrategy } from './indicatorRegistry.js';
import { wilderRsi, evaluateIndicatorBar } from './indicatorEngine.js';
import { BarCollector, collectRows, dayEvents } from './history.js';

const src = (field) => ({ op:'source', field });
const num = (value) => ({ op:'constant', value });
const bin = (op, left, right) => ({ op, left, right });
const win = (op, input, period) => ({ op, input, period });
const close = src('close');
const recipe = (key) => FORMULA_RECIPES.find((item) => item.key === key).ast;
const closes = (values) => values.map((value) => ({ open:value, high:value, low:value, close:value, volume:1 }));
const round = (values, digits = 9) => values.map((value) => value == null ? null : Number(value.toFixed(digits)));

// Deterministic pseudo-random OHLCV walk with a real high/low range.
function walk(length, seed = 7) {
  let state = seed, price = 100;
  const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  return Array.from({ length }, () => {
    const open = price; price = Math.max(1, price + (random() - 0.5) * 2);
    const high = Math.max(open, price) + random() * 0.5, low = Math.min(open, price) - random() * 0.5;
    return { open, high, low, close:price, volume:Math.round(100 + random() * 900) };
  });
}

test('source 可讀 open/high/low/close/volume，其他欄位拒絕', () => {
  const bars = [{ open:1, high:4, low:0.5, close:2, volume:9 }];
  for (const [field, value] of [['open', 1], ['high', 4], ['low', 0.5], ['close', 2], ['volume', 9]]) assert.deepEqual(evaluateFormulaSeries(src(field), bars), [value]);
  assert.deepEqual(evaluateFormulaSeries(src('high'), [{ close:1 }]), [null]);
  assert.throws(() => validateFormula(bin('gte', src('vwap'), num(1))), { code:'FORMULA_SOURCE_UNSUPPORTED' });
  assert.throws(() => validateFormula(bin('gte', { op:'source', field:'high', extra:1 }, num(1))), { code:'FORMULA_FIELD_UNKNOWN' });
});

test('highest/lowest/stddev 視窗數值與暖機', () => {
  const bars = closes([1, 2, 3, 4, 5, 3]);
  assert.deepEqual(evaluateFormulaSeries(win('highest', close, 3), bars), [null, null, 3, 4, 5, 5]);
  assert.deepEqual(evaluateFormulaSeries(win('lowest', close, 3), bars), [null, null, 1, 2, 3, 3]);
  // Population standard deviation (divide by n), the Bollinger convention.
  assert.deepEqual(round(evaluateFormulaSeries(win('stddev', close, 3), bars)), round([null, null, Math.sqrt(2 / 3), Math.sqrt(2 / 3), Math.sqrt(2 / 3), Math.sqrt(2 / 3)]));
  assert.deepEqual(evaluateFormulaSeries(win('stddev', close, 2), closes([5, 5, 5])), [null, 0, 0]);
  assert.equal(validateFormula(bin('gte', win('highest', close, 20), num(0))).warmupBars, 20);
});

test('rma 為 Wilder 平滑、以 SMA 為種子，等同台股 KD 的 1/3 權重', () => {
  const values = evaluateFormulaSeries(win('rma', close, 3), closes([1, 2, 3, 4, 5]));
  assert.deepEqual(round(values), round([null, null, 2, 8 / 3, 31 / 9]));
  // K_t = ⅔·K_{t−1} + ⅓·x_t
  for (let index = 3; index < values.length; index++) assert.ok(Math.abs(values[index] - (values[index - 1] * 2 / 3 + (index + 1) / 3)) < 1e-12);
  assert.equal(validateFormula(bin('gte', win('rma', close, 14), num(0))).warmupBars, 14);
});

test('prev 取前 n 根、abs、max/min、gt/lt 嚴格比較', () => {
  const bars = closes([1, 2, 3, 4, 5]);
  assert.deepEqual(evaluateFormulaSeries(win('prev', close, 2), bars), [null, null, 1, 2, 3]);
  assert.equal(validateFormula(bin('gte', win('prev', close, 2), num(0))).warmupBars, 3);
  assert.deepEqual(evaluateFormulaSeries({ op:'abs', input:bin('sub', num(3), close) }, bars), [2, 1, 0, 1, 2]);
  assert.deepEqual(evaluateFormulaSeries(bin('max', close, num(3)), bars), [3, 3, 3, 4, 5]);
  assert.deepEqual(evaluateFormulaSeries(bin('min', close, num(3)), bars), [1, 2, 3, 3, 3]);
  assert.deepEqual(evaluateFormulaSeries(bin('gt', close, num(3)), bars), [false, false, false, true, true]);
  assert.deepEqual(evaluateFormulaSeries(bin('lt', close, num(3)), bars), [true, true, false, false, false]);
  assert.deepEqual(evaluateFormulaSeries(bin('gte', close, num(3)), bars)[2], true);
});

test('any/all 接受 2–4 項，任一項無值時結果為 null', () => {
  const bars = closes([1, 2, 3, 4]);
  const any = { op:'any', items:[bin('lt', close, num(2)), bin('gt', close, num(3))] };
  assert.deepEqual(evaluateFormulaSeries(any, bars), [true, false, false, true]);
  const all3 = { op:'all', items:[bin('gt', close, num(1)), bin('lt', close, num(4)), bin('gt', win('prev', close, 1), num(0))] };
  assert.deepEqual(evaluateFormulaSeries(all3, bars), [null, true, true, false]);
  assert.equal(formulaSummary(any), '收盤價 < 2 或 收盤價 > 3');
  assert.equal(formulaSummary({ op:'all', items:[any, bin('gt', close, num(0))] }), '（收盤價 < 2 或 收盤價 > 3） 且 收盤價 > 0');
  assert.throws(() => validateFormula({ op:'any', items:[bin('gt', close, num(1))] }), { code:'FORMULA_TYPE_INVALID' });
  assert.throws(() => validateFormula({ op:'all', items:Array.from({ length:5 }, () => bin('gt', close, num(1))) }), { code:'FORMULA_TYPE_INVALID' });
  assert.throws(() => validateFormula({ op:'any', items:[bin('gt', close, num(1)), close] }), { code:'FORMULA_TYPE_INVALID' });
});

test('validator 拒絕非法期數、欄位、過深、節點過多與超過當日 270 根暖機', () => {
  for (const [op, period] of [['sma', 1], ['stddev', 201], ['highest', 2.5], ['rma', '14'], ['prev', 0], ['prev', 61], ['prev', 1.5]]) {
    assert.throws(() => validateFormula(bin('gte', win(op, close, period), num(0))), { code:'FORMULA_PERIOD_INVALID' }, `${op} ${period}`);
  }
  assert.doesNotThrow(() => validateFormula(bin('gte', win('prev', close, 60), num(0))));
  assert.throws(() => validateFormula(bin('gte', { op:'abs', input:close, period:3 }, num(0))), { code:'FORMULA_FIELD_UNKNOWN' });
  assert.throws(() => validateFormula(bin('gte', { op:'max', left:close }, num(0))), { code:'FORMULA_FIELD_UNKNOWN' });
  assert.throws(() => validateFormula(bin('gte', { op:'eval', input:close }, num(0))), { code:'FORMULA_OPERATOR_UNSUPPORTED' });
  assert.throws(() => validateFormula(win('sma', close, 3)), { code:'FORMULA_ROOT_NOT_BOOLEAN' });
  assert.throws(() => validateFormula(bin('gte', bin('gt', close, num(1)), num(0))), { code:'FORMULA_TYPE_INVALID' });
  assert.throws(() => validateFormula(bin('gte', num('1'), num(0))), { code:'FORMULA_NUMBER_INVALID' });
  let deep = close; for (let index = 0; index < 10; index++) deep = { op:'abs', input:deep }; // depth 12 with root + leaf
  assert.doesNotThrow(() => validateFormula(bin('gte', deep, num(0))));
  assert.throws(() => validateFormula(bin('gte', { op:'abs', input:deep }, num(0))), { code:'FORMULA_COMPLEXITY_EXCEEDED' });
  let wide = close; for (let index = 0; index < 31; index++) wide = bin('add', wide, close); // 63 nodes
  const tooWide = bin('add', wide, num(1)); // 65 nodes (67 with the gte root) > 64
  assert.throws(() => validateFormula(bin('gte', tooWide, num(0))), { code:'FORMULA_COMPLEXITY_EXCEEDED' });
  assert.throws(() => validateFormula(bin('gte', win('prev', win('highest', win('sma', close, 200), 20), 60), num(0))), { code:'FORMULA_WARMUP_EXCEEDS_TRADING_DAY' });
  assert.throws(() => validateFormula(bin('gte', bin('div', close, { op:'abs', input:bin('sub', close, close) }), num(1))), { code:'FORMULA_DIVISION_BY_ZERO' });
});

test('指紋與 canonical 涵蓋新積木：鍵序無關、參數不同即不同', () => {
  const a = validateFormula(bin('gt', close, win('prev', win('highest', src('high'), 20), 1)));
  const b = validateFormula({ right:{ period:1, input:{ period:20, input:{ field:'high', op:'source' }, op:'highest' }, op:'prev' }, left:close, op:'gt' });
  const c = validateFormula(bin('gt', close, win('prev', win('highest', src('high'), 20), 2)));
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, c.fingerprint);
  assert.deepEqual([...FORMULA_OPS].sort(), ['abs', 'add', 'all', 'any', 'constant', 'crosses_above', 'crosses_below', 'div', 'ema', 'gt', 'gte', 'highest', 'lowest', 'lt', 'lte', 'max', 'min', 'mul', 'prev', 'rma', 'sma', 'source', 'stddev', 'sub', 'tr']);
});

// ---- Reference implementations (plain loops, independent of the engine) ----------------------
function refEma(values, period) { const out = Array(values.length).fill(null); let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[period - 1] = prev; for (let i = period; i < values.length; i++) { prev = values[i] * 2 / (period + 1) + prev * (1 - 2 / (period + 1)); out[i] = prev; } return out; }
function refKd(bars, n = 9) {
  const k = Array(bars.length).fill(null), d = Array(bars.length).fill(null); const rsv = [];
  for (let i = n - 1; i < bars.length; i++) { const w = bars.slice(i - n + 1, i + 1); const hi = Math.max(...w.map((b) => b.high)), lo = Math.min(...w.map((b) => b.low)); rsv.push({ i, v:(bars[i].close - lo) / (hi - lo) * 100 }); }
  let kv = null; const ks = [];
  rsv.forEach(({ i, v }, j) => { if (j === 2) kv = (rsv[0].v + rsv[1].v + v) / 3; else if (j > 2) kv = kv * 2 / 3 + v / 3; if (j >= 2) { k[i] = kv; ks.push({ i, v:kv }); } });
  let dv = null; ks.forEach(({ i, v }, j) => { if (j === 2) dv = (ks[0].v + ks[1].v + v) / 3; else if (j > 2) dv = dv * 2 / 3 + v / 3; if (j >= 2) d[i] = dv; });
  return { k, d };
}
function crosses(a, b, index, up) { if (index === 0 || [a[index - 1], b[index - 1], a[index], b[index]].some((x) => x == null)) return null; return up ? a[index - 1] <= b[index - 1] && a[index] > b[index] : a[index - 1] >= b[index - 1] && a[index] < b[index]; }

test('KD 積木組法等於台股 K=⅔前K+⅓RSV、D=⅔前D+⅓K（SMA 種子）', () => {
  const bars = walk(120);
  const ref = refKd(bars);
  assert.deepEqual(round(evaluateFormulaSeries(kdK(), bars), 8), round(ref.k, 8));
  assert.deepEqual(round(evaluateFormulaSeries(kdD(), bars), 8), round(ref.d, 8));
  const golden = evaluateFormulaSeries(recipe('kd_golden'), bars);
  golden.forEach((value, index) => assert.equal(value, crosses(ref.k, ref.d, index, true)));
  assert.ok(golden.some((value) => value === true), 'fixture should contain at least one KD golden cross');
  const low = evaluateFormulaSeries(recipe('kd_low_golden'), bars);
  low.forEach((value, index) => assert.equal(value, golden[index] == null ? null : golden[index] && ref.k[index] < 20));
});

test('RSI(Wilder) 積木組法與既有 rsi.cross 執行器數值一致', () => {
  const bars = walk(80, 11);
  const expected = wilderRsi(bars.map((bar) => bar.close), 14);
  const actual = evaluateFormulaSeries(rsiFormula(14), bars);
  expected.forEach((value, index) => { if (value == null) assert.equal(actual[index], null); else assert.ok(Math.abs(actual[index] - value) <= 0.006, `index ${index}`); });
  // Flat prices: 0 ÷ 0 is no value (the registry executor reports 50); the cross simply does not fire.
  assert.equal(evaluateFormula(recipe('rsi_up'), closes(Array(20).fill(100))).current, null);
  // Falling then recovering crosses 30 upward; rising then falling crosses 70 downward.
  const upBars = closes([...Array.from({ length:16 }, (_, i) => 100 - i), 86, 89, 93]);
  const up = evaluateFormulaSeries(recipe('rsi_up'), upBars);
  assert.equal(up.indexOf(true) > 15, true);
  const downBars = closes([...Array.from({ length:16 }, (_, i) => 100 + i), 112, 106, 100]);
  assert.equal(evaluateFormulaSeries(recipe('rsi_down'), downBars).includes(true), true);
});

test('MACD 黃金/死亡交叉對照參考實作', () => {
  const bars = walk(150, 3);
  const c = bars.map((bar) => bar.close);
  const e12 = refEma(c, 12), e26 = refEma(c, 26);
  const dif = c.map((_, i) => e12[i] == null || e26[i] == null ? null : e12[i] - e26[i]);
  const dea = Array(c.length).fill(null); const firstDif = dif.findIndex((v) => v != null);
  refEma(dif.slice(firstDif), 9).forEach((v, i) => { dea[firstDif + i] = v; });
  const golden = evaluateFormulaSeries(recipe('macd_golden'), bars), death = evaluateFormulaSeries(recipe('macd_death'), bars);
  golden.forEach((value, index) => assert.equal(value, crosses(dif, dea, index, true)));
  death.forEach((value, index) => assert.equal(value, crosses(dif, dea, index, false)));
  assert.ok(golden.includes(true) && death.includes(true));
  assert.equal(golden.findIndex((value) => value != null), validateFormula(recipe('macd_golden')).warmupBars - 1);
});

test('布林通道、前 N 根最高、量增、威廉 %R、漲幅範例在小資料上的觸發', () => {
  // Bollinger: 20 quiet bars then a jump above mid + 2σ.
  const quiet = Array.from({ length:20 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1));
  assert.equal(evaluateFormula(recipe('boll_upper'), closes([...quiet, 100.5])).triggered, true);
  assert.equal(evaluateFormula(recipe('boll_upper'), closes([...quiet, 100.1])).triggered, false);
  assert.equal(evaluateFormula(recipe('boll_lower'), closes([...quiet, 99.5])).triggered, true);
  // Breakout: today's high must not be part of the reference window.
  const base = Array.from({ length:21 }, () => ({ open:10, high:10.5, low:9.8, close:10, volume:100 }));
  assert.equal(evaluateFormula(recipe('breakout_high'), [...base, { open:10, high:10.8, low:10, close:10.6, volume:100 }]).triggered, true);
  assert.equal(evaluateFormula(recipe('breakout_high'), [...base, { open:10, high:10.8, low:10, close:10.5, volume:100 }]).triggered, false);
  assert.equal(evaluateFormula(recipe('breakout_high'), base).current, null); // 21 bars < 22 warm-up
  // Volume surge vs the previous 20 bars' average (the current bar excluded).
  assert.equal(evaluateFormula(recipe('volume_surge'), [...base, { ...base[0], volume:200 }]).triggered, true);
  assert.equal(evaluateFormula(recipe('volume_surge'), [...base, { ...base[0], volume:199 }]).triggered, false);
  assert.equal(evaluateFormula(recipe('volume_surge'), base.slice(0, 20)).current, null);
  // Williams %R(14) from below −80 back above it.
  const wr = Array.from({ length:14 }, (_, i) => ({ open:10, high:11, low:9, close:i === 13 ? 9.2 : 10, volume:1 }));
  assert.equal(evaluateFormula(recipe('williams_r'), [...wr, { open:9.5, high:9.8, low:9.4, close:9.8, volume:1 }]).triggered, true);
  // % rise: close ≥ close 5 bars ago × 1.02.
  assert.equal(evaluateFormula(recipe('pct_rise'), closes([100, 100, 100, 100, 100, 102])).triggered, true);
  assert.equal(evaluateFormula(recipe('pct_rise'), closes([100, 100, 100, 100, 100, 101.99])).triggered, false);
  assert.equal(evaluateFormula(recipe('pct_rise'), closes([100, 100, 100, 100, 102])).current, null);
});

test('每個範例 AST 都通過驗證、暖機 ≤ 270、首個有值位置等於暖機，摘要中性', () => {
  const bars = walk(300, 5);
  for (const { key, name, ast } of FORMULA_RECIPES) {
    const validated = validateFormula(ast);
    assert.ok(validated.warmupBars <= 270, key);
    const values = evaluateFormulaSeries(ast, bars);
    assert.equal(values.findIndex((value) => value !== null), validated.warmupBars - 1, key);
    for (const text of [name, formulaSummary(ast)]) assert.doesNotMatch(text, /買進|賣出|超買|超賣|訊號|轉強|轉弱|多頭|空頭/, key);
  }
});

test('規劃器 schema 相容 strict JSON schema，節點圖以 itemIds 表達 all/any', async () => {
  const checkStrict = (schema, path) => {
    if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
      assert.equal(schema.additionalProperties, false, path);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), path);
      for (const [key, child] of Object.entries(schema.properties)) checkStrict(child, `${path}.${key}`);
    }
    if (schema.items) checkStrict(schema.items, `${path}[]`);
  };
  checkStrict(FORMULA_PLAN_SCHEMA, 'root');
  const definitions = await new IndicatorRegistry().list();
  const common = { message:'', timeframe:'1m', indicatorId:null, version:null, params:{ period:null, threshold:null } };
  for (const { key, name, ast } of FORMULA_RECIPES) {
    const graph = toGraph(ast);
    const plan = validatePlan({ ...common, status:'formula', name, ...graph }, definitions);
    assert.equal(plan.proposal.fingerprint, validateFormula(ast).fingerprint, key);
    const strategy = validateFormulaStrategy({ id:'formula.custom', version:'formula.v1', executor:'formula_v1', name, timeframe:'1m', source:'db/m1_live/{tradingDate}.parquet', definitionFingerprint:plan.proposal.fingerprint, params:{}, formula:{ ast:plan.proposal.ast } }, '2026-10-01T00:00:00.000Z');
    assert.equal(strategy.formula.warmupBars, plan.proposal.warmupBars);
  }
  const node = (id, op, extra = {}) => ({ id, op, field:null, value:null, period:null, inputId:null, leftId:null, rightId:null, itemIds:null, ...extra });
  const base = [node('c', 'source', { field:'close' }), node('h', 'source', { field:'high' }), node('a', 'gt', { leftId:'c', rightId:'h' }), node('b', 'lt', { leftId:'c', rightId:'h' })];
  const plan = (nodes, rootId = 'x') => validatePlan({ ...common, status:'formula', name:'收盤與最高價比較', nodes, rootId }, definitions);
  assert.equal(plan([...base, node('x', 'any', { itemIds:['a', 'b'] })]).proposal.ast.op, 'any');
  for (const bad of [
    node('x', 'any', { itemIds:['a'] }),
    node('x', 'any', { itemIds:['a', 'a'] }),
    node('x', 'any', { itemIds:['a', 'missing'] }),
    node('x', 'all', { itemIds:['a', 'b'], leftId:'a' }),
    node('x', 'gt', { leftId:'c', rightId:'h', itemIds:['a', 'b'] }),
    node('x', 'prev', { inputId:'c', period:61 }),
    node('x', 'abs', { inputId:'c', period:3 }),
    node('x', 'any', { itemIds:['a', 'c'] })
  ]) assert.throws(() => plan([...base, bad]), /FORMULA_PLAN_INVALID/, JSON.stringify(bad));
  assert.throws(() => plan([node('x', 'source', { field:'vwap' })]), /FORMULA_PLAN_INVALID/);
  const { itemIds, ...legacyNode } = node('x', 'gt', { leftId:'c', rightId:'h' });
  assert.throws(() => plan([...base, legacyNode]), /FORMULA_PLAN_INVALID/);
});

test('盤中 session 與 7 日回查的 bar 都帶 open/high/low，新積木可在兩條路徑上觸發', () => {
  // History: parquet rows → collector → bars with OHLC → dayEvents with a high-based formula.
  const collector = new BarCollector(new Set(['2330']));
  const start = Date.parse('2026-09-25T01:00:00.000Z');
  const rows = Array.from({ length:25 }, (_, i) => ({ stock_id:'2330', date:new Date(start + i * 60_000), open:10, high:i === 24 ? 10.9 : 10.5, low:9.8, close:i === 24 ? 10.7 : 10, volume:100 }));
  collectRows(rows, collector, { shift:0, samples:[] });
  const bars = collector.barsFor('2026-09-25').get('2330');
  assert.deepEqual({ open:bars[0].open, high:bars[0].high, low:bars[0].low }, { open:10, high:10.5, low:9.8 });
  const strategy = { executor:'formula_v1', formula:{ ast:recipe('breakout_high') } };
  assert.deepEqual(dayEvents(strategy, bars).map((bar) => bar.close), [10.7]);
  // Live: evaluateIndicatorBar keeps OHLC in the session so `high` is readable.
  const ast = bin('crosses_above', close, win('prev', win('highest', src('high'), 3), 1));
  const validated = validateFormula(ast);
  const live = validateFormulaStrategy({ id:'formula.custom', version:'formula.v1', executor:'formula_v1', name:'收盤價向上穿越前3根最高價', timeframe:'1m', source:'db/m1_live/{tradingDate}.parquet', definitionFingerprint:validated.fingerprint, params:{}, formula:{ ast } }, '2026-09-25T00:00:00.000Z');
  const state = { indicatorSessions:{}, dedupe:{} };
  const liveBar = (minute, values) => { const s = new Date(start + minute * 60_000), e = new Date(s.getTime() + 60_000); return { symbol:'2330', market:'TWSE', provider:'fixture', timeframe:'1m', tradingDate:'2026-09-25', barStart:s.toISOString(), barEnd:e.toISOString(), open:10, high:10.5, low:9.8, close:10, volume:100, complete:true, providerEventAt:e.toISOString(), receivedAt:e.toISOString(), ...values }; };
  const reasons = [{}, {}, {}, {}, { high:10.8, close:10.6 }].map((values, minute) => evaluateIndicatorBar(state, live, liveBar(minute, values), liveBar(minute, values).barEnd).reasonCode);
  assert.deepEqual(reasons, ['warmup', 'warmup', 'warmup', 'warmup', 'triggered']);
});

test('Ichimoku recipes validate, warm up within a session and label readably', () => {
  const above = validateFormula(recipe('ichimoku_above_cloud'));
  assert.equal(above.warmupBars, 79);
  assert.match(formulaSummary(above.ast), /一目雲層上緣\(9,26,52\)/);
  const tk = validateFormula(recipe('ichimoku_tk_cross'));
  assert.equal(tk.warmupBars, 27);
  assert.match(formulaSummary(tk.ast), /轉換線\(9\).*基準線\(26\)/);
});

test('tr block equals Wilder true range and ATR labels readably', () => {
  const bars = [{ open:10, high:11, low:9, close:10.5, volume:1 }, { open:10.5, high:13, low:10, close:12, volume:1 }, { open:12, high:12.5, low:8, close:9, volume:1 }];
  const series = evaluateFormulaSeries({ op:'gt', left:{ op:'tr' }, right:{ op:'constant', value:0 } }, bars);
  assert.deepEqual(series, [null, true, true]);
  const atr = validateFormula({ op:'gt', left:{ op:'rma', input:{ op:'tr' }, period:14 }, right:{ op:'constant', value:1 } });
  assert.equal(atr.warmupBars, 15);
  assert.match(formulaSummary(atr.ast), /ATR\(14\)/);
});
