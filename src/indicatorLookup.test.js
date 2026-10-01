import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UnknownIndicatorStore, extractIndicatorCandidates, lookupIndicator, normalizeUnknown } from './indicatorLookup.js';
import { planMonitorCondition, unknownIndicatorResult } from './formulaPlanner.js';
import { FormulaLibrary, resolveMonitorCondition } from './formulaLibrary.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';
import { IndicatorRegistry } from './indicatorRegistry.js';

const quiet = { warn() {}, error() {}, info() {} };
const definitionsPromise = new IndicatorRegistry().list();
const wiki = (results, snippet = (title) => `${title} is a technical indicator`) => new Response(JSON.stringify({ query: { search: results.map((title) => ({ title, snippet: snippet(title) })) } }), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchStub = (byLang) => { const calls = []; const fetchImpl = async (url) => { calls.push(url); const lang = /https:\/\/(zh|en)\.wikipedia/.exec(url)[1]; const answer = byLang[lang]; if (answer instanceof Error) throw answer; if (typeof answer === 'function') return answer(url); return answer ?? wiki([]); }; return { fetchImpl, calls }; };
const options = (extra = {}) => ({ cache: new Map(), log: quiet, ...extra });

test('候選抽取：去參數／方向詞取指標名，「MACD 背離」含「MACD divergence」；公式庫字彙與價格字彙全部視為已知', () => {
  const macd = extractIndicatorCandidates('MACD 背離');
  assert.ok(macd.candidates.includes('MACD divergence'), JSON.stringify(macd.candidates));
  assert.equal(macd.candidates[0], 'MACD 背離'); assert.equal(macd.remainder, '背離');
  const engulf = extractIndicatorCandidates('長紅吞噬');
  assert.ok(engulf.candidates.includes('engulfing pattern'), 'unknown words alone are translated too');
  assert.equal(extractIndicatorCandidates('RSI(14) 向上穿越 30').remainder, '', 'numbers, parentheses and direction words leave nothing unknown');
  assert.equal(extractIndicatorCandidates('收盤價向上穿越布林上軌(20,2σ)').remainder, '');
  assert.equal(extractIndicatorCandidates('連三紅').remainder, '', '台股 slang built from colour / numeral words is price action, not an indicator');
  assert.equal(extractIndicatorCandidates('十字星 出現').remainder, '星', 'a single leftover character is too short to look up');
  assert.deepEqual(extractIndicatorCandidates('').candidates, []);
  // Every recipe name is whitelisted vocabulary: none of them should go to the network.
  for (const recipe of FORMULA_RECIPES) { const { remainder } = extractIndicatorCandidates(recipe.name); assert.ok(remainder.length < 2, `${recipe.name} → remainder ${JSON.stringify(remainder)}`); }
  assert.equal(normalizeUnknown('  MACD　背離！ '), 'macd背離');
});

test('lookupIndicator：白名單不打網路；找到→found:true 帶 matched.title；找不到→false；逾時／5xx→null 不擋並 log；快取 24 小時', async () => {
  const whitelisted = fetchStub({});
  const kd = await lookupIndicator('KD 黃金交叉', options({ fetchImpl: whitelisted.fetchImpl }));
  assert.deepEqual([kd.found, kd.skipped, whitelisted.calls.length], [true, 'whitelist', 0]);
  const short = await lookupIndicator('十字星 出現', options({ fetchImpl: whitelisted.fetchImpl }));
  assert.deepEqual([short.found, short.skipped, whitelisted.calls.length], [true, 'too_short', 0]);

  const found = fetchStub({ zh: wiki(['隨機指標']), en: (url) => wiki(/divergence/i.test(url) ? ['MACD'] : [], () => 'Moving average convergence/divergence (MACD) is a <span class="searchmatch">divergence</span> indicator') });
  const divergence = await lookupIndicator('MACD 背離', options({ fetchImpl: found.fetchImpl }));
  assert.equal(divergence.found, true); assert.equal(divergence.matched.title, 'MACD'); assert.equal(divergence.matched.lang, 'en');
  assert.ok(found.calls.some((url) => url.startsWith('https://zh.wikipedia.org/w/api.php?action=query&list=search&')) && found.calls.some((url) => url.startsWith('https://en.wikipedia.org/')), 'zh and en both searched');

  const missing = fetchStub({ zh: wiki(['不相干的條目']), en: wiki(['Something else']) });
  const bogus = await lookupIndicator('神奇飛天指標 上穿 50', options({ fetchImpl: missing.fetchImpl }));
  assert.equal(bogus.found, false); assert.ok(bogus.candidates.length >= 1); assert.equal(bogus.indicatorName, '神奇飛天指標');

  const warnings = [];
  const timeout = fetchStub({ zh: Object.assign(new Error('timeout'), { name: 'TimeoutError' }), en: new Response('oops', { status: 503 }) });
  const unsure = await lookupIndicator('神奇飛天指標 上穿 50', options({ fetchImpl: timeout.fetchImpl, log: { warn: (line) => warnings.push(line) } }));
  assert.equal(unsure.found, null, 'network trouble never blocks'); assert.match(unsure.error, /timeout/); assert.match(unsure.error, /http_503/);
  assert.equal(warnings.length, 1);
  // A real timeout via AbortSignal.timeout is reported the same way.
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout timers are unref'd; keep the loop alive for the real timeout
  try { const slow = await lookupIndicator('神奇飛天指標 上穿 50', options({ timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(signal.reason)); }) })); assert.equal(slow.found, null); assert.match(slow.error, /timeout/); }
  finally { clearTimeout(keepAlive); }
  // One good answer plus one failure still counts as found.
  const partial = fetchStub({ zh: wiki(['神奇飛天指標']), en: new Response('', { status: 500 }) });
  assert.equal((await lookupIndicator('神奇飛天指標 上穿 50', options({ fetchImpl: partial.fetchImpl }))).found, true);

  // Cache: a second identical request answers without fetching; null results are not cached; TTL is 24 h.
  const cache = new Map(); let now = 1_000_000;
  const counted = fetchStub({ zh: wiki(['不相干']), en: wiki([]) });
  await lookupIndicator('神奇飛天指標', options({ cache, fetchImpl: counted.fetchImpl, now: () => now }));
  const callsAfterFirst = counted.calls.length;
  const second = await lookupIndicator('神奇飛天指標', options({ cache, fetchImpl: counted.fetchImpl, now: () => now }));
  assert.equal(second.cached, true); assert.equal(counted.calls.length, callsAfterFirst);
  now += 24 * 60 * 60 * 1000 + 1;
  await lookupIndicator('神奇飛天指標', options({ cache, fetchImpl: counted.fetchImpl, now: () => now }));
  assert.equal(counted.calls.length, callsAfterFirst * 2, 'expired entry is re-fetched');
});

test('UnknownIndicatorStore：upsert 累計 count／更新 lastSeen、依 norm 去重、持久化後可重讀', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unknown-'));
  try {
    const filePath = join(dir, 'unknown-indicators.json');
    const store = await new UnknownIndicatorStore(filePath, { log: quiet }).load();
    const first = await store.record({ text: '神奇飛天指標 上穿 50', candidates: ['神奇飛天指標'] });
    const second = await store.record({ text: '神奇飛天指標 上穿 60', candidates: ['神奇飛天指標'] });
    assert.equal(first.count, 1); assert.equal(second.count, 2); assert.equal(second.norm, '神奇飛天指標');
    await new Promise((resolve) => setTimeout(resolve, 5)); // distinct lastSeen
    await store.record({ text: '另一個', candidates: [] });
    assert.equal(store.count(), 2);
    const listed = store.list({ limit: 1 }); assert.equal(listed.length, 1); assert.equal(listed[0].norm, '另一個', 'most recent first');
    const raw = JSON.parse(await readFile(filePath, 'utf8')); assert.equal(raw.version, 1); assert.equal(raw.items.length, 2);
    const reloaded = await new UnknownIndicatorStore(filePath, { log: quiet }).load();
    assert.deepEqual(reloaded.list().map((item) => [item.norm, item.count]), [['另一個', 1], ['神奇飛天指標', 2]]);
    assert.deepEqual(Object.keys(reloaded.list()[1]).sort(), ['candidates', 'count', 'firstSeen', 'lastSeen', 'norm', 'text']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('關卡順序：公式庫命中不查核；查核 found:false → unknown_indicator（不叫 AI）；found:true 把 canonicalName 附進 AI 訊息；null 照常交給 AI；籌碼類略過查核', async () => {
  const definitions = await definitionsPromise;
  const env = { INDICATOR_AGENT_PROVIDER: 'groq', INDICATOR_AGENT_MODEL: 'test', GROQ_API_KEY: 'k' };
  const dir = await mkdtemp(join(tmpdir(), 'lookup-library-'));
  try {
    const library = await new FormulaLibrary(join(dir, 'formula-library.json'), { log: quiet }).load();
    let lookups = 0; let aiCalls = 0; let lastUser = null;
    const fetchImpl = async (_url, init) => { aiCalls += 1; lastUser = JSON.parse(init.body).messages.at(-1).content; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const node = (id, op, extra = {}) => ({ id, op, field: null, value: null, period: null, inputId: null, leftId: null, rightId: null, itemIds: null, ...extra });
    const plan = { status: 'formula', message: '', name: '收盤上穿 SMA 20', timeframe: '1m', indicatorId: null, version: null, params: { period: null, threshold: null }, nodes: [node('n1', 'source', { field: 'close' }), node('n2', 'sma', { inputId: 'n1', period: 20 }), node('n3', 'crosses_above', { leftId: 'n1', rightId: 'n2' })], rootId: 'n3' };
    // 1. Library hit: no lookup, no AI.
    const hit = await resolveMonitorCondition('KD黃金交叉', definitions, { library, env, fetchImpl, lookupImpl: async () => { lookups += 1; return { found: false, candidates: ['x'] }; } });
    assert.equal(hit.status, 'formula'); assert.equal(hit.library, true); assert.equal(lookups, 0); assert.equal(aiCalls, 0);
    // 2. Unknown indicator: blocked before any model call, HTTP-200 shaped result with candidates.
    const blocked = await resolveMonitorCondition('神奇飛天指標 上穿 50', definitions, { library, env, fetchImpl, lookupImpl: async (text) => { lookups += 1; assert.equal(text, '神奇飛天指標 上穿 50'); return { found: false, candidates: ['神奇飛天指標', 'magic flying indicator'], indicatorName: '神奇飛天指標' }; } });
    assert.equal(blocked.status, 'unknown_indicator'); assert.equal(lookups, 1); assert.equal(aiCalls, 0);
    assert.deepEqual(blocked.lookup, { candidates: ['神奇飛天指標', 'magic flying indicator'], indicatorName: '神奇飛天指標' });
    assert.match(blocked.message, /神奇飛天指標/); assert.deepEqual(blocked.provider, { provider: 'rules', model: 'lookup' });
    assert.equal(unknownIndicatorResult({ candidates: [] }).lookup.indicatorName, '這個');
    // 3. Found: the model gets { request, canonicalName }.
    const found = await planMonitorCondition('自訂波動指標 上穿 50', definitions, { env, fetchImpl, lookupImpl: async () => ({ found: true, candidates: ['自訂波動指標'], matched: { lang: 'zh', candidate: '自訂波動指標', title: '波動率指標' } }) });
    assert.equal(found.status, 'formula'); assert.equal(aiCalls, 1);
    assert.deepEqual(JSON.parse(lastUser), { request: '自訂波動指標 上穿 50', canonicalName: '波動率指標' });
    // 4. Reference unavailable (null) or lookup throwing: plain request goes to the model.
    await planMonitorCondition('自訂波動指標 上穿 50', definitions, { env, fetchImpl, lookupImpl: async () => ({ found: null, candidates: ['自訂波動指標'], error: 'zh:timeout' }) });
    assert.equal(lastUser, '自訂波動指標 上穿 50');
    const warn = console.warn; console.warn = () => {};
    try { await planMonitorCondition('自訂波動指標 上穿 50', definitions, { env, fetchImpl, lookupImpl: async () => { throw new Error('boom'); } }); } finally { console.warn = warn; }
    assert.equal(lastUser, '自訂波動指標 上穿 50'); assert.equal(aiCalls, 3);
    // 5. Hard-limit wording (籌碼／法人) is a data question, answered by the model's discussion, not a lookup.
    lookups = 0;
    await planMonitorCondition('外資買超 且 籌碼集中', definitions, { env, fetchImpl, lookupImpl: async () => { lookups += 1; return { found: false, candidates: ['外資買超'] }; } });
    assert.equal(lookups, 0); assert.equal(aiCalls, 4);
    // 6. Follow-up replies (context) skip the lookup too.
    await planMonitorCondition('神奇飛天指標', definitions, { env, fetchImpl, context: [{ request: '神奇飛天指標', response: '哪個參數？' }], lookupImpl: async () => { lookups += 1; return { found: false, candidates: [] }; } }).catch(() => {});
    assert.equal(lookups, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
