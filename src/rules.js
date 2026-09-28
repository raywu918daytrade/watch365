import { isRegularSession, normalizeTwSymbol, validateMarketBar } from './marketBar.js';

export const RULE_NAME = '突破今日高點 + 成交量放大';
export const RULE_VERSION = 'tw_high_volume_v1';
export const VOLUME_MULTIPLIER = 2;
export const COOLDOWN_MS = 30 * 60 * 1000;
export const TW_MARKETS = Object.freeze(['TWSE', 'TPEx']);

export function parseWatchlist(input, options = {}) {
  if (!Array.isArray(input) || (input.length === 0 && !options.allowEmpty)) throw watchlistError('WATCHLIST_REQUIRED');
  const seen = new Set();
  return input.map((item) => {
    const symbol = normalizeTwSymbol(item?.symbol);
    if (!symbol) throw watchlistError('WATCHLIST_SYMBOL_INVALID');
    if (!item?.market) throw watchlistError('WATCHLIST_MARKET_REQUIRED');
    if (!TW_MARKETS.includes(item.market)) throw watchlistError('WATCHLIST_MARKET_INVALID');
    if (seen.has(symbol)) throw watchlistError('WATCHLIST_SYMBOL_DUPLICATED');
    seen.add(symbol);
    return { symbol, name: String(item.name || symbol).trim() || symbol, market: item.market };
  });
}

function watchlistError(code) {
  return Object.assign(new Error(code), { code, statusCode: 400 });
}

export function evaluateMarketBar(state, bar, evaluatedAt = new Date().toISOString()) {
  const result = baseDecision(bar, evaluatedAt);
  const validation = validateMarketBar(bar);
  if (!validation.valid) return finish(result, validation.reasonCode);
  if (!isRegularSession(bar.barStart)) return finish(result, 'outside_regular_session');
  const eventMs = new Date(bar.providerEventAt).getTime();
  const evaluatedMs = new Date(evaluatedAt).getTime();
  if (evaluatedMs - eventMs > 120_000) return finish(result, 'stale');

  const prior = state.sessions?.[bar.symbol];
  const session = prior?.tradingDate === bar.tradingDate
    ? structuredClone(prior)
    : { tradingDate: bar.tradingDate, bars: [], lastSignalAt: null };
  const last = session.bars.at(-1);
  if (last && new Date(bar.barEnd) <= new Date(last.barEnd)) return finish(result, 'out_of_order');
  const gap = last ? new Date(bar.barStart).getTime() - new Date(last.barEnd).getTime() : 0;
  if (gap > 120_000) session.contiguousAfterGap = 0;
  else if (session.contiguousAfterGap != null) session.contiguousAfterGap += 1;

  const referenceHigh = session.bars.length ? Math.max(...session.bars.map((item) => item.high)) : null;
  const baselineBars = session.bars.slice(-20);
  const baseline = baselineBars.length >= 5 ? median(baselineBars.map((item) => item.volume)) : null;
  const dedupeKey = `${bar.tradingDate}|${bar.symbol}|${RULE_VERSION}|${bar.barEnd}`;
  Object.assign(result, { referenceHigh, baseline, volumeThreshold: baseline == null ? null : baseline * VOLUME_MULTIPLIER, dedupeKey });

  session.bars.push({ barEnd: bar.barEnd, high: bar.high, volume: bar.volume });
  session.bars = session.bars.slice(-21);
  state.sessions ??= {};
  state.sessions[bar.symbol] = session;
  if (gap > 120_000) return finish(result, 'data_gap');
  if (session.contiguousAfterGap != null && session.contiguousAfterGap < 5) return finish(result, 'gap_recovery');
  if (session.contiguousAfterGap >= 5) delete session.contiguousAfterGap;
  if (baseline == null) return finish(result, 'warmup');
  if (state.dedupe?.[dedupeKey]) return finish(result, 'duplicate');
  if (referenceHigh == null || bar.high <= referenceHigh) return finish(result, 'high_not_broken');
  if (bar.volume < result.volumeThreshold) return finish(result, 'volume_below_threshold');
  if (session.lastSignalAt && evaluatedMs - new Date(session.lastSignalAt).getTime() < COOLDOWN_MS) return finish(result, 'cooldown');

  result.triggered = true;
  result.reasonCode = 'triggered';
  session.lastSignalAt = evaluatedAt;
  state.dedupe ??= {};
  state.dedupe[dedupeKey] = evaluatedAt;
  return result;
}

export function providerFailureDecision(errorCode, evaluatedAt = new Date().toISOString()) {
  return { ruleVersion: RULE_VERSION, triggered: false, reasonCode: 'provider_down', errorCode, evaluatedAt };
}

export function buildNotificationMessage(signal) {
  return `${signal.symbol} ${RULE_NAME} | 最高 ${signal.high} > 前高 ${signal.referenceHigh} | 成交量 ${signal.volume} / 門檻 ${signal.volumeThreshold}`;
}

export function makeId(prefix, date = new Date()) {
  return `${prefix}_${date.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function baseDecision(bar, evaluatedAt) {
  return { ruleVersion: RULE_VERSION, symbol: bar?.symbol || null, tradingDate: bar?.tradingDate || null, barEnd: bar?.barEnd || null, providerEventAt: bar?.providerEventAt || null, receivedAt: bar?.receivedAt || null, evaluatedAt, triggered: false, reasonCode: null };
}

function finish(result, reasonCode) {
  result.reasonCode = reasonCode;
  return result;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
