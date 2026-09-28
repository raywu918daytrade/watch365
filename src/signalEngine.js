import { buildNotificationMessage, evaluateMarketBar, makeId, RULE_NAME } from './rules.js';
import { evaluateIndicatorBar, indicatorMessage } from './indicatorEngine.js';
import { legacyStrategy } from './indicatorRegistry.js';

export function applyScopedMarketBars(state, bars, scope, source, now = new Date()) {
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
  state.decisions = decisions.reverse().concat(state.decisions || []);
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
