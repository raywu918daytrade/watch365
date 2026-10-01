// Indicator reality check (PM decision: formulas must be generic — before the AI builds a formula for an
// indicator the library does not know, confirm on a public reference that the indicator exists; if it cannot
// be found, do not build anything, record it for research).
//
// lookupIndicator(text):
//   1. extractIndicatorCandidates strips parameters (numbers, %, 根/倍/…) and direction words (上穿／跌破／黃金交叉…)
//      from the request, leaving the indicator name, e.g. 「MACD 背離」→ ["MACD 背離", "MACD divergence"] (the second
//      candidate translates common Chinese indicator words to English for en.wikipedia).
//   2. Words the formula library already knows (family names, synonyms, recipe vocabulary and generic price /
//      volume words) are whitelisted: a request made only of those is accepted without any network call, and a
//      remainder shorter than 2 characters is accepted too (too little to search for).
//   3. Otherwise zh.wikipedia and en.wikipedia search APIs are queried (4 s timeout each). A result counts when its
//      title or snippet contains every major token of a candidate (「MACD」 and 「背離」/「divergence」 both appear).
//   4. found:false only when every query answered and none matched; any network failure gives found:null, which
//      callers treat as "unknown, let the AI try" (a reference outage must not block users). Results are cached for
//      24 hours in memory.
//
// UnknownIndicatorStore keeps the blocked requests (watch365_unknown_indicators or data/unknown-indicators.json)
// so the team can research them from the admin page.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ALIAS_SYNONYMS } from './formulaLibrary.js';
import { FAMILY_ORDER } from './indicatorTemplates.js';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 4000;
const MAX_CANDIDATES = 2;
const MAX_UNKNOWN = 2000;

// Direction / comparison / filler words: they describe what to do with the indicator, not which indicator.
const DIRECTION_WORDS = ['向上穿越', '向下穿越', '向上交叉', '向下交叉', '向上突破', '向下突破', '黃金交叉', '死亡交叉', '上穿越', '下穿越', '上穿', '下穿', '金叉', '死叉', '站上', '站回', '跌破', '跌落', '失守', '突破', '升破', '大於等於', '小於等於', '大於', '小於', '高於', '低於', '超過', '不到', '等於', '創新高', '創新低', '創高', '創低', '新高', '新低', '以上', '以下', '之上', '之下', '翻多', '翻空', '轉多', '轉空', '向上', '向下', '上升', '下降', '放大', '縮小', '擴大', '收斂',
  '並且', '而且', '同時', '且', '或', '當', '的', '時', '就', '請', '我要', '我想', '幫我', '監控', '提醒', '通知', '條件', '設定', '參數', '出現', '發生', '成立', '觸發', '盯', '追蹤',
  'crosses above', 'crosses below', 'cross above', 'cross below', 'golden cross', 'death cross', 'crossover', 'crossunder', 'breaks above', 'breaks below', 'breakout', 'greater than', 'less than', 'above', 'below', 'over', 'under', 'exceeds', 'reaches', 'when', 'and', 'or', 'the', 'is'];
// Units and quantity words that only make sense next to a number.
const UNIT_WORDS = ['根', '倍', '次', '日', '天', '分鐘', '分', '個', '條', '檔', '期', '點', 'k線', 'k棒', 'bars', 'bar', 'times', 'percent', 'pct', 'days', 'day', 'minutes', 'minute', 'min', 'x'];
// Chinese → English indicator vocabulary for the en.wikipedia candidate.
export const ZH_EN_TERMS = Object.freeze([
  ['背離', 'divergence'], ['乖離率', 'bias ratio'], ['乖離', 'bias ratio'], ['能量潮', 'OBV'], ['威廉指標', 'Williams %R'], ['威廉', 'Williams %R'], ['布林通道', 'Bollinger Bands'], ['布林帶', 'Bollinger Bands'], ['布林', 'Bollinger'],
  ['一目均衡表', 'Ichimoku'], ['一目', 'Ichimoku'], ['移動平均線', 'moving average'], ['移動平均', 'moving average'], ['均線', 'moving average'], ['量能', 'volume'], ['成交量', 'volume'], ['隨機指標', 'stochastic oscillator'],
  ['相對強弱指標', 'RSI'], ['相對強弱', 'RSI'], ['指數平滑異同移動平均線', 'MACD'], ['拋物線', 'parabolic SAR'], ['停損點轉向', 'parabolic SAR'], ['趨向指標', 'directional movement index'], ['動向指標', 'directional movement index'], ['平均趨向指標', 'ADX'],
  ['順勢指標', 'CCI'], ['商品通道指標', 'CCI'], ['動量指標', 'momentum'], ['動量', 'momentum'], ['真實波幅', 'average true range'], ['波動率', 'volatility'], ['成交量加權平均價', 'VWAP'], ['籌碼', 'chip distribution'], ['資金流向', 'money flow index'], ['資金流量指標', 'money flow index'],
  ['三重指數平滑', 'TRIX'], ['變動率', 'rate of change'], ['價格通道', 'price channel'], ['唐奇安通道', 'Donchian channel'], ['肯特納通道', 'Keltner channel'], ['超級趨勢', 'Supertrend'], ['渦流指標', 'vortex indicator'], ['鱷魚線', 'alligator indicator'], ['費波那契', 'Fibonacci'], ['黃金分割', 'Fibonacci retracement'],
  ['寶塔線', 'tower chart'], ['心理線', 'psychological line'], ['人氣指標', 'AR BR indicator'], ['意願指標', 'AR BR indicator'], ['累積派發', 'accumulation distribution'], ['佳慶', 'Chaikin oscillator'], ['力度指標', 'force index'], ['強力指數', 'force index'], ['終極指標', 'ultimate oscillator'], ['阿隆', 'Aroon'], ['中軸', 'pivot point'], ['樞軸點', 'pivot point'], ['樞紐點', 'pivot point'],
  ['吊人線', 'hanging man candlestick'], ['錘子線', 'hammer candlestick'], ['十字星', 'doji'], ['吞噬', 'engulfing pattern'], ['晨星', 'morning star candlestick'], ['夜星', 'evening star candlestick'], ['三白兵', 'three white soldiers'], ['三黑鴉', 'three black crows'], ['頭肩頂', 'head and shoulders'], ['頭肩底', 'head and shoulders'], ['雙重頂', 'double top'], ['雙重底', 'double bottom'], ['旗形', 'flag pattern'], ['三角收斂', 'triangle pattern'], ['楔形', 'wedge pattern'], ['杯柄', 'cup and handle'], ['缺口', 'gap'], ['跳空', 'gap']
]);
// Generic price-action vocabulary the engine can express without any named indicator; never a reason to block.
const GENERIC_WORDS = ['收盤價', '開盤價', '最高價', '最低價', '收盤', '開盤', '最高', '最低', '股價', '價格', '價', '漲幅', '跌幅', '漲跌幅', '漲', '跌', '紅k', '黑k', '綠k', '陽線', '陰線', '紅棒', '黑棒', '連續', '相對', '當日', '今日', '今天', '前', '均量', '量', '乖離率', '乖離', '波動率', '振幅', '區間', '高點', '低點', '前高', '前低', '盤中', '開盤以來', '漲停', '跌停', '長紅', '長黑', '十字', '實體', '影線', '上影線', '下影線', '均價', '成交金額', '金額',
  'close', 'open', 'high', 'low', 'price', 'volume', 'change', 'gain', 'loss', 'range', 'candle', 'candlestick', 'bias', 'atr', 'tr', 'vwap', 'obv', 'macd', 'rsi', 'kd', 'sma', 'ema', 'rma', 'wma', 'ma', 'dif', 'dea', 'bb', 'k', 'd', 'j', 'stdev', 'stddev', 'highest', 'lowest', 'average', 'avg', 'mean', 'sum', 'typical'];

export const INDICATOR_WHITELIST = Object.freeze([...new Set([
  ...ALIAS_SYNONYMS.flatMap(([, words]) => words),
  ...FAMILY_ORDER.filter((name) => name !== '其他'),
  'kd指標', 'k值', 'd值', 'k線', 'rsv', '布林上軌', '布林下軌', '轉換線', '基準線', '先行帶', '遲行帶', '雲層', '雲帶', '一目雲', '上軌', '下軌', '中軌', '均量', 'atr', '真實波幅', 'obv', '能量潮', 'vwap', '成交量加權平均價', '成交量加權均價', '威廉%r', 'williams %r', '%r',
  ...GENERIC_WORDS
].map((word) => normalizeWord(word)))].filter(Boolean).sort((a, b) => b.length - a.length));

function normalizeWord(word) { return String(word).normalize('NFKC').toLowerCase().trim(); }

// Returns { candidates, remainder, indicatorName, tokens }. candidates is [] when nothing is left to look up.
export function extractIndicatorCandidates(text) {
  let value = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  const lower = value.toLowerCase();
  // Strip numbers (with sign / decimals / %) and Chinese numerals used as quantities, then units and direction words.
  const units = '根|倍|次|日|天|分鐘|分|個|條|檔|期|點|k線|k棒|bars?|times|x';
  let cleaned = lower.replace(new RegExp(`[-+]?\\d+(\\.\\d+)?\\s*(%|${units})?(?![a-z])`, 'g'), ' ').replace(new RegExp(`[零一二三四五六七八九十兩百千]+\\s*(${units}|%)`, 'g'), ' ');
  for (const word of [...DIRECTION_WORDS].sort((a, b) => b.length - a.length)) cleaned = cleaned.split(normalizeWord(word)).join(' ');
  for (const unit of UNIT_WORDS) cleaned = cleaned.replace(new RegExp(`(^|\\s)${escapeRegExp(unit)}(?=\\s|$)`, 'g'), ' ');
  cleaned = cleaned.replace(/[^\p{L}\p{N}%]+/gu, ' ').replace(/\s+/g, ' ').trim();
  // Tokens: latin words and CJK runs; CJK runs are split further by whitelisted words so「布林背離」→ 布林 + 背離.
  // Latin tokens keep the user's casing (MACD stays MACD) for the candidate strings.
  const rawTokens = cleaned.match(/[一-鿿]+|[a-z][a-z0-9%]*/g) || [];
  const tokens = [];
  for (const token of rawTokens) {
    if (!/[一-鿿]/.test(token)) { tokens.push({ text: value.match(new RegExp(`(?<![a-z])${escapeRegExp(token)}(?![a-z])`, 'i'))?.[0] ?? token, known: INDICATOR_WHITELIST.includes(token) }); continue; }
    for (const piece of splitByWhitelist(token)) tokens.push(piece);
  }
  const indicatorName = tokens.map((token) => token.text).join(' ');
  const remainder = tokens.filter((token) => !token.known).map((token) => token.text).join('');
  const candidates = [];
  if (tokens.length && remainder.length >= 2) {
    candidates.push(tokens.map((token) => token.text).join(' '));
    const translated = tokens.map((token) => (/[一-鿿]/.test(token.text) ? translate(token.text) : token.text)).join(' ');
    if (translated !== candidates[0] && !/[一-鿿]/.test(translated)) candidates.push(translated);
  }
  return { candidates: candidates.slice(0, MAX_CANDIDATES), remainder, indicatorName, tokens: tokens.map((token) => token.text) };
}
function splitByWhitelist(run) {
  const pieces = []; let buffer = '';
  let index = 0;
  while (index < run.length) {
    const hit = INDICATOR_WHITELIST.find((word) => /[一-鿿]/.test(word) && run.startsWith(word, index));
    if (hit) { if (buffer) { pieces.push({ text: buffer, known: false }); buffer = ''; } pieces.push({ text: hit, known: true }); index += hit.length; continue; }
    buffer += run[index]; index += 1;
  }
  if (buffer) pieces.push({ text: buffer, known: false });
  return pieces;
}
function translate(token) {
  let out = token;
  for (const [zh, en] of ZH_EN_TERMS) if (out.includes(normalizeWord(zh))) out = out.split(normalizeWord(zh)).join(` ${en} `);
  for (const [token2, words] of ALIAS_SYNONYMS) { const english = words.find((word) => /^[a-z]/.test(word)); if (!english) continue; for (const word of words) if (/[一-鿿]/.test(word) && out.includes(word)) out = out.split(word).join(` ${english} `); void token2; }
  return out.replace(/\s+/g, ' ').trim();
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const defaultCache = new Map();
export function clearLookupCache() { defaultCache.clear(); }

export async function lookupIndicator(text, { fetchImpl = fetch, cache = defaultCache, now = Date.now, timeoutMs = TIMEOUT_MS, log = console } = {}) {
  const extracted = extractIndicatorCandidates(text);
  const { candidates, remainder } = extracted;
  if (!extracted.tokens.length) return { found: true, skipped: 'too_short', candidates: [], indicatorName: extracted.indicatorName };
  if (!remainder) return { found: true, skipped: 'whitelist', candidates: [], indicatorName: extracted.indicatorName };
  if (remainder.length < 2 || !candidates.length) return { found: true, skipped: 'too_short', candidates, indicatorName: extracted.indicatorName };
  const cacheKey = candidates.join('|');
  const cached = cache.get(cacheKey);
  if (cached && now() - cached.at < CACHE_TTL_MS) return { ...cached.result, cached: true };
  const queries = candidates.flatMap((candidate) => [['zh', candidate], ['en', candidate]]);
  const outcomes = await Promise.all(queries.map(([lang, candidate]) => searchWikipedia(lang, candidate, { fetchImpl, timeoutMs })));
  const hits = [], errors = [];
  outcomes.forEach((outcome, index) => {
    const [lang, candidate] = queries[index];
    if (outcome.error) { errors.push(`${lang}:${outcome.error}`); return; }
    const matched = outcome.results.find((item) => matches(item, candidate));
    if (matched) hits.push({ lang, candidate, title: matched.title });
  });
  let result;
  if (hits.length) result = { found: true, candidates, indicatorName: extracted.indicatorName, matched: hits[0] };
  else if (errors.length) { result = { found: null, candidates, indicatorName: extracted.indicatorName, error: errors.join(',') }; log.warn?.(`indicator-lookup: reference unavailable for "${candidates[0]}" (${result.error}); not blocking`); }
  else result = { found: false, candidates, indicatorName: extracted.indicatorName };
  if (result.found !== null) { cache.set(cacheKey, { at: now(), result }); if (cache.size > 5000) cache.delete(cache.keys().next().value); }
  return result;
}

async function searchWikipedia(lang, query, { fetchImpl, timeoutMs }) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&utf8=1`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'watch365-indicator-check/1.0', Accept: 'application/json' } });
    if (!response.ok) return { error: `http_${response.status}` };
    const body = await response.json();
    const results = Array.isArray(body?.query?.search) ? body.query.search.map((item) => ({ title: String(item.title || ''), snippet: String(item.snippet || '') })) : [];
    return { results };
  } catch (error) { return { error: error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : (error.code || error.name || 'fetch_failed') }; }
}
// Every major token of the candidate (latin words, CJK runs ≥ 2 chars; single CJK chars are too weak) must appear.
function matches({ title, snippet }, candidate) {
  const haystack = `${title} ${snippet}`.normalize('NFKC').toLowerCase().replace(/<[^>]+>/g, '').replace(/[\s ]+/g, ' ');
  const compact = haystack.replace(/\s+/g, '');
  const majors = (candidate.normalize('NFKC').toLowerCase().match(/[一-鿿]+|[a-z][a-z0-9%]*/g) || []).filter((token) => !/[一-鿿]/.test(token) || token.length >= 2);
  if (!majors.length) return false;
  return majors.every((token) => haystack.includes(token) || compact.includes(token));
}

// --- Unknown indicator store ------------------------------------------------------------------------------------
export class UnknownIndicatorStore {
  constructor(filePath, { backend = null, log = console } = {}) { this.filePath = filePath; this.backend = backend; this.log = log; this.items = new Map(); this.queue = Promise.resolve(); }
  async load() {
    let rows = [];
    if (this.backend) rows = await this.backend.loadAll();
    else {
      await mkdir(dirname(this.filePath), { recursive: true });
      try { const raw = JSON.parse(await readFile(this.filePath, 'utf8')); if (raw?.version === 1 && Array.isArray(raw.items)) rows = raw.items; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.items = new Map();
    for (const row of rows) if (row && typeof row.norm === 'string') this.items.set(row.norm, { norm: row.norm, text: String(row.text || row.norm), candidates: Array.isArray(row.candidates) ? row.candidates : [], count: Number.isInteger(row.count) ? row.count : 1, firstSeen: row.firstSeen || new Date().toISOString(), lastSeen: row.lastSeen || row.firstSeen || new Date().toISOString() });
    return this;
  }
  // Never rejects (called fire-and-forget from the parse endpoint).
  record({ text, candidates = [] }) {
    const operation = this.queue.then(async () => {
      const norm = normalizeUnknown(candidates[0] || text); if (!norm) return null;
      const now = new Date().toISOString();
      const item = this.items.get(norm) || { norm, text: String(text || '').slice(0, 500), candidates: candidates.slice(0, MAX_CANDIDATES), count: 0, firstSeen: now, lastSeen: now };
      item.count += 1; item.lastSeen = now; item.text = String(text || '').slice(0, 500); item.candidates = candidates.slice(0, MAX_CANDIDATES);
      if (!this.items.has(norm) && this.items.size >= MAX_UNKNOWN) { const oldest = [...this.items.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0]; this.items.delete(oldest.norm); }
      this.items.set(norm, item);
      if (this.backend) await this.backend.upsert(item); else await this.persist();
      return structuredClone(item);
    }).catch((error) => { this.log.error?.('unknown-indicators: record failed', error.code || error.message); return null; });
    this.queue = operation;
    return operation;
  }
  list({ limit = 200 } = {}) { return [...this.items.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, Math.max(1, Math.min(2000, Number(limit) || 200))).map((item) => structuredClone(item)); }
  count() { return this.items.size; }
  async persist() {
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, items: [...this.items.values()] }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}
export function normalizeUnknown(text) { return String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\p{Z}\p{C}\p{P}]/gu, '').slice(0, 255); }
