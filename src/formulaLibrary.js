// Formula library: successfully parsed formulas accumulate in storage so the next user who says the same
// thing gets the stored formula without an AI call, and new common formulas can be added by writing the
// store (DB or JSON file) instead of changing code.
//
// Two collections:
//   formulas  fingerprint → { ast, name, summary, warmupBars, source:'preset'|'ai', status:'active'|'pending_review'|'disabled', hitCount, createdAt, updatedAt }
//   aliases   normalized user text → { fingerprint, aliasRaw, hits, lastUsedAt, source }
// Matching is an exact lookup on the normalized text (no fuzzy matching: applying the wrong condition is
// worse than a miss). Stored ASTs are never trusted: every load re-validates them and checks the
// fingerprint, and a mismatch disables the entry.
//
// Promotion rule (PM decision: automatic rule, no admin UI for now): an AI formula starts as
// 'pending_review' and only 'active' formulas are served to other users. It becomes 'active' once
//   hitCount ≥ PROMOTE_MIN_HITS (3 successful activations) AND
//   at least PROMOTE_MIN_ALIASES (2) different normalized phrasings have been bound to it,
// i.e. several people described the same condition in different words and each applied the same formula.
// A preset's status and hitCount are never overwritten by the seed, so a preset can be disabled in the store.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { formulaSummary, validateFormula } from './formulaEngine.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';
import { planMonitorCondition } from './formulaPlanner.js';

export const FORMULA_LIBRARY_STATUSES = Object.freeze(['active', 'pending_review', 'disabled']);
export const FORMULA_LIBRARY_SOURCES = Object.freeze(['preset', 'ai']);
export const LIBRARY_PROVIDER = Object.freeze({ provider: 'library', model: 'alias' });
const PROMOTE_MIN_HITS = 3;
const PROMOTE_MIN_ALIASES = 2;
const MAX_ALIAS_RAW = 200;
const MAX_ALIAS_NORM = 255;
const MIN_ALIAS_NORM = 2;

// Synonym groups, applied in order after NFKC + lowercase + punctuation removal. Longer phrases come first
// inside a group so "向上穿越" is consumed before "上穿". Tokens are upper-case so they cannot collide with
// the lower-cased input, and later groups never match inside an earlier token.
export const ALIAS_SYNONYMS = Object.freeze([
  ['XUP', ['黃金交叉', '金叉', '向上穿越', '向上交叉', '向上突破', '上穿越', '上穿', '升破', '突破', '站上', '站回', 'goldencross', 'crossabove', 'crossesabove', 'crossover']],
  ['XDN', ['死亡交叉', '死叉', '向下穿越', '向下交叉', '向下突破', '下穿越', '下穿', '跌破', '跌落', '失守', 'deathcross', 'crossbelow', 'crossesbelow', 'crossunder']],
  ['BOLL', ['布林通道', '布林帶', '布林線', '布林', '保力加通道', 'bollingerbands', 'bollingerband', 'bollinger', 'bbands', 'bband']],
  ['MACD', ['指數平滑異同移動平均線', '指數平滑異同移動平均', 'macd']],
  ['KD', ['隨機指標', 'stochastic', 'kd']],
  ['RSI', ['相對強弱指標', '相對強弱', 'rsi']],
  ['WR', ['威廉指標r', '威廉指標', '威廉r', '威廉', 'williamsr', 'williams', 'wr']],
  ['VOL', ['成交量', '交易量', '量能', 'volume', 'vol']],
  ['CLOSE', ['收盤價', '收盤', '股價', '價格', 'close', 'price']],
  ['UPB', ['上軌', '上緣', '上帶', 'upperband', 'upper']],
  ['LOB', ['下軌', '下緣', '下帶', 'lowerband', 'lower']],
  ['SMA', ['簡單移動平均線', '簡單移動平均', 'sma']],
  ['EMA', ['指數移動平均線', '指數移動平均', 'ema']],
  ['MA', ['移動平均線', '移動平均', '均線', 'ma']]
]);

// NFKC (full-width → half-width), lower-case, drop whitespace / control chars / punctuation except '-' and
// '.' (sign and decimal point carry meaning: 威廉 -80, 1.5 倍), then unify synonyms.
export function normalizeAlias(text) {
  let value = String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{C}]/gu, '').replace(/[^\P{P}\-.]/gu, '');
  for (const [token, words] of ALIAS_SYNONYMS) for (const word of words) value = value.split(word).join(token);
  return value;
}

export const PRESET_ALIASES = Object.freeze({
  macd_golden: ['MACD黃金交叉', 'MACD金叉', 'DIF上穿DEA', 'MACD向上交叉', 'DIF向上穿越DEA', 'MACD快線上穿慢線'],
  macd_death: ['MACD死亡交叉', 'MACD死叉', 'DIF下穿DEA', 'MACD向下交叉', 'DIF向下穿越DEA', 'MACD快線下穿慢線'],
  kd_golden: ['KD黃金交叉', 'KD金叉', 'K上穿D', 'KD向上交叉', '隨機指標黃金交叉', 'K值上穿D值'],
  kd_low_golden: ['KD低檔黃金交叉', 'KD低檔金叉', 'KD20以下黃金交叉', 'K小於20且K上穿D', 'K值低於20且黃金交叉'],
  boll_upper: ['突破布林上軌', '股價突破布林上軌', '收盤價上穿布林上軌', '站上布林上軌', '布林通道上軌突破', '收盤站上布林帶上緣'],
  boll_lower: ['跌破布林下軌', '股價跌破布林下軌', '收盤價下穿布林下軌', '布林通道下軌跌破', '收盤跌破布林帶下緣'],
  breakout_high: ['突破20根新高', '突破前20根最高價', '創20根新高', '收盤突破前20根高點', '突破20K高點', '突破前20根高點', '突破20根高點', '突破前20K高點', '突破近20根高點', '創20K新高', '突破20根最高價'],
  volume_surge: ['爆量', '量增兩倍', '成交量大於20根均量2倍', '成交量是均量兩倍', '量能放大兩倍', '成交量超過均量兩倍'],
  rsi_up: ['RSI上穿30', 'RSI向上穿越30', 'RSI14上穿30', 'RSI突破30', '相對強弱指標上穿30', 'RSI站上30'],
  rsi_down: ['RSI下穿70', 'RSI向下穿越70', 'RSI14下穿70', 'RSI跌破70', '相對強弱指標下穿70'],
  williams_r: ['威廉指標上穿-80', '威廉%R上穿-80', 'WR上穿-80', '威廉14上穿-80', '威廉指標向上穿越-80'],
  pct_rise: ['5根內漲幅2%', '5分鐘漲2%', '五根漲幅超過2%', '相對5根前漲幅2%', '5根K漲2%'],
  ichimoku_above_cloud: ['一目雲', '一目均衡表', '一目均衡圖', 'ichimoku', '一目雲圖', '站上一目雲', '突破一目雲', '收盤站上雲層', '價格突破雲帶', '站上雲帶', '突破雲層上緣', '一目均衡表站上雲'],
  ichimoku_below_cloud: ['跌破一目雲', '跌破雲層', '跌破雲帶', '收盤跌破雲層下緣', '一目均衡表跌破雲', '跌破雲層下緣'],
  ichimoku_tk_cross: ['一目均衡表黃金交叉', '轉換線上穿基準線', '一目雲黃金交叉', '轉換線向上穿越基準線', 'ichimoku黃金交叉', '一目均衡表金叉'],
  vwap_above: ['vwap', '站上vwap', '收盤站上vwap', '收盤價站上vwap', '突破vwap', '收盤上穿vwap', '成交量加權平均價', '股價站上vwap', '站上成交量加權均價'],
  vwap_below: ['跌破vwap', '收盤跌破vwap', '收盤價下穿vwap', '股價跌破vwap', '跌破成交量加權均價'],
  open_gain: ['開盤漲幅2%', '相對開盤漲2%', '今日漲幅2%', '當日漲幅超過2%', '比開盤價高2%', '開盤以來漲幅2%']
});

export class FormulaLibrary {
  constructor(filePath, { backend = null, recipes = FORMULA_RECIPES, presetAliases = PRESET_ALIASES, log = console } = {}) {
    this.filePath = filePath; this.backend = backend; this.recipes = recipes; this.presetAliases = presetAliases; this.log = log;
    this.formulas = new Map(); this.aliases = new Map(); this.queue = Promise.resolve();
  }

  async load() {
    const raw = await this.readStored();
    this.formulas = new Map(); this.aliases = new Map();
    for (const row of raw.formulas) { const formula = sanitizeFormula(row, this.log); if (formula) this.formulas.set(formula.fingerprint, formula); }
    for (const row of raw.aliases) {
      const alias = sanitizeAlias(row);
      if (!alias || !this.formulas.has(alias.fingerprint)) { this.log.warn?.(`formula-library: dropping alias ${JSON.stringify(row?.aliasNorm ?? row?.alias_norm)} (invalid or unknown fingerprint)`); continue; }
      this.aliases.set(alias.aliasNorm, alias);
    }
    await this.seed();
    return this;
  }

  // Upserts every recipe as a preset. Status and hitCount of an existing row are kept (operators may have
  // disabled a preset in the store); ast/name/summary follow the code so a recipe fix propagates.
  seed() { return this.enqueue(() => this.seedLocked()); }
  async seedLocked() {
    const now = new Date().toISOString(); const changedFormulas = [], changedAliases = [];
    for (const recipe of this.recipes) {
      const validated = validateFormula(recipe.ast);
      const existing = this.formulas.get(validated.fingerprint);
      const formula = { fingerprint: validated.fingerprint, ast: validated.ast, name: recipe.name, summary: formulaSummary(validated.ast), warmupBars: validated.warmupBars, source: 'preset', status: existing?.status ?? 'active', hitCount: existing?.hitCount ?? 0, createdAt: existing?.createdAt ?? now, updatedAt: now };
      if (!existing || JSON.stringify(stripTimes(existing)) !== JSON.stringify(stripTimes(formula))) { this.formulas.set(formula.fingerprint, formula); changedFormulas.push(formula); }
      for (const aliasRaw of this.presetAliases[recipe.key] || []) {
        const aliasNorm = normalizeAlias(aliasRaw); if (!validNorm(aliasNorm)) continue;
        const current = this.aliases.get(aliasNorm);
        if (current && current.fingerprint === formula.fingerprint && current.source === 'preset') continue;
        if (current && current.fingerprint !== formula.fingerprint) this.log.warn?.(`formula-library: preset alias "${aliasRaw}" re-bound from ${current.fingerprint.slice(0, 8)} to ${recipe.key}`);
        const alias = { aliasNorm, aliasRaw, fingerprint: formula.fingerprint, hits: current?.hits ?? 0, lastUsedAt: current?.lastUsedAt ?? null, source: 'preset' };
        this.aliases.set(aliasNorm, alias); changedAliases.push(alias);
      }
    }
    await this.persist(changedFormulas, changedAliases);
  }

  // Exact lookup on the normalized text. Returns a planner-shaped formula result or null. Only 'active'
  // formulas are served; the stored AST is re-validated on every hit.
  async match(text) {
    const aliasNorm = normalizeAlias(text); if (!validNorm(aliasNorm)) return null;
    const alias = this.aliases.get(aliasNorm); if (!alias) return null;
    const formula = this.formulas.get(alias.fingerprint); if (!formula || formula.status !== 'active') return null;
    let validated; try { validated = validateFormula(formula.ast); } catch { validated = null; }
    if (!validated || validated.fingerprint !== formula.fingerprint) { formula.status = 'disabled'; this.log.error?.(`formula-library: stored AST for ${formula.fingerprint.slice(0, 8)} failed validation, disabled`); return null; }
    await this.enqueue(async () => {
      const now = new Date().toISOString(); alias.hits += 1; alias.lastUsedAt = now; formula.hitCount += 1; formula.updatedAt = now;
      await this.persist([formula], [alias]);
    });
    return { status: 'formula', summary: `${formula.name} · 一分鐘`, formulaSummary: formulaSummary(validated.ast), proposal: { name: formula.name, ast: validated.ast, fingerprint: validated.fingerprint, warmupBars: validated.warmupBars }, provider: { ...LIBRARY_PROVIDER }, library: true };
  }

  // Called after a formula was applied successfully (activate / configure). New formulas enter as
  // source='ai', status='pending_review'; an existing fingerprint only gains a hit. sourceText (what the
  // user said) is bound as an alias when present; a phrase already bound to a different formula is kept
  // as is (the phrase is ambiguous, so it must not be re-bound). Then the promotion rule above is applied.
  recordActivation({ ast, name, sourceText = null }) { return this.enqueue(() => this.recordActivationLocked({ ast, name, sourceText })); }
  async recordActivationLocked({ ast, name, sourceText }) {
    const validated = validateFormula(ast); const now = new Date().toISOString();
    let formula = this.formulas.get(validated.fingerprint);
    if (formula) { formula.hitCount += 1; formula.updatedAt = now; }
    else { formula = { fingerprint: validated.fingerprint, ast: validated.ast, name: String(name || '').trim().slice(0, 100) || formulaSummary(validated.ast).slice(0, 100), summary: formulaSummary(validated.ast), warmupBars: validated.warmupBars, source: 'ai', status: 'pending_review', hitCount: 1, createdAt: now, updatedAt: now }; this.formulas.set(formula.fingerprint, formula); }
    const changedAliases = [];
    const aliasRaw = typeof sourceText === 'string' ? sourceText.trim().replace(/\s+/g, ' ').slice(0, MAX_ALIAS_RAW) : '';
    const aliasNorm = normalizeAlias(aliasRaw);
    if (validNorm(aliasNorm)) {
      const current = this.aliases.get(aliasNorm);
      if (!current) { const alias = { aliasNorm, aliasRaw, fingerprint: formula.fingerprint, hits: 1, lastUsedAt: now, source: 'ai' }; this.aliases.set(aliasNorm, alias); changedAliases.push(alias); }
      else if (current.fingerprint === formula.fingerprint) { current.hits += 1; current.lastUsedAt = now; changedAliases.push(current); }
      else this.log.warn?.(`formula-library: "${aliasRaw}" already bound to ${current.fingerprint.slice(0, 8)}, not re-bound to ${formula.fingerprint.slice(0, 8)}`);
    }
    let promoted = false;
    if (formula.source === 'ai' && formula.status === 'pending_review' && formula.hitCount >= PROMOTE_MIN_HITS && this.aliasesOf(formula.fingerprint).length >= PROMOTE_MIN_ALIASES) { formula.status = 'active'; promoted = true; this.log.info?.(`formula-library: ${formula.fingerprint.slice(0, 8)} "${formula.name}" promoted to active`); }
    await this.persist([formula], changedAliases);
    return { formula: publicFormula(formula, this.aliasesOf(formula.fingerprint)), promoted };
  }

  get(fingerprint) { const formula = this.formulas.get(fingerprint); return formula ? publicFormula(formula, this.aliasesOf(fingerprint)) : null; }
  list({ status = null } = {}) {
    return [...this.formulas.values()].filter((formula) => !status || formula.status === status)
      .sort((a, b) => b.hitCount - a.hitCount || a.name.localeCompare(b.name, 'zh-Hant'))
      .map((formula) => publicFormula(formula, this.aliasesOf(formula.fingerprint)));
  }
  aliasesOf(fingerprint) { return [...this.aliases.values()].filter((alias) => alias.fingerprint === fingerprint).map((alias) => alias.aliasRaw); }

  enqueue(task) { const operation = this.queue.then(task); this.queue = operation.catch(() => {}); return operation; }
  async readStored() {
    if (this.backend) return this.backend.loadAll();
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw; try { raw = JSON.parse(await readFile(this.filePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return { formulas: [], aliases: [] }; }
    if (!raw || raw.version !== 1 || !Array.isArray(raw.formulas) || !Array.isArray(raw.aliases)) throw Object.assign(new Error('FORMULA_LIBRARY_STORE_INVALID'), { code: 'FORMULA_LIBRARY_STORE_INVALID', statusCode: 500 });
    return raw;
  }
  async persist(changedFormulas, changedAliases) {
    if (this.backend) { for (const formula of changedFormulas) await this.backend.upsertFormula(formula); for (const alias of changedAliases) await this.backend.upsertAlias(alias); return; }
    const data = { version: 1, formulas: [...this.formulas.values()], aliases: [...this.aliases.values()] };
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

// Library-first entry used by /api/indicator-agent/parse: a fresh request (no clarification context) is
// looked up in the library; a miss (or a follow-up reply) goes to the AI planner unchanged.
export async function resolveMonitorCondition(text, definitions, { library = null, context = [], planner = planMonitorCondition, ...options } = {}) {
  if (library && !(Array.isArray(context) && context.length)) { const hit = await library.match(text); if (hit) return hit; }
  return planner(text, definitions, { context, ...options });
}

function publicFormula(formula, aliases) { return { fingerprint: formula.fingerprint, name: formula.name, summary: formula.summary, warmupBars: formula.warmupBars, source: formula.source, status: formula.status, hitCount: formula.hitCount, createdAt: formula.createdAt, updatedAt: formula.updatedAt, aliases }; }
function stripTimes({ createdAt, updatedAt, ...rest }) { return rest; }
function validNorm(value) { return typeof value === 'string' && value.length >= MIN_ALIAS_NORM && value.length <= MAX_ALIAS_NORM; }

// Stored rows are untrusted: shape is checked, the AST is re-validated and its fingerprint must match the
// key. A mismatch keeps the row but as 'disabled' so it is never served.
function sanitizeFormula(row, log) {
  if (!row || typeof row !== 'object' || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint)) { log.warn?.('formula-library: dropping formula row with invalid fingerprint'); return null; }
  const status = FORMULA_LIBRARY_STATUSES.includes(row.status) ? row.status : 'disabled';
  const source = FORMULA_LIBRARY_SOURCES.includes(row.source) ? row.source : 'ai';
  const name = typeof row.name === 'string' && row.name.trim().length >= 2 ? row.name.trim().slice(0, 100) : row.fingerprint.slice(0, 12);
  const hitCount = Number.isInteger(row.hitCount) && row.hitCount >= 0 ? row.hitCount : 0;
  const createdAt = typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString();
  const updatedAt = typeof row.updatedAt === 'string' ? row.updatedAt : createdAt;
  let ast = row.ast; if (typeof ast === 'string') { try { ast = JSON.parse(ast); } catch { ast = null; } }
  let validated = null; try { validated = validateFormula(ast); } catch { validated = null; }
  if (!validated || validated.fingerprint !== row.fingerprint) { log.error?.(`formula-library: stored AST for ${row.fingerprint.slice(0, 8)} failed validation or fingerprint mismatch, disabled`); return { fingerprint: row.fingerprint, ast: ast ?? null, name, summary: typeof row.summary === 'string' ? row.summary : '', warmupBars: 0, source, status: 'disabled', hitCount, createdAt, updatedAt }; }
  return { fingerprint: row.fingerprint, ast: validated.ast, name, summary: formulaSummary(validated.ast), warmupBars: validated.warmupBars, source, status, hitCount, createdAt, updatedAt };
}
function sanitizeAlias(row) {
  if (!row || typeof row !== 'object' || typeof row.aliasNorm !== 'string' || typeof row.fingerprint !== 'string') return null;
  const aliasNorm = row.aliasNorm; if (!validNorm(aliasNorm)) return null;
  return { aliasNorm, aliasRaw: typeof row.aliasRaw === 'string' ? row.aliasRaw.slice(0, MAX_ALIAS_RAW) : aliasNorm, fingerprint: row.fingerprint, hits: Number.isInteger(row.hits) && row.hits >= 0 ? row.hits : 0, lastUsedAt: typeof row.lastUsedAt === 'string' ? row.lastUsedAt : null, source: FORMULA_LIBRARY_SOURCES.includes(row.source) ? row.source : 'ai' };
}
