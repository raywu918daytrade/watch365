import { validateFormula, FORMULA_VERSION } from './formulaEngine.js';

// Translates the structured conditions from the new UI into a single backend strategy.
// Registry executors cover single RSI/SMA upward crosses; everything else (EMA, downward crosses,
// two combined conditions) becomes a formula_v1 AST. The backend runs one strategy at a time.
// Formula `all` accepts 2–4 boolean items; this structured UI path keeps its own limit of two conditions.
export const CONDITION_INDICATORS=['rsi','sma','ema'];
export const CONDITION_DIRECTIONS=['above','below'];
const MAX_CONDITIONS=2;

export function parseConditions(input){
  if(!Array.isArray(input)||!input.length)throw conditionError('CONDITIONS_REQUIRED');
  if(input.length>MAX_CONDITIONS)throw conditionError('CONDITIONS_TOO_MANY');
  return input.map((item)=>{
    if(!item||typeof item!=='object'||Array.isArray(item))throw conditionError('CONDITION_INVALID');
    const indicator=String(item.indicator||''),direction=String(item.direction||''),period=Number(item.period);
    if(!CONDITION_INDICATORS.includes(indicator))throw conditionError('CONDITION_INDICATOR_UNSUPPORTED');
    if(!CONDITION_DIRECTIONS.includes(direction))throw conditionError('CONDITION_DIRECTION_INVALID');
    if(!Number.isInteger(period)||period<2||period>(indicator==='rsi'?100:200))throw conditionError('CONDITION_PERIOD_INVALID');
    if(indicator!=='rsi')return{indicator,direction,period,threshold:null};
    const threshold=Number(item.threshold);
    if(!Number.isFinite(threshold)||threshold<1||threshold>99)throw conditionError('CONDITION_THRESHOLD_INVALID');
    return{indicator,direction,period,threshold};
  });
}

// Returns either {kind:'registry', request:{id,version,params}} for indicatorRegistry.resolve/validateStrategy,
// or {kind:'formula', strategy:{...}} ready for validateFormulaStrategy.
export function planConditionStrategy(conditions){
  const parsed=parseConditions(conditions);
  if(parsed.length===1&&parsed[0].direction==='above'&&parsed[0].indicator==='rsi')return{kind:'registry',request:{id:'rsi.cross',version:'1.0.0',params:{period:parsed[0].period,threshold:parsed[0].threshold}}};
  if(parsed.length===1&&parsed[0].direction==='above'&&parsed[0].indicator==='sma')return{kind:'registry',request:{id:'sma.cross',version:'1.0.0',params:{period:parsed[0].period}}};
  // RSI only exists as a registry executor (upward cross); the formula engine has no RSI operator.
  if(parsed.some((item)=>item.indicator==='rsi'))throw conditionError(parsed.length>1?'CONDITION_RSI_COMBINATION_UNSUPPORTED':'CONDITION_RSI_BELOW_UNSUPPORTED');
  const nodes=parsed.map(crossNode);
  const ast=nodes.length===1?nodes[0]:{op:'all',items:nodes};
  const validated=validateFormula(ast);
  return{kind:'formula',strategy:{id:'formula.custom',version:FORMULA_VERSION,executor:'formula_v1',name:conditionsName(parsed),timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:validated.fingerprint,params:{},formula:{ast:validated.ast}}};
}

export function conditionsName(conditions){
  return conditions.map((item)=>`${item.indicator.toUpperCase()} ${item.period} ${item.direction==='above'?'上穿':'下穿'}${item.threshold===null?'':` ${item.threshold}`}`).join(' ＋ ');
}

function crossNode({indicator,direction,period}){
  const close={op:'source',field:'close'};
  return{op:direction==='above'?'crosses_above':'crosses_below',left:close,right:{op:indicator,input:{op:'source',field:'close'},period}};
}

function conditionError(code){return Object.assign(new Error(code),{code,statusCode:422});}
