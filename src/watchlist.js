import { normalizeTwSymbol } from './marketBar.js';

export function tokenizeWatchlist(input) {
  const rawItems = String(input || '').split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
  const seen = new Set();
  const symbols = [];
  const duplicates = [];
  const invalid = [];
  for (const raw of rawItems) {
    const symbol = normalizeTwSymbol(raw);
    if (!symbol) {
      invalid.push({ raw, reasonCode: 'SYMBOL_FORMAT_INVALID' });
      continue;
    }
    if (seen.has(symbol)) {
      duplicates.push({ raw, symbol });
      continue;
    }
    seen.add(symbol);
    symbols.push({ raw, symbol });
  }
  return { symbols, duplicates, invalid, inputCount: rawItems.length };
}

export function resolveWatchlistInput(input, tickerMetadata) {
  const parsed = tokenizeWatchlist(input);
  const valid = [];
  const needsCorrection = [];
  for (const item of parsed.symbols) {
    const metadata = tickerMetadata?.get(item.symbol);
    if (metadata && ['TWSE', 'TPEx'].includes(metadata.market) && metadata.supported !== false) {
      valid.push({ symbol: item.symbol, name: metadata.name || item.symbol, market: metadata.market, supported: true });
    } else {
      needsCorrection.push({ ...item, reasonCode: metadata?.supported === false ? 'SYMBOL_NOT_SUPPORTED' : 'MARKET_UNCONFIRMED' });
    }
  }
  return { ...parsed, valid, needsCorrection };
}

export function mergeWatchlists(existing, additions) {
  const merged = new Map(existing.map((item) => [item.symbol, item]));
  let addedCount = 0;
  let existingCount = 0;
  for (const item of additions) {
    if (merged.has(item.symbol)) existingCount += 1;
    else addedCount += 1;
    merged.set(item.symbol, item);
  }
  return { watchlist: [...merged.values()], addedCount, existingCount };
}
