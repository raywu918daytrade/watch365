import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { formatCapabilityReport, probeCapabilities } from './capabilityProbe.js';
import { fromCumulativeVolume, isTwSymbol, mapProviderSymbol, toTaipeiTradingDate } from './marketBar.js';
import { evaluateMarketBar, parseWatchlist, providerFailureDecision } from './rules.js';
import { JsonStore } from './storage.js';
import { buildSystemUniverseItems, downloadHfAsset, hfAssetPaths, readHfAssetVersion } from './hfAdapter.js';
import { mergeWatchlists, resolveWatchlistInput, tokenizeWatchlist } from './watchlist.js';
import { calculateUniverseCoverage } from './universeCoverage.js';
import { applyMonitorScope, buildMonitorScope, filterBarsToMonitorScope, markMonitorScopeUnknown, notificationEligibility, signalMatchesCurrentStrategy } from './monitorScope.js';
import { applyScopedMarketBars } from './signalEngine.js';
import { evaluateIndicatorBar, sma, wilderRsi } from './indicatorEngine.js';
import { IndicatorRegistry, legacyStrategy, strategyIdentity, validateDefinition, validateFormulaStrategy, validateStrategy } from './indicatorRegistry.js';
import { AGENT_OUTPUT_SCHEMA, analyzeIndicatorRequest, indicatorAgentStatus, validateAgentOutput, validateAgentProposal } from './indicatorAgent.js';
import { loadProjectEnv } from './env.js';
import { IndicatorRequestStore, validateIndicatorRequest } from './indicatorRequests.js';
import { evaluateFormula, evaluateFormulaSeries, issueFormulaToken, validateFormula, verifyFormulaToken } from './formulaEngine.js';
import { planMonitorCondition, validatePlan } from './formulaPlanner.js';

test('輸入解析支援換行、逗號、空格並去重且保留原始錯誤', () => {
  const parsed = tokenizeWatchlist('2330, 2454\n6488 2330\nBAD');
  assert.deepEqual(parsed.symbols.map((item) => item.symbol), ['2330', '2454', '6488']);
  assert.deepEqual(parsed.duplicates, [{ raw: '2330', symbol: '2330' }]);
  assert.deepEqual(parsed.invalid, [{ raw: 'BAD', reasonCode: 'SYMBOL_FORMAT_INVALID' }]);
});

test('HF ticker metadata 自動帶入名稱與 TWSE/TPEx，查無資料才需修正', () => {
  const metadata = new Map([
    ['2330', { name: '台積電', market: 'TWSE', supported: true }],
    ['6488', { name: '環球晶', market: 'TPEx', supported: true }]
  ]);
  const result = resolveWatchlistInput('2330 6488 9999', metadata);
  assert.deepEqual(result.valid, [
    { symbol: '2330', name: '台積電', market: 'TWSE', supported: true },
    { symbol: '6488', name: '環球晶', market: 'TPEx', supported: true }
  ]);
  assert.deepEqual(result.needsCorrection, [{ raw: '9999', symbol: '9999', reasonCode: 'MARKET_UNCONFIRMED' }]);
});

test('有效項目可直接合併，重複不新增，部分錯誤不阻擋', () => {
  const resolved = resolveWatchlistInput('2330 6488 BAD', new Map([
    ['2330', { name: '台積電', market: 'TWSE', supported: true }],
    ['6488', { name: '環球晶', market: 'TPEx', supported: true }]
  ]));
  const merged = mergeWatchlists([{ symbol: '2330', name: '台積電', market: 'TWSE' }], resolved.valid);
  assert.deepEqual(merged.watchlist.map((item) => item.symbol), ['2330', '6488']);
  assert.equal(merged.addedCount, 1);
  assert.equal(merged.existingCount, 1);
  assert.equal(resolved.invalid[0].raw, 'BAD');
});

test('設定 parser 可明確允許空清單，但預設仍拒絕', () => {
  assert.throws(() => parseWatchlist([]), { code: 'WATCHLIST_REQUIRED' });
  assert.deepEqual(parseWatchlist([], { allowEmpty: true }), []);
});

test('台股代號保持字串，2330 TWSE 與 6488 TPEx 市場 metadata 可保存', () => {
  assert.equal(isTwSymbol('0050'), true);
  assert.equal(isTwSymbol('2330.TW'), false);
  assert.equal(isTwSymbol('123'), false);
  assert.deepEqual(mapProviderSymbol('0050', { market: 'TWSE' }), { symbol: '0050', providerSymbol: '0050', market: 'TWSE' });
  assert.deepEqual(parseWatchlist([
    { symbol: '2330', name: '台積電', market: 'TWSE' },
    { symbol: '6488', name: '環球晶', market: 'TPEx' }
  ]), [
    { symbol: '2330', name: '台積電', market: 'TWSE' },
    { symbol: '6488', name: '環球晶', market: 'TPEx' }
  ]);
});

test('watchlist 缺 market 或非法 market 一律拒絕', () => {
  assert.throws(() => parseWatchlist([{ symbol: '6488', name: '環球晶' }]), { code: 'WATCHLIST_MARKET_REQUIRED' });
  assert.throws(() => parseWatchlist([{ symbol: '6488', name: '環球晶', market: 'OTC' }]), { code: 'WATCHLIST_MARKET_INVALID' });
});

test('6488 TPEx 可跨 JsonStore 保存回讀，既有合法市場保持不變', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-watchlist-'));
  const path = join(dir, 'state.json');
  const store = new JsonStore(path);
  await store.load();
  await store.update((state) => {
    state.settings.watchlist = parseWatchlist([
      { symbol: '2330', name: '台積電', market: 'TWSE' },
      { symbol: '6488', name: '環球晶', market: 'TPEx' }
    ]);
  });
  const restarted = new JsonStore(path);
  await restarted.load();
  assert.deepEqual(restarted.getState().settings.watchlist.map(({ symbol, market }) => ({ symbol, market })), [
    { symbol: '2330', market: 'TWSE' },
    { symbol: '6488', market: 'TPEx' }
  ]);
  await rm(dir, { recursive: true });
});

test('JsonStore 寫入失敗時不會把未持久化設定留在記憶體', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch365-transaction-'));const path=join(dir,'state.json');
  class FailingStore extends JsonStore{fail=false;async save(state){if(this.fail)throw new Error('disk failed');return super.save(state);}}
  const store=new FailingStore(path);await store.load();const before=structuredClone(store.getState().settings);store.fail=true;
  await assert.rejects(()=>store.update((state)=>{state.settings.enabled=true;state.settings.formulaActivationId='proposal-test';}),/disk failed/);
  assert.deepEqual(store.getState().settings,before);const unchanged=new JsonStore(path);await unchanged.load();assert.deepEqual(unchanged.getState().settings,before);store.fail=false;await store.update((state)=>{state.settings.enabled=true;});assert.equal(store.getState().settings.enabled,true);const restarted=new JsonStore(path);await restarted.load();assert.equal(restarted.getState().settings.enabled,true);await rm(dir,{recursive:true,force:true});
});

test('JsonStore 並行更新會序列化且失敗後可重試，不遺失先完成欄位', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch365-queue-'));const path=join(dir,'state.json');const store=new JsonStore(path);await store.load();
  await Promise.all([store.update(async(state)=>{await new Promise((resolve)=>setTimeout(resolve,20));state.settings.enabled=true;}),store.update((state)=>{state.settings.pollIntervalSeconds=123;})]);
  assert.equal(store.getState().settings.enabled,true);assert.equal(store.getState().settings.pollIntervalSeconds,123);
  const restarted=new JsonStore(path);await restarted.load();assert.equal(restarted.getState().settings.enabled,true);assert.equal(restarted.getState().settings.pollIntervalSeconds,123);
  await rm(dir,{recursive:true,force:true});
});

test('migration 保留缺 market 項目並標記需要補正', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-migration-'));
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ settings: { watchlist: [{ symbol: '6488', name: '環球晶' }] } }));
  const store = new JsonStore(path);
  await store.load();
  assert.deepEqual(store.getState().settings.watchlist[0], { symbol: '6488', name: '環球晶', market: null, needsMarketCorrection: true });
  assert.equal(store.getState().settings.monitorTask.onboardingCompleted, true);
  assert.equal(store.getState().settings.monitorTask.name, '台股突破量能監控');
  assert.equal(store.getState().settings.strategy.id, 'legacy.breakout-volume');
  assert.equal(store.getState().settings.strategy.version, '1.0.0');
  await rm(dir, { recursive: true });
});

test('全新狀態從 onboarding Step 1 開始', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-new-state-'));
  const store = new JsonStore(join(dir, 'state.json'));
  await store.load();
  assert.equal(store.getState().settings.watchlist.length, 0);
  assert.equal(store.getState().settings.monitorTask.onboardingCompleted, false);
  await rm(dir, { recursive: true });
});

test('Asia/Taipei tradingDate 不受執行主機時區影響', () => {
  assert.equal(toTaipeiTradingDate('2026-09-24T16:30:00.000Z'), '2026-09-25');
  assert.deepEqual(hfAssetPaths('2026-09-24T16:30:00.000Z'), {
    tradingDate: '2026-09-25',
    d1: 'db/d1/2026_09.parquet',
    m1Live: 'db/m1_live/2026-09-25.parquet'
  });
});

test('capability probe 永不輸出設定值', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-cap-'));
  const secret = 'DO_NOT_LEAK_THIS_SECRET';
  const path = join(dir, '.env');
  await writeFile(path, `HF_REPO_ID=private-dataset\nHF_TOKEN=${secret}\n`);
  const report = formatCapabilityReport(await probeCapabilities([path]));
  assert.match(report, /HF_TOKEN: available/);
  assert.match(report, /HF_REPO_ID: available/);
  assert.equal(report.includes(secret), false);
  assert.equal(report.includes('private-dataset'), false);
  await rm(dir, { recursive: true });
});

test('HF adapter 使用 cache，並將 404/授權錯誤轉成不洩密錯誤碼', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-hf-'));
  const config = { repoId: 'SECRET_REPO', token: 'SECRET_TOKEN' };
  let calls = 0;
  const okay = async () => { calls += 1; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); };
  const first = await downloadHfAsset('db/m1_live/2026-09-25.parquet', { cacheRoot: dir, config, fetchImpl: okay });
  const second = await downloadHfAsset('db/m1_live/2026-09-25.parquet', { cacheRoot: dir, config, fetchImpl: okay });
  assert.equal(first.cacheStatus, 'miss');
  assert.equal(second.cacheStatus, 'hit');
  assert.equal(calls, 1);
  for (const [status, code] of [[404, 'HF_ASSET_NOT_FOUND'], [401, 'HF_UNAUTHORIZED']]) {
    await assert.rejects(
      downloadHfAsset(`missing-${status}`, { cacheRoot: dir, config, fetchImpl: async () => new Response('', { status }) }),
      (error) => error.code === code && !error.message.includes(config.repoId) && !error.message.includes(config.token)
    );
  }
  await rm(dir, { recursive: true });
});

test('系統監控名單去重並以 ticker master 補名稱，缺名稱仍保留合法股票', () => {
  const items = buildSystemUniverseItems([
    { stock_id:'2330' }, { stock_id:'6488' }, { stock_id:'2330' }, { stock_id:'BAD' }, { stock_id:'9999' }
  ], new Map([['2330',{ name:'台積電' }],['6488',{ name:'環球晶' }]]), new Map([['2330','半導體業']]));
  assert.deepEqual(items, [
    { symbol:'2330', name:'台積電', group:'半導體業' },
    { symbol:'6488', name:'環球晶', group:null },
    { symbol:'9999', name:null, group:null }
  ]);
});

test('客戶選股 10 檔與系統名單交集 6 檔，保留原順序與完整客戶名單', () => {
  const watchlist=Array.from({length:10},(_,index)=>({symbol:String(1000+index),name:`股票${index}`,market:index%2?'TPEx':'TWSE'}));
  const universe=watchlist.slice(2,8).map(({symbol})=>({symbol,name:null}));
  const result=calculateUniverseCoverage(watchlist,universe);
  assert.deepEqual(result.counts,{selected:10,covered:6,uncovered:4});
  assert.deepEqual(result.items.map((item)=>item.symbol),watchlist.map((item)=>item.symbol));
  assert.deepEqual(result.items.filter((item)=>item.coverage==='covered').map((item)=>item.symbol),watchlist.slice(2,8).map((item)=>item.symbol));
});

test('系統名單換版會重算交集，零交集、全交集與空選擇皆正確', () => {
  const selected=[{symbol:'2330',name:'台積電',market:'TWSE'},{symbol:'6488',name:'環球晶',market:'TPEx'}];
  assert.deepEqual(calculateUniverseCoverage(selected,[]).counts,{selected:2,covered:0,uncovered:2});
  assert.deepEqual(calculateUniverseCoverage(selected,selected).counts,{selected:2,covered:2,uncovered:0});
  assert.deepEqual(calculateUniverseCoverage(selected,[{symbol:'6488'}]).items.map(({symbol,coverage})=>({symbol,coverage})),[{symbol:'2330',coverage:'uncovered'},{symbol:'6488',coverage:'covered'}]);
  assert.deepEqual(calculateUniverseCoverage([],selected).counts,{selected:0,covered:0,uncovered:0});
});

test('有效集合未變不因 revision 更新重置暖機；移出再加入只清 bars 且保留 cooldown', () => {
  const watchlist=[{symbol:'2330',name:'台積電',market:'TWSE'}];
  const state={runtime:{coverageRevision:'rev-1',effectiveWatchlist:['2330'],coverageInterrupted:false},sessions:{'2330':{tradingDate:'2026-09-25',bars:[{barEnd:'x',high:1,volume:1}],lastSignalAt:'2026-09-25T01:00:00Z'}}};
  applyMonitorScope(state,buildMonitorScope(watchlist,{sourceRevision:'rev-2',updatedDate:'2026-09-25',items:[{symbol:'2330'}]}));
  assert.equal(state.sessions['2330'].bars.length,1);
  applyMonitorScope(state,buildMonitorScope(watchlist,{sourceRevision:'rev-3',updatedDate:'2026-09-25',items:[]}));
  applyMonitorScope(state,buildMonitorScope(watchlist,{sourceRevision:'rev-4',updatedDate:'2026-09-25',items:[{symbol:'2330'}]}));
  assert.deepEqual(state.sessions['2330'],{tradingDate:'2026-09-25',bars:[],lastSignalAt:'2026-09-25T01:00:00Z'});
});

test('範圍未知恢復會清暖機資料但保留 lastSignalAt，排隊通知重新確認選股與涵蓋', () => {
  const state={settings:{enabled:true,watchlist:[{symbol:'2330'}]},runtime:{effectiveWatchlist:['2330']},sessions:{'2330':{tradingDate:'2026-09-25',bars:[1,2,3],lastSignalAt:'2026-09-25T01:00:00Z'}},signals:[{id:'sig-1',symbol:'2330'}]};
  markMonitorScopeUnknown(state,'HF_DOWN');
  applyMonitorScope(state,buildMonitorScope([{symbol:'2330',name:'台積電',market:'TWSE'}],{sourceRevision:'rev-2',updatedDate:'2026-09-25',items:[{symbol:'2330'}]}));
  assert.deepEqual(state.sessions['2330'],{tradingDate:'2026-09-25',bars:[],lastSignalAt:'2026-09-25T01:00:00Z'});
  assert.deepEqual(notificationEligibility(state,{status:'pending',signalId:'sig-1'},{items:[{symbol:'2330'}]}),{deliver:true,reason:null});
  assert.equal(notificationEligibility(state,{status:'pending',signalId:'sig-1'},{items:[]}).reason,'not_covered');
  state.settings.watchlist=[];
  assert.equal(notificationEligibility(state,{status:'pending',signalId:'sig-1'},{items:[{symbol:'2330'}]}).reason,'not_selected');
  state.settings.watchlist=[{symbol:'2330'}]; state.settings.enabled=false;
  assert.deepEqual(notificationEligibility(state,{status:'pending',signalId:'sig-1'},{items:[{symbol:'2330'}]}),{deliver:false,reason:'monitor_paused'});
});

test('通知策略身份包含版本、週期、參數與 fingerprint；舊 signal 僅相容 legacy', () => {
  const base={id:'sma.cross',version:'1.0.0',executor:'sma_cross',name:'SMA',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:'fp-v1',params:{period:10},activatedAt:'2026-09-25T00:00:00Z'};
  const state={settings:{strategy:base}};
  assert.equal(signalMatchesCurrentStrategy(state,{strategy:structuredClone(base)}),true);
  assert.equal(signalMatchesCurrentStrategy(state,{strategy:{...base,params:{period:20}}}),false);
  assert.equal(signalMatchesCurrentStrategy(state,{strategy:{...base,version:'2.0.0'}}),false);
  assert.equal(signalMatchesCurrentStrategy(state,{strategy:{...base,definitionFingerprint:'fp-mutated'}}),false);
  assert.equal(signalMatchesCurrentStrategy(state,{}),false);
  assert.equal(signalMatchesCurrentStrategy({settings:{strategy:legacyStrategy()}},{}),true);
});

test('引擎同輪只接收交集內行情，交集外即使有資料也不進規則判定', () => {
  const scope=buildMonitorScope([
    {symbol:'2330',name:'台積電',market:'TWSE'},
    {symbol:'6488',name:'環球晶',market:'TPEx'}
  ],{sourceRevision:'rev',updatedDate:'2026-09-25',items:[{symbol:'2330'}]});
  const filtered=filterBarsToMonitorScope([{symbol:'2330',high:1},{symbol:'6488',high:999}],scope);
  assert.deepEqual(filtered,[{symbol:'2330',high:1}]);
});

test('同批涵蓋與未涵蓋股票都滿足條件時，只為涵蓋股票建立 signal 與 notification', () => {
  const state=warmState(); state.sessions['6488']=structuredClone(state.sessions['2330']);
  Object.assign(state,{settings:{enabled:true,watchlist:[{symbol:'2330',name:'台積電',market:'TWSE'},{symbol:'6488',name:'環球晶',market:'TPEx'}],notification:{channel:'browser',target:'本機瀏覽器'}},runtime:{},quotes:[],decisions:[],signals:[],notifications:[]});
  const scope=buildMonitorScope(state.settings.watchlist,{sourceRevision:'rev',updatedDate:'2026-09-25',items:[{symbol:'2330'}]});
  const result=applyScopedMarketBars(state,[bar(5,{high:105,volume:200}),{...bar(5,{high:105,volume:200}),symbol:'6488',market:'TPEx'}],scope,'test',new Date(at(5)));
  assert.deepEqual(result.signals.map((item)=>item.symbol),['2330']);
  assert.equal(state.notifications.length,1); assert.equal(state.notifications[0].signalId,state.signals[0].id);
  assert.equal(result.decisions.some((item)=>item.symbol==='6488'),false);
});

test('等待行情期間移除股票或暫停後，提交階段不建立舊設定訊號', () => {
  const base=warmState(); Object.assign(base,{settings:{enabled:true,watchlist:[{symbol:'2330',name:'台積電',market:'TWSE'}],notification:{channel:'browser',target:'本機瀏覽器'}},runtime:{},quotes:[],decisions:[],signals:[],notifications:[]});
  const scope=buildMonitorScope(base.settings.watchlist,{sourceRevision:'rev',updatedDate:'2026-09-25',items:[{symbol:'2330'}]});
  const removed=structuredClone(base); removed.settings.watchlist=[];
  assert.equal(applyScopedMarketBars(removed,[bar(5,{high:105,volume:200})],scope,'test',new Date(at(5))).signals.length,0);
  const paused=structuredClone(base); paused.settings.enabled=false;
  const pausedResult=applyScopedMarketBars(paused,[bar(5,{high:105,volume:200})],scope,'test',new Date(at(5)));
  assert.equal(pausedResult.skipped,true); assert.equal(paused.signals.length,0); assert.equal(paused.notifications.length,0);
});

test('系統名單版本讀取只回傳提交時間與不可變 revision，不洩漏設定', async () => {
  const config={repoId:'SECRET_REPO',token:'SECRET_TOKEN'};
  const fetchImpl=async()=>new Response(JSON.stringify([{path:'db/tickers/tick_universe.parquet',lastCommit:{date:'2026-09-25T10:45:23.000Z',id:'immutable-revision'}}]),{status:200,headers:{'content-type':'application/json'}});
  const version=await readHfAssetVersion('db/tickers/tick_universe.parquet',{config,fetchImpl});
  assert.deepEqual(version,{updatedAt:'2026-09-25T10:45:23.000Z',revision:'immutable-revision'});
  assert.equal(JSON.stringify(version).includes(config.repoId),false);
  assert.equal(JSON.stringify(version).includes(config.token),false);
});

test('前高相等不觸發，超過才觸發；baseline 100 時 199 不成立、200 成立', () => {
  const equalState = warmState();
  assert.equal(evaluateMarketBar(equalState, bar(5, { high: 104, volume: 200 }), at(5)).reasonCode, 'high_not_broken');
  const lowVolume = warmState();
  assert.equal(evaluateMarketBar(lowVolume, bar(5, { high: 105, volume: 199 }), at(5)).reasonCode, 'volume_below_threshold');
  const exact = warmState();
  const decision = evaluateMarketBar(exact, bar(5, { high: 105, volume: 200 }), at(5));
  assert.equal(decision.triggered, true);
  assert.equal(decision.baseline, 100);
  assert.equal(decision.referenceHigh, 104);
});

test('warm-up 至少 5 根，且當前 bar 不進 referenceHigh 或 baseline', () => {
  const state = emptyState();
  for (let i = 0; i < 5; i += 1) assert.equal(evaluateMarketBar(state, bar(i, { high: 100 + i, volume: 100 }), at(i)).reasonCode, 'warmup');
  const decision = evaluateMarketBar(state, bar(5, { high: 999, volume: 200 }), at(5));
  assert.equal(decision.referenceHigh, 104);
  assert.equal(decision.baseline, 100);
  assert.equal(decision.triggered, true);
});

test('30 分鐘冷卻邊界：29:59 阻擋，30:00 放行', () => {
  const blocked = warmState();
  blocked.sessions['2330'].lastSignalAt = '2026-09-25T00:36:01.000Z';
  assert.equal(evaluateMarketBar(blocked, bar(5, { high: 105, volume: 200 }), '2026-09-25T01:06:00.000Z').reasonCode, 'cooldown');
  const allowed = warmState();
  allowed.sessions['2330'].lastSignalAt = '2026-09-25T00:36:00.000Z';
  assert.equal(evaluateMarketBar(allowed, bar(5, { high: 105, volume: 200 }), '2026-09-25T01:06:00.000Z').triggered, true);
});

test('去重鍵跨 JsonStore 重啟仍有效', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'watch365-state-'));
  const path = join(dir, 'state.json');
  const first = new JsonStore(path);
  await first.load();
  first.getState().sessions = warmState().sessions;
  const target = bar(5, { high: 105, volume: 200 });
  assert.equal(evaluateMarketBar(first.getState(), target, at(5)).triggered, true);
  await first.save();
  const restarted = new JsonStore(path);
  await restarted.load();
  restarted.getState().sessions['2330'].bars.pop();
  assert.equal(evaluateMarketBar(restarted.getState(), target, at(5)).reasonCode, 'duplicate');
  await rm(dir, { recursive: true });
});

test('新交易日重置 session', () => {
  const state = warmState();
  const next = bar(0, { tradingDate: '2026-09-28', start: '2026-09-28T01:00:00.000Z', high: 999, volume: 999 });
  assert.equal(evaluateMarketBar(state, next, '2026-09-28T01:01:00.000Z').reasonCode, 'warmup');
  assert.equal(state.sessions['2330'].bars.length, 1);
});

test('stale 120 秒可判斷，121 秒拒絕', () => {
  assert.notEqual(evaluateMarketBar(warmState(), bar(5), '2026-09-25T01:08:00.000Z').reasonCode, 'stale');
  assert.equal(evaluateMarketBar(warmState(), bar(5), '2026-09-25T01:08:01.000Z').reasonCode, 'stale');
});

test('out-of-order、gap 與累積量 reset 有明確 reason code', () => {
  assert.equal(evaluateMarketBar(warmState(), bar(3), at(5)).reasonCode, 'out_of_order');
  assert.equal(evaluateMarketBar(warmState(), bar(8), at(8)).reasonCode, 'data_gap');
  assert.deepEqual(fromCumulativeVolume(900, 1000), { valid: false, reasonCode: 'volume_reset' });
});

test('provider down decision 不清空既有狀態也不產生訊號', () => {
  const state = warmState();
  const before = structuredClone(state);
  const decision = providerFailureDecision('ECONNRESET');
  assert.equal(decision.reasonCode, 'provider_down');
  assert.equal(decision.triggered, false);
  assert.deepEqual(state, before);
});

test('SMA 與 Wilder RSI 對照獨立參考值，常數 RSI 明確為 50', () => {
  assert.equal(sma([1,2,3,4],3),3);
  const reference=[44.34,44.09,44.15,43.61,44.33,44.83,45.1,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46,46.03,46.41,46.22,45.64];
  assert.deepEqual(wilderRsi(reference,14).filter((value)=>value!=null),[70.46,66.25,66.48,69.35,66.29,57.92]);
  assert.deepEqual(wilderRsi([5,5,5,5,5],3).filter((value)=>value!=null),[50,50]);
  assert.deepEqual(wilderRsi([10,10,10,10],2),[null,null,50,50]);
  assert.deepEqual(wilderRsi([10,10,10,10,11],2),[null,null,50,50,100]);
});

test('RSI 平盤後上漲可由 50 上穿門檻，append 不改寫既有 prefix', () => {
  const strategy={id:'rsi.cross',version:'1.0.0',executor:'rsi_wilder_cross',name:'RSI 上穿門檻',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',params:{period:2,threshold:70},activatedAt:'2026-09-25T00:00:00.000Z'};
  const state={indicatorSessions:{},dedupe:{}};
  const results=[10,10,10,10,11].map((close,index)=>evaluateIndicatorBar(state,strategy,bar(index,{close,open:10,high:11,low:9}),at(index),{allowSignal:true}));
  assert.equal(results[3].currentValue,50);
  assert.equal(results[4].previousValue,50);
  assert.equal(results[4].currentValue,100);
  assert.equal(results[4].reasonCode,'triggered');
});

test('SMA 上穿只在前後兩個有效值成立時觸發，持續高於不重複', () => {
  const strategy={id:'sma.cross',version:'1.0.0',executor:'sma_cross',name:'價格上穿 SMA',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',params:{period:3},activatedAt:'2026-09-25T00:00:00.000Z'};
  const state={indicatorSessions:{},dedupe:{}};
  const closes=[3,2,1,4,5];
  const results=closes.map((close,index)=>evaluateIndicatorBar(state,strategy,bar(index,{close,high:Math.max(close,3),low:Math.min(close,1)}),at(index),{allowSignal:true}));
  assert.deepEqual(results.map((item)=>item.reasonCode),['warmup','warmup','warmup','triggered','not_crossed']);
});

test('首次歷史載入只建基線，未完成 bar 不判斷，gap 後重新暖機且保留 cooldown', () => {
  const strategy={id:'sma.cross',version:'1.0.0',executor:'sma_cross',name:'價格上穿 SMA',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',params:{period:3},activatedAt:'2026-09-25T01:04:30.000Z'};
  const state={indicatorSessions:{},dedupe:{}};
  const results=[3,2,1,4].map((close,index)=>evaluateIndicatorBar(state,strategy,bar(index,{close,high:4,low:1}),at(index),{allowSignal:index===3}));
  assert.equal(results.at(-1).reasonCode,'baseline_only');
  const incomplete=bar(4,{close:5,high:5,low:1}); incomplete.complete=false;
  assert.equal(evaluateIndicatorBar(state,strategy,incomplete,at(4),{allowSignal:true}).reasonCode,'bar_incomplete');
  const key=strategyIdentity(strategy); state.indicatorSessions[key]['2330'].lastSignalAt='2026-09-25T00:59:00.000Z';
  const gapBar=bar(8,{close:6,high:6,low:1});
  assert.equal(evaluateIndicatorBar(state,strategy,gapBar,at(8),{allowSignal:true}).reasonCode,'data_gap');
  assert.equal(state.indicatorSessions[key]['2330'].bars.length,1);
  assert.equal(state.indicatorSessions[key]['2330'].lastSignalAt,'2026-09-25T00:59:00.000Z');
});

test('registry 可在運行中讀到新增版本，拒絕未知 executor 與非法參數', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch365-registry-'));
  const base={id:'sma.cross',version:'1.0.0',name:'SMA',description:'test',executor:'sma_cross',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',warmupBars:3,params:[{key:'period',label:'期數',type:'integer',min:2,max:200,default:3}],condition:{operator:'crosses_above',left:'close',right:'sma'}};
  await writeFile(join(dir,'sma-v1.json'),JSON.stringify(base));
  const registry=new IndicatorRegistry(dir,join(dir,'lock.json'));
  assert.equal((await registry.list()).length,1);
  await writeFile(join(dir,'sma-v2.json'),JSON.stringify({...base,version:'2.0.0'}));
  assert.deepEqual((await registry.list()).map((item)=>item.version),['1.0.0','2.0.0']);
  await writeFile(join(dir,'sma-v2.json'),JSON.stringify({...base,version:'2.0.0',name:'mutated'}));
  const isolated=await registry.load(); assert.deepEqual(isolated.items.map((item)=>item.version),['1.0.0']); assert.equal(isolated.errors[0].code,'INDICATOR_VERSION_MUTATED');
  await writeFile(join(dir,'bad.json'),'{broken'); assert.equal((await registry.list()).length,1);
  assert.throws(()=>validateDefinition({...base,executor:'uploaded_javascript'}),/INDICATOR_EXECUTOR_NOT_ALLOWED/);
  assert.throws(()=>validateDefinition({...base,condition:{operator:'crosses_below'}}),/INDICATOR_EXECUTOR_SCHEMA_INVALID/);
  assert.throws(()=>validateStrategy({id:base.id,version:base.version,params:{period:1}},validateDefinition(base)),/INDICATOR_PARAM_INVALID/);
  await rm(dir,{recursive:true,force:true});
});

test('Agent 必須明確設定 provider/model，不因主機有 Anthropic key 自動啟用', () => {
  assert.deepEqual(indicatorAgentStatus({ANTHROPIC_API_KEY:'present-but-not-authorized'}),{configured:false,provider:null,model:null,reason:'INDICATOR_AGENT_NOT_CONFIGURED'});
  assert.equal(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'anthropic',INDICATOR_AGENT_MODEL:'test-model'}).reason,'INDICATOR_AGENT_KEY_UNAVAILABLE');
  assert.deepEqual(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'anthropic',INDICATOR_AGENT_MODEL:'test-model',ANTHROPIC_API_KEY:'secret'}),{configured:true,provider:'anthropic',model:'test-model',reason:null});
  assert.equal(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'gemini',INDICATOR_AGENT_MODEL:'test-model'}).reason,'INDICATOR_AGENT_KEY_UNAVAILABLE');
  assert.deepEqual(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'gemini',INDICATOR_AGENT_MODEL:'test-model',GEMINI_API_KEY:'secret'}),{configured:true,provider:'gemini',model:'test-model',reason:null});
  assert.equal(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'test-model'}).reason,'INDICATOR_AGENT_KEY_UNAVAILABLE');
  assert.deepEqual(indicatorAgentStatus({INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'test-model',GROQ_API_KEY:'secret'}),{configured:true,provider:'groq',model:'test-model',reason:null});
});

test('專案 env 不覆蓋外部環境，且可載入缺少的設定', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch365-env-')); const path=join(dir,'.env');
  const existing=process.env.WATCH365_ENV_EXISTING; const loaded=process.env.WATCH365_ENV_LOADED;
  try {
    process.env.WATCH365_ENV_EXISTING='external'; delete process.env.WATCH365_ENV_LOADED;
    await writeFile(path,'WATCH365_ENV_EXISTING=file\nWATCH365_ENV_LOADED=from-file\n');
    assert.equal(loadProjectEnv(path),true); assert.equal(process.env.WATCH365_ENV_EXISTING,'external'); assert.equal(process.env.WATCH365_ENV_LOADED,'from-file');
    assert.equal(loadProjectEnv(join(dir,'missing.env')),false);
  } finally {
    if(existing===undefined)delete process.env.WATCH365_ENV_EXISTING;else process.env.WATCH365_ENV_EXISTING=existing;
    if(loaded===undefined)delete process.env.WATCH365_ENV_LOADED;else process.env.WATCH365_ENV_LOADED=loaded;
    await rm(dir,{recursive:true,force:true});
  }
});

test('Gemini adapter 使用官方 structured JSON 契約且不把 key 放進 body', async () => {
  const definitions=await new IndicatorRegistry().list(); let captured;
  const fetchImpl=async(url,options)=>{captured={url,options,body:JSON.parse(options.body)};return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify(agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',params:{period:14,threshold:30}}))}]}}]}),{status:200,headers:{'content-type':'application/json'}});};
  const result=await analyzeIndicatorRequest('一分鐘RSI14上穿30',definitions,{env:{INDICATOR_AGENT_PROVIDER:'gemini',INDICATOR_AGENT_MODEL:'models/gemini-2.5-flash',GEMINI_API_KEY:'not-in-body'},fetchImpl});
  assert.deepEqual(result.proposal.params,{period:14,threshold:30});
  assert.equal(captured.url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(captured.options.headers['x-goog-api-key'],'not-in-body');
  assert.equal(captured.body.generationConfig.responseMimeType,'application/json');
  assert.deepEqual(captured.body.generationConfig.responseJsonSchema,AGENT_OUTPUT_SCHEMA);
  assert.equal(captured.body.generationConfig.thinkingConfig.thinkingBudget,0);
  assert.equal(captured.body.contents[0].parts[0].text,'一分鐘RSI14上穿30');
  assert.equal(JSON.stringify(captured.body).includes('not-in-body'),false);
});

test('Agent 將 provider 401/403 映射為安全且明確的錯誤碼', async () => {
  const definitions=await new IndicatorRegistry().list(); const env={INDICATOR_AGENT_PROVIDER:'gemini',INDICATOR_AGENT_MODEL:'test-model',GEMINI_API_KEY:'secret'};
  await assert.rejects(()=>analyzeIndicatorRequest('一分鐘SMA20價格上穿',definitions,{env,fetchImpl:async()=>new Response('provider secret detail',{status:401})}),{code:'INDICATOR_AGENT_CREDENTIALS_REJECTED',statusCode:502});
  await assert.rejects(()=>analyzeIndicatorRequest('一分鐘SMA20價格上穿',definitions,{env,fetchImpl:async()=>new Response('project denied detail',{status:403})}),{code:'INDICATOR_AGENT_ACCESS_DENIED',statusCode:503});
});

test('Groq adapter 使用 strict structured output 並分離 system/user 訊息', async () => {
  const definitions=await new IndicatorRegistry().list(); let captured;
  const fetchImpl=async(url,options)=>{captured={url,options,body:JSON.parse(options.body)};return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',params:{period:14,threshold:30}}))}}]}),{status:200,headers:{'content-type':'application/json'}});};
  const result=await analyzeIndicatorRequest('一分鐘RSI14上穿30',definitions,{env:{INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'openai/gpt-oss-20b',GROQ_API_KEY:'not-in-body'},fetchImpl});
  assert.deepEqual(result.proposal.params,{period:14,threshold:30});
  assert.equal(captured.url,'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(captured.options.headers.authorization,'Bearer not-in-body');
  assert.deepEqual(captured.body.messages.map(({role})=>role),['system','user']);
  assert.match(captured.body.messages[0].content,/clarificationQuestion\/unsupportedReason 必須設為空字串，絕不能設為 null/);
  assert.match(captured.body.messages[0].content,/未提到的週期或方向一律標為 unknown；other 只用於使用者明確要求/);
  assert.match(captured.body.messages[0].content,/「我要RSI」應回 status=clarification/);
  assert.match(captured.body.messages[0].content,/必須使用繁體中文/);
  assert.equal(captured.body.messages[1].content,'一分鐘RSI14上穿30');
  assert.equal(captured.body.response_format.json_schema.strict,true);
  assert.deepEqual(captured.body.response_format.json_schema.schema,AGENT_OUTPUT_SCHEMA);
  assert.match(AGENT_OUTPUT_SCHEMA.properties.clarificationQuestion.description,/Never null/);
  assert.equal(captured.body.reasoning_effort,'low'); assert.equal(captured.body.temperature,0); assert.equal(captured.body.max_completion_tokens,1200);
  assert.equal(JSON.stringify(captured.body).includes('not-in-body'),false);
});

test('Agent schema 契約可解析 SMA20 與 RSI14/30，且傳輸只含文字與精簡 registry', async () => {
  const definitions=await new IndicatorRegistry().list(); const requests=[];
  const fetchImpl=async(_url,options)=>{requests.push(JSON.parse(options.body));const text=JSON.parse(options.body).messages[0].content;const output=text.includes('RSI')?agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',params:{period:14,threshold:30}}):agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:20,threshold:null}});return new Response(JSON.stringify({content:[{type:'tool_use',name:'submit_indicator_request',input:output}]}),{status:200,headers:{'content-type':'application/json'}});};
  const options={env:{INDICATOR_AGENT_PROVIDER:'anthropic',INDICATOR_AGENT_MODEL:'contract-model',ANTHROPIC_API_KEY:'not-logged'},fetchImpl};
  const smaResult=await analyzeIndicatorRequest('一分鐘SMA20價格上穿',definitions,options); const rsiResult=await analyzeIndicatorRequest('一分鐘RSI14上穿30',definitions,options);
  assert.deepEqual(smaResult.proposal.params,{period:20}); assert.deepEqual(rsiResult.proposal.params,{period:14,threshold:30});
  assert.equal(requests.every((body)=>body.model==='contract-model'&&body.tools[0].strict===true),true);
  assert.equal(JSON.stringify(requests).includes('not-logged'),false);
  assert.equal(JSON.stringify(requests).includes('watchlist'),false);
  assert.equal(requests.every((body)=>body.messages[0].content.startsWith('一分鐘')&&!body.messages[0].content.includes('Registry:')),true);
});

test('Agent 含糊需求要求確認；D1、下穿、未知指標與越界輸出不會偷換', async () => {
  const definitions=await new IndicatorRegistry().list();
  const clarification=validateAgentOutput(agentOutput({status:'clarification',indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:null,threshold:null},clarificationQuestion:'是否使用 SMA 20？'}),definitions);
  assert.equal(clarification.status,'clarification'); assert.equal(clarification.proposal.params.period,20);
  const missing=validateAgentOutput(agentOutput({status:'clarification',indicatorId:null,version:null,timeframe:null,requestedIndicator:'unknown',requestedTimeframe:'unknown',requestedDirection:'unknown',params:{period:null,threshold:null},clarificationQuestion:'想使用哪個指標與週期？'}),definitions); assert.equal(missing.status,'clarification'); assert.equal(missing.proposal,null);
  const d1=validateAgentOutput(agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',requestedTimeframe:'d1',params:{period:14,threshold:30}}),definitions); assert.equal(d1.status,'unsupported'); assert.equal(d1.requestDraft.requestedIndicator,'rsi');
  const down=validateAgentOutput(agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',requestedDirection:'crosses_below',params:{period:14,threshold:30}}),definitions); assert.equal(down.status,'unsupported');
  const macd=validateAgentOutput(agentOutput({status:'unsupported',indicatorId:null,version:null,timeframe:null,requestedIndicator:'other',requestedDirection:'unknown',params:{period:null,threshold:null},unsupportedReason:'MACD 尚未支援'}),definitions); assert.equal(macd.status,'unsupported');
  assert.throws(()=>validateAgentOutput(agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:999,threshold:null}}),definitions),/INDICATOR_AGENT_OUTPUT_INVALID/);
  assert.throws(()=>validateAgentOutput(agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:20,threshold:30}}),definitions),/INDICATOR_AGENT_OUTPUT_INVALID/);
  assert.throws(()=>validateAgentOutput({...agentOutput({}),executor:'eval(userInput)'},definitions),/INDICATOR_AGENT_OUTPUT_INVALID/);
  assert.throws(()=>validateAgentOutput({...agentOutput({}),params:{period:'20',threshold:null}},definitions),/INDICATOR_AGENT_OUTPUT_INVALID/);
  const proposal=validateAgentOutput(agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:20,threshold:null}}),definitions).proposal;
  assert.deepEqual(validateAgentProposal(proposal,definitions),proposal);
  assert.throws(()=>validateAgentProposal({...proposal,definitionFingerprint:'stale'},definitions),/INDICATOR_AGENT_PROPOSAL_STALE/);
  const source=definitions.find((item)=>item.executor==='sma_cross'); const custom={...source,id:'customer.sma',fingerprint:'custom-fp'};
  assert.equal(validateAgentOutput(agentOutput({indicatorId:'customer.sma',requestedIndicator:'sma',params:{period:20,threshold:null}}),[custom]).status,'matched');
});

test('新指標需求驗證、持久化及併發去重不改監控 state', async () => {
  const dir=await mkdtemp(join(tmpdir(),'watch365-indicator-requests-')); const path=join(dir,'requests.json'); const store=new IndicatorRequestStore(path); await store.load();
  const input={sourceText:'請支援 MACD 黃金交叉',indicatorName:'MACD',timeframe:'1m',parameterDescription:'快線 12、慢線 26、訊號線 9',triggerCondition:'MACD 線向上穿越訊號線'};
  const [first,second]=await Promise.all([store.submit(input),store.submit({...input,sourceText:'  請支援   MACD 黃金交叉  '})]);
  assert.equal([first,second].filter((item)=>!item.duplicate).length,1); assert.equal(store.list().length,1); assert.equal(store.list()[0].status,'pending_evaluation');
  const restarted=new IndicatorRequestStore(path); await restarted.load(); assert.equal(restarted.get(first.request.id)?.sourceText,'請支援 MACD 黃金交叉');
  assert.throws(()=>validateIndicatorRequest({...input,timeframe:'unknown'}),{code:'INDICATOR_REQUEST_FIELDS_REQUIRED'});
  assert.throws(()=>validateIndicatorRequest({...input,timeframe:'other',customTimeframe:''}),{code:'INDICATOR_REQUEST_FIELDS_REQUIRED'});
  assert.equal(validateIndicatorRequest({...input,timeframe:'other',customTimeframe:'5 分鐘'}).customTimeframe,'5 分鐘');
  assert.throws(()=>validateIndicatorRequest({...input,sourceText:'短'}),{code:'INDICATOR_REQUEST_TEXT_TOO_SHORT'});
  assert.throws(()=>validateIndicatorRequest({...input,indicatorName:{name:'MACD'}}),{code:'INDICATOR_REQUEST_FIELDS_INVALID'});
  assert.throws(()=>validateIndicatorRequest({...input,adminApproved:true}),{code:'INDICATOR_REQUEST_FIELDS_INVALID'});
  assert.throws(()=>validateIndicatorRequest({...input,parameterDescription:''}),{code:'INDICATOR_REQUEST_FIELDS_REQUIRED'});
  assert.equal(validateIndicatorRequest({...input,parameterDescription:'無參數'}).parameterDescription,'無參數');
  class FailingOnceStore extends IndicatorRequestStore{failNext=false;async save(data){if(this.failNext){this.failNext=false;throw new Error('disk unavailable');}return super.save(data);}}
  const failing=new FailingOnceStore(join(dir,'retry.json'));await failing.load();failing.failNext=true;await assert.rejects(()=>failing.submit(input),/disk unavailable/);assert.equal(failing.list().length,0);assert.equal((await failing.submit(input)).duplicate,false);assert.equal(failing.list().length,1);
  const full=new IndicatorRequestStore(join(dir,'full.json'));await full.load();full.data.requests=Array.from({length:500},(_,index)=>({id:`request-${index}`,status:'pending_evaluation',fingerprint:`fingerprint-${index}`,createdAt:'2026-09-26T00:00:00.000Z'}));await assert.rejects(()=>full.submit({...input,sourceText:'請支援布林通道突破'}),{code:'INDICATOR_REQUEST_LIMIT_REACHED',statusCode:409});assert.equal(full.list().length,500);
  const corruptPath=join(dir,'corrupt.json');await writeFile(corruptPath,JSON.stringify({version:1,requests:[{id:'damaged'}]}));await assert.rejects(()=>new IndicatorRequestStore(corruptPath).load(),{code:'INDICATOR_REQUEST_STORE_INVALID',statusCode:500});
  await rm(dir,{recursive:true,force:true});
});

test('受限公式可計算 EMA/MACD 且暖機、除零、預算與 token fail closed', () => {
  const close={op:'source',field:'close'};const macd={op:'sub',left:{op:'ema',input:close,period:12},right:{op:'ema',input:close,period:26}};const signal={op:'ema',input:macd,period:9};const ast={op:'crosses_above',left:macd,right:signal};
  const validated=validateFormula(ast);assert.equal(validated.warmupBars,35);const bars=Array.from({length:60},(_,index)=>({close:index<50?100:100+(index-49)*4,volume:100}));const result=evaluateFormula(ast,bars);assert.equal(typeof result.triggered,'boolean');
  const noFuture=evaluateFormula(ast,bars.slice(0,-1));assert.notEqual(result.current,undefined);assert.notEqual(noFuture.current,undefined);
  const divide={op:'gte',left:{op:'div',left:close,right:{op:'constant',value:0}},right:{op:'constant',value:1}};assert.throws(()=>validateFormula(divide),/FORMULA_DIVISION_BY_ZERO/);
  assert.throws(()=>validateFormula({op:'gte',left:{op:'div',left:close,right:{op:'sub',left:close,right:structuredClone(close)}},right:{op:'constant',value:1}}),/FORMULA_DIVISION_BY_ZERO/);
  assert.throws(()=>evaluateFormula(ast,Array.from({length:513},()=>({close:1,volume:1}))),/FORMULA_DATA_BUDGET_EXCEEDED/);
  assert.throws(()=>validateFormula({op:'gte',left:{op:'ema',input:{op:'ema',input:{op:'ema',input:close,period:200},period:200},period:200},right:{op:'constant',value:0}}),/FORMULA_WARMUP_EXCEEDS_DATA_BUDGET|FORMULA_WARMUP_EXCEEDS_TRADING_DAY/);
  assert.throws(()=>validateFormula({op:'gte',left:{op:'ema',input:{op:'ema',input:close,period:200},period:100},right:{op:'constant',value:0}}),/FORMULA_WARMUP_EXCEEDS_TRADING_DAY/);
  const proposal={ast,name:'MACD 上穿訊號線',fingerprint:validated.fingerprint};const token=issueFormulaToken(proposal,'server-secret',1000);assert.equal(verifyFormulaToken(token,'server-secret',1100).fingerprint,validated.fingerprint);assert.throws(()=>verifyFormulaToken(token,'wrong-secret',1100),/FORMULA_TOKEN_INVALID/);assert.throws(()=>verifyFormulaToken(token,'server-secret',700000),/FORMULA_PROPOSAL_STALE/);
});

test('公式數值序列使用技術指標庫、追加資料不改前綴，資料中斷後重新暖機', () => {
  const close={op:'source',field:'close'};
  const ema3={op:'ema',input:close,period:3};
  assert.deepEqual(evaluateFormulaSeries(ema3,[1,2,3,4,5].map((value)=>({close:value}))),[null,null,2,3,4]);
  const macd={op:'sub',left:{op:'ema',input:close,period:12},right:{op:'ema',input:close,period:26}};
  const bars=Array.from({length:60},(_,index)=>({close:100+index+(index%7)*0.25,volume:10}));
  const prefix=evaluateFormulaSeries(macd,bars.slice(0,50));
  assert.deepEqual(evaluateFormulaSeries(macd,bars).slice(0,50),prefix);
  const interrupted={op:'ema',input:{op:'div',left:close,right:{op:'source',field:'volume'}},period:3};
  const values=evaluateFormulaSeries(interrupted,[
    {close:3,volume:1},{close:6,volume:1},{close:9,volume:1},{close:12,volume:0},
    {close:15,volume:1},{close:18,volume:1},{close:21,volume:1}
  ]);
  assert.deepEqual(values,[null,null,6,null,null,null,18]);
  assert.equal(values.every((value)=>value===null||Number.isFinite(value)),true);
  assert.deepEqual(evaluateFormula({op:'gte',left:{op:'mul',left:close,right:{op:'constant',value:1e9}},right:{op:'constant',value:0}},[{close:Number.MAX_VALUE,volume:1}]),{previous:null,current:null,triggered:false,errorCode:'formula_calculation_error'});
  assert.deepEqual(evaluateFormula({op:'gte',left:{op:'sma',input:close,period:2},right:{op:'constant',value:0}},[{close:1e308},{close:1e308}]),{previous:null,current:null,triggered:false,errorCode:'formula_calculation_error'});
  assert.equal(evaluateFormula({op:'gte',left:{op:'div',left:close,right:{op:'source',field:'volume'}},right:{op:'constant',value:1}},[{close:10,volume:0}]).errorCode,'formula_calculation_error');
});

test('公式提案 token 逐欄驗證版本、到期、能力版本與指紋', () => {
  const ast={op:'gte',left:{op:'source',field:'close'},right:{op:'constant',value:100}};
  const validated=validateFormula(ast);const secret='server-secret';
  const token=issueFormulaToken({ast,name:'價格至少 100',fingerprint:validated.fingerprint},secret,1000);
  const [encoded,signature]=token.split('.');const payload=JSON.parse(Buffer.from(encoded,'base64url'));
  assert.equal(verifyFormulaToken(token,secret,1001).v,1);
  assert.throws(()=>issueFormulaToken({ast,name:'價格至少 100',fingerprint:'0'.repeat(64)},secret,1000),/FORMULA_PROPOSAL_INVALID/);
  for(const mutation of [{v:2},{exp:'soon'},{capabilityRevision:'formula.v0'},{fingerprint:'bad'},{name:''},{extra:true}]){
    const mutated={...payload,...mutation};const body=Buffer.from(JSON.stringify(mutated)).toString('base64url');
    const resigned=`${body}.${createHmac('sha256',secret).update(body).digest('base64url')}`;
    assert.throws(()=>verifyFormulaToken(resigned,secret,1001),/FORMULA_TOKEN_INVALID|FORMULA_PROPOSAL_STALE/);
  }
  assert.doesNotThrow(()=>verifyFormulaToken(`${encoded}.${signature}`,secret,1001));
});

test('公式策略有不可變身分並沿用暖機、基線、去重與資料預算', () => {
  const ast={op:'crosses_above',left:{op:'source',field:'close'},right:{op:'sma',input:{op:'source',field:'close'},period:3}};
  const validated=validateFormula(ast);
  const strategy=validateFormulaStrategy({id:'formula.custom',version:'formula.v1',executor:'formula_v1',name:'價格上穿三期均線',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:validated.fingerprint,params:{},formula:{ast}},'2026-09-25T00:00:00.000Z');
  assert.equal(strategy.formula.summary,'收盤價 向上穿越 SMA(收盤價, 3)');
  assert.match(strategyIdentity(strategy),new RegExp(validated.fingerprint));
  assert.throws(()=>validateFormulaStrategy({...strategy,definitionFingerprint:'0'.repeat(64)}),/INDICATOR_VERSION_MISMATCH/);
  const state={indicatorSessions:{},dedupe:{}};
  const results=[3,2,1,4,5].map((close,index)=>evaluateIndicatorBar(state,strategy,bar(index,{close,volume:100+index}),at(index),{allowSignal:true}));
  assert.deepEqual(results.map((item)=>item.reasonCode),['warmup','warmup','warmup','triggered','not_crossed']);
  const key=strategyIdentity(strategy);assert.equal(state.indicatorSessions[key]['2330'].bars.at(-1).volume,104);
  state.indicatorSessions[key]['2330'].bars=Array.from({length:512},()=>({barEnd:bar(4).barEnd,close:1,volume:1}));
  assert.equal(evaluateIndicatorBar(state,strategy,bar(5,{close:2}),at(5),{allowSignal:true}).reasonCode,'data_budget_exceeded');
});

test('單一規劃器可分流既有條件、公式、補問與討論，運算圖只能向前引用', async () => {
  const definitions=await new IndicatorRegistry().list();
  const common={message:'',name:'一分鐘 MACD 黃金交叉',timeframe:'1m',indicatorId:null,version:null,params:{period:null,threshold:null}};
  const nodes=[
    {id:'close',op:'source',field:'close',value:null,period:null,inputId:null,leftId:null,rightId:null},
    {id:'fast',op:'ema',field:null,value:null,period:12,inputId:'close',leftId:null,rightId:null},
    {id:'slow',op:'ema',field:null,value:null,period:26,inputId:'close',leftId:null,rightId:null},
    {id:'macd',op:'sub',field:null,value:null,period:null,inputId:null,leftId:'fast',rightId:'slow'},
    {id:'signal',op:'ema',field:null,value:null,period:9,inputId:'macd',leftId:null,rightId:null},
    {id:'cross',op:'crosses_above',field:null,value:null,period:null,inputId:null,leftId:'macd',rightId:'signal'}
  ];
  const formula=validatePlan({...common,status:'formula',nodes,rootId:'cross'},definitions);assert.equal(formula.status,'formula');assert.match(formula.formulaSummary,/EMA/);assert.equal(formula.proposal.warmupBars,35);
  const numericIds=nodes.map((node,index)=>({...node,id:String(index+1),inputId:node.inputId?String(nodes.findIndex((item)=>item.id===node.inputId)+1):null,leftId:node.leftId?String(nodes.findIndex((item)=>item.id===node.leftId)+1):null,rightId:node.rightId?String(nodes.findIndex((item)=>item.id===node.rightId)+1):null}));assert.equal(validatePlan({...common,status:'formula',nodes:numericIds,rootId:'6'},definitions).proposal.warmupBars,35);
  const sma=definitions.find((item)=>item.id==='sma.cross');const existing=validatePlan({...common,status:'existing',name:'SMA',indicatorId:sma.id,version:sma.version,params:{period:20,threshold:null},nodes:[],rootId:null},definitions);assert.equal(existing.proposal.params.period,20);
  assert.throws(()=>validatePlan({...common,status:'existing',name:'SMA',indicatorId:sma.id,version:sma.version,params:{period:20,threshold:30},nodes:[],rootId:null},definitions),/FORMULA_PLAN_INVALID/);
  assert.equal(validatePlan({...common,status:'clarification',message:'請問要向上還是向下穿越？',timeframe:null,nodes:[],rootId:null},definitions).status,'clarification');
  assert.equal(validatePlan({...common,status:'discussion',message:'目前只有一分鐘完整K。',nodes:[],rootId:null},definitions).status,'discussion');
  const invalid=structuredClone(nodes);invalid[1].inputId='signal';assert.throws(()=>validatePlan({...common,status:'formula',nodes:invalid,rootId:'cross'},definitions),/FORMULA_PLAN_INVALID/);
  const stray=structuredClone(nodes);stray[0].value=1;assert.throws(()=>validatePlan({...common,status:'formula',nodes:stray,rootId:'cross'},definitions),/FORMULA_PLAN_INVALID/);
});

test('規劃器補問會把受限對話前文連同本次回答交給同一次規劃', async () => {
  const definitions=await new IndicatorRegistry().list();let captured;
  const output={status:'clarification',indicatorId:null,version:null,timeframe:null,params:{period:null,threshold:null},requestedIndicator:'rsi',requestedTimeframe:'1m',requestedDirection:'crosses_above',clarificationQuestion:'請補充上穿門檻。',unsupportedReason:''};
  const fetchImpl=async(_url,options)=>{captured=JSON.parse(options.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{status:200,headers:{'content-type':'application/json'}});};
  await planMonitorCondition('30',definitions,{context:[{request:'一分鐘 RSI 14 上穿',response:'請補充上穿門檻。'}],env:{INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'test',GROQ_API_KEY:'secret'},fetchImpl});
  const payload=JSON.parse(captured.messages[1].content);assert.equal(payload.currentReply,'30');assert.equal(payload.previousConversation[0].request,'一分鐘 RSI 14 上穿');
});

test('registry-first 修復固定 RSI 根因、單次分流、補問 context 與公式 fallback', async () => {
  const definitions=await new IndicatorRegistry().list();
  const badRsiFormula={status:'formula',message:'RSI 14 上穿 30',name:'RSI 上穿 30',timeframe:'1m',indicatorId:null,version:null,params:{period:14,threshold:30},nodes:[
    {id:'close',op:'source',field:'close',value:null,period:null,inputId:null,leftId:null,rightId:null},
    {id:'sma14',op:'sma',field:null,value:null,period:14,inputId:'close',leftId:null,rightId:null},
    {id:'cross',op:'crosses_above',field:null,value:null,period:null,inputId:null,leftId:'close',rightId:'sma14'}
  ],rootId:'cross'};
  assert.throws(()=>validatePlan(badRsiFormula,definitions),/FORMULA_PLAN_INVALID/);

  const env={INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'fixture',GROQ_API_KEY:'secret'};
  for(const fixture of [
    {text:'一分鐘 RSI 14 上穿 30',output:agentOutput({indicatorId:'rsi.cross',requestedIndicator:'rsi',params:{period:14,threshold:30}}),id:'rsi.cross'},
    {text:'一分鐘價格上穿 SMA 20',output:agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:20,threshold:null}}),id:'sma.cross'}
  ]){
    let calls=0;const fetchImpl=async()=>{calls++;return groqResponse(fixture.output);};
    const result=await planMonitorCondition(fixture.text,definitions,{env,fetchImpl});assert.equal(result.status,'existing');assert.equal(result.proposal.id,fixture.id);assert.equal(calls,1);
  }

  let clarificationBody,calls=0;const clarificationOutput=agentOutput({status:'clarification',indicatorId:null,version:null,timeframe:null,requestedIndicator:'rsi',requestedTimeframe:'1m',requestedDirection:'crosses_above',params:{period:null,threshold:null},clarificationQuestion:'請補充上穿門檻。'});
  const clarification=await planMonitorCondition('30',definitions,{context:[{request:'一分鐘 RSI 14 上穿',response:'請補充上穿門檻。'}],env,fetchImpl:async(_url,options)=>{calls++;clarificationBody=JSON.parse(options.body);return groqResponse(clarificationOutput);}});
  assert.equal(clarification.status,'clarification');assert.equal(clarification.proposal,undefined);assert.equal(calls,1);const conversation=JSON.parse(clarificationBody.messages[1].content);assert.equal(conversation.currentReply,'30');assert.equal(conversation.previousConversation[0].request,'一分鐘 RSI 14 上穿');

  calls=0;const formulaNodes=[{id:'close',op:'source',field:'close',value:null,period:null,inputId:null,leftId:null,rightId:null},{id:'ema3',op:'ema',field:null,value:null,period:3,inputId:'close',leftId:null,rightId:null},{id:'cross',op:'crosses_above',field:null,value:null,period:null,inputId:null,leftId:'close',rightId:'ema3'}];
  const unsupported=agentOutput({status:'unsupported',indicatorId:null,version:null,timeframe:null,requestedIndicator:'other',requestedTimeframe:'1m',requestedDirection:'crosses_above',params:{period:null,threshold:null},unsupportedReason:'需要公式規劃'});
  const formulaOutput={status:'formula',message:'',name:'價格上穿 EMA3',timeframe:'1m',indicatorId:null,version:null,params:{period:null,threshold:null},nodes:formulaNodes,rootId:'cross'};
  const formula=await planMonitorCondition('一分鐘價格上穿 EMA 3',definitions,{env,fetchImpl:async()=>groqResponse(++calls===1?unsupported:formulaOutput)});assert.equal(formula.status,'formula');assert.equal(calls,2);

  calls=0;const smaBelow=agentOutput({status:'unsupported',indicatorId:'sma.cross',requestedIndicator:'sma',requestedTimeframe:'1m',requestedDirection:'crosses_below',params:{period:20,threshold:null},unsupportedReason:'registry 僅提供上穿'});const deterministic=await planMonitorCondition('一分鐘收盤價下穿 SMA 20',definitions,{env,fetchImpl:async()=>{calls++;return groqResponse(smaBelow);}});assert.equal(deterministic.status,'formula');assert.match(deterministic.formulaSummary,/向下穿越 SMA/);assert.equal(deterministic.proposal.warmupBars,21);assert.equal(calls,1);
  calls=0;const missingSmaPeriod=agentOutput({status:'unsupported',indicatorId:'sma.cross',requestedIndicator:'sma',requestedTimeframe:'1m',requestedDirection:'crosses_below',params:{period:null,threshold:null},unsupportedReason:'缺少期數'});const missingResult=await planMonitorCondition('一分鐘收盤價下穿 SMA',definitions,{env,fetchImpl:async()=>{calls++;return groqResponse(missingSmaPeriod);}});assert.equal(missingResult.status,'discussion');assert.equal(calls,1);

  for(const firstPass of [
    agentOutput({status:'unsupported',indicatorId:'rsi.cross',requestedIndicator:'rsi',requestedTimeframe:'1m',requestedDirection:'crosses_below',params:{period:14,threshold:30},unsupportedReason:'RSI 下穿目前不支援'}),
    agentOutput({status:'unsupported',indicatorId:'sma.cross',requestedIndicator:'sma',requestedTimeframe:'d1',requestedDirection:'crosses_above',params:{period:20,threshold:null},unsupportedReason:'日線目前不支援'})
  ]){calls=0;const result=await planMonitorCondition('不支援的 registry 條件',definitions,{env,fetchImpl:async()=>{calls++;return groqResponse(firstPass);}});assert.equal(result.status,'discussion');assert.equal(calls,1);}

  calls=0;const smuggledExisting={status:'existing',message:'',name:'SMA',timeframe:'1m',indicatorId:'sma.cross',version:'1.0.0',params:{period:20,threshold:null},nodes:[],rootId:null};
  await assert.rejects(()=>planMonitorCondition('自訂條件',definitions,{env,fetchImpl:async()=>groqResponse(++calls===1?unsupported:smuggledExisting)}),/FORMULA_PLAN_INVALID/);assert.equal(calls,2);

  calls=0;await assert.rejects(()=>planMonitorCondition('一分鐘價格上穿 SMA 20',definitions,{env,fetchImpl:async()=>{calls++;return groqResponse({...agentOutput({indicatorId:'sma.cross',requestedIndicator:'sma',params:{period:20,threshold:null}}),executor:'eval'});}}),/INDICATOR_AGENT_OUTPUT_INVALID/);assert.equal(calls,1);
});

function groqResponse(output){return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)}}]}),{status:200,headers:{'content-type':'application/json'}});}

function emptyState() { return { sessions: {}, dedupe: {} }; }
function warmState() {
  const state = emptyState();
  for (let i = 0; i < 5; i += 1) evaluateMarketBar(state, bar(i, { high: 100 + i, volume: 100 }), at(i));
  return state;
}
function at(minute) { return new Date(Date.parse('2026-09-25T01:01:00.000Z') + minute * 60_000).toISOString(); }
function bar(minute, overrides = {}) {
  const start = new Date(Date.parse('2026-09-25T01:00:00.000Z') + minute * 60_000);
  if (overrides.start) start.setTime(Date.parse(overrides.start));
  const end = new Date(start.getTime() + 60_000);
  return { symbol: '2330', market: 'TWSE', provider: 'fixture', timeframe: '1m', tradingDate: overrides.tradingDate || '2026-09-25', barStart: start.toISOString(), barEnd: end.toISOString(), open: overrides.open ?? 100, high: overrides.high ?? 100, low: overrides.low ?? 99, close: overrides.close ?? 100, volume: overrides.volume ?? 100, complete: true, providerEventAt: end.toISOString(), receivedAt: end.toISOString() };
}

function agentOutput(overrides={}){return{status:'matched',indicatorId:'sma.cross',version:'1.0.0',timeframe:'1m',params:{period:20,threshold:null},requestedIndicator:'sma',requestedTimeframe:'1m',requestedDirection:'crosses_above',clarificationQuestion:'',unsupportedReason:'',...overrides};}
