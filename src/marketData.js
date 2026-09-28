import { readHfM1Bars } from './hfAdapter.js';

export async function fetchMarketBars(settings, options = {}) {
  if (settings.provider !== 'hf_dataset') {
    throw Object.assign(new Error('unsupported_provider'), { code: 'UNSUPPORTED_PROVIDER' });
  }
  return readHfM1Bars(settings.watchlist, options);
}
