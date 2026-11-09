// 13:00 Taipei check of every D1-only monitor (owner decision 2026-10: notify before the close with the 13:00 price as
// the close). Runs in GitHub Actions (.github/workflows/daily-close.yml), started by cron-job.org on weekdays; replaces
// runDailyClose in src/server.js after the move off Railway. Monitors and LINE users are read from and written back to
// the Cloudflare Worker (worker/index.js /admin/*); market data: the site's daily.json.gz (daily history up to the
// last D1 update) plus today's HF m1_live file for today's bar.
//
// Env: W365_API (Worker URL), ADMIN_TOKEN, SITE_URL, HF_REPO_ID, HF_TOKEN, LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN.
// FORCE=1 runs outside 13:00-13:30 / on a day already done (testing). DRY_RUN=1 writes nothing and sends nothing.
import { gunzipSync } from 'node:zlib';
import { JsonStore, appendLog } from '../src/storage.js';
import { LineNotifier } from '../src/line.js';
import { DailyIndex, dailyBarsFromMinutes } from '../src/dailyIndex.js';
import { applyDailyClose } from '../src/signalEngine.js';
import { BarCollector, listHfM1Dates, readParquetInto } from '../src/history.js';
import { taipeiDate } from '../src/ruleState.js';
import { seriesFromDailyJson } from '../web/dailyData.js';

const API = String(process.env.W365_API || '').replace(/\/$/, '');
const SITE = String(process.env.SITE_URL || 'https://watch365.just1stock.com').replace(/\/$/, '');
const FORCE = process.env.FORCE === '1', DRY = process.env.DRY_RUN === '1';
if (!API || !process.env.ADMIN_TOKEN) throw new Error('W365_API and ADMIN_TOKEN are required');

const headers = { Authorization:`Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type':'application/json' };
async function call(path, init = {}) {
  const response = await fetch(API + path, { ...init, headers });
  if (!response.ok) throw new Error(`${init.method || 'GET'} ${path}: HTTP ${response.status}`);
  return response.json();
}
// JsonStore document backend over the Worker's admin API.
const backend = {
  read:async (key) => (await call(`/admin/doc/${encodeURIComponent(key)}`)).value,
  write:async (key, value) => { if (DRY) return; await call(`/admin/doc/${encodeURIComponent(key)}`, { method:'PUT', body:JSON.stringify({ value }) }); }
};

const now = new Date(), today = taipeiDate(now);
const taipei = new Date(now.getTime() + 8 * 3_600_000), minutes = taipei.getUTCHours() * 60 + taipei.getUTCMinutes();
if (!FORCE && (taipei.getUTCDay() === 0 || taipei.getUTCDay() === 6 || minutes < 13 * 60 || minutes > 13 * 60 + 40)) { console.log(`not 13:00-13:40 on a weekday (${taipei.toISOString().slice(11, 16)} Taipei), nothing to do`); process.exit(0); }

const shared = new JsonStore(null, { backend, key:'state' }); await shared.load();
const owners = (await call('/admin/monitors')).owners;
const stores = [];
for (const owner of owners) { const store = new JsonStore(null, { backend, key:`monitor:${owner}` }); await store.load(); store.owner = owner; stores.push(store); }
const due = stores.filter((store) => { const state = store.getState(); return state.settings.enabled && state.settings.strategy?.executor === 'daily_close' && state.settings.daily?.filters?.length && (FORCE || state.runtime.dailyClose?.day !== today); });
console.log(`${owners.length} monitors, ${due.length} D1 monitors due for ${today}`);
if (!due.length) process.exit(0);

// Daily history (site file) and today's minute bars.
const fetchJson = async (path, gz = false) => { const response = await fetch(`${SITE}${path}`, { cache:'no-store' }); if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`); const buffer = Buffer.from(await response.arrayBuffer()); return JSON.parse((gz ? gunzipSync(buffer) : buffer).toString('utf8')); };
const [dailyJson, universeJson] = await Promise.all([fetchJson('/data/daily.json.gz', true), fetchJson('/data/universe.json')]);
const series = seriesFromDailyJson(dailyJson);
const universe = universeJson.universe.items.flatMap((item) => { const meta = universeJson.master[item.symbol]; return meta && ['TWSE', 'TPEx'].includes(meta[1]) ? [{ symbol:item.symbol, name:meta[0] || item.name || item.symbol, market:meta[1] }] : []; });
const symbols = new Set([...universe.map((item) => item.symbol), ...due.flatMap((store) => store.getState().settings.watchlist.map((item) => item.symbol))]);
const files = await listHfM1Dates();
const todayFile = files.find((file) => file.date === today);
const line = new LineNotifier({ store:shared, ownerOf:(id) => shared.getState().accounts?.owners?.[id] || id });

if (!todayFile) {
  console.log(`no m1_live file for ${today}: no session today`);
  for (const store of due) await store.update((state) => { state.runtime.lastRunAt = now.toISOString(); state.runtime.lastProviderStatus = 'daily_no_session'; state.runtime.dailyClose = { day:today, noSession:true, count:0 }; });
  process.exit(0);
}
const collector = new BarCollector(symbols);
await readParquetInto(todayFile.path, collector, { maxAgeSeconds:0 });
const minuteDay = collector.days.get(today);
if (!minuteDay?.size) throw new Error(`m1_live ${today} has no bars for the universe`);
// Volume scale: the latest day both sources have (yesterday's minute file vs. yesterday's daily bar).
const lastDaily = dailyJson.dates.at(-1), overlap = files.filter((file) => file.date <= lastDaily).at(-1);
let overlapDay = null;
if (overlap) { const previous = new BarCollector(symbols); await readParquetInto(overlap.path, previous, { maxAgeSeconds:0 }).catch(() => {}); overlapDay = previous.days.get(overlap.date) ?? null; }
const bars = dailyBarsFromMinutes(minuteDay, today, { series, overlapDate:overlap?.date ?? null, overlapDay });
console.log(`daily history ${dailyJson.dates[0]} … ${lastDaily} (${series.size} stocks), today's bars ${bars.size}`);

const index = new DailyIndex(); index.setSeries(series);
const checks = new Map();
let sentTotal = 0;
for (const store of due) {
  const settings = store.getState().settings;
  const conditions = settings.daily.filters.map(({ key, ast }) => ({ key, ast }));
  try {
    if (settings.scopeMode === 'universe') await store.update((state) => { state.settings.watchlist = universe; });
    const stocks = store.getState().settings.watchlist.map((item) => item.symbol);
    const checkKey = `${conditions.map((item) => item.key).sort().join(',')}|${[...stocks].sort().join(',')}`;
    if (!checks.has(checkKey)) { index.ensure(conditions); checks.set(checkKey, { date:today, ...index.closeCheck(conditions.map((item) => item.key), bars, new Set(stocks)) }); }
    const result = checks.get(checkKey);
    let applied;
    await store.update((state) => {
      applied = applyDailyClose(state, result, state.settings.strategy, now);
      Object.assign(state.runtime, { lastRunAt:now.toISOString(), lastError:null, lastProviderStatus:'ok', dailyClose:{ day:today, count:applied.signals.length, met:result.met.length } });
      appendLog(state, 'info', `13:00 日 K 判斷：新符合 ${applied.signals.length} 檔（共符合 ${result.met.length} 檔）`, { source:'github-actions' });
    });
    let outcome = { sent:0 };
    if (applied.signals.length && !DRY) {
      outcome = await line.notifySignals(applied.signals, { owner:store.owner });
      const ids = new Set(applied.signals.map((signal) => signal.id));
      await store.update((state) => { for (const item of state.notifications) if (ids.has(item.signalId)) item.line = outcome.sent ? 'sent' : 'failed'; if (line.usersOf(store.owner).length) appendLog(state, outcome.sent ? 'info' : 'warn', outcome.sent ? `LINE 通知已送出（${applied.signals.length} 檔）` : 'LINE 通知送出失敗', { error:outcome.error ?? null }); });
    }
    sentTotal += outcome.sent || 0;
    console.log(`${store.owner.slice(0, 6)}… ${settings.strategy.name}: met ${result.met.length}, new ${applied.signals.length}, LINE ${outcome.sent || 0}`);
  } catch (error) {
    console.error(`${store.owner.slice(0, 6)}… failed`, error);
    await store.update((state) => { Object.assign(state.runtime, { lastRunAt:now.toISOString(), lastProviderStatus:'error', lastError:error.code || 'DAILY_CLOSE_FAILED' }); }).catch(() => {});
    process.exitCode = 1;
  }
}
console.log(`done: ${due.length} monitors, LINE pushes to ${sentTotal} accounts${DRY ? ' (dry run)' : ''}`);
