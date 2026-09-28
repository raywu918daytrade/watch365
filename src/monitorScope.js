import { calculateUniverseCoverage } from './universeCoverage.js';
import { legacyStrategy, strategyIdentity } from './indicatorRegistry.js';

export function buildMonitorScope(watchlist, universe) {
  const coverage = calculateUniverseCoverage(watchlist, universe.items);
  return {
    status: 'available',
    revision: universe.sourceRevision,
    updatedDate: universe.updatedDate,
    selectedCount: coverage.counts.selected,
    effectiveCount: coverage.counts.covered,
    uncoveredCount: coverage.counts.uncovered,
    effectiveWatchlist: coverage.items.filter((item) => item.coverage === 'covered').map(({ coverage: _coverage, ...item }) => item),
    uncoveredWatchlist: coverage.items.filter((item) => item.coverage === 'uncovered').map(({ coverage: _coverage, ...item }) => item)
  };
}

export function applyMonitorScope(state, scope) {
  const previousSymbols = state.runtime.effectiveWatchlist || [];
  const nextSymbols = scope.effectiveWatchlist.map((item) => item.symbol);
  const previous = new Set(previousSymbols);
  const interrupted = state.runtime.coverageInterrupted === true;
  for (const symbol of nextSymbols) if (interrupted || !previous.has(symbol)) resetSessionBars(state, symbol);
  Object.assign(state.runtime, {
    coverageStatus: 'available',
    coverageRevision: scope.revision,
    coverageUpdatedDate: scope.updatedDate,
    selectedWatchlistCount: scope.selectedCount,
    effectiveWatchlistCount: scope.effectiveCount,
    uncoveredWatchlistCount: scope.uncoveredCount,
    effectiveWatchlist: nextSymbols,
    coverageError: null,
    coverageInterrupted: false
  });
}

export function markMonitorScopeUnknown(state, errorCode) {
  Object.assign(state.runtime, {
    coverageStatus: 'unknown',
    coverageError: errorCode,
    effectiveWatchlistCount: null,
    uncoveredWatchlistCount: null,
    coverageInterrupted: true
  });
}

function resetSessionBars(state, symbol) {
  const session = state.sessions?.[symbol];
  if (!session) return;
  state.sessions[symbol] = { tradingDate:session.tradingDate, bars:[], lastSignalAt:session.lastSignalAt || null };
  for (const strategySessions of Object.values(state.indicatorSessions || {})) {
    const indicatorSession = strategySessions[symbol];
    if (indicatorSession) strategySessions[symbol] = { tradingDate:indicatorSession.tradingDate, bars:[], lastSignalAt:indicatorSession.lastSignalAt || null };
  }
}

export function notificationEligibility(state, notification, universe) {
  if (!notification || notification.status !== 'pending') return { deliver:false, reason:'not_pending' };
  if (!state.settings.enabled) return { deliver:false, reason:'monitor_paused' };
  const signal = state.signals.find((item) => item.id === notification.signalId);
  if (!signal) return { deliver:false, reason:'signal_missing' };
  if (!signalMatchesCurrentStrategy(state, signal)) return { deliver:false, reason:'strategy_mismatch' };
  const selected = state.settings.watchlist.some((item) => item.symbol === signal.symbol);
  if (!selected) return { deliver:false, reason:'not_selected' };
  const covered = universe.items.some((item) => item.symbol === signal.symbol);
  return covered ? { deliver:true, reason:null } : { deliver:false, reason:'not_covered' };
}

export function signalMatchesCurrentStrategy(state, signal) {
  const current = state.settings.strategy || legacyStrategy('1970-01-01T00:00:00.000Z');
  if (!signal?.strategy) return current.id === 'legacy.breakout-volume' && current.version === '1.0.0' && current.timeframe === '1m';
  return strategyIdentity(signal.strategy) === strategyIdentity(current);
}

export function filterBarsToMonitorScope(bars, scope) {
  const effective = new Set(scope.effectiveWatchlist.map((item) => item.symbol));
  return bars.filter((bar) => effective.has(String(bar.symbol)));
}
