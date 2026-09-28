export const TAIPEI_TIME_ZONE = 'Asia/Taipei';
export const REGULAR_SESSION = Object.freeze({ open: '09:00', close: '13:30' });

export function isTwSymbol(value) {
  return /^\d{4,6}$/.test(String(value ?? ''));
}

export function normalizeTwSymbol(value) {
  const symbol = String(value ?? '').trim();
  return isTwSymbol(symbol) ? symbol : null;
}

export function toTaipeiTradingDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

export function taipeiParts(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TAIPEI_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
}

export function isRegularSession(value) {
  const parts = taipeiParts(value);
  if (!parts) return false;
  const day = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return false;
  const hhmm = `${parts.hour}:${parts.minute}`;
  return hhmm >= REGULAR_SESSION.open && hhmm <= REGULAR_SESSION.close;
}

export function mapProviderSymbol(symbol, metadata) {
  const canonical = normalizeTwSymbol(symbol);
  if (!canonical) throw new Error('invalid_tw_symbol');
  if (!metadata || !['TWSE', 'TPEx'].includes(metadata.market)) throw new Error('market_metadata_required');
  return { symbol: canonical, providerSymbol: canonical, market: metadata.market };
}

export function validateMarketBar(bar) {
  const requiredTimes = ['barStart', 'barEnd', 'providerEventAt', 'receivedAt'];
  if (!normalizeTwSymbol(bar?.symbol) || !bar?.market || !bar?.provider || bar?.timeframe !== '1m') return { valid: false, reasonCode: 'data_invalid' };
  if (requiredTimes.some((key) => !bar[key] || Number.isNaN(new Date(bar[key]).getTime()))) return { valid: false, reasonCode: 'data_invalid' };
  if (![bar.open, bar.high, bar.low, bar.close].every((value) => Number.isFinite(value) && value > 0)) return { valid: false, reasonCode: 'data_invalid' };
  if (!Number.isFinite(bar.volume) || bar.volume < 0 || bar.complete !== true) return { valid: false, reasonCode: bar?.complete === false ? 'bar_incomplete' : 'data_invalid' };
  const tradingDate = toTaipeiTradingDate(bar.barEnd);
  if (!tradingDate || tradingDate !== bar.tradingDate) return { valid: false, reasonCode: 'data_invalid' };
  return { valid: true };
}

export function fromCumulativeVolume(current, previous) {
  if (!Number.isFinite(current) || current < 0) return { valid: false, reasonCode: 'data_invalid' };
  if (previous == null) return { valid: false, reasonCode: 'volume_baseline_missing' };
  if (!Number.isFinite(previous) || previous < 0 || current < previous) return { valid: false, reasonCode: 'volume_reset' };
  return { valid: true, volume: current - previous };
}
