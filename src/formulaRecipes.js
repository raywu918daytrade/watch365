// Standard compositions of common Taiwan-market indicators out of formula_v1 blocks.
// Used as few-shot examples in the planner prompt (rendered as a node graph, so every example is a
// graph the validator accepts) and by the unit tests. Names are neutral descriptions only.
const src = (field) => ({ op:'source', field });
const num = (value) => ({ op:'constant', value });
const bin = (op, left, right) => ({ op, left, right });
const win = (op, input, period) => ({ op, input, period });

export function macdLine(fast = 12, slow = 26) { return bin('sub', win('ema', src('close'), fast), win('ema', src('close'), slow)); }
export function macdSignal(fast = 12, slow = 26, signal = 9) { return win('ema', macdLine(fast, slow), signal); }

// RSV(n) = (close − lowest(low,n)) ÷ (highest(high,n) − lowest(low,n)) × 100
// K = RMA(RSV,3), D = RMA(K,3): RMA(x,3) is exactly K_t = ⅔·K_{t−1} + ⅓·RSV_t (the TW 1/3 weighting).
// The seed is the SMA of the first 3 values instead of the conventional 50; the difference decays by ⅔ per bar.
export function kdRsv(n = 9) {
  const low = win('lowest', src('low'), n);
  return bin('mul', bin('div', bin('sub', src('close'), low), bin('sub', win('highest', src('high'), n), low)), num(100));
}
export function kdK(n = 9, smooth = 3) { return win('rma', kdRsv(n), smooth); }
export function kdD(n = 9, smooth = 3) { return win('rma', kdK(n, smooth), smooth); }

// Wilder RSI: RMA of gains / (RMA of gains + RMA of losses) × 100.
export function wilderRsi(period = 14) {
  const change = bin('sub', src('close'), win('prev', src('close'), 1));
  const gain = win('rma', bin('max', change, num(0)), period);
  const loss = win('rma', bin('max', bin('sub', win('prev', src('close'), 1), src('close')), num(0)), period);
  return bin('mul', bin('div', gain, bin('add', gain, loss)), num(100));
}

// Williams %R(n) = (highest(high,n) − close) ÷ (highest(high,n) − lowest(low,n)) × −100, range −100..0.
export function williamsR(n = 14) {
  const high = win('highest', src('high'), n);
  return bin('mul', bin('div', bin('sub', high, src('close')), bin('sub', high, win('lowest', src('low'), n))), num(-100));
}

export function bollinger(period = 20, width = 2, side = 'upper') {
  const mid = win('sma', src('close'), period);
  const band = bin('mul', win('stddev', src('close'), period), num(width));
  return bin(side === 'upper' ? 'add' : 'sub', mid, band);
}

export const FORMULA_RECIPES = Object.freeze([
  { key:'macd_golden', name:'MACD(12,26,9) DIF 向上穿越 DEA', ast:bin('crosses_above', macdLine(), macdSignal()) },
  { key:'macd_death', name:'MACD(12,26,9) DIF 向下穿越 DEA', ast:bin('crosses_below', macdLine(), macdSignal()) },
  { key:'kd_golden', name:'KD(9,3,3) K 向上穿越 D', ast:bin('crosses_above', kdK(), kdD()) },
  { key:'kd_low_golden', name:'KD(9,3,3) K<20 且 K 向上穿越 D', ast:{ op:'all', items:[bin('lt', kdK(), num(20)), bin('crosses_above', kdK(), kdD())] } },
  { key:'boll_upper', name:'收盤價向上穿越布林上軌(20,2σ)', ast:bin('crosses_above', src('close'), bollinger(20, 2, 'upper')) },
  { key:'boll_lower', name:'收盤價向下穿越布林下軌(20,2σ)', ast:bin('crosses_below', src('close'), bollinger(20, 2, 'lower')) },
  { key:'breakout_high', name:'收盤價向上穿越前20根最高價', ast:bin('crosses_above', src('close'), win('prev', win('highest', src('high'), 20), 1)) },
  { key:'volume_surge', name:'成交量 ≥ 前20根均量 × 2', ast:bin('gte', src('volume'), bin('mul', win('prev', win('sma', src('volume'), 20), 1), num(2))) },
  { key:'rsi_up', name:'RSI(14, Wilder) 向上穿越 30', ast:bin('crosses_above', wilderRsi(14), num(30)) },
  { key:'rsi_down', name:'RSI(14, Wilder) 向下穿越 70', ast:bin('crosses_below', wilderRsi(14), num(70)) },
  { key:'williams_r', name:'威廉 %R(14) 向上穿越 -80', ast:bin('crosses_above', williamsR(14), num(-80)) },
  { key:'pct_rise', name:'收盤價相對前5根收盤漲幅 ≥ 2%', ast:bin('gte', src('close'), bin('mul', win('prev', src('close'), 5), num(1.02))) }
]);
