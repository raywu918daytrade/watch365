// Builds the static data files the browser engine reads (GitHub Pages, no server):
//   public/data/daily.json.gz  D1 bars of the system universe (last MONTHS months), one row per stock aligned to `dates`
//   public/data/universe.json  universe (symbol, name, group), ticker master (symbol → [name, market]), versions
// Run by .github/workflows/site.yml after the daily D1 update (cron-job.org → workflow_dispatch). Needs HF_REPO_ID and
// HF_TOKEN (read access) in the environment.
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { listHfD1Months, readD1Rows } from '../src/history.js';
import { readHfAssetVersion, readHfSystemUniverse, readHfTickerMaster } from '../src/hfAdapter.js';

const MONTHS = Number(process.env.DATA_MONTHS || 20);
const OUT = new URL('../public/data/', import.meta.url).pathname;

const version = await readHfAssetVersion('db/tickers/tick_universe.parquet');
const universe = await readHfSystemUniverse({ version });
const master = await readHfTickerMaster();
const symbols = new Set(universe.items.map((item) => item.symbol));
const months = (await listHfD1Months()).slice(-MONTHS);
const rows = [];
for (const file of months) { rows.push(...await readD1Rows(file.path, { maxAgeSeconds:0, symbols })); console.log(`d1 ${file.month}: ${rows.length} rows so far`); }

const dates = [...new Set(rows.map((row) => row.date))].sort();
const slot = new Map(dates.map((date, index) => [date, index]));
const series = {};
for (const row of rows) {
  const list = series[row.symbol] ??= Array(dates.length).fill(null);
  list[slot.get(row.date)] = [row.open, row.high, row.low, row.close, row.volume];
}
const bars = rows.length, stocks = Object.keys(series).length;
if (!stocks || bars / stocks < Math.min(20, months.length * 5)) throw new Error(`daily data looks wrong: ${bars} bars for ${stocks} stocks`);

await mkdir(OUT, { recursive:true });
const builtAt = new Date().toISOString();
await writeFile(join(OUT, 'daily.json.gz'), gzipSync(JSON.stringify({ builtAt, months:months.map((file) => file.month), dates, series })));
await writeFile(join(OUT, 'universe.json'), JSON.stringify({
  builtAt,
  universe:{ ...universe, items:universe.items },
  master:Object.fromEntries([...master.metadata.values()].map((item) => [item.symbol, [item.name, item.market]]))
}));
console.log(`data: ${stocks} stocks × ${dates.length} dates (${months[0]?.month} … ${months.at(-1)?.month}), universe ${universe.total}, master ${master.metadata.size}`);
