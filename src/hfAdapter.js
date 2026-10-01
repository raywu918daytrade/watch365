import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { normalizeTwSymbol, roundPrice, toTaipeiTradingDate } from './marketBar.js';

export const DEFAULT_CACHE_ROOT = new URL('../cache/hf/', import.meta.url).pathname;
export const DEFAULT_ENV_PATHS = [
  new URL('../.env', import.meta.url).pathname,
  '/Users/wumingrui/Library/CloudStorage/Dropbox/vwap/backend/.env'
];

export function hfAssetPaths(asOf = new Date()) {
  const tradingDate = toTaipeiTradingDate(asOf);
  if (!tradingDate) throw hfError('HF_INVALID_AS_OF');
  return {
    tradingDate,
    d1: `db/d1/${tradingDate.slice(0, 7).replace('-', '_')}.parquet`,
    m1Live: `db/m1_live/${tradingDate}.parquet`
  };
}

export async function loadHfConfig(paths = DEFAULT_ENV_PATHS) {
  const values = new Map();
  for (const path of paths) {
    try {
      for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
        const match = line.match(/^\s*(?:export\s+)?(HF_REPO_ID|HF_TOKEN)\s*=\s*(.*)$/);
        if (!match) continue;
        values.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim());
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw hfError('HF_CONFIG_READ_FAILED');
    }
  }
  const repoId = process.env.HF_REPO_ID || values.get('HF_REPO_ID');
  const token = process.env.HF_TOKEN || values.get('HF_TOKEN');
  if (!repoId || !token) throw hfError('HF_CONFIG_UNAVAILABLE');
  return { repoId, token };
}

const DOWNLOAD_TIMEOUT_MS = Number(process.env.HF_DOWNLOAD_TIMEOUT_MS || 180_000);

export async function downloadHfAsset(assetPath, {
  cacheRoot = DEFAULT_CACHE_ROOT,
  config,
  fetchImpl = fetch,
  force = false,
  maxAgeSeconds = 300,
  revision = 'main'
} = {}) {
  const credentials = config || await loadHfConfig();
  const cachePath = join(cacheRoot, assetPath);
  if (!force) {
    try {
      const info = await stat(cachePath);
      if (Date.now() - info.mtimeMs <= maxAgeSeconds * 1000) return { cachePath, cacheStatus: 'hit' };
    } catch (error) {
      if (error.code !== 'ENOENT') throw hfError('HF_CACHE_READ_FAILED');
    }
  }
  let response;
  try {
    const encodedRepo = credentials.repoId.split('/').map(encodeURIComponent).join('/');
    // A stalled HF download must fail instead of holding the history queue forever.
    response = await fetchImpl(`https://huggingface.co/datasets/${encodedRepo}/resolve/${encodeURIComponent(revision)}/${assetPath}`, {
      headers: { Authorization: `Bearer ${credentials.token}` }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
    });
  } catch (error) {
    throw hfError(error?.name === 'TimeoutError' ? 'HF_DOWNLOAD_TIMEOUT' : 'HF_DOWNLOAD_FAILED');
  }
  if (response.status === 401 || response.status === 403) throw hfError('HF_UNAUTHORIZED');
  if (response.status === 404) throw hfError('HF_ASSET_NOT_FOUND');
  if (!response.ok) throw hfError('HF_DOWNLOAD_FAILED');
  let body;
  try { body = Buffer.from(await response.arrayBuffer()); }
  catch (error) { throw hfError(error?.name === 'TimeoutError' ? 'HF_DOWNLOAD_TIMEOUT' : 'HF_DOWNLOAD_FAILED'); }
  await mkdir(dirname(cachePath), { recursive: true });
  try {
    await writeFile(cachePath, body);
  } catch {
    throw hfError('HF_CACHE_WRITE_FAILED');
  }
  return { cachePath, cacheStatus: 'miss' };
}

export async function inspectHfD1({ asOf = new Date(), ...options } = {}) {
  const asset = hfAssetPaths(asOf);
  const downloaded = await downloadHfAsset(asset.d1, { maxAgeSeconds: 3600, ...options });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const metadata = await parquetMetadataAsync(file);
  const schema = parquetSchema(metadata).children.map((item) => item.element.name);
  const rows = await parquetReadObjects({ file, compressors, columns: ['stock_id', 'date', 'open', 'high', 'low', 'close', 'volume'] });
  const required = ['stock_id', 'date', 'open', 'high', 'low', 'close', 'volume'];
  const complete = rows.filter((row) => required.every((key) => row[key] !== null && row[key] !== undefined)).length;
  const dates = rows.map((row) => String(row.date).slice(0, 10)).sort();
  return { provider: 'hf_dataset', assetKind: 'd1_month', schema, rowCount: rows.length, completeness: rows.length ? complete / rows.length : 0, latestTradingDate: dates.at(-1) || null, cacheStatus: downloaded.cacheStatus };
}

export async function readHfTickerMaster(options = {}) {
  const downloaded = await downloadHfAsset('db/tickers/tickers.parquet', { maxAgeSeconds: 86400, ...options });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file, compressors, columns: ['stock_id', 'exchange', 'name'] });
  const metadata = new Map();
  for (const row of rows) {
    const symbol = normalizeTwSymbol(row.stock_id);
    if (!symbol || !['TWSE', 'TPEx'].includes(row.exchange)) continue;
    metadata.set(symbol, { symbol, name: String(row.name || symbol), market: row.exchange, supported: true });
  }
  return { metadata, rowCount: rows.length, supportedCount: metadata.size, cacheStatus: downloaded.cacheStatus };
}

export async function readHfSystemUniverse({ config, fetchImpl = fetch, version: suppliedVersion, ...options } = {}) {
  const credentials = config || await loadHfConfig();
  const assetPath = 'db/tickers/tick_universe.parquet';
  const version = suppliedVersion || await readHfAssetVersion(assetPath, { config: credentials, fetchImpl });
  const downloaded = await downloadHfAsset(assetPath, { config: credentials, fetchImpl, force: true, revision: version.revision, ...options });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file, compressors, columns: ['stock_id'] });
  const master = await readHfTickerMaster({ config: credentials, fetchImpl, ...options });
  let groups = new Map();
  try { groups = await readHfStockGroups({ config: credentials, fetchImpl, ...options }); } catch {}
  const items = buildSystemUniverseItems(rows, master.metadata, groups);
  const updatedDate = toTaipeiTradingDate(version.updatedAt);
  if (!updatedDate) throw hfError('HF_UNIVERSE_VERSION_INVALID');
  return {
    provider: 'hf_dataset',
    assetKind: 'system_monitor_universe',
    assetPath,
    updatedDate,
    sourceUpdatedAt: version.updatedAt,
    sourceRevision: version.revision,
    status: 'available',
    total: items.length,
    items
  };
}

export function buildSystemUniverseItems(rows, metadata, groups = new Map()) {
  const symbols = [...new Set(rows.map((row) => normalizeTwSymbol(row.stock_id)).filter(Boolean))];
  return symbols.map((symbol) => ({ symbol, name: metadata.get(symbol)?.name || null, group: groups.get(symbol) || null }));
}

// TWSE and TPEx name a few sectors differently; fold the pure synonyms into one label.
const GROUP_ALIASES = new Map([['金融業', '金融保險'], ['其他電子類', '其他電子業']]);

// Sector (類股) per stock from db/info/info.parquet (stock_id, name, market_type, group).
export async function readHfStockGroups(options = {}) {
  const downloaded = await downloadHfAsset('db/info/info.parquet', { maxAgeSeconds: 86400, ...options });
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file, compressors, columns: ['stock_id', 'group'] });
  const groups = new Map();
  for (const row of rows) {
    const symbol = normalizeTwSymbol(row.stock_id);
    const group = String(row.group || '').trim();
    if (symbol && group) groups.set(symbol, GROUP_ALIASES.get(group) || group);
  }
  return groups;
}

export async function readHfAssetVersion(assetPath, { config, fetchImpl = fetch } = {}) {
  const credentials = config || await loadHfConfig();
  const directory = assetPath.split('/').slice(0, -1).join('/');
  const encodedRepo = credentials.repoId.split('/').map(encodeURIComponent).join('/');
  const encodedDirectory = encodeURIComponent(directory);
  let response;
  try {
    response = await fetchImpl(`https://huggingface.co/api/datasets/${encodedRepo}/tree/main/${encodedDirectory}?expand=true&limit=50`, {
      headers: { Authorization: `Bearer ${credentials.token}` }
    });
  } catch {
    throw hfError('HF_UNIVERSE_SOURCE_FAILED');
  }
  if (response.status === 401 || response.status === 403) throw hfError('HF_UNAUTHORIZED');
  if (!response.ok) throw hfError('HF_UNIVERSE_SOURCE_FAILED');
  let entries;
  try {
    entries = await response.json();
  } catch {
    throw hfError('HF_UNIVERSE_SOURCE_FAILED');
  }
  const entry = entries.find((item) => item.path === assetPath);
  if (!entry) throw hfError('HF_UNIVERSE_NOT_FOUND');
  const updatedAt = entry.lastCommit?.date;
  const revision = entry.lastCommit?.id;
  if (!updatedAt || !revision) throw hfError('HF_UNIVERSE_VERSION_UNAVAILABLE');
  return { updatedAt, revision };
}

export async function readHfM1Bars(watchlist, { asOf = new Date(), receivedAt = new Date().toISOString(), ...options } = {}) {
  const asset = hfAssetPaths(asOf);
  const downloaded = await downloadHfAsset(asset.m1Live, { maxAgeSeconds: 30, ...options });
  const metadata = new Map(watchlist.map((item) => [normalizeTwSymbol(item.symbol), item.market]));
  for (const [symbol, market] of metadata) {
    if (!symbol || !['TWSE', 'TPEx'].includes(market)) throw hfError('MARKET_METADATA_REQUIRED');
  }
  const file = await asyncBufferFromFile(downloaded.cachePath);
  const rows = await parquetReadObjects({ file, compressors, columns: ['stock_id', 'date', 'open', 'high', 'low', 'close', 'volume'] });
  return rows.filter((row) => metadata.has(String(row.stock_id))).map((row) => {
    const start = String(row.date).includes('T') ? new Date(row.date) : new Date(`${row.date.replace(' ', 'T')}+08:00`);
    const end = new Date(start.getTime() + 60_000);
    return { symbol: String(row.stock_id), market: metadata.get(String(row.stock_id)), provider: 'hf_dataset', timeframe: '1m', tradingDate: toTaipeiTradingDate(end), barStart: start.toISOString(), barEnd: end.toISOString(), open: roundPrice(row.open), high: roundPrice(row.high), low: roundPrice(row.low), close: roundPrice(row.close), volume: Number(row.volume), complete: true, providerEventAt: end.toISOString(), receivedAt };
  }).sort((a, b) => a.barEnd.localeCompare(b.barEnd));
}

function hfError(code) {
  return Object.assign(new Error(code), { code });
}
