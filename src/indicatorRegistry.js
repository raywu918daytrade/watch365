import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { FORMULA_VERSION, formulaSummary, validateFormula } from './formulaEngine.js';

export const EXECUTOR_WHITELIST = new Set(['high_volume_breakout', 'sma_cross', 'rsi_wilder_cross']);
export const DEFAULT_REGISTRY_DIR = new URL('../config/indicators/', import.meta.url).pathname;

export class IndicatorRegistry {
  constructor(directory = process.env.INDICATOR_REGISTRY_DIR || DEFAULT_REGISTRY_DIR, lockPath = process.env.INDICATOR_REGISTRY_LOCK) { this.directory = resolve(directory); this.lockPath=resolve(lockPath || new URL('../config/indicator-registry-lock.json', import.meta.url).pathname); }

  async list() {
    return (await this.load()).items;
  }

  async load() {
    const files = (await readdir(this.directory)).filter((name) => name.endsWith('.json') && resolve(this.directory,name) !== this.lockPath).sort();
    const definitions = [];
    const errors = [];
    let lock={}; try{lock=JSON.parse(await readFile(this.lockPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
    let lockChanged=false;
    for (const file of files) {
      try {
        const definition=validateDefinition(JSON.parse(await readFile(resolve(this.directory, file), 'utf8')));
        const key=identity(definition.id,definition.version); const fingerprint=definitionFingerprint(definition);
        if(lock[key] && lock[key]!==fingerprint)throw registryError('INDICATOR_VERSION_MUTATED');
        if(!lock[key]){lock[key]=fingerprint;lockChanged=true;}
        definitions.push(Object.freeze({...definition,fingerprint}));
      } catch(error) { errors.push({file,code:error.code||'INDICATOR_DEFINITION_INVALID'}); }
    }
    const identities = new Set();
    const items=[];
    for (const definition of definitions) {
      const key = identity(definition.id, definition.version);
      if (identities.has(key)) { errors.push({file:null,code:'INDICATOR_VERSION_DUPLICATED',identity:key}); continue; }
      identities.add(key);
      items.push(definition);
    }
    if(lockChanged)await writeFile(this.lockPath,`${JSON.stringify(lock,null,2)}\n`,'utf8');
    return {items,errors};
  }

  async resolve(id, version) {
    const definition = (await this.list()).find((item) => item.id === id && item.version === version);
    if (!definition) throw registryError('INDICATOR_VERSION_UNAVAILABLE');
    return definition;
  }
}

export function validateDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw registryError('INDICATOR_DEFINITION_INVALID');
  const allowed = new Set(['id','version','name','description','executor','timeframe','source','warmupBars','params','condition']);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw registryError('INDICATOR_FIELD_UNKNOWN');
  if (!/^[a-z][a-z0-9.-]{2,63}$/.test(input.id || '')) throw registryError('INDICATOR_ID_INVALID');
  if (!/^\d+\.\d+\.\d+$/.test(input.version || '')) throw registryError('INDICATOR_VERSION_INVALID');
  if (!EXECUTOR_WHITELIST.has(input.executor)) throw registryError('INDICATOR_EXECUTOR_NOT_ALLOWED');
  if (input.timeframe !== '1m') throw registryError('INDICATOR_TIMEFRAME_UNSUPPORTED');
  if (input.source !== 'db/m1_live/{tradingDate}.parquet') throw registryError('INDICATOR_SOURCE_UNSUPPORTED');
  if (!Number.isInteger(input.warmupBars) || input.warmupBars < 0 || input.warmupBars > 500) throw registryError('INDICATOR_WARMUP_INVALID');
  if (!String(input.name || '').trim() || !String(input.description || '').trim()) throw registryError('INDICATOR_TEXT_REQUIRED');
  if (!Array.isArray(input.params) || !input.condition || typeof input.condition !== 'object') throw registryError('INDICATOR_SCHEMA_INVALID');
  const keys = new Set();
  const params = input.params.map((param) => {
    if (!/^[a-z][a-zA-Z0-9]*$/.test(param?.key || '') || keys.has(param.key)) throw registryError('INDICATOR_PARAM_INVALID');
    keys.add(param.key);
    if (!['integer','number'].includes(param.type) || !Number.isFinite(param.min) || !Number.isFinite(param.max) || param.min > param.max) throw registryError('INDICATOR_PARAM_INVALID');
    if (!Number.isFinite(param.default) || param.default < param.min || param.default > param.max || (param.type === 'integer' && !Number.isInteger(param.default))) throw registryError('INDICATOR_PARAM_DEFAULT_INVALID');
    return { key:param.key, label:String(param.label || param.key), type:param.type, min:param.min, max:param.max, default:param.default };
  });
  validateExecutorSchema(input,params);
  return Object.freeze({ ...structuredClone(input), params:Object.freeze(params) });
}

export function validateStrategy(input, definition, activatedAt = new Date().toISOString()) {
  if (!input || input.id !== definition.id || input.version !== definition.version || input.timeframe && input.timeframe !== definition.timeframe) throw registryError('INDICATOR_VERSION_MISMATCH');
  const supplied = input.params || {};
  if (Object.keys(supplied).some((key) => !definition.params.some((param) => param.key === key))) throw registryError('INDICATOR_PARAM_UNKNOWN');
  const params = {};
  for (const schema of definition.params) {
    const value = supplied[schema.key] ?? schema.default;
    if (!Number.isFinite(value) || value < schema.min || value > schema.max || (schema.type === 'integer' && !Number.isInteger(value))) throw registryError('INDICATOR_PARAM_INVALID');
    params[schema.key] = value;
  }
  return { id:definition.id, version:definition.version, executor:definition.executor, name:definition.name, timeframe:definition.timeframe, source:definition.source, definitionFingerprint:definition.fingerprint || definitionFingerprint(definition), params, activatedAt };
}

export function validateFormulaStrategy(input, activatedAt = new Date().toISOString()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw registryError('INDICATOR_STRATEGY_INVALID');
  const allowed=new Set(['id','version','executor','name','timeframe','source','definitionFingerprint','params','formula','activatedAt']);
  if(Object.keys(input).some((key)=>!allowed.has(key)))throw registryError('INDICATOR_FIELD_UNKNOWN');
  if(input.id!=='formula.custom'||input.version!==FORMULA_VERSION||input.executor!=='formula_v1'||input.timeframe!=='1m'||input.source!=='db/m1_live/{tradingDate}.parquet')throw registryError('INDICATOR_VERSION_MISMATCH');
  if(input.params&&Object.keys(input.params).length)throw registryError('INDICATOR_PARAM_UNKNOWN');
  const validated=validateFormula(input.formula?.ast);
  if(input.definitionFingerprint!==validated.fingerprint)throw registryError('INDICATOR_VERSION_MISMATCH');
  const name=String(input.name||'').trim();if(name.length<2||name.length>100)throw registryError('INDICATOR_TEXT_REQUIRED');
  return{id:'formula.custom',version:FORMULA_VERSION,executor:'formula_v1',name,timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:validated.fingerprint,params:{},formula:{ast:validated.ast,summary:formulaSummary(validated.ast),warmupBars:validated.warmupBars},activatedAt};
}

export function strategyIdentity(strategy) { return `${strategy.id}@${strategy.version}:${strategy.timeframe}:${strategy.definitionFingerprint || 'legacy-unlocked'}:${stableParams(strategy.params)}`; }
export function legacyStrategy(activatedAt = new Date().toISOString()) { return { id:'legacy.breakout-volume', version:'1.0.0', executor:'high_volume_breakout', name:'突破今日高點＋成交量放大', timeframe:'1m', source:'db/m1_live/{tradingDate}.parquet', params:{}, activatedAt }; }
function stableParams(params = {}) { return Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join(','); }
function identity(id, version) { return `${id}@${version}`; }
export function definitionFingerprint(definition){return createHash('sha256').update(JSON.stringify(canonicalize({...definition,fingerprint:undefined}))).digest('hex');}
function canonicalize(value){if(Array.isArray(value))return value.map(canonicalize);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).filter((key)=>value[key]!==undefined).sort().map((key)=>[key,canonicalize(value[key])]));return value;}
function validateExecutorSchema(input,params){
  const keys=params.map((param)=>param.key).join(','); const condition=input.condition;
  if(input.executor==='high_volume_breakout'&&(keys||condition.operator!=='all'))throw registryError('INDICATOR_EXECUTOR_SCHEMA_INVALID');
  if(input.executor==='sma_cross'&&(keys!=='period'||condition.operator!=='crosses_above'||condition.left!=='close'||condition.right!=='sma'))throw registryError('INDICATOR_EXECUTOR_SCHEMA_INVALID');
  if(input.executor==='rsi_wilder_cross'&&(keys!=='period,threshold'||condition.operator!=='crosses_above'||condition.left!=='rsi'||condition.right!=='threshold'))throw registryError('INDICATOR_EXECUTOR_SCHEMA_INVALID');
  const period=params.find((param)=>param.key==='period'); const threshold=params.find((param)=>param.key==='threshold');
  if(period&&(period.type!=='integer'||period.min<2||period.max>200))throw registryError('INDICATOR_EXECUTOR_SCHEMA_INVALID');
  if(threshold&&(threshold.min<1||threshold.max>99))throw registryError('INDICATOR_EXECUTOR_SCHEMA_INVALID');
}
function registryError(code) { return Object.assign(new Error(code), { code, statusCode:400 }); }
