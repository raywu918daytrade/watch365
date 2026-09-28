import { requestStructuredAgent } from './indicatorAgent.js';
import { validateStrategy } from './indicatorRegistry.js';
import { formulaSummary, validateFormula } from './formulaEngine.js';

const NAME='plan_monitor_condition';
const NODE_OPS=['source','constant','add','sub','mul','div','sma','ema','crosses_above','crosses_below','gte','lte','all'];
const nullableString={type:['string','null']};
const nullableNumber={type:['number','null']};
export const FORMULA_PLAN_SCHEMA={type:'object',additionalProperties:false,properties:{
  status:{type:'string',enum:['existing','formula','clarification','discussion']},message:{type:'string'},name:{type:'string'},timeframe:{type:['string','null'],enum:['1m',null]},
  indicatorId:nullableString,version:nullableString,params:{type:'object',additionalProperties:false,properties:{period:nullableNumber,threshold:nullableNumber},required:['period','threshold']},
  nodes:{type:'array',maxItems:32,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},op:{type:'string',enum:NODE_OPS},field:{type:['string','null'],enum:['close','volume',null]},value:nullableNumber,period:nullableNumber,inputId:nullableString,leftId:nullableString,rightId:nullableString},required:['id','op','field','value','period','inputId','leftId','rightId']}},rootId:nullableString
},required:['status','message','name','timeframe','indicatorId','version','params','nodes','rootId']};

export async function planMonitorCondition(text,definitions,{context=[],...options}={}){
  const request=String(text||'').trim();if(!request)throw plannerError('INDICATOR_AGENT_INPUT_REQUIRED',400);if(request.length>500)throw plannerError('INDICATOR_AGENT_INPUT_TOO_LONG',400);
  const history=validateContext(context);
  const registry=definitions.map(({id,version,name,timeframe,params,condition})=>({id,version,name,timeframe,params,condition}));
  const system=[
    '你是台股盤中監控條件規劃器，只能輸出 schema，不得執行程式。所有說明使用繁體中文。',
    '只允許當日已完成的一分鐘K：close、volume、常數、add/sub/mul/div、任意數值序列的SMA/EMA、crosses_above/crosses_below/gte/lte，以及最多兩條布林條件的all。週期2到200；總暖機需求不可超過台股當日270根完整K，不可跨日補資料。',
    'nodes 必須依相依順序排列且 id 唯一；source填field；constant填value；sma/ema填inputId與period；二元運算與比較填leftId/rightId；all也用leftId/rightId。其他不適用欄位一律null。rootId指向最後布林節點。',
    'MACD(12,26,9)表示 EMA(close,12)-EMA(close,26)，訊號線表示 EMA(前述差值,9)，可直接產生公式，不要回discussion。',
    '使用者明確指定可計算公式且資訊完整時回formula。能完全對應Registry時回existing。缺少週期、比較方向、比較對象或門檻時回clarification且message只問必要問題，禁止猜測。要求5分、日線、跨股票、外部資料、未完成K、超過當日270根暖機或能力外運算時回discussion，message需提出可計算的替代方向並說明必須由使用者確認。',
    'formula與existing都必須明確是1m；使用者未指定資料週期時回clarification。existing才填indicatorId/version/params；formula才填nodes/rootId。',
    `Registry: ${JSON.stringify(registry)}`
  ].join('\n');
  const user=history.length?JSON.stringify({previousConversation:history,currentReply:request}):request;
  const {raw,status}=await requestStructuredAgent(system,user,FORMULA_PLAN_SCHEMA,NAME,options);
  return validatePlan(raw,definitions,status);
}

export function validatePlan(raw,definitions,provider={provider:'stub',model:'stub'}){
  exactObject(raw,Object.keys(FORMULA_PLAN_SCHEMA.properties));
  if(!['existing','formula','clarification','discussion'].includes(raw.status)||typeof raw.message!=='string'||typeof raw.name!=='string'||![null,'1m'].includes(raw.timeframe))throw plannerError('FORMULA_PLAN_INVALID',422);
  if(![raw.indicatorId,raw.version,raw.rootId].every((value)=>value===null||typeof value==='string')||!raw.params||typeof raw.params!=='object'||Array.isArray(raw.params)||Object.keys(raw.params).sort().join(',')!=='period,threshold'||![raw.params.period,raw.params.threshold].every((value)=>value===null||Number.isFinite(value))||!Array.isArray(raw.nodes))throw plannerError('FORMULA_PLAN_INVALID',422);
  if(raw.status==='clarification'||raw.status==='discussion'){if(raw.nodes.length||raw.rootId!==null||raw.indicatorId!==null||raw.version!==null)throw plannerError('FORMULA_PLAN_INVALID',422);return{status:raw.status,message:raw.message||'請補充監控條件。',provider};}
  if(raw.timeframe!=='1m')throw plannerError('FORMULA_PLAN_INVALID',422);
  if(raw.status==='existing'){
    if(raw.nodes.length||raw.rootId!==null)throw plannerError('FORMULA_PLAN_INVALID',422);
    const definition=definitions.find((item)=>item.id===raw.indicatorId&&item.version===raw.version);if(!definition)throw plannerError('FORMULA_PLAN_INVALID',422);
    const params={};for(const schema of definition.params){const value=raw.params[schema.key];if(value==null)throw plannerError('FORMULA_PLAN_INVALID',422);params[schema.key]=value;}
    let strategy;try{strategy=validateStrategy({id:definition.id,version:definition.version,timeframe:'1m',params},definition);}catch{throw plannerError('FORMULA_PLAN_INVALID',422);}
    return{status:'existing',summary:`${definition.name}${definition.params.length?`（${definition.params.map((item)=>`${item.label} ${strategy.params[item.key]}`).join('、')}）`:''} · M1`,proposal:{id:strategy.id,version:strategy.version,timeframe:'1m',definitionFingerprint:definition.fingerprint,params:strategy.params},provider};
  }
  if(raw.indicatorId!==null||raw.version!==null||raw.params.period!==null||raw.params.threshold!==null)throw plannerError('FORMULA_PLAN_INVALID',422);
  const ast=compileGraph(raw.nodes,raw.rootId);let validated;try{validated=validateFormula(ast);}catch{throw plannerError('FORMULA_PLAN_INVALID',422);}
  const name=raw.name.trim();if(name.length<2||name.length>100)throw plannerError('FORMULA_PLAN_INVALID',422);
  return{status:'formula',summary:`${name} · 一分鐘`,formulaSummary:formulaSummary(ast),proposal:{name,ast:validated.ast,fingerprint:validated.fingerprint,warmupBars:validated.warmupBars},provider};
}

function compileGraph(nodes,rootId){if(!Array.isArray(nodes)||nodes.length<1||nodes.length>32||typeof rootId!=='string')throw plannerError('FORMULA_PLAN_INVALID',422);const built=new Map();for(const node of nodes){exactObject(node,['id','op','field','value','period','inputId','leftId','rightId']);if(!/^[a-z0-9][a-z0-9_]{0,31}$/i.test(node.id)||built.has(node.id)||!NODE_OPS.includes(node.op))throw plannerError('FORMULA_PLAN_INVALID',422);validateNodeFields(node);let ast;if(node.op==='source')ast={op:'source',field:node.field};else if(node.op==='constant')ast={op:'constant',value:node.value};else if(['sma','ema'].includes(node.op))ast={op:node.op,input:lookup(built,node.inputId),period:node.period};else if(node.op==='all')ast={op:'all',items:[lookup(built,node.leftId),lookup(built,node.rightId)]};else ast={op:node.op,left:lookup(built,node.leftId),right:lookup(built,node.rightId)};built.set(node.id,ast);}return lookup(built,rootId);}
function validateNodeFields(node){const nulled=(...keys)=>keys.every((key)=>node[key]===null);if(node.op==='source'&&['close','volume'].includes(node.field)&&nulled('value','period','inputId','leftId','rightId'))return;if(node.op==='constant'&&Number.isFinite(node.value)&&nulled('field','period','inputId','leftId','rightId'))return;if(['sma','ema'].includes(node.op)&&Number.isInteger(node.period)&&typeof node.inputId==='string'&&nulled('field','value','leftId','rightId'))return;if(['add','sub','mul','div','crosses_above','crosses_below','gte','lte','all'].includes(node.op)&&typeof node.leftId==='string'&&typeof node.rightId==='string'&&nulled('field','value','period','inputId'))return;throw plannerError('FORMULA_PLAN_INVALID',422);}
function validateContext(value){if(!Array.isArray(value)||value.length>4)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return value.map((item)=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='request,response'||typeof item.request!=='string'||typeof item.response!=='string'||item.request.length>500||item.response.length>500)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return{request:item.request,response:item.response};});}
function lookup(map,id){if(typeof id!=='string'||!map.has(id))throw plannerError('FORMULA_PLAN_INVALID',422);return map.get(id);}
function exactObject(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some((key)=>!keys.includes(key)))throw plannerError('FORMULA_PLAN_INVALID',422);}
function plannerError(code,statusCode){return Object.assign(new Error(code),{code,statusCode});}
