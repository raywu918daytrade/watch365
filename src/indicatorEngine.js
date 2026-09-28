import { isRegularSession, validateMarketBar } from './marketBar.js';
import { strategyIdentity } from './indicatorRegistry.js';
import { RSI, SMA } from 'technicalindicators';
import { evaluateFormula } from './formulaEngine.js';

const COOLDOWN_MS = 30 * 60 * 1000;

export function evaluateIndicatorBar(state, strategy, bar, evaluatedAt = new Date().toISOString(), { allowSignal = true } = {}) {
  const result = baseResult(strategy, bar, evaluatedAt);
  const validation = validateMarketBar(bar);
  if (!validation.valid) return finish(result, validation.reasonCode);
  if (!isRegularSession(bar.barStart)) return finish(result, 'outside_regular_session');
  if (new Date(evaluatedAt).getTime() - new Date(bar.providerEventAt).getTime() > 120_000) return finish(result, 'stale');
  const key = strategyIdentity(strategy);
  state.indicatorSessions ??= {};
  state.indicatorSessions[key] ??= {};
  const previous = state.indicatorSessions[key][bar.symbol];
  const session = previous?.tradingDate === bar.tradingDate ? structuredClone(previous) : { tradingDate:bar.tradingDate, bars:[], lastSignalAt:null };
  const last = session.bars.at(-1);
  if (last && new Date(bar.barEnd) <= new Date(last.barEnd)) return finish(result, 'out_of_order');
  const gap = last ? new Date(bar.barStart).getTime() - new Date(last.barEnd).getTime() : 0;
  if (gap > 120_000) {
    session.bars = [{ barEnd:bar.barEnd, close:bar.close, volume:bar.volume }];
    state.indicatorSessions[key][bar.symbol] = session;
    return finish(result, 'data_gap');
  }
  if(strategy.executor==='formula_v1'&&session.bars.length>=512)return finish(result,'data_budget_exceeded');
  session.bars.push({ barEnd:bar.barEnd, close:bar.close, volume:bar.volume });
  state.indicatorSessions[key][bar.symbol] = session;
  const closes = session.bars.map((item) => item.close);
  let crossed = false;
  if (strategy.executor === 'sma_cross') {
    const period = strategy.params.period;
    const previousSma = sma(closes.slice(0, -1), period);
    const currentSma = sma(closes, period);
    Object.assign(result, { previousValue:last?.close ?? null, currentValue:bar.close, previousIndicator:previousSma, currentIndicator:currentSma, indicatorLabel:`SMA(${period})` });
    if (previousSma == null || currentSma == null) return finish(result, 'warmup');
    crossed = last.close <= previousSma && bar.close > currentSma;
  } else if (strategy.executor === 'rsi_wilder_cross') {
    const values = wilderRsi(closes, strategy.params.period);
    const previousRsi = values.at(-2) ?? null;
    const currentRsi = values.at(-1) ?? null;
    Object.assign(result, { previousValue:previousRsi, currentValue:currentRsi, previousIndicator:strategy.params.threshold, currentIndicator:strategy.params.threshold, indicatorLabel:`RSI(${strategy.params.period})`, threshold:strategy.params.threshold });
    if (previousRsi == null || currentRsi == null) return finish(result, 'warmup');
    crossed = previousRsi <= strategy.params.threshold && currentRsi > strategy.params.threshold;
  } else if(strategy.executor==='formula_v1'){
    const evaluated=evaluateFormula(strategy.formula.ast,session.bars);
    Object.assign(result,{previousValue:evaluated.previous,currentValue:evaluated.current,indicatorLabel:strategy.formula.summary});
    if(evaluated.current==null)return finish(result,evaluated.errorCode||'warmup');
    crossed=evaluated.triggered;
  } else return finish(result, 'executor_unavailable');
  const dedupeKey = `${bar.tradingDate}|${bar.symbol}|${key}|${bar.barEnd}`;
  result.dedupeKey = dedupeKey;
  if (!allowSignal || new Date(bar.barEnd) <= new Date(strategy.activatedAt)) return finish(result, 'baseline_only');
  if (!crossed) return finish(result, 'not_crossed');
  if (state.dedupe?.[dedupeKey]) return finish(result, 'duplicate');
  if (session.lastSignalAt && new Date(evaluatedAt) - new Date(session.lastSignalAt) < COOLDOWN_MS) return finish(result, 'cooldown');
  result.triggered = true; result.reasonCode = 'triggered'; session.lastSignalAt = evaluatedAt;
  state.dedupe ??= {}; state.dedupe[dedupeKey] = evaluatedAt;
  return result;
}

export function sma(values, period) { return SMA.calculate({ period, values }).at(-1) ?? null; }

export function wilderRsi(values, period = 14) {
  const prefix = Array(Math.min(period, values.length)).fill(null);
  if (values.length <= period) return Array(values.length).fill(null);
  const calculated = RSI.calculate({ period, values }).map((value,index) => {
    const sourceIndex=index+period;
    return values.slice(0,sourceIndex+1).every((item)=>item===values[0]) ? 50 : value;
  });
  return prefix.concat(calculated);
}

export function indicatorMessage(signal) {
  if (signal.executor === 'sma_cross') return `${signal.symbol} 價格上穿 ${signal.indicatorLabel} | 收盤 ${format(signal.currentValue)} / 指標 ${format(signal.currentIndicator)}`;
  if (signal.executor === 'rsi_wilder_cross') return `${signal.symbol} ${signal.indicatorLabel} 上穿 ${format(signal.threshold)} | 目前 ${format(signal.currentValue)}`;
  if(signal.executor==='formula_v1')return `${signal.symbol} 觸發 ${signal.indicatorLabel}`;
  return `${signal.symbol} 觸發監控條件`;
}
function baseResult(strategy,bar,evaluatedAt){return{strategyId:strategy.id,strategyVersion:strategy.version,strategyIdentity:strategyIdentity(strategy),executor:strategy.executor,ruleVersion:`${strategy.id}@${strategy.version}`,symbol:bar?.symbol||null,tradingDate:bar?.tradingDate||null,barEnd:bar?.barEnd||null,providerEventAt:bar?.providerEventAt||null,receivedAt:bar?.receivedAt||null,evaluatedAt,triggered:false,reasonCode:null};}
function finish(result,reasonCode){result.reasonCode=reasonCode;return result;}
function format(value){return Number(value).toLocaleString('zh-TW',{maximumFractionDigits:2});}
