import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMULA_PLAN_SCHEMA, buildPlannerSystem, normalizePlan, planMonitorCondition, validatePlan } from './formulaPlanner.js';
import { indicatorAgentStatus, normalizeAgentOutput, parseFallbacks, requestStructuredAgent, schemaHint, validateAgentOutput } from './indicatorAgent.js';
import { IndicatorRegistry } from './indicatorRegistry.js';

// Sloppy nodes the way gpt-oss writes them: only the keys that carry a value, numbers sometimes as strings.
const n = (id, op, extra = {}) => ({ id, op, ...extra });
const full = (id, op, extra = {}) => ({ id, op, field:null, value:null, period:null, inputId:null, leftId:null, rightId:null, itemIds:null, ...extra });
const definitionsPromise = new IndicatorRegistry().list();
const chat = (output) => new Response(JSON.stringify({ choices:[{ message:{ content:typeof output === 'string' ? output : JSON.stringify(output) } }] }), { status:200, headers:{ 'content-type':'application/json' } });
const gemini = (output) => new Response(JSON.stringify({ candidates:[{ content:{ parts:[{ text:JSON.stringify(output) }] } }] }), { status:200, headers:{ 'content-type':'application/json' } });
const tooMany = (seconds) => new Response(JSON.stringify({ error:{ message:`Rate limit reached. Please try again in ${seconds}s.` } }), { status:429, headers:{ 'content-type':'application/json' } });
const quiet = async (fn) => { const warn = console.warn, error = console.error; const lines = []; console.warn = (...args) => lines.push(args.join(' ')); console.error = () => {}; try { return { result:await fn(), lines }; } finally { console.warn = warn; console.error = error; } };

test('normalizePlan 補齊缺欄位、刪未知欄位、轉數字字串並依 status 清掉不該有的欄位', () => {
  const sloppy = normalizePlan({ status:'formula', name:'收盤上穿 SMA 20', params:{ period:'20', threshold:3 }, extra:'drop me', nodes:[n('n1', 'source', { field:'close' }), n('n2', 'sma', { inputId:'n1', period:'20', bogus:1 }), n('n3', 'crosses_above', { leftId:'n1', rightId:'n2', itemIds:['n1', 'n2'] })] });
  assert.deepEqual(Object.keys(sloppy).sort(), Object.keys(FORMULA_PLAN_SCHEMA.properties).sort());
  assert.equal(sloppy.message, ''); assert.equal(sloppy.timeframe, '1m'); assert.equal(sloppy.indicatorId, null); assert.equal(sloppy.version, null);
  assert.deepEqual(sloppy.params, { period:null, threshold:null }, 'formula forces params to null');
  assert.deepEqual(sloppy.nodes[0], full('n1', 'source', { field:'close' }));
  assert.deepEqual(sloppy.nodes[1], full('n2', 'sma', { inputId:'n1', period:20 }), 'numeric string period becomes a number, unknown key dropped');
  assert.equal(sloppy.nodes[2].itemIds, null, 'itemIds cleared on a non-all/any node');
  assert.equal(sloppy.rootId, 'n3', 'rootId inferred as the last boolean node');
  // all/any keep itemIds and lose leftId/rightId; the last boolean node wins even when a later arithmetic node follows.
  const logic = normalizePlan({ status:'formula', name:'x', nodes:[n('a', 'source', { field:'close' }), n('b', 'source', { field:'open' }), n('c', 'gt', { leftId:'a', rightId:'b' }), n('d', 'lt', { leftId:'a', rightId:'b' }), n('e', 'all', { itemIds:['c', 'd'], leftId:'c' }), n('f', 'add', { leftId:'a', rightId:'b' })] });
  assert.deepEqual(logic.nodes[4], full('e', 'all', { itemIds:['c', 'd'] })); assert.equal(logic.rootId, 'e');
  // discussion / clarification: nodes cleared, rootId null; existing: nodes cleared but params kept as numbers.
  const discussion = normalizePlan({ status:'discussion', message:'需要當日累計。可改用：收盤 vs sma(close,20)。', nodes:[n('n1', 'source', { field:'close' })], rootId:'n1', indicatorId:'x' });
  assert.deepEqual(discussion.nodes, []); assert.equal(discussion.rootId, null); assert.equal(discussion.indicatorId, null);
  assert.deepEqual(normalizePlan({ status:'clarification', message:'哪個指標？', nodes:[{}], rootId:'n1' }).nodes, []);
  const existing = normalizePlan({ status:'existing', indicatorId:'sma.cross', version:'1.0.0', params:{ period:'20' }, nodes:[n('n1', 'source', { field:'close' })], rootId:'n1' });
  assert.deepEqual(existing.params, { period:20, threshold:null }); assert.deepEqual(existing.nodes, []); assert.equal(existing.rootId, null);
  // Non-objects and numeric ids pass through sensibly.
  assert.equal(normalizePlan(null), null); assert.equal(normalizePlan('x'), 'x');
  assert.equal(normalizePlan({ status:'formula', nodes:[n(1, 'source', { field:'close' }), n(2, 'sma', { inputId:1, period:5 })] }).nodes[1].inputId, '1');
  // An explicit rootId is kept, and a formula with no boolean node gets none (validator then names the problem).
  assert.equal(normalizePlan({ status:'formula', rootId:'n9', nodes:[n('n1', 'source', { field:'close' })] }).rootId, 'n9');
  assert.equal(normalizePlan({ status:'formula', nodes:[n('n1', 'source', { field:'close' })] }).rootId, null);
});

test('QA 失敗句的模型輸出（省略 null 欄位、params 填數字）經正規化後通過 validatePlan', async () => {
  const definitions = await definitionsPromise;
  const run = (raw) => validatePlan(normalizePlan(raw), definitions);
  // 跌幅超過 3%：close ≤ prev(close,1) × 0.97
  const drop = run({ status:'formula', message:'', name:'跌幅超過 3%（相對前 1 根）', timeframe:'1m', params:{ period:1, threshold:3 }, nodes:[n('n1', 'source', { field:'close' }), n('n2', 'prev', { inputId:'n1', period:'1' }), n('n3', 'constant', { value:'0.97' }), n('n4', 'mul', { leftId:'n2', rightId:'n3' }), n('n5', 'lte', { leftId:'n1', rightId:'n4' })] });
  assert.equal(drop.status, 'formula'); assert.equal(drop.proposal.ast.op, 'lte'); assert.equal(drop.proposal.ast.right.right.value, 0.97); assert.equal(drop.proposal.warmupBars, 2);
  // 乖離率大於 3%：(close − sma20) ÷ sma20 > 0.03
  const bias = run({ status:'formula', name:'乖離率 SMA20 大於 3%', params:{ period:20, threshold:0.03 }, nodes:[n('c', 'source', { field:'close' }), n('ma', 'sma', { inputId:'c', period:20 }), n('diff', 'sub', { leftId:'c', rightId:'ma' }), n('ratio', 'div', { leftId:'diff', rightId:'ma' }), n('k', 'constant', { value:0.03 }), n('gt1', 'gt', { leftId:'ratio', rightId:'k' })] });
  assert.equal(bias.status, 'formula'); assert.equal(bias.proposal.ast.op, 'gt'); assert.equal(bias.proposal.ast.left.op, 'div'); assert.equal(bias.proposal.warmupBars, 20);
  // 收盤站上 SMA5 且 SMA5 > SMA20：all(crosses_above, gt), itemIds given, rootId omitted
  const stack = run({ status:'formula', name:'收盤上穿 SMA5 且 SMA5 大於 SMA20', params:{ period:5, threshold:20 }, nodes:[n('c', 'source', { field:'close' }), n('s5', 'sma', { inputId:'c', period:5 }), n('s20', 'sma', { inputId:'c', period:20 }), n('x', 'crosses_above', { leftId:'c', rightId:'s5' }), n('g', 'gt', { leftId:'s5', rightId:'s20' }), n('both', 'all', { itemIds:['x', 'g'] })] });
  assert.equal(stack.status, 'formula'); assert.equal(stack.proposal.ast.op, 'all'); assert.equal(stack.proposal.ast.items.length, 2); assert.equal(stack.proposal.warmupBars, 20);
  // 連續三根紅K：all(close>open, prev(close,1)>prev(open,1), prev(close,2)>prev(open,2))
  const reds = run({ status:'formula', name:'連續三根紅K', params:{ period:3, threshold:null }, nodes:[n('c', 'source', { field:'close' }), n('o', 'source', { field:'open' }), n('r0', 'gt', { leftId:'c', rightId:'o' }), n('c1', 'prev', { inputId:'c', period:1 }), n('o1', 'prev', { inputId:'o', period:1 }), n('r1', 'gt', { leftId:'c1', rightId:'o1' }), n('c2', 'prev', { inputId:'c', period:2 }), n('o2', 'prev', { inputId:'o', period:2 }), n('r2', 'gt', { leftId:'c2', rightId:'o2' }), n('all3', 'all', { itemIds:['r0', 'r1', 'r2'] })] });
  assert.equal(reds.status, 'formula'); assert.equal(reds.proposal.ast.items.length, 3); assert.equal(reds.proposal.warmupBars, 3);
  // discussion with nodes attached (the VWAP case) becomes a plain discussion instead of a 422.
  const vwap = run({ status:'discussion', message:'VWAP 需要當日累計，無法表達。可改用：收盤 ≥ sma(close,20)。', name:'VWAP', nodes:[n('n1', 'source', { field:'close' })], rootId:'n1' });
  assert.equal(vwap.status, 'discussion'); assert.match(vwap.message, /可改用/);
});

test('validatePlan 的每個拒絕點都帶具體 detail，code/statusCode 不變', async () => {
  const definitions = await definitionsPromise;
  const common = { status:'formula', message:'', name:'測試條件', timeframe:'1m', indicatorId:null, version:null, params:{ period:null, threshold:null } };
  const reject = (raw, pattern) => { try { validatePlan(raw, definitions); } catch (error) { assert.equal(error.code, 'FORMULA_PLAN_INVALID'); assert.equal(error.statusCode, 422); assert.match(error.detail, pattern); assert.match(error.message, /FORMULA_PLAN_INVALID/); return; } assert.fail(`expected rejection ${pattern}`); };
  const close = full('n1', 'source', { field:'close' });
  reject({ ...common, nodes:[close, full('n4', 'sma', { inputId:'n1' }), full('n5', 'gt', { leftId:'n1', rightId:'n4' })], rootId:'n5' }, /node n4: period required for sma/);
  reject({ ...common, nodes:[close, full('n9', 'sma', { inputId:'n1', period:20 })], rootId:'n9' }, /rootId n9 not boolean/);
  reject({ ...common, nodes:[close, full('n2', 'gt', { leftId:'n1', rightId:'nope' })], rootId:'n2' }, /node n2: rightId 'nope' not defined before use/);
  reject({ ...common, nodes:[close, full('n2', 'gt', { leftId:'n1', rightId:'n1', value:3 })], rootId:'n2' }, /node n2: value must be null for gt/);
  reject({ ...common, nodes:[close, full('n2', 'all', { itemIds:['n1'] })], rootId:'n2' }, /itemIds needs 2\.\.4/);
  reject({ ...common, nodes:[close, full('n2', 'sma', { inputId:'n1', period:200 }), full('n3', 'sma', { inputId:'n2', period:200 }), full('n4', 'gt', { leftId:'n1', rightId:'n3' })], rootId:'n4' }, /formula validation: FORMULA_WARMUP_EXCEEDS_TRADING_DAY/);
  reject({ ...common, nodes:[close], rootId:null }, /rootId required/);
  reject({ ...common, params:{ period:5, threshold:null }, nodes:[close], rootId:'n1' }, /formula params must be null/);
  reject({ ...common, status:'discussion', nodes:[close], rootId:'n1' }, /discussion must have empty nodes/);
  reject({ ...common, nodes:[close, { id:'n2', op:'gt', leftId:'n1', rightId:'n1' }], rootId:'n2' }, /node #2: missing field,value,period,inputId,itemIds/);
  reject({ ...common, nodes:[close, full('n2', 'gt', { leftId:'n1', rightId:'n1' })], rootId:'n2', extra:1 }, /plan: unexpected extra/);
  reject({ ...common, status:'nope', nodes:[], rootId:null }, /status 'nope'/);
  reject({ ...common, status:'existing', indicatorId:'nope', version:'1', nodes:[], rootId:null }, /existing indicator nope@1 not in registry/);
});

test('planMonitorCondition 用 json_object 回覆、正規化後回 formula，被拒時 log 帶 detail', async () => {
  const definitions = await definitionsPromise;
  const env = { INDICATOR_AGENT_PROVIDER:'groq', INDICATOR_AGENT_MODEL:'openai/gpt-oss-20b', GROQ_API_KEY:'secret' };
  let body;
  const sloppy = { status:'formula', name:'跌幅超過 3%（前 1 根）', params:{ period:1, threshold:3 }, nodes:[n('n1', 'source', { field:'close' }), n('n2', 'prev', { inputId:'n1', period:1 }), n('n3', 'constant', { value:0.97 }), n('n4', 'mul', { leftId:'n2', rightId:'n3' }), n('n5', 'lte', { leftId:'n1', rightId:'n4' })] };
  const result = await planMonitorCondition('跌幅超過 3%', definitions, { env, fetchImpl:async (_url, options) => { body = JSON.parse(options.body); return chat('```json\n' + JSON.stringify(sloppy) + '\n```'); } });
  assert.equal(result.status, 'formula'); assert.equal(result.proposal.warmupBars, 2); assert.deepEqual(result.provider, { configured:true, provider:'groq', model:'openai/gpt-oss-20b', reason:null, fallbacks:[] });
  assert.deepEqual(body.response_format, { type:'json_object' }); assert.equal(body.reasoning_effort, 'low'); assert.equal(body.temperature, 0);
  const system = body.messages[0].content;
  assert.match(system, /每個 node 一律輸出 9 個 key/); assert.match(system, /完整範例「收盤上穿 SMA 20」/); assert.match(system, /可改用：/); assert.match(system, /連續N根紅K/); assert.match(system, /乖離率/); assert.match(system, /CCI/); assert.match(system, /VWAP、OBV/);
  assert.ok(system.indexOf('每個 node 一律輸出 9 個 key') < system.indexOf('Registry:'), 'format rules come first');
  assert.match(system, /輸出一個 JSON 物件，欄位：status\(existing\|formula\|clarification\|discussion\)/);
  assert.ok(buildPlannerSystem(definitions).length + schemaHint(FORMULA_PLAN_SCHEMA).length <= 4500, `system too long: ${system.length}`);
  // A still-invalid plan is rejected with the reason in the warning.
  const broken = { status:'formula', name:'缺 period', nodes:[n('n1', 'source', { field:'close' }), n('n2', 'sma', { inputId:'n1' }), n('n3', 'gt', { leftId:'n1', rightId:'n2' })] };
  const { lines } = await quiet(() => assert.rejects(() => planMonitorCondition('自訂條件', definitions, { env, fetchImpl:async () => chat(broken) }), { code:'FORMULA_PLAN_INVALID', statusCode:422, detail:'node n2: period required for sma' }));
  assert.match(lines.join('\n'), /detail=node n2: period required for sma/);
});

test('fallback 鏈：主要 429 → 第二個成功，status 反映實際 provider；全部 429 → RATE_LIMITED 帶最小 retryAfterSeconds', async () => {
  const definitions = await definitionsPromise;
  const env = { INDICATOR_AGENT_PROVIDER:'groq', INDICATOR_AGENT_MODEL:'openai/gpt-oss-20b', GROQ_API_KEY:'primary-key', INDICATOR_AGENT_FALLBACKS:'groq:GROQ_API_KEY_JUST1STOCK:openai/gpt-oss-20b, gemini:GEMINI_API_KEY:gemini-2.5-flash,openrouter:OPENROUTER_API_KEY:openai/gpt-oss-120b:free,bogus:X:y,nokey:', GROQ_API_KEY_JUST1STOCK:'second-key', GEMINI_API_KEY:'gemini-key', INDICATOR_AGENT_TIMEOUT_MS:'2000' };
  assert.deepEqual(parseFallbacks(env), [{ provider:'groq', keyEnv:'GROQ_API_KEY_JUST1STOCK', model:'openai/gpt-oss-20b' }, { provider:'gemini', keyEnv:'GEMINI_API_KEY', model:'gemini-2.5-flash' }, { provider:'openrouter', keyEnv:'OPENROUTER_API_KEY', model:'openai/gpt-oss-120b:free' }]);
  assert.deepEqual(indicatorAgentStatus(env).fallbacks, [{ provider:'groq', model:'openai/gpt-oss-20b', keyConfigured:true }, { provider:'gemini', model:'gemini-2.5-flash', keyConfigured:true }, { provider:'openrouter', model:'openai/gpt-oss-120b:free', keyConfigured:false }]);
  const output = { status:'discussion', message:'可改用：收盤上穿 SMA(20)。', name:'', timeframe:null, indicatorId:null, version:null, params:{ period:null, threshold:null }, nodes:[], rootId:null };
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push({ url, auth:options.headers.authorization || options.headers['x-goog-api-key'] }); if (calls.length === 1) return tooMany(20); if (calls.length === 2) return tooMany(7); return gemini(output); };
  const { result, lines } = await quiet(() => requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl }));
  assert.equal(result.status.provider, 'gemini'); assert.equal(result.status.model, 'gemini-2.5-flash'); assert.equal(result.raw.status, 'discussion');
  assert.deepEqual(calls.map((call) => call.auth), ['Bearer primary-key', 'Bearer second-key', 'gemini-key'], 'no waiting: each 429 moves straight to the next key');
  assert.match(calls[2].url, /generativelanguage/);
  assert.match(lines[0], /groq\/openai\/gpt-oss-20b→groq\/openai\/gpt-oss-20b INDICATOR_AGENT_RATE_LIMITED retryAfter=20s/);
  assert.match(lines[1], /groq\/openai\/gpt-oss-20b→gemini\/gemini-2.5-flash INDICATOR_AGENT_RATE_LIMITED retryAfter=7s/);
  // The planner surfaces the fallback provider to the UI.
  const planned = await quiet(() => planMonitorCondition('自訂條件', definitions, { env, fetchImpl:async (url) => (/groq/.test(url) ? tooMany(3) : gemini(output)) }));
  assert.equal(planned.result.status, 'discussion'); assert.equal(planned.result.provider.provider, 'gemini');
  // All rate limited: RATE_LIMITED with the smallest wait, three attempts, no sleeping.
  const started = Date.now(); let attempts = 0;
  await quiet(() => assert.rejects(() => requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl:async () => tooMany([30, 4, 9][attempts++]) }), { code:'INDICATOR_AGENT_RATE_LIMITED', statusCode:429, retryAfterSeconds:4 }));
  assert.equal(attempts, 3); assert.ok(Date.now() - started < 1000);
  // Mixed failures without any 429 throw the last error; a 400 on the primary moves on too, and the retry-once per provider still applies.
  attempts = 0;
  await quiet(() => assert.rejects(() => requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl:async () => { attempts++; return new Response('bad', { status:attempts <= 2 ? 400 : 401 }); } }), { code:'INDICATOR_AGENT_CREDENTIALS_REJECTED' }));
  assert.equal(attempts, 4, 'primary retried once on 400, then two fallbacks rejected on 401 without retry');
  // Input errors are not switch reasons.
  attempts = 0;
  await quiet(() => assert.rejects(() => requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl:async () => { attempts++; throw Object.assign(new Error('x'), { code:'INDICATOR_AGENT_INPUT_REQUIRED' }); } }), { code:'INDICATOR_AGENT_INPUT_REQUIRED' }));
  assert.equal(attempts, 1);
});

test('openrouter provider 使用 json_object、附 Referer/Title，單一 provider 無 fallback 時行為不變', async () => {
  const output = { status:'discussion', message:'可改用：量增。', name:'', timeframe:null, indicatorId:null, version:null, params:{ period:null, threshold:null }, nodes:[], rootId:null };
  let captured;
  const env = { INDICATOR_AGENT_PROVIDER:'openrouter', INDICATOR_AGENT_MODEL:'openai/gpt-oss-120b', OPENROUTER_API_KEY:'router-key' };
  assert.deepEqual(indicatorAgentStatus(env), { configured:true, provider:'openrouter', model:'openai/gpt-oss-120b', reason:null, fallbacks:[] });
  const { status } = await requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl:async (url, options) => { captured = { url, options, body:JSON.parse(options.body) }; return chat(output); } });
  assert.equal(status.provider, 'openrouter');
  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer router-key'); assert.equal(captured.options.headers['HTTP-Referer'], 'https://watch365.just1stock.com'); assert.equal(captured.options.headers['X-Title'], 'watch365');
  assert.deepEqual(captured.body.response_format, { type:'json_object' }); assert.equal(captured.body.model, 'openai/gpt-oss-120b'); assert.equal(captured.body.reasoning_effort, 'low');
  assert.equal(JSON.stringify(captured.body).includes('router-key'), false);
  // Single provider, long 429: reported at once with the wait, as before.
  await quiet(() => assert.rejects(() => requestStructuredAgent('sys', 'user', FORMULA_PLAN_SCHEMA, 'plan', { env, fetchImpl:async () => tooMany(40) }), { code:'INDICATOR_AGENT_RATE_LIMITED', retryAfterSeconds:40 }));
});

test('normalizeAgentOutput 補齊 registry 解析器省略的欄位，但不吞掉未知欄位', async () => {
  const definitions = await definitionsPromise;
  const repaired = normalizeAgentOutput({ status:'matched', indicatorId:'rsi.cross', version:'1.0.0', timeframe:'1m', params:{ period:'14', threshold:30 }, requestedIndicator:'rsi', requestedTimeframe:'1m', requestedDirection:'crosses_above' });
  assert.equal(repaired.clarificationQuestion, ''); assert.equal(repaired.unsupportedReason, ''); assert.deepEqual(repaired.params, { period:14, threshold:30 });
  assert.equal(validateAgentOutput(repaired, definitions).status, 'matched');
  const noParams = normalizeAgentOutput({ status:'clarification', requestedIndicator:'rsi', requestedTimeframe:'unknown', requestedDirection:'unknown', clarificationQuestion:null });
  assert.deepEqual(noParams.params, { period:null, threshold:null }); assert.equal(noParams.indicatorId, null); assert.equal(noParams.clarificationQuestion, '');
  assert.equal(validateAgentOutput(noParams, definitions).status, 'clarification');
  assert.throws(() => validateAgentOutput(normalizeAgentOutput({ ...repaired, executor:'eval' }), definitions), /INDICATOR_AGENT_OUTPUT_INVALID/);
  assert.equal(normalizeAgentOutput(null), null);
});

test('planner tolerates forward references, prev without period and the tr block', () => {
  const nodes = [
    { id:'root', op:'crosses_above', leftId:'c', rightId:'atr' },
    { id:'atr', op:'rma', inputId:'tr', period:14 },
    { id:'tr', op:'tr' },
    { id:'c', op:'source', field:'close' },
    { id:'p', op:'prev', inputId:'c' }
  ];
  const plan = validatePlan(normalizePlan({ status:'formula', name:'收盤上穿 ATR(14)', nodes, rootId:'root' }), []);
  assert.equal(plan.status, 'formula');
  assert.match(plan.formulaSummary, /ATR\(14\)/);
  const red3 = normalizePlan({ status:'formula', name:'連續三根紅K', nodes:[
    { id:'c', op:'source', field:'close' }, { id:'o', op:'source', field:'open' },
    { id:'c1', op:'prev', inputId:'c', n:1 }, { id:'o1', op:'prev', inputId:'o', n:1 }, { id:'c2', op:'prev', inputId:'c', n:2 }, { id:'o2', op:'prev', inputId:'o', n:2 },
    { id:'b0', op:'gt', leftId:'c', rightId:'o' }, { id:'b1', op:'gt', leftId:'c1', rightId:'o1' }, { id:'b2', op:'gt', leftId:'c2', rightId:'o2' },
    { id:'all', op:'all', itemIds:['b0','b1','b2'] } ], rootId:'all' });
  assert.equal(red3.nodes.find((n) => n.id === 'c2').period, 2);
  assert.equal(validatePlan(red3, []).status, 'formula');
});
