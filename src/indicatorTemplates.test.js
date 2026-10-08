import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { FAMILY_ORDER, MAX_TEMPLATE_PARAMS, extractTemplate, instantiateTemplate, templatePresets, templateSummaryName } from './indicatorTemplates.js';
import { FORMULA_RECIPES, bollinger } from './formulaRecipes.js';
import { formulaFingerprint, formulaSummary, issueFormulaToken, validateFormula, verifyFormulaToken } from './formulaEngine.js';
import { FormulaLibrary } from './formulaLibrary.js';

const quiet = { warn() {}, error() {}, info() {} };
const secret = 'test-secret-at-least-8-chars';
const recipe = (key) => FORMULA_RECIPES.find((item) => item.key === key).ast;
const num = (value) => ({ op:'constant', value });
const close = { op:'source', field:'close' };
const byLabel = (template, label) => template.params.find((param) => param.label === label);

test('RSI 上穿 30 與下穿 70 是同一個指標（同 shapeKey），差在門檻與方向', () => {
  const up = extractTemplate(recipe('rsi_up')), down = extractTemplate(recipe('rsi_down'));
  assert.equal(up.shapeKey, down.shapeKey);
  assert.equal(up.direction.default, 'above'); assert.equal(down.direction.default, 'below');
  assert.equal(byLabel(up, '門檻').default, 30); assert.equal(byLabel(down, '門檻').default, 70);
  const period = byLabel(up, 'Wilder平滑期數');
  assert.equal(period.default, 14); assert.equal(period.type, 'integer'); assert.equal(period.min, 2); assert.equal(period.max, 200);
  assert.ok(period.paths.length >= 2, 'RSI 的兩個 RMA(14) 合併成同一參數');
  // ×100 與 max(·,0) 的 0 是結構常數，不會變成參數
  assert.ok(!up.params.some((param) => [100, 0].includes(param.default)));
  assert.notEqual(up.shapeKey, extractTemplate(recipe('williams_r')).shapeKey);
});

test('KD：兩個 RMA 期數 3 合併為一個參數；RSV 的 highest/lowest 9 合併為「期數」', () => {
  const template = extractTemplate(recipe('kd_golden'));
  const smooth = byLabel(template, 'Wilder平滑期數'), rsv = byLabel(template, '期數');
  assert.equal(smooth.default, 3); assert.equal(smooth.paths.length, 3);
  assert.equal(rsv.default, 9); assert.ok(rsv.paths.length >= 4);
  assert.equal(template.params.length, 2);
  // all 根節點：不提供方向參數
  const low = extractTemplate(recipe('kd_low_golden'));
  assert.equal(low.direction, null); assert.equal(byLabel(low, '門檻').default, 20);
  assert.notEqual(low.shapeKey, template.shapeKey);
});

test('布林：SMA(20) 與 stddev(20) 合併為一個期數參數，2σ 為標準差倍數（0.1–100）', () => {
  const template = extractTemplate(recipe('boll_upper'));
  assert.equal(template.params.length, 2);
  const period = byLabel(template, '期數'), width = byLabel(template, '標準差倍數');
  assert.equal(period.default, 20); assert.equal(period.paths.length, 2);
  assert.equal(width.default, 2); assert.equal(width.type, 'number'); assert.equal(width.min, 0.1); assert.equal(width.max, 100);
  // 下軌是 sub 而非 add，是另一個指標（方向翻轉後仍是「收盤價下穿上軌」而非下軌）
  assert.notEqual(template.shapeKey, extractTemplate(recipe('boll_lower')).shapeKey);
});

test('其他 label 規則：往前根數（1–60）、倍數、重複 label 加序號、參數上限 6', () => {
  const surge = extractTemplate(recipe('volume_surge'));
  assert.deepEqual(surge.params.map((param) => [param.label, param.default]), [['往前根數', 1], ['SMA期數', 20], ['倍數', 2]]);
  assert.equal(byLabel(surge, '往前根數').max, 60);
  assert.equal(surge.direction.default, 'above');
  const macd = extractTemplate(recipe('macd_golden'));
  assert.deepEqual(macd.params.map((param) => param.label), ['EMA期數 1', 'EMA期數 2', 'EMA期數 3']);
  assert.deepEqual(macd.params.map((param) => param.default), [12, 26, 9]);
  assert.equal(macd.shapeKey, extractTemplate(recipe('macd_death')).shapeKey);
  // 8 個不同常數門檻 → 只有前 6 個成為參數，其餘固定
  const many = { op:'all', items:[1, 2, 3, 4].map((i) => ({ op:'any', items:[{ op:'gt', left:close, right:num(i) }, { op:'lt', left:close, right:num(i + 10) }] })) };
  const template = extractTemplate(many);
  assert.equal(template.params.length, MAX_TEMPLATE_PARAMS);
  assert.equal(template.direction, null);
  const out = instantiateTemplate(many, template, { p1: 99 });
  assert.equal(out.items[0].items[0].right.value, 99);
  assert.equal(out.items[3].items[1].right.value, 14, '超過上限的常數保持固定值');
});

test('instantiate：替換參數與翻轉方向後 validateFormula 通過、warmup 隨期數變化；缺的參數用 default', () => {
  const ast = recipe('rsi_up'); const template = extractTemplate(ast);
  const period = byLabel(template, 'Wilder平滑期數'), threshold = byLabel(template, '門檻');
  const out = instantiateTemplate(ast, template, { [period.key]:21, [threshold.key]:65 }, 'below');
  assert.equal(out.op, 'crosses_below');
  assert.deepEqual(validateFormula(out).ast, out);
  assert.equal(validateFormula(out).warmupBars, validateFormula(ast).warmupBars + 7);
  assert.equal(formulaSummary(out), 'RSI(21, Wilder) 向下穿越 65');
  // 原 AST 不被改動
  assert.equal(formulaFingerprint(ast), formulaFingerprint(recipe('rsi_up')));
  // 預設值 + 翻方向 = 另一個 recipe 的 fingerprint（rsi_up 翻成 below，門檻改 70 → rsi_down）
  assert.equal(formulaFingerprint(instantiateTemplate(ast, template, { [threshold.key]:70 }, 'below')), formulaFingerprint(recipe('rsi_down')));
  assert.equal(formulaFingerprint(instantiateTemplate(ast, template, {})), formulaFingerprint(ast));
  // 布林：同一期數參數同時改 SMA 與 stddev，等於 bollinger(30, 2.5)
  const boll = recipe('boll_upper'); const bollTemplate = extractTemplate(boll);
  const widened = instantiateTemplate(boll, bollTemplate, { [byLabel(bollTemplate, '期數').key]:30, [byLabel(bollTemplate, '標準差倍數').key]:2.5 });
  assert.equal(formulaFingerprint(widened.right), formulaFingerprint(bollinger(30, 2.5, 'upper')));
  // gte 的方向翻轉 → lte
  const gain = recipe('open_gain'); assert.equal(instantiateTemplate(gain, extractTemplate(gain), {}, 'below').op, 'lte');
});

test('instantiate：型別／範圍／未知參數／無方向參數時給方向 → TEMPLATE_PARAM_INVALID 422 附 detail', () => {
  const ast = recipe('rsi_up'); const template = extractTemplate(ast);
  const period = byLabel(template, 'Wilder平滑期數'), threshold = byLabel(template, '門檻');
  const rejects = (values, direction, key) => { try { instantiateTemplate(ast, template, values, direction); assert.fail('應拒絕'); } catch (error) { assert.equal(error.code, 'TEMPLATE_PARAM_INVALID'); assert.equal(error.statusCode, 422); assert.equal(error.detail.key, key); } };
  rejects({ [period.key]:201 }, null, period.key);
  rejects({ [period.key]:1 }, null, period.key);
  rejects({ [period.key]:14.5 }, null, period.key);
  rejects({ [period.key]:'14' }, null, period.key);
  rejects({ [threshold.key]:1e7 }, null, threshold.key);
  rejects({ nope:1 }, null, 'nope');
  rejects({}, 'sideways', 'dir');
  const kd = recipe('kd_low_golden'); try { instantiateTemplate(kd, extractTemplate(kd), {}, 'below'); assert.fail(); } catch (error) { assert.equal(error.detail.key, 'dir'); }
});

test('templateSummaryName：不含參數的具體數字、含 N、方向詞中性；family / category 分類', () => {
  for (const { key, ast } of FORMULA_RECIPES) {
    const template = extractTemplate(ast); const { name } = templateSummaryName(ast, template);
    for (const param of template.params) assert.ok(!new RegExp(`(?<![\\d.\\-])${String(param.default).replace('.', '\\.')}(?![\\d.])`).test(name), `${key}: ${name} 仍含 ${param.default}`);
    if (template.params.length) assert.ok(name.includes('N'), `${key}: ${name}`);
    if (template.direction) assert.ok(!/向上穿越|向下穿越/.test(name), `${key}: ${name}`);
  }
  assert.equal(templateSummaryName(recipe('rsi_up')).name, 'RSI(N, Wilder) 穿越 N');
  assert.equal(templateSummaryName(recipe('rsi_down')).name, 'RSI(N, Wilder) 穿越 N');
  assert.equal(templateSummaryName(recipe('boll_upper')).name, '收盤價 穿越 布林上軌(N, Nσ)');
  // 120 不會被 20 的替換吃掉
  const sma120 = { op:'crosses_above', left:close, right:{ op:'sma', input:{ op:'sma', input:close, period:120 }, period:20 } };
  assert.equal(templateSummaryName(sma120).name, '收盤價 穿越 SMA(SMA(收盤價, N), N)');
  assert.deepEqual([templateSummaryName(recipe('rsi_up')).family, templateSummaryName(recipe('rsi_up')).category], ['RSI', '擺盪']);
  assert.deepEqual([templateSummaryName(recipe('kd_golden')).family, templateSummaryName(recipe('kd_golden')).category], ['KD', '擺盪']);
  assert.deepEqual([templateSummaryName(recipe('macd_golden')).family, templateSummaryName(recipe('macd_golden')).category], ['MACD', '趨勢']);
  assert.deepEqual([templateSummaryName(recipe('boll_upper')).family, templateSummaryName(recipe('boll_upper')).category], ['布林', '通道']);
  assert.deepEqual([templateSummaryName(recipe('vwap_above')).family, templateSummaryName(recipe('vwap_above')).category], ['VWAP', '量價']);
  assert.deepEqual([templateSummaryName(recipe('volume_surge')).family, templateSummaryName(recipe('volume_surge')).category], ['量能', '量價']);
  assert.deepEqual([templateSummaryName(recipe('close_above_sma')).family, templateSummaryName(recipe('sma_cross')).family, templateSummaryName(recipe('atr_pct')).family], ['均線', '均線', 'ATR']);
  assert.deepEqual([templateSummaryName(recipe('pct_rise')).family, templateSummaryName(recipe('pct_rise')).category], ['漲跌幅', '量價']);
  assert.deepEqual([templateSummaryName(recipe('ichimoku_tk_cross')).family, templateSummaryName(recipe('ichimoku_tk_cross')).category], ['一目', '趨勢']);
  assert.deepEqual([templateSummaryName(recipe('williams_r')).family, templateSummaryName(recipe('williams_r')).category], ['威廉', '擺盪']);
  assert.deepEqual([templateSummaryName(recipe('breakout_high')).family, templateSummaryName(recipe('breakout_high')).category], ['其他', '其他']);
});

test('FormulaLibrary.templates()：26 個 recipes 分成 21 個指標、不含 ast、pending 公式會列入並與 preset 同組', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indicator-templates-'));
  try {
    const library = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
    const templates = library.templates();
    assert.equal(FORMULA_RECIPES.length, 26);
    assert.equal(templates.length, 21);
    const pairs = templates.filter((template) => template.members.length === 2).map((template) => template.members.map((member) => member.name).sort().join(' / '));
    assert.equal(pairs.length, 5, 'MACD 金叉/死叉、RSI 上穿/下穿、VWAP 上穿/下穿、前N根漲/跌、開盤漲/跌 各合為一個指標');
    for (const template of templates) {
      assert.ok(!('ast' in template)); for (const member of template.members) assert.ok(!('ast' in member));
      assert.equal(template.source, 'preset'); assert.ok(template.params.length <= MAX_TEMPLATE_PARAMS);
      assert.ok(template.members.some((member) => member.fingerprint === template.representative));
      assert.match(template.name, /N|VWAP/);
    }
    const families = templates.map((template) => template.family);
    assert.deepEqual(families, [...families].sort((a, b) => FAMILY_ORDER.indexOf(a) - FAMILY_ORDER.indexOf(b)), '依 family 排序');
    assert.deepEqual([...new Set(families)], ['均線', 'MACD', 'KD', 'RSI', '布林', 'VWAP', '一目', '威廉', 'ATR', '量能', '漲跌幅', '其他']);
    // 使用者套用 RSI(21) 下穿 65（AI 或模板產生）→ pending_review，仍歸入 RSI 指標；hitCount 累加到該指標
    const rsi = templates.find((template) => template.family === 'RSI');
    const custom = instantiateTemplate(recipe('rsi_up'), extractTemplate(recipe('rsi_up')), { p1:21, p3:65 }, 'below');
    await library.recordActivation({ ast: custom, name: 'RSI(21) 下穿 65', sourceText: 'RSI21跌破65' });
    const after = library.templates().find((template) => template.shapeKey === rsi.shapeKey);
    assert.equal(after.members.length, 3); assert.equal(after.hitCount, rsi.hitCount + 1);
    assert.deepEqual(after.members.find((member) => member.status === 'pending_review').aliases, ['RSI21跌破65']);
    assert.equal(library.templates().length, 21);
    assert.equal(library.templates({ includePending:false }).find((template) => template.shapeKey === rsi.shapeKey).members.length, 2);
    // 新形狀（EMA 交叉）成為新指標
    await library.recordActivation({ ast: { op:'crosses_above', left:close, right:{ op:'ema', input:{ op:'abs', input:close }, period:20 } }, name: '收盤上穿EMA20' });
    assert.equal(library.templates().length, 22);
    assert.equal(library.templates({ includePending:false }).length, 21);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('instantiate API 形狀：與 parse 的 formula 回傳同形，proposalToken 可被 verifyFormulaToken 驗證；404 / 422', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indicator-templates-'));
  try {
    const library = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
    const rsi = library.templates().find((template) => template.family === 'RSI');
    const period = rsi.params.find((param) => param.label === 'Wilder平滑期數'), threshold = rsi.params.find((param) => param.label === '門檻');
    // 同 server.js：instantiate → proposalId / proposalToken → 去掉 proposal.ast
    const result = library.instantiate(rsi.shapeKey, { values: { [period.key]:21, [threshold.key]:65 }, direction:'below' });
    result.proposalId = randomUUID();
    result.proposalToken = issueFormulaToken({ ...result.proposal, proposalId: result.proposalId, sourceText: result.proposal.name }, secret);
    delete result.proposal.ast;
    assert.deepEqual(Object.keys(result).sort(), ['formulaSummary', 'library', 'proposal', 'proposalId', 'proposalToken', 'provider', 'shapeKey', 'status', 'summary', 'template'].sort());
    assert.equal(result.status, 'formula'); assert.equal(result.library, true); assert.equal(result.template, true);
    assert.deepEqual(result.provider, { provider:'library', model:'template' });
    assert.equal(result.formulaSummary, 'RSI(21, Wilder) 向下穿越 65');
    assert.equal(result.summary, 'RSI(21, Wilder) 向下穿越 65 · 一分鐘');
    assert.deepEqual(Object.keys(result.proposal).sort(), ['fingerprint', 'name', 'warmupBars']);
    const payload = verifyFormulaToken(result.proposalToken, secret);
    assert.equal(payload.fingerprint, result.proposal.fingerprint); assert.equal(payload.name, result.proposal.name);
    assert.equal(payload.sourceText, 'RSI(21, Wilder) 向下穿越 65');
    assert.equal(formulaSummary(payload.ast), 'RSI(21, Wilder) 向下穿越 65');
    assert.equal(payload.warmupBars, validateFormula(payload.ast).warmupBars);
    // 預設值 + 預設方向 = preset 本身
    assert.equal(library.instantiate(rsi.shapeKey).proposal.fingerprint, rsi.representative);
    assert.throws(() => library.instantiate('0'.repeat(64)), (error) => error.code === 'TEMPLATE_NOT_FOUND' && error.statusCode === 404);
    assert.throws(() => library.instantiate(rsi.shapeKey, { values: { [period.key]:500 } }), (error) => error.code === 'TEMPLATE_PARAM_INVALID' && error.statusCode === 422 && error.detail.key === period.key);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('presets：每個 family 的粗刻度變體、label 中性具體；每個 preset instantiate 後都通過 validateFormula', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indicator-templates-'));
  try {
    const library = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
    const templates = library.templates();
    const labels = (predicate) => templates.filter(predicate).flatMap((template) => template.presets.map((preset) => preset.label));
    assert.deepEqual(labels((t) => t.family === '均線' && /SMA\(收盤價, N\)\)?$/.test(t.name) && t.params.length === 1), ['收盤上穿 SMA(5)', '收盤下穿 SMA(5)', '收盤上穿 SMA(10)', '收盤下穿 SMA(10)', '收盤上穿 SMA(20)', '收盤下穿 SMA(20)', '收盤上穿 SMA(60)', '收盤下穿 SMA(60)']);
    assert.equal(labels((t) => t.family === '均線' && /EMA/.test(t.name)).length, 8);
    assert.deepEqual(labels((t) => t.family === '均線' && t.params.length === 2), ['SMA(5) 上穿 SMA(20)', 'SMA(5) 下穿 SMA(20)', 'SMA(10) 上穿 SMA(20)', 'SMA(10) 下穿 SMA(20)', 'SMA(20) 上穿 SMA(60)', 'SMA(20) 下穿 SMA(60)']);
    assert.deepEqual(labels((t) => t.family === 'RSI'), ['RSI(14) 上穿 20', 'RSI(14) 上穿 30', 'RSI(14) 下穿 70', 'RSI(14) 下穿 80']);
    assert.deepEqual(labels((t) => t.family === 'KD').sort(), ['KD 死亡交叉', 'KD 低檔黃金交叉（K<20）', 'KD 黃金交叉'].sort());
    assert.deepEqual(labels((t) => t.family === 'MACD'), ['MACD 黃金交叉', 'MACD 死亡交叉']);
    assert.deepEqual(labels((t) => t.family === '布林').sort(), ['收盤上穿布林上軌(20,2σ)', '收盤下穿布林下軌(20,2σ)']);
    assert.deepEqual(labels((t) => t.family === 'VWAP'), ['收盤站上 VWAP', '收盤跌破 VWAP']);
    assert.deepEqual(labels((t) => t.family === '一目').sort(), ['收盤站上一目雲', '收盤跌破一目雲', '轉換線上穿基準線'].sort());
    assert.deepEqual(labels((t) => t.family === '威廉'), ['威廉%R(14) 上穿 -80', '威廉%R(14) 下穿 -20']);
    assert.deepEqual(labels((t) => t.family === 'ATR'), ['ATR(14) ≥ 收盤 1%', 'ATR(14) ≥ 收盤 2%', 'ATR(14) ≥ 收盤 3%', 'ATR(14) ≥ 收盤 4%', 'ATR(14) ≥ 收盤 5%']);
    assert.deepEqual(labels((t) => t.family === '量能' && /成交量/.test(t.name)), ['量 ≥ 均量 1.5 倍', '量 ≥ 均量 2 倍', '量 ≥ 均量 3 倍']);
    assert.deepEqual(labels((t) => t.family === '量能' && /OBV/.test(t.name)).sort(), ['OBV 向上穿越 OBV 的 SMA(20)', 'OBV 向上穿越前20根 OBV 最高值']);
    assert.deepEqual(labels((t) => t.family === '漲跌幅' && /前N根/.test(t.name)), [1, 2, 3, 4, 5].map((x) => `相對前5根漲 ${x}%`).concat([1, 2, 3, 4, 5].map((x) => `相對前5根跌 ${x}%`)));
    assert.deepEqual(labels((t) => t.family === '漲跌幅' && /開盤/.test(t.name)), [1, 2, 3, 4, 5].map((x) => `相對開盤漲 ${x}%`).concat([1, 2, 3, 4, 5].map((x) => `相對開盤跌 ${x}%`)));
    assert.deepEqual(labels((t) => t.family === '其他'), ['收盤價向上穿越前20根最高價'], '其他：唯一 preset = 原公式');
    // 每個 preset 都能 instantiate、通過 validateFormula；預設 preset 覆蓋原 recipe
    let count = 0; const fingerprints = new Set();
    for (const template of templates) for (const preset of template.presets) {
      const result = library.instantiate(template.shapeKey, { values: preset.values, direction: preset.direction });
      assert.equal(validateFormula(result.proposal.ast).fingerprint, result.proposal.fingerprint, preset.label);
      assert.doesNotMatch(preset.label, /買進|賣出|超買|超賣|訊號|轉強|轉弱|多頭|空頭/);
      fingerprints.add(result.proposal.fingerprint); count += 1;
    }
    assert.equal(count, 8 + 8 + 6 + 2 + 3 + 4 + 2 + 2 + 3 + 2 + 5 + 3 + 10 + 10 + 1 + 2);
    for (const key of ['rsi_up', 'rsi_down', 'macd_death', 'boll_lower', 'vwap_below', 'pct_drop', 'open_drop', 'atr_pct', 'volume_surge', 'sma_cross', 'close_above_ema']) assert.ok(fingerprints.has(formulaFingerprint(recipe(key))), key);
    // 相對開盤跌 3% = 收盤 ≤ 首根開盤 × 0.97
    const openDrop = library.instantiate(templates.find((t) => t.family === '漲跌幅' && /開盤/.test(t.name)).shapeKey, { values: { p1: 0.97 }, direction: 'below' });
    assert.equal(openDrop.formulaSummary, '收盤價 ≤ (當日第一根的開盤價 × 0.97)');
    // AI 新建立的指標（無 family 規則）：唯一 preset = 原公式
    await library.recordActivation({ ast: { op:'gt', left:{ op:'abs', input:close }, right:{ op:'highest', input:close, period:30 } }, name: '自訂條件' });
    const custom = library.templates().find((t) => t.members.some((m) => m.name === '自訂條件'));
    assert.deepEqual(custom.presets, [{ label: '自訂條件', values: {}, direction: 'above', summary: '|收盤價| > 最高值(收盤價, 30)' }]);
    assert.equal(templatePresets(recipe('rsi_up')).length, 4);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('compose：items 兩個過濾以 all 合併、token 可驗、summary 為「A 且 B」；fingerprint 直接用既有成員；超過 3 個或無效拒絕', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'indicator-templates-'));
  try {
    const library = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
    const templates = library.templates();
    const rsi = templates.find((t) => t.family === 'RSI'), volume = templates.find((t) => t.family === '量能');
    const result = library.compose([{ shapeKey: rsi.shapeKey, values: { [rsi.params.find((p) => p.label === '門檻').key]: 25 }, direction: 'above' }, { fingerprint: formulaFingerprint(recipe('volume_surge')) }]);
    assert.equal(result.proposal.ast.op, 'all'); assert.equal(result.proposal.ast.items.length, 2);
    assert.equal(result.formulaSummary, 'RSI(14, Wilder) 向上穿越 25 且 成交量 ≥ (前1根的SMA(成交量, 20) × 2)');
    assert.equal(result.proposal.name, result.formulaSummary); assert.equal(result.summary, `${result.formulaSummary} · 一分鐘`);
    assert.equal(result.items.length, 2); assert.equal(result.items[1].fingerprint, formulaFingerprint(recipe('volume_surge'))); assert.equal(result.items[1].shapeKey, volume.shapeKey);
    assert.ok(!('shapeKey' in result));
    const token = issueFormulaToken({ ...result.proposal, proposalId: randomUUID(), sourceText: result.proposal.name }, secret);
    const payload = verifyFormulaToken(token, secret);
    assert.equal(payload.fingerprint, result.proposal.fingerprint); assert.equal(payload.ast.op, 'all');
    assert.equal(payload.warmupBars, Math.max(validateFormula(recipe('rsi_up')).warmupBars, validateFormula(recipe('volume_surge')).warmupBars));
    // 單一 item 與舊格式等價
    assert.equal(library.compose([{ shapeKey: rsi.shapeKey }]).proposal.fingerprint, library.instantiate(rsi.shapeKey).proposal.fingerprint);
    assert.equal(library.compose([{ fingerprint: formulaFingerprint(recipe('rsi_down')) }]).proposal.fingerprint, formulaFingerprint(recipe('rsi_down')));
    // 套用後：合併公式進公式庫成為新指標（其他／唯一 preset），兩個成員指標不受影響
    await library.recordActivation({ ast: result.proposal.ast, name: result.proposal.name });
    assert.equal(library.templates().length, templates.length + 1);
    const rejects = (items, code, status) => assert.throws(() => library.compose(items), (error) => error.code === code && error.statusCode === status);
    rejects([{ shapeKey: rsi.shapeKey }, { shapeKey: rsi.shapeKey }, { shapeKey: volume.shapeKey }, { shapeKey: volume.shapeKey }], 'TEMPLATE_REQUEST_INVALID', 422);   // at most 3 filters
    rejects([], 'TEMPLATE_REQUEST_INVALID', 422);
    rejects([{ values: {} }], 'TEMPLATE_REQUEST_INVALID', 422);
    rejects([{ fingerprint: 'f'.repeat(64) }], 'TEMPLATE_NOT_FOUND', 404);
    rejects([{ shapeKey: rsi.shapeKey }, { shapeKey: 'nope' }], 'TEMPLATE_NOT_FOUND', 404);
    assert.throws(() => library.compose([{ shapeKey: rsi.shapeKey }, { shapeKey: rsi.shapeKey, values: { p1: 999 } }]), (error) => error.code === 'TEMPLATE_PARAM_INVALID' && error.detail.index === 1);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('compose accepts a pre-resolved AST item (verified AI proposal) alongside a library filter', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { FormulaLibrary } = await import('./formulaLibrary.js');
  const dir = await mkdtemp(join(tmpdir(), 'fl-'));
  try {
    const library = new FormulaLibrary(join(dir, 'lib.json'), { log: { warn() {}, error() {}, info() {} } });
    await library.load();
    const vol = library.templates().find((t) => t.family === '量能' && /成交量/.test(t.name));
    const aiAst = { op:'crosses_above', left:{ op:'source', field:'close' }, right:{ op:'sma', input:{ op:'source', field:'close' }, period:7 } };
    const result = library.compose([{ ast: aiAst, name:'AI 公式' }, { shapeKey: vol.shapeKey, values: vol.presets[0].values, direction: vol.presets[0].direction }]);
    assert.equal(result.status, 'formula'); assert.equal(result.proposal.ast.op, 'all'); assert.equal(result.proposal.ast.items.length, 2);
    assert.match(result.formulaSummary, /SMA\(收盤價, 7\)/); assert.match(result.formulaSummary, /成交量/);
  } finally { await rm(dir, { recursive:true, force:true }); }
});
