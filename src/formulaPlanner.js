import { analyzeIndicatorRequest, requestStructuredAgent } from './indicatorAgent.js';
import { validateStrategy } from './indicatorRegistry.js';
import { FORMULA_OPS, FORMULA_SOURCE_FIELDS, formulaSummary, validateFormula } from './formulaEngine.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';

const NAME='plan_monitor_condition';
const NODE_OPS=[...FORMULA_OPS];
const NODE_KEYS=['id','op','field','value','period','inputId','leftId','rightId','itemIds'];
const MAX_GRAPH_NODES=40;
// Node field usage (all others must be null):
//   source: field · constant: value · sma/ema/rma/highest/lowest/stddev/prev: inputId+period · abs: inputId
//   add/sub/mul/div/max/min and comparisons: leftId+rightId · all/any: itemIds (2–4 ids)
const INPUT_PERIOD_OPS=['sma','ema','rma','highest','lowest','stddev','prev'];
const LEFT_RIGHT_OPS=['add','sub','mul','div','max','min','crosses_above','crosses_below','gte','lte','gt','lt'];
const nullableString={type:['string','null']};
const nullableNumber={type:['number','null']};
export const FORMULA_PLAN_SCHEMA={type:'object',additionalProperties:false,properties:{
  status:{type:'string',enum:['existing','formula','clarification','discussion']},message:{type:'string'},name:{type:'string'},timeframe:{type:['string','null'],enum:['1m',null]},
  indicatorId:nullableString,version:nullableString,params:{type:'object',additionalProperties:false,properties:{period:nullableNumber,threshold:nullableNumber},required:['period','threshold']},
  nodes:{type:'array',maxItems:MAX_GRAPH_NODES,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},op:{type:'string',enum:NODE_OPS},field:{type:['string','null'],enum:[...FORMULA_SOURCE_FIELDS,null]},value:nullableNumber,period:nullableNumber,inputId:nullableString,leftId:nullableString,rightId:nullableString,itemIds:{type:['array','null'],items:{type:'string'},maxItems:4}},required:NODE_KEYS}},rootId:nullableString
},required:['status','message','name','timeframe','indicatorId','version','params','nodes','rootId']};

export async function planMonitorCondition(text,definitions,{context=[],...options}={}){
  const request=String(text||'').trim();if(!request)throw plannerError('INDICATOR_AGENT_INPUT_REQUIRED',400);if(request.length>500)throw plannerError('INDICATOR_AGENT_INPUT_TOO_LONG',400);
  const history=validateContext(context);
  const registryResult=await analyzeIndicatorRequest(request,definitions,{...options,context:history});
  if(registryResult.status==='matched')return{status:'existing',summary:registryResult.summary,proposal:registryResult.proposal,provider:registryResult.provider};
  // A registry match that only lacked parameters is applied with the registry defaults (shown in the summary)
  // instead of asking again: users should get a usable condition on the first try.
  if(registryResult.status==='clarification'&&registryResult.proposal)return{status:'existing',summary:`${registryResult.summary}（未指定的參數已套用預設值，可再調整）`,proposal:registryResult.proposal,provider:registryResult.provider};
  if(registryResult.status==='clarification')return{status:'clarification',message:registryResult.question,provider:registryResult.provider};
  const deterministic=knownUnsupportedFormula(registryResult,definitions);if(deterministic)return deterministic;
  // Only a timeframe the engine can't run (d1, 5m, …) ends here; any other registry miss (other direction,
  // combinations, extra filters) goes on to formula planning.
  if(['d1','other'].includes(registryResult.requestDraft?.requestedTimeframe))return{status:'discussion',message:'目前只支援一分鐘 K 盤中監控，日 K／其他週期尚未開放。可以改用一分鐘 K 的同一條件，例如「收盤上穿 SMA(20)」。',provider:registryResult.provider};
  const registry=definitions.map(({id,version,name,timeframe,params,condition})=>({id,version,name,timeframe,params,condition}));
  const system=[
    '你是台股盤中監控條件規劃器，只能輸出 schema，不得執行程式。所有說明使用繁體中文。',
    '系統只有一分鐘K；使用者沒講週期時一律視為一分鐘K，timeframe填1m，絕不為了週期追問。只允許當日已完成的一分鐘K，可用積木：source(open/high/low/close/volume)、constant、add/sub/mul/div/max/min、abs、sma/ema/rma(Wilder平滑，SMA作種子)/highest/lowest/stddev(母體標準差)、prev(前n根，n=1..60)、crosses_above/crosses_below/gte/lte/gt/lt，以及all(且)/any(或) 2到4條布林條件。視窗期數2到200；總暖機需求不可超過台股當日270根完整K，不可跨日補資料。',
    'nodes 必須依相依順序排列且 id 唯一，可重複引用同一節點；source填field；constant填value；sma/ema/rma/highest/lowest/stddev/prev填inputId與period；abs填inputId；add/sub/mul/div/max/min與比較填leftId/rightId；all/any填itemIds陣列(2到4個布林節點id)。其他不適用欄位一律null。rootId指向最後布林節點。',
    '台股常見指標標準組法（以下範例只列非null欄位，實際輸出時其餘欄位填null；照抄結構、替換參數即可）：',
    ...FORMULA_RECIPES.map((recipe)=>`- ${recipe.name}：${compactGraph(toGraph(recipe.ast))}`),
    '補充定義：KD的RSV=(收盤-最低價N根最低)÷(最高價N根最高-最低價N根最低)×100，K=rma(RSV,3)、D=rma(K,3)，等同台股 K=⅔前K+⅓RSV。RSI用Wilder平滑(rma)。威廉%R=(N根最高-收盤)÷(N根最高-N根最低)×(-100)。「突破前N根最高」要先highest再prev 1，避免包含當根。「漲幅超過X%」定義為收盤≥前N根收盤×(1+X/100)，未指定N時用前1根，把N寫進name。「量增／爆量」未指定時用成交量≥前20根均量×2。',
    '這是公式階段，只能回formula、clarification或discussion，禁止回existing。目標是讓使用者第一次就拿到可監控的條件：只要能用允許的運算組出來就回formula。參數沒講就用業界常用預設值（例如MACD 12/26/9、均線20、成交量均量20根與2倍），「MA」未指明時用SMA，「黃金交叉／突破／站上」視為向上穿越、「死亡交叉／跌破」視為向下穿越，並把採用的參數寫進name。只有連要看哪個指標都無法判斷時才回clarification。要求5分、日線、跨股票、籌碼、財報、新聞等外部資料、未完成K、超過當日270根暖機，或允許的運算確實組不出來時才回discussion，message用一句話說明原因，再給一個可用一分鐘K計算、最接近的替代條件寫法。',
    'name與message只描述條件本身，使用中性用語，不得出現買進、賣出、超買、超賣、轉強、訊號等判斷字眼。formula的indicatorId/version與params值一律null，只填nodes/rootId。',
    `Registry: ${JSON.stringify(registry)}`
  ].join('\n');
  const user=history.length?JSON.stringify({previousConversation:history,currentReply:request}):request;
  // Graphs such as KD or RSI need ~15–20 nodes, so allow more output tokens than the registry pass.
  const {raw,status}=await requestStructuredAgent(system,user,FORMULA_PLAN_SCHEMA,NAME,{maxTokens:4000,...options});
  const result=validatePlan(raw,definitions,status);
  if(result.status==='existing')throw plannerError('FORMULA_PLAN_INVALID',422);
  return result;
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
    for(const key of ['period','threshold'])if(!definition.params.some((item)=>item.key===key)&&raw.params[key]!==null)throw plannerError('FORMULA_PLAN_INVALID',422);
    const params={};for(const schema of definition.params){const value=raw.params[schema.key];if(value==null)throw plannerError('FORMULA_PLAN_INVALID',422);params[schema.key]=value;}
    let strategy;try{strategy=validateStrategy({id:definition.id,version:definition.version,timeframe:'1m',params},definition);}catch{throw plannerError('FORMULA_PLAN_INVALID',422);}
    return{status:'existing',summary:`${definition.name}${definition.params.length?`（${definition.params.map((item)=>`${item.label} ${strategy.params[item.key]}`).join('、')}）`:''} · M1`,proposal:{id:strategy.id,version:strategy.version,timeframe:'1m',definitionFingerprint:definition.fingerprint,params:strategy.params},provider};
  }
  if(raw.indicatorId!==null||raw.version!==null||raw.params.period!==null||raw.params.threshold!==null)throw plannerError('FORMULA_PLAN_INVALID',422);
  const ast=compileGraph(raw.nodes,raw.rootId);let validated;try{validated=validateFormula(ast);}catch{throw plannerError('FORMULA_PLAN_INVALID',422);}
  const name=raw.name.trim();if(name.length<2||name.length>100)throw plannerError('FORMULA_PLAN_INVALID',422);
  return{status:'formula',summary:`${name} · 一分鐘`,formulaSummary:formulaSummary(ast),proposal:{name,ast:validated.ast,fingerprint:validated.fingerprint,warmupBars:validated.warmupBars},provider};
}

function knownUnsupportedFormula(result,definitions){const draft=result.requestDraft;if(!draft||draft.requestedIndicator!=='sma'||!['1m','unknown'].includes(draft.requestedTimeframe)||draft.requestedDirection!=='crosses_below'||(draft.params?.period!=null&&!Number.isFinite(draft.params.period))||draft.params?.threshold!=null)return null;const definition=definitions.find((item)=>item.executor==='sma_cross');if(!definition)return null;const period=draft.params?.period??definition.params.find((item)=>item.key==='period')?.default;let strategy;try{strategy=validateStrategy({id:definition.id,version:definition.version,timeframe:'1m',params:{period}},definition);}catch{return null;}const ast={op:'crosses_below',left:{op:'source',field:'close'},right:{op:'sma',input:{op:'source',field:'close'},period:strategy.params.period}};const validated=validateFormula(ast);return{status:'formula',summary:`價格下穿 SMA ${strategy.params.period} · 一分鐘`,formulaSummary:formulaSummary(validated.ast),proposal:{name:`價格下穿 SMA ${strategy.params.period}`,ast:validated.ast,fingerprint:validated.fingerprint,warmupBars:validated.warmupBars},provider:result.provider};}

function compileGraph(nodes,rootId){if(!Array.isArray(nodes)||nodes.length<1||nodes.length>MAX_GRAPH_NODES||typeof rootId!=='string')throw plannerError('FORMULA_PLAN_INVALID',422);const built=new Map();for(const node of nodes){exactObject(node,NODE_KEYS);if(typeof node.id!=='string'||!/^[a-z0-9][a-z0-9_]{0,31}$/i.test(node.id)||built.has(node.id)||!NODE_OPS.includes(node.op))throw plannerError('FORMULA_PLAN_INVALID',422);validateNodeFields(node);let ast;if(node.op==='source')ast={op:'source',field:node.field};else if(node.op==='constant')ast={op:'constant',value:node.value};else if(INPUT_PERIOD_OPS.includes(node.op))ast={op:node.op,input:lookup(built,node.inputId),period:node.period};else if(node.op==='abs')ast={op:'abs',input:lookup(built,node.inputId)};else if(['all','any'].includes(node.op))ast={op:node.op,items:node.itemIds.map((id)=>lookup(built,id))};else ast={op:node.op,left:lookup(built,node.leftId),right:lookup(built,node.rightId)};built.set(node.id,ast);}return lookup(built,rootId);}
function validateNodeFields(node){const nulled=(...keys)=>keys.every((key)=>node[key]===null);const id=(value)=>typeof value==='string';
  if(node.op==='source'&&FORMULA_SOURCE_FIELDS.includes(node.field)&&nulled('value','period','inputId','leftId','rightId','itemIds'))return;
  if(node.op==='constant'&&typeof node.value==='number'&&Number.isFinite(node.value)&&nulled('field','period','inputId','leftId','rightId','itemIds'))return;
  if(INPUT_PERIOD_OPS.includes(node.op)&&Number.isInteger(node.period)&&id(node.inputId)&&nulled('field','value','leftId','rightId','itemIds'))return;
  if(node.op==='abs'&&id(node.inputId)&&nulled('field','value','period','leftId','rightId','itemIds'))return;
  if(LEFT_RIGHT_OPS.includes(node.op)&&id(node.leftId)&&id(node.rightId)&&nulled('field','value','period','inputId','itemIds'))return;
  if(['all','any'].includes(node.op)&&Array.isArray(node.itemIds)&&node.itemIds.length>=2&&node.itemIds.length<=4&&node.itemIds.every(id)&&new Set(node.itemIds).size===node.itemIds.length&&nulled('field','value','period','inputId','leftId','rightId'))return;
  throw plannerError('FORMULA_PLAN_INVALID',422);}
function compactGraph({nodes,rootId}){return JSON.stringify({nodes:nodes.map((node)=>Object.fromEntries(Object.entries(node).filter(([,value])=>value!==null))),rootId});}
// Renders an AST as the planner's node-graph format (identical sub-trees become one shared node).
export function toGraph(ast){const nodes=[],ids=new Map();const visit=(node)=>{const key=JSON.stringify(node);if(ids.has(key))return ids.get(key);const out={id:null,op:node.op,field:null,value:null,period:null,inputId:null,leftId:null,rightId:null,itemIds:null};if(node.op==='source')out.field=node.field;else if(node.op==='constant')out.value=node.value;else if(node.input){out.inputId=visit(node.input);if('period' in node)out.period=node.period;}else if(node.items)out.itemIds=node.items.map(visit);else{out.leftId=visit(node.left);out.rightId=visit(node.right);}out.id=`n${nodes.length+1}`;nodes.push(out);ids.set(key,out.id);return out.id;};const rootId=visit(ast);return{nodes,rootId};}
function validateContext(value){if(!Array.isArray(value)||value.length>4)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return value.map((item)=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='request,response'||typeof item.request!=='string'||typeof item.response!=='string'||item.request.length>500||item.response.length>500)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return{request:item.request,response:item.response};});}
function lookup(map,id){if(typeof id!=='string'||!map.has(id))throw plannerError('FORMULA_PLAN_INVALID',422);return map.get(id);}
function exactObject(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some((key)=>!keys.includes(key)))throw plannerError('FORMULA_PLAN_INVALID',422);}
function plannerError(code,statusCode){return Object.assign(new Error(code),{code,statusCode});}
