import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHmac } from 'node:crypto';
import { FormulaLibrary, PRESET_ALIASES, normalizeAlias, resolveMonitorCondition } from './formulaLibrary.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';
import { formulaFingerprint, formulaSummary, issueFormulaToken, validateFormula, verifyFormulaToken } from './formulaEngine.js';
import { IndicatorRegistry } from './indicatorRegistry.js';

const quiet = { warn() {}, error() {}, info() {} };
const secret = 'test-secret-at-least-8-chars';
async function tempLibrary(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'formula-library-'));
  const filePath = join(dir, 'formula-library.json');
  const library = await new FormulaLibrary(filePath, { log: quiet, ...options }).load();
  return { dir, filePath, library };
}
const close = { op:'source', field:'close' };
const emaCross = (period) => ({ op:'crosses_above', left:close, right:{ op:'ema', input:close, period } });

test('別名正規化：全形轉半形、去空白標點、小寫、同義詞統一；不同條件不會被併成同一鍵', () => {
  assert.equal(normalizeAlias('ＫＤ 黃金交叉！'), normalizeAlias('kd金叉'));
  assert.equal(normalizeAlias('K 上穿 D'), normalizeAlias('k向上穿越d'));
  assert.equal(normalizeAlias('隨機指標黃金交叉'), normalizeAlias('KD黃金交叉'));
  assert.equal(normalizeAlias('股價突破布林上軌'), normalizeAlias('收盤價 向上穿越 bollinger 上軌'));
  assert.equal(normalizeAlias('MACD死亡交叉'), normalizeAlias('macd 死叉'));
  assert.equal(normalizeAlias('RSI 跌破 70'), normalizeAlias('rsi下穿70'));
  assert.equal(normalizeAlias('威廉%R上穿-80'), normalizeAlias('WR 上穿 -80'));
  assert.notEqual(normalizeAlias('RSI上穿30'), normalizeAlias('RSI上穿70'));
  assert.notEqual(normalizeAlias('KD黃金交叉'), normalizeAlias('KD死亡交叉'));
  assert.notEqual(normalizeAlias('突破布林上軌'), normalizeAlias('跌破布林下軌'));
  assert.equal(normalizeAlias(''), '');
});

test('啟動 seed：每個 recipe 為 preset/active，所有人工別名都能精確命中且回傳格式與 AI 路徑一致、token 可驗', async () => {
  const { dir, library } = await tempLibrary();
  try {
    const active = library.list({ status:'active' });
    assert.equal(active.length, FORMULA_RECIPES.length);
    assert.ok(active.every((item) => item.source === 'preset' && !('ast' in item)));
    for (const recipe of FORMULA_RECIPES) {
      const aliases = PRESET_ALIASES[recipe.key]; assert.ok(aliases.length >= 3, recipe.key);
      for (const alias of aliases) {
        const hit = await library.match(alias);
        assert.ok(hit, `${recipe.key}: ${alias}`);
        assert.deepEqual(Object.keys(hit).sort(), ['formulaSummary', 'library', 'proposal', 'provider', 'status', 'summary']);
        assert.equal(hit.status, 'formula'); assert.equal(hit.library, true);
        assert.deepEqual(hit.provider, { provider:'library', model:'alias' });
        assert.equal(hit.proposal.fingerprint, formulaFingerprint(recipe.ast));
        assert.equal(hit.summary, `${recipe.name} · 一分鐘`); assert.equal(hit.formulaSummary, formulaSummary(recipe.ast));
        assert.deepEqual(Object.keys(hit.proposal).sort(), ['ast', 'fingerprint', 'name', 'warmupBars']);
        const token = issueFormulaToken({ ...hit.proposal, sourceText:alias }, secret);
        const payload = verifyFormulaToken(token, secret);
        assert.equal(payload.fingerprint, hit.proposal.fingerprint); assert.equal(payload.sourceText, alias);
      }
    }
    // Full-width / spaced variants of a seeded alias hit too; hits are counted.
    const variant = await library.match('ＫＤ　金叉');
    assert.equal(variant.proposal.fingerprint, formulaFingerprint(FORMULA_RECIPES.find((item) => item.key === 'kd_golden').ast));
    await library.queue;
    assert.ok(library.aliases.get(normalizeAlias('KD金叉')).hits >= 2);
    assert.equal(await library.match('完全沒有這個說法'), null);
    // Re-seeding keeps an operator's status / hitCount change.
    const macd = library.formulas.get(formulaFingerprint(FORMULA_RECIPES[0].ast)); macd.status = 'disabled'; macd.hitCount = 42;
    await library.seed();
    assert.equal(library.get(macd.fingerprint).status, 'disabled'); assert.equal(library.get(macd.fingerprint).hitCount, 42);
    assert.equal(await library.match('MACD黃金交叉'), null);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('解析入口：context 為空先查公式庫，命中不呼叫 AI；未命中或有 context 走 planner（fetch stub）', async () => {
  const { dir, library } = await tempLibrary();
  try {
    const definitions = await new IndicatorRegistry().list();
    const env = { INDICATOR_AGENT_PROVIDER:'groq', INDICATOR_AGENT_MODEL:'test', GROQ_API_KEY:'secret' };
    let calls = 0;
    const unsupported = { status:'unsupported', indicatorId:null, version:null, timeframe:null, params:{ period:null, threshold:null }, requestedIndicator:'other', requestedTimeframe:'1m', requestedDirection:'crosses_above', clarificationQuestion:'', unsupportedReason:'需要公式規劃' };
    const nodes = [{ id:'close', op:'source', field:'close', value:null, period:null, inputId:null, leftId:null, rightId:null, itemIds:null }, { id:'ema3', op:'ema', field:null, value:null, period:3, inputId:'close', leftId:null, rightId:null, itemIds:null }, { id:'cross', op:'crosses_above', field:null, value:null, period:null, inputId:null, leftId:'close', rightId:'ema3', itemIds:null }];
    const formulaOutput = { status:'formula', message:'', name:'收盤價上穿 EMA3', timeframe:'1m', indicatorId:null, version:null, params:{ period:null, threshold:null }, nodes, rootId:'cross' };
    const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ choices:[{ message:{ content:JSON.stringify(calls === 1 ? unsupported : formulaOutput) } }] }), { status:200, headers:{ 'content-type':'application/json' } }); };
    const hit = await resolveMonitorCondition('kd 黃金交叉', definitions, { library, context:[], env, fetchImpl });
    assert.equal(hit.library, true); assert.equal(calls, 0);
    const miss = await resolveMonitorCondition('收盤價上穿 EMA 3', definitions, { library, env, fetchImpl });
    assert.equal(miss.status, 'formula'); assert.equal(miss.library, undefined); assert.equal(miss.proposal.fingerprint, formulaFingerprint(emaCross(3))); assert.equal(calls, 2);
    assert.deepEqual(Object.keys(miss).filter((key) => key !== 'library').sort(), Object.keys(hit).filter((key) => key !== 'library').sort());
    // A follow-up reply (context present) always goes to the planner even if the text matches an alias.
    calls = 0;
    await resolveMonitorCondition('kd 黃金交叉', definitions, { library, context:[{ request:'KD', response:'請問要向上還是向下？' }], env, fetchImpl, planner:async () => { calls++; return { status:'clarification', message:'stub' }; } });
    assert.equal(calls, 1);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('套用成功入庫為 pending_review、不供命中；同指紋只累加 hitCount；三次不同說法後升級 active', async () => {
  const { dir, library } = await tempLibrary();
  try {
    const ast = emaCross(5); const fingerprint = formulaFingerprint(ast);
    const first = await library.recordActivation({ ast, name:'收盤價上穿 EMA5', sourceText:'收盤上穿EMA5' });
    assert.equal(first.formula.status, 'pending_review'); assert.equal(first.formula.source, 'ai'); assert.equal(first.formula.hitCount, 1); assert.equal(first.promoted, false);
    assert.equal(await library.match('收盤上穿EMA5'), null, 'pending_review 不供命中');
    assert.equal(library.list({ status:'active' }).some((item) => item.fingerprint === fingerprint), false);
    // Same phrasing again (same user repeating): hitCount grows, still one alias → stays pending.
    const second = await library.recordActivation({ ast, name:'收盤價上穿 EMA5', sourceText:'收盤 上穿 ema5' });
    assert.equal(second.formula.hitCount, 2); assert.equal(second.formula.aliases.length, 1); assert.equal(second.formula.status, 'pending_review');
    const third = await library.recordActivation({ ast, name:'收盤價上穿 EMA5', sourceText:'收盤上穿EMA5' });
    assert.equal(third.formula.hitCount, 3); assert.equal(third.formula.status, 'pending_review', '三次但只有一種說法不升級');
    // A different phrasing → 2 aliases, hitCount ≥ 3 → active, and now matchable.
    const fourth = await library.recordActivation({ ast, name:'收盤價上穿 EMA5', sourceText:'價格站上五日EMA' });
    assert.equal(fourth.promoted, true); assert.equal(fourth.formula.status, 'active'); assert.equal(fourth.formula.aliases.length, 2);
    const hit = await library.match('收盤上穿 EMA5');
    assert.equal(hit?.proposal.fingerprint, fingerprint); assert.equal(hit.summary, '收盤價上穿 EMA5 · 一分鐘');
    // Activation without sourceText (old token / frontend without text) still counts a hit.
    const fifth = await library.recordActivation({ ast, name:'收盤價上穿 EMA5' });
    assert.equal(fifth.formula.hitCount, 6);
    // A phrase already bound to a preset is never re-bound to another formula.
    await library.recordActivation({ ast:emaCross(8), name:'收盤價上穿 EMA8', sourceText:'KD黃金交叉' });
    assert.equal(library.aliases.get(normalizeAlias('KD黃金交叉')).fingerprint, formulaFingerprint(FORMULA_RECIPES.find((item) => item.key === 'kd_golden').ast));
    assert.deepEqual(library.get(formulaFingerprint(emaCross(8))).aliases, []);
    // Library listing has no AST.
    const listed = library.list().find((item) => item.fingerprint === fingerprint);
    assert.equal('ast' in listed, false); assert.deepEqual(listed.aliases.sort(), ['價格站上五日EMA', '收盤上穿EMA5']);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('token payload 選填 sourceText：舊 token 仍可驗、超長被截斷、非字串被拒', () => {
  const proposal = { name:'收盤價上穿 EMA5', ast:emaCross(5), fingerprint:formulaFingerprint(emaCross(5)) };
  const plain = verifyFormulaToken(issueFormulaToken(proposal, secret), secret);
  assert.equal('sourceText' in plain, false);
  const withText = verifyFormulaToken(issueFormulaToken({ ...proposal, sourceText:`  ${'收'.repeat(300)}  ` }, secret), secret);
  assert.equal(withText.sourceText.length, 200);
  assert.equal('sourceText' in verifyFormulaToken(issueFormulaToken({ ...proposal, sourceText:'   ' }, secret), secret), false);
  const forged = Buffer.from(JSON.stringify({ v:1, proposalId:'00000000-0000-4000-8000-000000000000', exp:Date.now() + 60_000, capabilityRevision:'formula.v1', fingerprint:proposal.fingerprint, ast:proposal.ast, name:proposal.name, sourceText:42 })).toString('base64url');
  assert.throws(() => verifyFormulaToken(`${forged}.${createHmac('sha256', secret).update(forged).digest('base64url')}`, secret), /FORMULA_TOKEN_INVALID/);
});

test('無 DB：JSON 檔寫入、重讀；庫中被竄改的 AST 視為 disabled 不供命中；壞檔案被拒', async () => {
  const { dir, filePath, library } = await tempLibrary();
  try {
    const ast = emaCross(5); const fingerprint = formulaFingerprint(ast);
    await library.recordActivation({ ast, name:'收盤價上穿 EMA5', sourceText:'收盤上穿EMA5' });
    await library.match('KD黃金交叉'); await library.queue;
    const stored = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(stored.version, 1);
    assert.equal(stored.formulas.length, FORMULA_RECIPES.length + 1);
    assert.equal(stored.formulas.find((item) => item.fingerprint === fingerprint).status, 'pending_review');
    assert.equal(stored.aliases.find((item) => item.aliasNorm === normalizeAlias('KD黃金交叉')).hits, 1);
    const reloaded = await new FormulaLibrary(filePath, { log:quiet }).load();
    assert.equal(reloaded.get(fingerprint).status, 'pending_review'); assert.equal(reloaded.get(fingerprint).hitCount, 1);
    assert.deepEqual(reloaded.get(fingerprint).aliases, ['收盤上穿EMA5']);
    assert.equal(reloaded.aliases.get(normalizeAlias('KD黃金交叉')).hits, 1);
    // Tamper: swap the stored AST of an active formula (fingerprint no longer matches) and of the user formula.
    const kd = formulaFingerprint(FORMULA_RECIPES.find((item) => item.key === 'kd_golden').ast);
    const tampered = structuredClone(stored);
    tampered.formulas.find((item) => item.fingerprint === kd).ast = emaCross(3);
    const user = tampered.formulas.find((item) => item.fingerprint === fingerprint); user.ast = emaCross(9); user.status = 'active';
    tampered.aliases.push({ aliasNorm:'orphan', aliasRaw:'orphan', fingerprint:'0'.repeat(64), hits:0, lastUsedAt:null, source:'ai' });
    await writeFile(filePath, JSON.stringify(tampered));
    const errors = []; const logging = { warn() {}, info() {}, error(message) { errors.push(message); } };
    const checked = await new FormulaLibrary(filePath, { log:logging }).load();
    assert.equal(checked.get(fingerprint).status, 'disabled');
    assert.equal(await checked.match('收盤上穿EMA5'), null);
    assert.ok(errors.some((message) => message.includes(fingerprint.slice(0, 8))));
    // The preset's AST is repaired by the seed but it stays disabled until an operator re-enables it.
    assert.equal(checked.get(kd).status, 'disabled'); assert.equal(await checked.match('KD黃金交叉'), null);
    assert.equal(checked.aliases.has('orphan'), false);
    await writeFile(filePath, JSON.stringify({ version:2 }));
    await assert.rejects(() => new FormulaLibrary(filePath, { log:quiet }).load(), /FORMULA_LIBRARY_STORE_INVALID/);
    // Env-style override: a different file path starts an independent library.
    const other = await new FormulaLibrary(join(dir, 'nested', 'other.json'), { log:quiet }).load();
    assert.equal(other.list().length, FORMULA_RECIPES.length);
  } finally { await rm(dir, { recursive:true, force:true }); }
});

test('有 DB：寫入透過 backend upsert，不碰 JSON 檔', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'formula-library-db-'));
  try {
    const formulas = new Map(), aliases = new Map();
    const backend = { async loadAll() { return { formulas:[...formulas.values()], aliases:[...aliases.values()] }; }, async upsertFormula(row) { formulas.set(row.fingerprint, structuredClone(row)); }, async upsertAlias(row) { aliases.set(row.aliasNorm, structuredClone(row)); } };
    const library = await new FormulaLibrary(join(dir, 'never-written.json'), { backend, log:quiet }).load();
    assert.equal(formulas.size, FORMULA_RECIPES.length);
    await library.recordActivation({ ast:emaCross(5), name:'收盤價上穿 EMA5', sourceText:'收盤上穿EMA5' });
    assert.equal(formulas.get(formulaFingerprint(emaCross(5))).status, 'pending_review');
    assert.equal(aliases.get(normalizeAlias('收盤上穿EMA5')).fingerprint, formulaFingerprint(emaCross(5)));
    await assert.rejects(() => readFile(join(dir, 'never-written.json')), /ENOENT/);
    // A second boot against the same backend keeps counts (seed does not reset them).
    const again = await new FormulaLibrary(join(dir, 'never-written.json'), { backend, log:quiet }).load();
    assert.equal(again.get(formulaFingerprint(emaCross(5))).hitCount, 1);
    assert.equal(validateFormula(again.formulas.get(formulaFingerprint(emaCross(5))).ast).fingerprint, formulaFingerprint(emaCross(5)));
  } finally { await rm(dir, { recursive:true, force:true }); }
});
