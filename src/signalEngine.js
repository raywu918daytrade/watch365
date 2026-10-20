import { buildNotificationMessage, evaluateMarketBar, makeId, RULE_NAME } from './rules.js';
import { evaluateIndicatorBar, indicatorMessage } from './indicatorEngine.js';
import { legacyStrategy, strategyIdentity } from './indicatorRegistry.js';

// Signals from the monitoring state machine (src/ruleState.js) replace the old per-bar indicator signals when
// ruleTriggers is given (NOTIFY_ENGINE=state, the default). A trigger becomes a signal + notification only when it
// belongs to the current strategy, the stock is in scope, and its bar is recent (a trigger found late — after a
// restart or a slow data file — is logged, not notified). The legacy breakout+volume rule has no formula form and
// keeps its own engine. The old engine still runs for the decision log; its would-be signals are only counted.
export const STATE_SIGNAL_MAX_AGE_MS = 180_000;

export function applyScopedMarketBars(state, bars, scope, source, now = new Date(), { ruleTriggers = null } = {}) {
  if (!state.settings.enabled) return { signals:[], decisions:[], skipped:true, reason:'monitor_paused' };
  const selected = new Set(state.settings.watchlist.map((item) => item.symbol));
  const effective = new Set(scope.effectiveWatchlist.map((item) => item.symbol));
  const eligibleBars = bars.filter((bar) => selected.has(bar.symbol) && effective.has(bar.symbol));
  state.runtime.lastRunAt = now.toISOString();
  state.runtime.lastProviderStatus = eligibleBars.length ? 'ok' : 'empty';
  state.runtime.lastError = null;
  state.quotes = eligibleBars.slice(-50).reverse().concat(state.quotes || []);
  const strategy = state.settings.strategy || legacyStrategy('1970-01-01T00:00:00.000Z');
  const latestBySymbol = new Map();
  for (const bar of eligibleBars) latestBySymbol.set(bar.symbol, bar.barEnd);
  const decisions = eligibleBars.map((bar) => strategy.executor === 'high_volume_breakout'
    ? evaluateMarketBar(state, bar, now.toISOString())
    : evaluateIndicatorBar(state, strategy, bar, now.toISOString(), { allowSignal:latestBySymbol.get(bar.symbol) === bar.barEnd }));
  const stateEngine = Array.isArray(ruleTriggers) && strategy.executor !== 'high_volume_breakout';
  if (stateEngine) {
    const today = taipeiDay(now);
    if (state.runtime.legacyShadow?.day !== today) state.runtime.legacyShadow = { day:today, count:0 };
    for (const decision of decisions) if (decision.triggered) { decision.triggered = false; decision.reasonCode = 'superseded_by_state_machine'; state.runtime.legacyShadow.count += 1; }
  }
  state.decisions = decisions.reverse().concat(state.decisions || []);
  if (stateEngine) return applyRuleTriggers(state, ruleTriggers, eligibleBars, strategy, now, decisions);
  const createdSignals = decisions.filter((decision) => decision.triggered).map((decision) => {
    const bar = eligibleBars.find((item) => item.symbol === decision.symbol && item.barEnd === decision.barEnd);
    return { ...decision, id:makeId('sig',now), ruleName:strategy.name || RULE_NAME, strategy:structuredClone(strategy), triggeredAt:now.toISOString(), name:state.settings.watchlist.find((item)=>item.symbol===decision.symbol)?.name||decision.symbol, market:bar.market, high:bar.high, price:bar.close, volume:bar.volume, provider:bar.provider, providerEventAt:bar.providerEventAt };
  });
  for (const signal of createdSignals) {
    state.signals.unshift(signal);
    const message = strategy.executor === 'high_volume_breakout' ? buildNotificationMessage(signal) : indicatorMessage(signal);
    state.notifications.unshift({id:makeId('noti',now),signalId:signal.id,channel:state.settings.notification.channel,target:state.settings.notification.target,status:'pending',createdAt:now.toISOString(),title:`${signal.symbol} 觸發盯盤條件`,message,retryCount:0});
  }
  return { signals:createdSignals, decisions, skipped:false, reason:null };
}

function applyRuleTriggers(state, triggers, eligibleBars, strategy, now, decisions) {
  const ruleId = strategyIdentity(strategy);
  const late = [];
  const createdSignals = [];
  for (const trigger of triggers) {
    if (trigger.ruleId !== ruleId) continue;
    const bar = eligibleBars.find((item) => item.symbol === trigger.symbol && item.barEnd === trigger.barEnd);
    if (!bar) continue;
    const dedupeKey = `${trigger.tradingDate}|${trigger.symbol}|${ruleId}|${trigger.barEnd}`;
    if (state.dedupe?.[dedupeKey]) continue;
    if (now.getTime() - new Date(trigger.barEnd).getTime() > STATE_SIGNAL_MAX_AGE_MS) { late.push(trigger); continue; }
    state.dedupe ??= {}; state.dedupe[dedupeKey] = now.toISOString();
    const name = state.settings.watchlist.find((item) => item.symbol === trigger.symbol)?.name || trigger.symbol;
    const signal = { id:makeId('sig', now), engine:'state_machine', ruleVersion:`${strategy.id}@${strategy.version}`, strategyIdentity:ruleId, executor:strategy.executor, symbol:trigger.symbol, tradingDate:trigger.tradingDate, barEnd:trigger.barEnd, dedupeKey, triggered:true, reasonCode:'triggered', ruleName:strategy.name || RULE_NAME, strategy:structuredClone(strategy), triggeredAt:now.toISOString(), name, market:bar.market, high:bar.high, price:bar.close, volume:bar.volume, provider:bar.provider, providerEventAt:bar.providerEventAt };
    createdSignals.push(signal);
    state.signals.unshift(signal);
    state.notifications.unshift({ id:makeId('noti', now), signalId:signal.id, channel:state.settings.notification.channel, target:state.settings.notification.target, status:'pending', createdAt:now.toISOString(), title:`${signal.symbol} 觸發盯盤條件`, message:stateMachineMessage(signal), retryCount:0 });
  }
  return { signals:createdSignals, decisions, skipped:false, reason:null, late };
}

// D1-only monitors (executor daily_close): one signal per stock that newly meets the daily filters on today's 13:00 price.
// result = { date, met, newly:[{ symbol, close }] } from the history index worker.
export function applyDailyClose(state, result, strategy, now = new Date()) {
  const ruleId = strategyIdentity(strategy);
  const selected = new Set(state.settings.watchlist.map((item) => item.symbol));
  const createdSignals = [];
  for (const item of result.newly || []) {
    if (!selected.has(item.symbol)) continue;
    const dedupeKey = `${result.date}|${item.symbol}|${ruleId}|daily`;
    if (state.dedupe?.[dedupeKey]) continue;
    state.dedupe ??= {}; state.dedupe[dedupeKey] = now.toISOString();
    const watch = state.settings.watchlist.find((entry) => entry.symbol === item.symbol);
    const signal = { id:makeId('sig', now), engine:'daily_close', ruleVersion:`${strategy.id}@${strategy.version}`, strategyIdentity:ruleId, executor:strategy.executor, symbol:item.symbol, tradingDate:result.date, barEnd:`${result.date}T05:00:00.000Z`, dedupeKey, triggered:true, reasonCode:'triggered', ruleName:strategy.name || RULE_NAME, strategy:structuredClone(strategy), triggeredAt:now.toISOString(), name:watch?.name || item.symbol, market:watch?.market, price:item.close };
    createdSignals.push(signal);
    state.signals.unshift(signal);
    state.notifications.unshift({ id:makeId('noti', now), signalId:signal.id, channel:state.settings.notification.channel, target:state.settings.notification.target, status:'pending', createdAt:now.toISOString(), title:`${signal.symbol} 13:00 符合日 K 條件`, message:stateMachineMessage(signal), retryCount:0 });
  }
  return { signals:createdSignals, skipped:false, reason:null };
}

export function stateMachineMessage(signal) {
  return `${signal.symbol} ${signal.name !== signal.symbol ? `${signal.name} ` : ''}條件成立：${signal.ruleName} | ${signal.engine === 'daily_close' ? '13:00 價' : '收盤'} ${Number(signal.price).toLocaleString('zh-TW', { maximumFractionDigits:2 })}`;
}

function taipeiDay(now) { return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10); }
