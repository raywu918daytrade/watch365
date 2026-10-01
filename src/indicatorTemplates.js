// Indicator templates: a stored formula (fixed numbers) is lifted into "indicator + adjustable parameters".
// extractTemplate walks the AST and turns every window/prev period and every meaningful constant into a
// parameter slot; slots with the same meaning and the same value are merged (KD's two RMA(3), Bollinger's
// SMA(20)+stddev(20)). shapeKey is the hash of the AST with slot values replaced by placeholders and the
// root comparison normalized to "above", so "RSI(14) crosses above 30" and "RSI(14) crosses below 70"
// are the same indicator differing only in parameters and direction. instantiateTemplate writes user
// values back into a copy of the AST; the result still goes through validateFormula like any other AST.
//
// Structural constants are never parameters: 0 (clamps such as max(change, 0)), a divisor (÷2, ÷3 in
// averages) and ×±100 percent scaling (RSI, RSV, Williams %R) stay fixed.

import { createHash } from 'node:crypto';
import { formulaSummary } from './formulaEngine.js';

const ARITH = ['add', 'sub', 'mul', 'div', 'max', 'min'];
const WINDOW = ['sma', 'ema', 'rma', 'highest', 'lowest', 'stddev'];
const COMPARE = ['crosses_above', 'crosses_below', 'gte', 'lte', 'gt', 'lt'];
const LOGIC = ['all', 'any'];
const UNARY = ['abs', 'cumsum', 'first'];
const TO_ABOVE = { crosses_above: 'crosses_above', gt: 'gt', gte: 'gte', crosses_below: 'crosses_above', lt: 'gt', lte: 'gte' };
const TO_BELOW = { crosses_below: 'crosses_below', lt: 'lt', lte: 'lte', crosses_above: 'crosses_below', gt: 'lt', gte: 'lte' };
const WINDOW_LABEL = { sma: 'SMA期數', ema: 'EMA期數', rma: 'Wilder平滑期數', highest: '最高期數', lowest: '最低期數', stddev: '標準差期數' };
const PREV_LABEL = '往前根數', PERIOD_LABEL = '期數';
const RANGE = { window: [2, 200], prev: [1, 60], 門檻: [-1e6, 1e6], 倍數: [0.01, 100], 標準差倍數: [0.1, 100], 數值: [-1e6, 1e6] };
export const MAX_TEMPLATE_PARAMS = 6;
export const DIRECTION_OPTIONS = Object.freeze([{ value: 'above', label: '上穿／大於' }, { value: 'below', label: '下穿／小於' }]);

export function extractTemplate(ast) {
  const slots = []; collect(ast, [], null, null, slots);
  const merged = new Map();
  for (const slot of slots) {
    const key = slot.kind === 'period' ? `period:${slot.default}` : `${slot.label}:${slot.default}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...slot, labels: new Set([slot.label]), paths: [slot.path] }); continue; }
    existing.labels.add(slot.label); existing.paths.push(slot.path);
    existing.min = Math.max(existing.min, slot.min); existing.max = Math.min(existing.max, slot.max);
  }
  const params = [...merged.values()].slice(0, MAX_TEMPLATE_PARAMS).map((slot, index) => ({ key: `p${index + 1}`, label: slot.labels.size === 1 ? [...slot.labels][0] : PERIOD_LABEL, type: slot.type, default: slot.default, min: slot.min, max: slot.max, path: slot.paths[0], paths: slot.paths }));
  dedupeLabels(params);
  const direction = COMPARE.includes(ast?.op) ? { key: 'dir', options: DIRECTION_OPTIONS.map((option) => ({ ...option })), default: TO_ABOVE[ast.op] === ast.op ? 'above' : 'below' } : null;
  const shape = structuredClone(ast);
  for (const param of params) for (const path of param.paths) setAt(shape, path, `$${param.key}`);
  if (direction) shape.op = TO_ABOVE[shape.op];
  const shapeKey = createHash('sha256').update(JSON.stringify(canonical(shape))).digest('hex');
  return { shapeKey, params, direction };
}

export function instantiateTemplate(ast, template, values = {}, direction = null) {
  if (values == null) values = {};
  if (typeof values !== 'object' || Array.isArray(values)) throw templateError('values 必須是物件', { key: null });
  const known = new Set(template.params.map((param) => param.key));
  for (const key of Object.keys(values)) if (!known.has(key)) throw templateError(`未知參數 ${key}`, { key });
  const out = structuredClone(ast);
  for (const param of template.params) {
    const value = values[param.key] === undefined ? param.default : values[param.key];
    if (param.type === 'integer' ? !Number.isInteger(value) : typeof value !== 'number' || !Number.isFinite(value)) throw templateError(`${param.label} 必須是${param.type === 'integer' ? '整數' : '數字'}`, { key: param.key, label: param.label, value, min: param.min, max: param.max });
    if (value < param.min || value > param.max) throw templateError(`${param.label} 超出範圍 ${param.min}–${param.max}`, { key: param.key, label: param.label, value, min: param.min, max: param.max });
    for (const path of param.paths) setAt(out, path, value);
  }
  if (direction != null) {
    if (!template.direction) throw templateError('此指標沒有方向參數', { key: 'dir', value: direction });
    if (!DIRECTION_OPTIONS.some((option) => option.value === direction)) throw templateError('方向必須是 above 或 below', { key: 'dir', value: direction });
    out.op = (direction === 'above' ? TO_ABOVE : TO_BELOW)[out.op];
  }
  return out;
}

// Family keyword tables; detection order matters (量能 before 均線 so "成交量 ≥ SMA(成交量)" is 量能), display
// order is FAMILY_ORDER (PM decision).
const FAMILIES = [
  ['RSI', /RSI/], ['KD', /K值|D值|KD/], ['MACD', /MACD/], ['布林', /布林/], ['VWAP', /VWAP/], ['一目', /一目/], ['威廉', /威廉/], ['ATR', /ATR/],
  ['量能', /成交量/], ['均線', /SMA|EMA|均線|移動平均/], ['漲跌幅', /(收盤價|開盤價).*[×÷]/]
];
const CATEGORY = { 均線: '趨勢', MACD: '趨勢', 一目: '趨勢', RSI: '擺盪', KD: '擺盪', 威廉: '擺盪', 布林: '通道', ATR: '通道', VWAP: '量價', 量能: '量價', 漲跌幅: '量價' };
export const FAMILY_ORDER = Object.freeze(['均線', 'MACD', 'KD', 'RSI', '布林', 'VWAP', '一目', '威廉', 'ATR', '量能', '漲跌幅', '其他']);
export const CATEGORY_ORDER = Object.freeze(['趨勢', '擺盪', '通道', '量價', '其他']);

// Coarse presets (PM decision: few, fixed variants per family rather than a free dial). Each preset is
// { label, values, direction } that instantiateTemplate accepts; a template no rule matches gets exactly
// one preset = the formula as stored (not adjustable).
export function templatePresets(ast, template = extractTemplate(ast), info = templateSummaryName(ast, template), fallbackLabel = formulaSummary(ast)) {
  const summary = formulaSummary(ast);
  const byLabel = (pattern) => template.params.filter((param) => pattern.test(param.label));
  const dir = template.direction;
  const periods = byLabel(/期數/), threshold = byLabel(/^門檻/)[0], multiplier = byLabel(/^倍數/)[0], prev = byLabel(/^往前根數/)[0];
  const pct = (x) => Number((x / 100).toFixed(4));
  const presets = [];
  const push = (label, values = {}, direction = dir ? dir.default : null) => presets.push({ label, values, direction });
  if (info.family === '均線' && dir && periods.length === 1 && !threshold && !multiplier) {
    const ma = periods[0].label.startsWith('EMA') ? 'EMA' : 'SMA';
    for (const n of [5, 10, 20, 60]) { push(`收盤上穿 ${ma}(${n})`, { [periods[0].key]: n }, 'above'); push(`收盤下穿 ${ma}(${n})`, { [periods[0].key]: n }, 'below'); }
  } else if (info.family === '均線' && dir && periods.length === 2 && !threshold && !multiplier) {
    const ma = periods[0].label.startsWith('EMA') ? 'EMA' : 'SMA'; const [fast, slow] = periods;
    for (const [f, s] of [[5, 20], [10, 20], [20, 60]]) { push(`${ma}(${f}) 上穿 ${ma}(${s})`, { [fast.key]: f, [slow.key]: s }, 'above'); push(`${ma}(${f}) 下穿 ${ma}(${s})`, { [fast.key]: f, [slow.key]: s }, 'below'); }
  } else if (info.family === 'RSI' && dir && threshold) {
    const n = byLabel(/^Wilder/)[0]?.default ?? 14;
    for (const [value, direction] of [[20, 'above'], [30, 'above'], [70, 'below'], [80, 'below']]) push(`RSI(${n}) ${direction === 'above' ? '上穿' : '下穿'} ${value}`, { [threshold.key]: value }, direction);
  } else if (info.family === 'KD' && dir && !threshold) { push('KD 黃金交叉', {}, 'above'); push('KD 死亡交叉', {}, 'below'); }
  else if (info.family === 'KD' && !dir && threshold && /</.test(summary)) push('KD 低檔黃金交叉（K<20）', { [threshold.key]: 20 });
  else if (info.family === 'MACD' && dir && !threshold) { push('MACD 黃金交叉', {}, 'above'); push('MACD 死亡交叉', {}, 'below'); }
  else if (info.family === '布林' && dir && /上軌/.test(summary)) push('收盤上穿布林上軌(20,2σ)', {}, 'above');
  else if (info.family === '布林' && dir && /下軌/.test(summary)) push('收盤下穿布林下軌(20,2σ)', {}, 'below');
  else if (info.family === 'VWAP' && dir) { push('收盤站上 VWAP', {}, 'above'); push('收盤跌破 VWAP', {}, 'below'); }
  else if (info.family === '一目' && dir && /雲層上緣/.test(summary)) push('收盤站上一目雲', {}, 'above');
  else if (info.family === '一目' && dir && /雲層下緣/.test(summary)) push('收盤跌破一目雲', {}, 'below');
  else if (info.family === '一目' && dir && /轉換線/.test(summary)) push('轉換線上穿基準線', {}, 'above');
  else if (info.family === '威廉' && dir && threshold) { const n = periods[0]?.default ?? 14; push(`威廉%R(${n}) 上穿 -80`, { [threshold.key]: -80 }, 'above'); push(`威廉%R(${n}) 下穿 -20`, { [threshold.key]: -20 }, 'below'); }
  else if (info.family === '量能' && dir && multiplier) for (const x of [1.5, 2, 3]) push(`量 ≥ 均量 ${x} 倍`, { [multiplier.key]: x }, 'above');
  else if (info.family === '漲跌幅' && dir && multiplier) {
    const base = /當日第一根/.test(summary) ? '相對開盤' : `相對前${prev?.default ?? 'N'}根`;
    for (const x of [1, 2, 3, 4, 5]) push(`${base}漲 ${x}%`, { [multiplier.key]: Number((1 + pct(x)).toFixed(4)) }, 'above');
    for (const x of [1, 2, 3, 4, 5]) push(`${base}跌 ${x}%`, { [multiplier.key]: Number((1 - pct(x)).toFixed(4)) }, 'below');
  } else if (info.family === 'ATR' && dir && multiplier) { const n = periods[0]?.default ?? 14; for (const x of [1, 2, 3, 4, 5]) push(`ATR(${n}) ≥ 收盤 ${x}%`, { [multiplier.key]: pct(x) }, 'above'); }
  if (!presets.length) push(fallbackLabel.slice(0, 100));
  return presets;
}

export function templateSummaryName(ast, template = extractTemplate(ast)) {
  const summary = formulaSummary(ast);
  let name = summary;
  for (const param of template.params) name = name.replace(new RegExp(`(?<![\\d.\\-])${escapeRegExp(String(param.default))}(?![\\d.])`, 'g'), 'N');
  if (template.direction) name = name.replace(/向上穿越|向下穿越/g, '穿越');
  const family = FAMILIES.find(([, pattern]) => pattern.test(summary))?.[0] ?? '其他';
  return { name, family, category: CATEGORY[family] ?? '其他' };
}

function collect(node, path, parent, role, slots) {
  if (!node || typeof node !== 'object') return;
  if (WINDOW.includes(node.op)) { slots.push({ kind: 'period', label: WINDOW_LABEL[node.op], type: 'integer', default: node.period, min: RANGE.window[0], max: RANGE.window[1], path: [...path, 'period'] }); collect(node.input, [...path, 'input'], node, 'input', slots); return; }
  if (node.op === 'prev') { slots.push({ kind: 'period', label: PREV_LABEL, type: 'integer', default: node.period, min: RANGE.prev[0], max: RANGE.prev[1], path: [...path, 'period'] }); collect(node.input, [...path, 'input'], node, 'input', slots); return; }
  if (node.op === 'constant') { const label = constantLabel(node, parent, role); if (label) slots.push({ kind: 'constant', label, type: 'number', default: node.value, min: RANGE[label][0], max: RANGE[label][1], path: [...path, 'value'] }); return; }
  if (ARITH.includes(node.op) || COMPARE.includes(node.op)) { collect(node.left, [...path, 'left'], node, 'left', slots); collect(node.right, [...path, 'right'], node, 'right', slots); return; }
  if (UNARY.includes(node.op)) { collect(node.input, [...path, 'input'], node, 'input', slots); return; }
  if (LOGIC.includes(node.op) && Array.isArray(node.items)) node.items.forEach((item, index) => collect(item, [...path, 'items', index], node, 'item', slots));
}
// null = structural constant, kept fixed.
function constantLabel(node, parent, role) {
  if (!parent || node.value === 0) return null;
  const sibling = role === 'left' ? parent.right : role === 'right' ? parent.left : null;
  if (parent.op === 'div' && role === 'right') return null;
  if (parent.op === 'mul' && Math.abs(node.value) === 100) return null;
  if (COMPARE.includes(parent.op) && role === 'right' && parent.left?.op !== 'constant') return '門檻';
  if (parent.op === 'mul') return sibling?.op === 'stddev' ? '標準差倍數' : '倍數';
  if ((parent.op === 'add' || parent.op === 'sub') && sibling?.op === 'stddev') return '標準差倍數';
  return '數值';
}
function dedupeLabels(params) {
  const counts = new Map(); for (const param of params) counts.set(param.label, (counts.get(param.label) || 0) + 1);
  const seen = new Map();
  for (const param of params) { if (counts.get(param.label) < 2) continue; const n = (seen.get(param.label) || 0) + 1; seen.set(param.label, n); param.label = `${param.label} ${n}`; }
}
function setAt(root, path, value) { let node = root; for (const step of path.slice(0, -1)) node = node[step]; node[path.at(-1)] = value; }
function canonical(value) { if (Array.isArray(value)) return value.map(canonical); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])); return value; }
function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&'); }
function templateError(message, detail) { return Object.assign(new Error('TEMPLATE_PARAM_INVALID'), { code: 'TEMPLATE_PARAM_INVALID', statusCode: 422, detail: { message, ...detail } }); }
