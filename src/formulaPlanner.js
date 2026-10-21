import { analyzeIndicatorRequest, requestStructuredAgent } from './indicatorAgent.js';
import { validateStrategy } from './indicatorRegistry.js';
import { FORMULA_OPS, FORMULA_SOURCE_FIELDS, formulaSummary, validateFormula } from './formulaEngine.js';
import { FORMULA_RECIPES } from './formulaRecipes.js';
import { dailyCapable } from './dailyIndex.js';

const NAME='plan_monitor_condition';
const NODE_OPS=[...FORMULA_OPS];
const NODE_KEYS=['id','op','field','value','period','inputId','leftId','rightId','itemIds'];
const PLAN_KEYS=['status','message','name','timeframe','indicatorId','version','params','nodes','rootId'];
const STATUSES=['existing','formula','clarification','discussion'];
const MAX_GRAPH_NODES=40;
// Node field usage (all others must be null):
//   source: field · constant: value · sma/ema/rma/highest/lowest/stddev/prev: inputId+period · abs: inputId
//   add/sub/mul/div/max/min and comparisons: leftId+rightId · all/any: itemIds (2–4 ids)
const INPUT_PERIOD_OPS=['sma','ema','rma','highest','lowest','stddev','prev'];
const LEFT_RIGHT_OPS=['add','sub','mul','div','max','min','crosses_above','crosses_below','gte','lte','gt','lt'];
const BOOLEAN_OPS=['crosses_above','crosses_below','gte','lte','gt','lt','all','any'];
const nullableString={type:['string','null']};
const nullableNumber={type:['number','null']};
export const FORMULA_PLAN_SCHEMA={type:'object',additionalProperties:false,properties:{
  status:{type:'string',enum:STATUSES},message:{type:'string'},name:{type:'string'},timeframe:{type:['string','null'],enum:['1m',null]},
  indicatorId:nullableString,version:nullableString,params:{type:'object',additionalProperties:false,properties:{period:nullableNumber,threshold:nullableNumber},required:['period','threshold']},
  nodes:{type:'array',maxItems:MAX_GRAPH_NODES,items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},op:{type:'string',enum:NODE_OPS},field:{type:['string','null'],enum:[...FORMULA_SOURCE_FIELDS,null]},value:nullableNumber,period:nullableNumber,inputId:nullableString,leftId:nullableString,rightId:nullableString,itemIds:{type:['array','null'],items:{type:'string'},maxItems:4}},required:NODE_KEYS}},rootId:nullableString
},required:PLAN_KEYS};

// lookupImpl (server: lookupIndicator from indicatorLookup.js) runs before the formula stage: an indicator no
// public reference knows is not built (status 'unknown_indicator'); a lookup failure (found:null) never blocks.
// timeframe 'd1' (the daily filter step): the same blocks evaluated on daily candles. No registry pass (its strategies
// are one-minute ones), daily wording is not a limit, and session-only blocks (first, VWAP-style cumsum÷cumsum) are refused.
export async function planMonitorCondition(text,definitions,{context=[],lookupImpl=null,timeframe='1m',...options}={}){
  if(timeframe==='d1')return planDailyCondition(text,definitions,{context,lookupImpl,...options});
  const request=String(text||'').trim();if(!request)throw plannerError('INDICATOR_AGENT_INPUT_REQUIRED',400);if(request.length>500)throw plannerError('INDICATOR_AGENT_INPUT_TOO_LONG',400);
  const history=validateContext(context);
  // Other timeframes are an engine limit, not something the model should guess at: answer at once with a 1m rewrite.
  const otherTimeframe=detectOtherTimeframe(request);
  if(otherTimeframe&&!history.length)return{status:'discussion',message:otherTimeframe,provider:{provider:'rules',model:'timeframe'}};
  // The registry pass only knows RSI / SMA / the breakout-volume rule. Skip it (and its tokens) when the
  // wording cannot refer to those, and go straight to formula planning.
  const registryResult=needsRegistryPass(request)||history.length?await analyzeIndicatorRequest(request,definitions,{...options,context:history}):{status:'unsupported',reason:'skipped',requestDraft:{requestedIndicator:'other',requestedTimeframe:'1m',requestedDirection:'other',params:{period:null,threshold:null}},provider:null};
  if(registryResult.status==='matched')return{status:'existing',summary:registryResult.summary,proposal:registryResult.proposal,provider:registryResult.provider};
  // A registry match that only lacked parameters is applied with the registry defaults (shown in the summary)
  // instead of asking again: users should get a usable condition on the first try.
  if(registryResult.status==='clarification'&&registryResult.proposal)return{status:'existing',summary:`${registryResult.summary}（未指定的參數已套用預設值，可再調整）`,proposal:registryResult.proposal,provider:registryResult.provider};
  if(registryResult.status==='clarification')return{status:'clarification',message:registryResult.question,provider:registryResult.provider};
  const deterministic=knownUnsupportedFormula(registryResult,definitions);if(deterministic)return deterministic;
  // Only a timeframe the engine can't run (d1, 5m, …) ends here; any other registry miss (other direction,
  // combinations, extra filters) goes on to formula planning.
  if(['d1','other'].includes(registryResult.requestDraft?.requestedTimeframe))return{status:'discussion',message:'目前只支援一分鐘 K 盤中監控，日 K／其他週期尚未開放。可以改用一分鐘 K 的同一條件，例如「收盤上穿 SMA(20)」。',provider:registryResult.provider};
  // Indicator reality check (gate order, PM decision): library → Wikipedia → AI → backtest vet. found:false blocks
  // here with no model call; found:true carries the reference title (canonicalName) into the model's user message so
  // the formula is built for the indicator the reference describes; found:null (reference unavailable) never blocks.
  let canonicalName=null;
  // Requests about 籌碼／法人／昨收／other timeframes name a data limit, not an indicator: the AI's discussion (with a
  // usable alternative) is the right answer there, so the reference check is skipped for them.
  if(lookupImpl&&!history.length&&!mentionsHardLimit(request)){
    let lookup=null;try{lookup=await lookupImpl(request);}catch(error){console.warn(`indicator-lookup: failed ${error.code||error.message}; not blocking`);}
    if(lookup&&lookup.found===false)return unknownIndicatorResult(lookup);
    if(lookup&&lookup.found===true&&typeof lookup.matched?.title==='string'&&lookup.matched.title.trim())canonicalName=lookup.matched.title.trim().slice(0,120);
  }
  const system=buildPlannerSystem(definitions);
  const user=history.length?JSON.stringify({previousConversation:history,currentReply:request}):canonicalName?JSON.stringify({request,canonicalName}):request;
  // Graphs such as KD or RSI need ~15–20 nodes, so allow more output tokens than the registry pass.
  // Formula planning is the one place the model has to reason (decompose an indicator into blocks), so it gets
  // medium effort. A premature "無法表達" on a request that names none of the hard limits is retried once with an
  // explicit instruction to attempt an approximation; the model's own general knowledge of the indicator is the input.
  const {raw,status}=await requestStructuredAgent(system,user,FORMULA_PLAN_SCHEMA,NAME,{maxTokens:6000,reasoningEffort:'medium',...options});
  let plan=normalizePlan(raw);
  if(plan.status==='discussion'&&!mentionsHardLimit(request)&&!history.length){
    console.warn(`formula-planner: premature discussion for "${request.slice(0,40)}", retrying with an approximation instruction`);
    const push=`${user}\n\n（系統提示：這個需求沒有用到昨收、日線、籌碼等不可得資料。請先用你對這個指標的一般知識寫出它的數學定義，再用允許的積木組出等價或近似的條件並回 formula；近似時在 name 標「近似」。只有真的做不到才回 discussion，並說明是哪一步做不到。）`;
    try{const second=await requestStructuredAgent(system,push,FORMULA_PLAN_SCHEMA,NAME,{maxTokens:6000,reasoningEffort:'medium',...options});const candidate=normalizePlan(second.raw);if(candidate.status==='formula'){try{validatePlan(candidate,definitions,second.status);plan=candidate;}catch(error){console.warn(`formula-planner: retry plan rejected (${error.detail||error.code}), keeping discussion`);}}}
    catch(error){console.warn(`formula-planner: retry failed ${error.code||error.message}`);}
  }
  let result;
  try{result=validatePlan(plan,definitions,status);}
  catch(error){console.warn(`formula-planner: rejected model plan (${error.code}) detail=${error.detail||'-'} status=${plan?.status} nodes=${Array.isArray(plan?.nodes)?plan.nodes.length:'?'} root=${plan?.rootId} name=${String(plan?.name||'').slice(0,60)}`);throw error;}
  if(result.status==='existing')throw plannerError('FORMULA_PLAN_INVALID',422,'formula stage returned existing');
  return result;
}

async function planDailyCondition(text,definitions,{context=[],lookupImpl=null,...options}){
  const request=String(text||'').trim();if(!request)throw plannerError('INDICATOR_AGENT_INPUT_REQUIRED',400);if(request.length>500)throw plannerError('INDICATOR_AGENT_INPUT_TOO_LONG',400);
  const history=validateContext(context);
  let canonicalName=null;
  if(lookupImpl&&!history.length&&!mentionsDailyLimit(request)){
    let lookup=null;try{lookup=await lookupImpl(request);}catch(error){console.warn(`indicator-lookup: failed ${error.code||error.message}; not blocking`);}
    if(lookup&&lookup.found===false)return unknownIndicatorResult(lookup);
    if(lookup&&lookup.found===true&&typeof lookup.matched?.title==='string'&&lookup.matched.title.trim())canonicalName=lookup.matched.title.trim().slice(0,120);
  }
  const system=buildPlannerSystem(definitions,{timeframe:'d1'});
  const user=history.length?JSON.stringify({previousConversation:history,currentReply:request}):canonicalName?JSON.stringify({request,canonicalName}):request;
  const {raw,status}=await requestStructuredAgent(system,user,FORMULA_PLAN_SCHEMA,NAME,{maxTokens:6000,reasoningEffort:'medium',...options});
  let plan=normalizePlan(raw);
  if(plan.status==='discussion'&&!mentionsDailyLimit(request)&&!history.length){
    console.warn(`formula-planner: premature daily discussion for "${request.slice(0,40)}", retrying with an approximation instruction`);
    const push=`${user}\n\n（系統提示：這個需求沒有用到籌碼、財報等不可得資料。請先用你對這個指標的一般知識寫出它的數學定義，再用允許的積木在日K上組出等價或近似的條件並回 formula；近似時在 name 標「近似」。只有真的做不到才回 discussion，並說明是哪一步做不到。）`;
    try{const second=await requestStructuredAgent(system,push,FORMULA_PLAN_SCHEMA,NAME,{maxTokens:6000,reasoningEffort:'medium',...options});const candidate=normalizePlan(second.raw);if(candidate.status==='formula'){try{validatePlan(candidate,definitions,second.status);plan=candidate;}catch(error){console.warn(`formula-planner: retry plan rejected (${error.detail||error.code}), keeping discussion`);}}}
    catch(error){console.warn(`formula-planner: retry failed ${error.code||error.message}`);}
  }
  let result;
  try{result=validatePlan(plan,definitions,status);}
  catch(error){console.warn(`formula-planner: rejected daily plan (${error.code}) detail=${error.detail||'-'} status=${plan?.status} nodes=${Array.isArray(plan?.nodes)?plan.nodes.length:'?'} root=${plan?.rootId} name=${String(plan?.name||'').slice(0,60)}`);throw error;}
  if(result.status==='existing')throw plannerError('FORMULA_PLAN_INVALID',422,'formula stage returned existing');
  if(result.status==='formula'){
    if(!dailyCapable(result.proposal.ast))return{status:'discussion',message:'這個條件要用盤中一分鐘 K（例如 VWAP、相對當日開盤）才算得出來，日 K 上沒有意義。可改用：收盤上穿 SMA(20)',provider:result.provider};
    result.summary=`${result.proposal.name} · 日 K`;
  }
  return result;
}
// Daily step: only data the engine lacks altogether (chips, financials, news, other stocks, intraday bars) is a limit.
export function mentionsDailyLimit(text){return /\d+\s*分(鐘|k|線)|小時|盤中|外資|投信|自營|法人|融資|融券|借券|籌碼|財報|營收|eps|本益比|新聞|公告|股東|除權|除息|大盤|加權指數|其他股票|跨股/i.test(String(text).normalize('NFKC'));}

// Output format rules come first and carry a complete example with its null fields: free models (gpt-oss) drop
// null keys and fill params unless they have seen the exact shape. Kept under 4500 chars for 8000-TPM tiers.
export function buildPlannerSystem(definitions,{timeframe='1m'}={}){
  const daily=timeframe==='d1';
  const registry=definitions.map(({id,version,name,timeframe,params,condition})=>({id,version,name,timeframe,params,condition}));
  return[
    daily?'你是台股日K選股條件規劃器，只輸出一個 JSON 物件，不得執行程式，說明一律繁體中文。':'你是台股盤中監控條件規劃器，只輸出一個 JSON 物件，不得執行程式，說明一律繁體中文。',
    '輸出格式（硬性規定）：頂層欄位 status/message/name/timeframe/indicatorId/version/params/nodes/rootId 都要有。每個 node 一律輸出 9 個 key：id,op,field,value,period,inputId,leftId,rightId,itemIds，不適用的填 null，不可省略。status=formula 時 params 一律 {"period":null,"threshold":null}、indicatorId/version 為 null，數字只寫在 node 的 period/value。status=discussion/clarification 時 nodes 必須是空陣列 []、rootId 為 null。',
    `完整範例「收盤上穿 SMA 20」：${JSON.stringify({status:'formula',message:'',name:'收盤上穿 SMA 20',timeframe:'1m',indicatorId:null,version:null,params:{period:null,threshold:null},nodes:[{id:'n1',op:'source',field:'close',value:null,period:null,inputId:null,leftId:null,rightId:null,itemIds:null},{id:'n2',op:'sma',field:null,value:null,period:20,inputId:'n1',leftId:null,rightId:null,itemIds:null},{id:'n3',op:'crosses_above',field:null,value:null,period:null,inputId:null,leftId:'n1',rightId:'n2',itemIds:null}],rootId:'n3'})}`,
    daily?'資料是每檔股票的日K（每根=一個交易日，條件在每天收盤判斷）；timeframe 仍固定填1m（格式欄位），不為週期追問。積木：source(open/high/low/close/volume)、constant、tr(真實波幅，無參數)、add/sub/mul/div/max/min、abs、cumsum(從資料起點累計，只用於OBV這類累計量)、sma/ema/rma(Wilder平滑)/highest/lowest/stddev(母體)、prev(前n根,n=1..60)、crosses_above/crosses_below/gte/lte/gt/lt、all(且)/any(或) 2到4條布林。視窗2到200。禁止 first 與 VWAP（日K上沒有意義）。月線=SMA20、季線=SMA60、半年線=SMA120，昨收=prev(close,1)，跳空=open與prev(high,1)/prev(low,1)比較。':'系統只有一分鐘K；沒講週期視為一分鐘K，timeframe填1m，不為週期追問。積木：source(open/high/low/close/volume)、constant、tr(真實波幅，無參數)、add/sub/mul/div/max/min、abs、cumsum(當日開盤以來累計)、first(當日第一根的值)、sma/ema/rma(Wilder平滑)/highest/lowest/stddev(母體)、prev(前n根,n=1..60)、crosses_above/crosses_below/gte/lte/gt/lt、all(且)/any(或) 2到4條布林。視窗2到200；總暖機不可超過當日270根。',
    'nodes依相依順序排列、id唯一、可重複引用。source填field；constant填value；sma/ema/rma/highest/lowest/stddev/prev填inputId+period；abs/cumsum/first填inputId；算術與比較填leftId/rightId；all/any填itemIds。rootId指向最後一個布林節點。',
    '更多範例（只列非null欄位，實際輸出其餘填null）：',
    ...FORMULA_RECIPES.filter((recipe)=>PROMPT_EXAMPLE_KEYS.includes(recipe.key)).map((recipe)=>`- ${recipe.name}：${compactGraph(toGraph(recipe.ast))}`),
    '常見組法：布林上軌=sma(close,20)+2×stddev(close,20)、下軌=sma−2×stddev。「連續N根紅K」=all(close>open, prev(close,1)>prev(open,1)…)。「跌幅超過X%」=close≤prev(close,N)×(1−X/100)，「漲幅超過X%」=close≥prev(close,N)×(1+X/100)，N未指定用1並寫進name。「乖離率」=(close−sma(close,20))÷sma(close,20)，門檻3%寫0.03。「突破前N根最高」=highest後prev 1。ATR(14)=rma(tr,14)（tr 是現成積木，不要自己組真實波幅）。DMI/ADX 無法表達，回discussion。CCI≈(TP−sma(TP,20))÷(0.015×stddev(TP,20))，TP=(high+low+close)/3，name標「近似」。KD：RSV=(close−lowest(low,9))÷(highest(high,9)−lowest(low,9))×100，K=rma(RSV,3)、D=rma(K,3)。RSI用rma。',
    daily?'OBV=cumsum(sign×volume)，sign=min(max((close−prev(close,1))×1000000,−1),1)。替代條件用白話（如「量 ≥ 均量 2 倍」），不要寫函數式。均量用20日。':'VWAP=cumsum(((high+low+close)÷3)×volume)÷cumsum(volume)。「相對開盤漲幅X%」=close≥first(open)×(1+X/100)。OBV=cumsum(sign×volume)，sign=min(max((close−prev(close,1))×1000000,−1),1)。替代條件用白話（如「量 ≥ 均量 2 倍」），不要寫函數式。需要昨日收盤（跳空、相對昨收漲跌幅）的條件無法表達：回discussion並建議改用相對當日開盤 first(open)。',
    daily?'這是公式階段，只能回formula、clarification或discussion，禁止existing。沒有現成組法的指標，先依一般技術分析知識寫出數學定義，再用積木組出等價或近似條件並回formula（近似時name標「近似」）；參數沒講用常用預設（MACD 12/26/9、均線20、均量20日×2），「MA」視為SMA，「黃金交叉／突破／站上」=向上穿越、「死亡交叉／跌破」=向下穿越，採用的參數寫進name。只有連指標都無法判斷才回clarification。盤中分鐘資料、跨股票、籌碼、財報、新聞或積木組不出時回discussion：message一句話說原因，並包含「可改用：…」一個同類、可用日K計算的具體替代條件。':'這是公式階段，只能回formula、clarification或discussion，禁止existing。沒有現成組法的指標，先依一般技術分析知識寫出數學定義，再用積木組出等價或近似條件並回formula（近似時name標「近似」）；參數沒講用常用預設（MACD 12/26/9、均線20、均量20根×2），「MA」視為SMA，「黃金交叉／突破／站上」=向上穿越、「死亡交叉／跌破」=向下穿越，採用的參數寫進name。只有連指標都無法判斷才回clarification。其他週期、跨股票、籌碼、財報、新聞、超過270根暖機或積木組不出時回discussion：message一句話說原因，並包含「可改用：…」一個同類、可用一分鐘K計算的具體替代條件（量能→量能、趨勢→均線/MACD、波動→ATR/布林、動能→RSI/KD）。',
    'name與message用中性用語，不得出現買進、賣出、超買、超賣、轉強、訊號等判斷字眼。輸入含 canonicalName 時，依該正式名稱指標的標準定義組公式。',
    `Registry: ${JSON.stringify(registry)}`
  ].join('\n');
}

// Lenient repair of a model plan before the strict validator: fills missing keys with null, drops unknown keys,
// coerces numeric strings and clears fields a status forbids. Shape errors that remain are real model errors.
export function normalizePlan(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw;
  const plan={status:raw.status,message:typeof raw.message==='string'?raw.message:'',name:typeof raw.name==='string'?raw.name:'',timeframe:raw.timeframe===undefined?'1m':raw.timeframe,indicatorId:raw.indicatorId??null,version:raw.version??null,params:{period:null,threshold:null},nodes:Array.isArray(raw.nodes)?raw.nodes:[],rootId:raw.rootId??null};
  if(raw.params&&typeof raw.params==='object'&&!Array.isArray(raw.params))plan.params={period:toNumber(raw.params.period),threshold:toNumber(raw.params.threshold)};
  plan.nodes=plan.nodes.map((node)=>{
    if(!node||typeof node!=='object'||Array.isArray(node))return node;
    const out={};for(const key of NODE_KEYS)out[key]=node[key]??null;
    if(typeof out.id==='number')out.id=String(out.id);
    out.value=toNumber(out.value);out.period=toNumber(out.period);
    for(const key of ['inputId','leftId','rightId'])if(typeof out[key]==='number')out[key]=String(out[key]);
    if(Array.isArray(out.itemIds))out.itemIds=out.itemIds.map((id)=>typeof id==='number'?String(id):id);
    if(['all','any'].includes(out.op)){out.leftId=null;out.rightId=null;}else out.itemIds=null;
    // Models write prev as n/shift/offset or leave it out meaning "the previous bar".
    if(out.op==='prev'&&out.period===null){const alias=toNumber(node.n??node.shift??node.offset??node.bars);out.period=alias??1;}
    if(out.op==='tr'){out.field=null;out.value=null;out.period=null;out.inputId=null;out.leftId=null;out.rightId=null;}
    return out;
  });
  if(plan.status==='formula'){plan.params={period:null,threshold:null};plan.indicatorId=null;plan.version=null;if(plan.timeframe===null)plan.timeframe='1m';
    if(plan.rootId===null&&plan.nodes.length){const last=[...plan.nodes].reverse().find((node)=>node&&BOOLEAN_OPS.includes(node.op));if(last&&typeof last.id==='string')plan.rootId=last.id;}}
  if(plan.status==='discussion'||plan.status==='clarification'){plan.nodes=[];plan.rootId=null;plan.indicatorId=null;plan.version=null;}
  if(plan.status==='existing'){plan.nodes=[];plan.rootId=null;}
  return plan;
}
function toNumber(value){if(typeof value==='string'&&value.trim()!==''){const number=Number(value);if(Number.isFinite(number))return number;}return value??null;}

export function validatePlan(raw,definitions,provider={provider:'stub',model:'stub'}){
  exactObject(raw,PLAN_KEYS,'plan');
  if(!STATUSES.includes(raw.status))throw invalid(`status '${raw.status}' not one of ${STATUSES.join('/')}`);
  if(typeof raw.message!=='string')throw invalid('message not a string');if(typeof raw.name!=='string')throw invalid('name not a string');
  if(![null,'1m'].includes(raw.timeframe))throw invalid(`timeframe '${raw.timeframe}' not 1m/null`);
  for(const key of ['indicatorId','version','rootId'])if(raw[key]!==null&&typeof raw[key]!=='string')throw invalid(`${key} not string/null`);
  if(!raw.params||typeof raw.params!=='object'||Array.isArray(raw.params)||Object.keys(raw.params).sort().join(',')!=='period,threshold')throw invalid('params must be {period,threshold}');
  for(const key of ['period','threshold'])if(raw.params[key]!==null&&!Number.isFinite(raw.params[key]))throw invalid(`params.${key} not number/null`);
  if(!Array.isArray(raw.nodes))throw invalid('nodes not an array');
  if(raw.status==='clarification'||raw.status==='discussion'){if(raw.nodes.length||raw.rootId!==null||raw.indicatorId!==null||raw.version!==null)throw invalid(`${raw.status} must have empty nodes and null rootId/indicatorId/version`);return{status:raw.status,message:raw.message||'請補充監控條件。',provider};}
  if(raw.timeframe!=='1m')throw invalid(`timeframe '${raw.timeframe}' must be 1m for ${raw.status}`);
  if(raw.status==='existing'){
    if(raw.nodes.length||raw.rootId!==null)throw invalid('existing must have empty nodes and null rootId');
    const definition=definitions.find((item)=>item.id===raw.indicatorId&&item.version===raw.version);if(!definition)throw invalid(`existing indicator ${raw.indicatorId}@${raw.version} not in registry`);
    for(const key of ['period','threshold'])if(!definition.params.some((item)=>item.key===key)&&raw.params[key]!==null)throw invalid(`existing params.${key} not accepted by ${definition.id}`);
    const params={};for(const schema of definition.params){const value=raw.params[schema.key];if(value==null)throw invalid(`existing params.${schema.key} required by ${definition.id}`);params[schema.key]=value;}
    let strategy;try{strategy=validateStrategy({id:definition.id,version:definition.version,timeframe:'1m',params},definition);}catch(error){throw invalid(`existing strategy: ${error.code||error.message}`);}
    return{status:'existing',summary:`${definition.name}${definition.params.length?`（${definition.params.map((item)=>`${item.label} ${strategy.params[item.key]}`).join('、')}）`:''} · M1`,proposal:{id:strategy.id,version:strategy.version,timeframe:'1m',definitionFingerprint:definition.fingerprint,params:strategy.params},provider};
  }
  if(raw.indicatorId!==null||raw.version!==null)throw invalid('formula must have null indicatorId/version');
  if(raw.params.period!==null||raw.params.threshold!==null)throw invalid('formula params must be null');
  const ast=compileGraph(raw.nodes,raw.rootId);let validated;try{validated=validateFormula(ast);}catch(error){throw invalid(`formula validation: ${error.code||error.message}`);}
  const name=raw.name.trim();if(name.length<2||name.length>100)throw invalid(`name length ${name.length} not in 2..100`);
  return{status:'formula',summary:`${name} · 一分鐘`,formulaSummary:formulaSummary(ast),proposal:{name,ast:validated.ast,fingerprint:validated.fingerprint,warmupBars:validated.warmupBars},provider};
}

export function unknownIndicatorResult(lookup){
  const name=lookup.indicatorName||lookup.candidates?.[0]||'這個';
  return{status:'unknown_indicator',message:`查不到「${name}」這個指標的公開定義，為避免建立錯誤公式，暫不建立。已記錄下來供我們研究；也可以換個常見名稱再試。`,lookup:{candidates:Array.isArray(lookup.candidates)?lookup.candidates:[],indicatorName:name},provider:{provider:'rules',model:'lookup'}};
}
// Matches 日線／週線／月線／季線／年線／5分／15分／60分／小時 K and offers the closest 1m condition.
export function detectOtherTimeframe(text){
  const t=String(text).normalize('NFKC').toLowerCase();
  const MA_NAMES=[['月線','20'],['季線','60'],['半年線','120'],['年線','240'],['週線','5'],['周線','5']];
  const hitMa=MA_NAMES.find(([name])=>t.includes(name));
  const hitTf=/(日線|日k|日k線|daily|週k|周k|weekly|月k|monthly|(\d+)\s*分(?:鐘|k|線)|小時|hour)/i.exec(t);
  if(!hitMa&&!hitTf)return null;
  const alt=hitMa?`收盤上穿 SMA(${hitMa[1]})`:'收盤上穿 SMA(20)';
  const what=hitMa?`「${hitMa[0]}」是日線上的均線`:'日線、週線或其他分鐘週期';
  return `目前只支援一分鐘 K 的盤中監控，${what}，暫時還不能用來監控。最接近的一分鐘 K 寫法是「${alt}」（以一分鐘 K 計算的均線），可以直接輸入試試。`;
}
// Two short graphs plus the full example above are enough for the model to copy the format; the rest of the
// recipes live in the formula library and hit without any model call. Keeping the prompt small matters on
// free-tier token-per-minute limits.
const PROMPT_EXAMPLE_KEYS=['macd_golden','volume_surge'];
export function needsRegistryPass(text){return /rsi|sma|ema|\bma\d*\b|均線|移動平均|相對強弱|突破今日|前高|量能放大|突破.*量|量.*突破/i.test(String(text).normalize('NFKC'));}
// Requests that genuinely need data the engine lacks (previous close, other timeframes, non-price data).
export function mentionsHardLimit(text){return /昨收|昨日|前一日|跳空|日線|日k|週線|周線|月線|季線|年線|\d+\s*分(鐘|k|線)|小時|外資|投信|自營|法人|融資|融券|借券|籌碼|財報|營收|eps|本益比|新聞|公告|股東|除權|除息|大盤|加權指數|其他股票|跨股/i.test(String(text).normalize('NFKC'));}
function knownUnsupportedFormula(result,definitions){const draft=result.requestDraft;if(!draft||draft.requestedIndicator!=='sma'||!['1m','unknown'].includes(draft.requestedTimeframe)||draft.requestedDirection!=='crosses_below'||(draft.params?.period!=null&&!Number.isFinite(draft.params.period))||draft.params?.threshold!=null)return null;const definition=definitions.find((item)=>item.executor==='sma_cross');if(!definition)return null;const period=draft.params?.period??definition.params.find((item)=>item.key==='period')?.default;let strategy;try{strategy=validateStrategy({id:definition.id,version:definition.version,timeframe:'1m',params:{period}},definition);}catch{return null;}const ast={op:'crosses_below',left:{op:'source',field:'close'},right:{op:'sma',input:{op:'source',field:'close'},period:strategy.params.period}};const validated=validateFormula(ast);return{status:'formula',summary:`價格下穿 SMA ${strategy.params.period} · 一分鐘`,formulaSummary:formulaSummary(validated.ast),proposal:{name:`價格下穿 SMA ${strategy.params.period}`,ast:validated.ast,fingerprint:validated.fingerprint,warmupBars:validated.warmupBars},provider:result.provider};}

function compileGraph(nodes,rootId){
  if(!Array.isArray(nodes)||nodes.length<1)throw invalid('formula needs at least one node');if(nodes.length>MAX_GRAPH_NODES)throw invalid(`too many nodes (${nodes.length} > ${MAX_GRAPH_NODES})`);
  if(typeof rootId!=='string')throw invalid('rootId required for formula');
  const built=new Map(),ops=new Map();
  for(const [index,node] of orderNodes(nodes).entries()){
    exactObject(node,NODE_KEYS,`node #${index+1}`);
    if(typeof node.id!=='string'||!/^[a-z0-9][a-z0-9_]{0,31}$/i.test(node.id))throw invalid(`node #${index+1}: id '${node.id}' invalid`);
    if(built.has(node.id))throw invalid(`node ${node.id}: duplicate id`);
    if(!NODE_OPS.includes(node.op))throw invalid(`node ${node.id}: unknown op '${node.op}'`);
    validateNodeFields(node);
    const ref=(key,id)=>lookup(built,id,`node ${node.id}: ${key} '${id}' not defined before use`);
    let ast;
    if(node.op==='source')ast={op:'source',field:node.field};
    else if(node.op==='constant')ast={op:'constant',value:node.value};
    else if(node.op==='tr')ast={op:'tr'};
    else if(INPUT_PERIOD_OPS.includes(node.op))ast={op:node.op,input:ref('inputId',node.inputId),period:node.period};
    else if(['abs','cumsum','first'].includes(node.op))ast={op:node.op,input:ref('inputId',node.inputId)};
    else if(['all','any'].includes(node.op))ast={op:node.op,items:node.itemIds.map((id)=>ref('itemIds',id))};
    else ast={op:node.op,left:ref('leftId',node.leftId),right:ref('rightId',node.rightId)};
    built.set(node.id,ast);ops.set(node.id,node.op);
  }
  const root=lookup(built,rootId,`rootId '${rootId}' not a node`);
  if(!BOOLEAN_OPS.includes(ops.get(rootId)))throw invalid(`rootId ${rootId} not boolean (${ops.get(rootId)})`);
  return root;
}
// Models sometimes list a node before the nodes it refers to; order by dependencies (stable for valid input),
// leaving genuinely undefined references to be reported by compileGraph.
function orderNodes(nodes){
  const byId=new Map();for(const node of nodes)if(node&&typeof node.id==='string'&&!byId.has(node.id))byId.set(node.id,node);
  const refs=(node)=>[node.inputId,node.leftId,node.rightId,...(Array.isArray(node.itemIds)?node.itemIds:[])].filter((id)=>typeof id==='string');
  const ordered=[],seen=new Set(),visiting=new Set();
  const visit=(node)=>{if(!node||seen.has(node)||visiting.has(node))return;visiting.add(node);for(const id of refs(node)){const dep=byId.get(id);if(dep&&dep!==node)visit(dep);}visiting.delete(node);seen.add(node);ordered.push(node);};
  for(const node of nodes)visit(node);
  return ordered;
}
function validateNodeFields(node){
  const id=(value)=>typeof value==='string';const label=`node ${node.id}`;
  const requireNull=(...keys)=>{for(const key of keys)if(node[key]!==null)throw invalid(`${label}: ${key} must be null for ${node.op}`);};
  if(node.op==='tr'){requireNull('field','value','period','inputId','leftId','rightId','itemIds');return;}
  if(node.op==='source'){if(!FORMULA_SOURCE_FIELDS.includes(node.field))throw invalid(`${label}: field '${node.field}' not one of ${FORMULA_SOURCE_FIELDS.join('/')}`);requireNull('value','period','inputId','leftId','rightId','itemIds');return;}
  if(node.op==='constant'){if(typeof node.value!=='number'||!Number.isFinite(node.value))throw invalid(`${label}: value required for constant`);requireNull('field','period','inputId','leftId','rightId','itemIds');return;}
  if(INPUT_PERIOD_OPS.includes(node.op)){if(!Number.isInteger(node.period))throw invalid(`${label}: period required for ${node.op}`);if(!id(node.inputId))throw invalid(`${label}: inputId required for ${node.op}`);requireNull('field','value','leftId','rightId','itemIds');return;}
  if(['abs','cumsum','first'].includes(node.op)){if(!id(node.inputId))throw invalid(`${label}: inputId required for ${node.op}`);requireNull('field','value','period','leftId','rightId','itemIds');return;}
  if(LEFT_RIGHT_OPS.includes(node.op)){if(!id(node.leftId)||!id(node.rightId))throw invalid(`${label}: leftId and rightId required for ${node.op}`);requireNull('field','value','period','inputId','itemIds');return;}
  if(['all','any'].includes(node.op)){
    if(!Array.isArray(node.itemIds)||!node.itemIds.every(id))throw invalid(`${label}: itemIds required for ${node.op}`);
    if(node.itemIds.length<2||node.itemIds.length>4)throw invalid(`${label}: itemIds needs 2..4 ids (got ${node.itemIds.length})`);
    if(new Set(node.itemIds).size!==node.itemIds.length)throw invalid(`${label}: itemIds has duplicates`);
    requireNull('field','value','period','inputId','leftId','rightId');return;
  }
  throw invalid(`${label}: unknown op '${node.op}'`);
}
function compactGraph({nodes,rootId}){return JSON.stringify({nodes:nodes.map((node)=>Object.fromEntries(Object.entries(node).filter(([,value])=>value!==null))),rootId});}
// Renders an AST as the planner's node-graph format (identical sub-trees become one shared node).
export function toGraph(ast){const nodes=[],ids=new Map();const visit=(node)=>{const key=JSON.stringify(node);if(ids.has(key))return ids.get(key);const out={id:null,op:node.op,field:null,value:null,period:null,inputId:null,leftId:null,rightId:null,itemIds:null};if(node.op==='source')out.field=node.field;else if(node.op==='constant')out.value=node.value;else if(node.input){out.inputId=visit(node.input);if('period' in node)out.period=node.period;}else if(node.items)out.itemIds=node.items.map(visit);else if(node.op!=='tr'){out.leftId=visit(node.left);out.rightId=visit(node.right);}out.id=`n${nodes.length+1}`;nodes.push(out);ids.set(key,out.id);return out.id;};const rootId=visit(ast);return{nodes,rootId};}
function validateContext(value){if(!Array.isArray(value)||value.length>4)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return value.map((item)=>{if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).sort().join(',')!=='request,response'||typeof item.request!=='string'||typeof item.response!=='string'||item.request.length>500||item.response.length>500)throw plannerError('FORMULA_PLAN_CONTEXT_INVALID',400);return{request:item.request,response:item.response};});}
function lookup(map,id,detail){if(typeof id!=='string'||!map.has(id))throw invalid(detail);return map.get(id);}
function exactObject(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid(`${label}: not an object`);
  const present=Object.keys(value);const extra=present.filter((key)=>!keys.includes(key));const missing=keys.filter((key)=>!present.includes(key));
  if(extra.length||missing.length)throw invalid(`${label}: ${missing.length?`missing ${missing.join(',')}`:''}${missing.length&&extra.length?'; ':''}${extra.length?`unexpected ${extra.join(',')}`:''}`);
}
function invalid(detail){return plannerError('FORMULA_PLAN_INVALID',422,detail);}
function plannerError(code,statusCode,detail){const error=Object.assign(new Error(detail?`${code}: ${detail}`:code),{code,statusCode});if(detail)error.detail=detail;return error;}
