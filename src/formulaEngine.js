import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import technicalIndicators from 'technicalindicators';
import { bollinger, ichimokuCloudBottom, ichimokuCloudTop, ichimokuMid, kdD, kdK, macdLine, macdSignal, wilderRsi, williamsR } from './formulaRecipes.js';

const { SMA, EMA } = technicalIndicators;

export const FORMULA_VERSION='formula.v1';
// Limits. Nodes are counted on the expanded tree (a sub-formula referenced twice counts twice), so
// the node cap is a size cap on what is stored/signed, not on compute: evaluation memoizes identical
// sub-trees. The standard TW shapes are large once expanded (KD low-zone golden cross = 44 nodes / depth 9,
// Wilder RSI cross = 27 / depth 9), and users combine them with a volume filter (+8), so 48 would already
// be too tight; 64 / depth 12 leaves room for one such combination and still bounds token size and cost.
const MAX_NODES=64,MAX_DEPTH=12,MAX_BARS=512,MAX_DAILY_COMPLETE_BARS=270;
export const FORMULA_SOURCE_FIELDS=Object.freeze(['open','high','low','close','volume']);
const ARITH=['add','sub','mul','div','max','min'];
const WINDOW=['sma','ema','rma','highest','lowest','stddev'];
const COMPARE=['crosses_above','crosses_below','gte','lte','gt','lt'];
const LOGIC=['all','any'];
// 'tr' is Wilder's true range max(high−low, |high−prev close|, |low−prev close|) as one block, so the model
// cannot get the definition wrong (a live test produced a plausible-looking ATR with a wrong TR).
export const FORMULA_OPS=Object.freeze(['source','constant','tr',...ARITH,'abs',...WINDOW,'prev',...COMPARE,...LOGIC]);
const MIN_PERIOD=2,MAX_PERIOD=200,MAX_PREV=60,MIN_ITEMS=2,MAX_ITEMS=4;
const MAX_SOURCE_TEXT=200;

export function validateFormula(ast){const budget={nodes:0};const type=visit(ast,1,budget);if(type!=='boolean')throw formulaError('FORMULA_ROOT_NOT_BOOLEAN');rejectCertainDivisionByZero(ast);const warmup=warmupBars(ast);if(warmup>MAX_BARS)throw formulaError('FORMULA_WARMUP_EXCEEDS_DATA_BUDGET');if(warmup>MAX_DAILY_COMPLETE_BARS)throw formulaError('FORMULA_WARMUP_EXCEEDS_TRADING_DAY');return Object.freeze({ast:structuredClone(ast),warmupBars:warmup,fingerprint:formulaFingerprint(ast)});}
export function formulaFingerprint(ast){return createHash('sha256').update(JSON.stringify(canonical(ast))).digest('hex');}
export function issueFormulaToken(proposal,secret,now=Date.now()){assertSecret(secret);const validated=validateFormula(proposal?.ast);if(!validName(proposal?.name)||proposal.fingerprint!==validated.fingerprint)throw formulaError('FORMULA_PROPOSAL_INVALID',422);const payload={v:1,proposalId:proposal.proposalId||randomUUID(),exp:now+10*60_000,capabilityRevision:FORMULA_VERSION,fingerprint:validated.fingerprint,ast:validated.ast,name:proposal.name.trim()};
  // Optional: what the user said (≤200 chars) so a successful activation can bind it as a library alias.
  if(typeof proposal.sourceText==='string'&&proposal.sourceText.trim())payload.sourceText=proposal.sourceText.trim().replace(/\s+/g,' ').slice(0,MAX_SOURCE_TEXT);
  const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');return `${encoded}.${createHmac('sha256',secret).update(encoded).digest('base64url')}`;}
export function verifyFormulaToken(token,secret,now=Date.now()){assertSecret(secret);const [encoded,signature,...rest]=String(token||'').split('.');if(!encoded||!signature||rest.length)throw formulaError('FORMULA_TOKEN_INVALID',422);const expected=createHmac('sha256',secret).update(encoded).digest();let supplied;try{supplied=Buffer.from(signature,'base64url');}catch{throw formulaError('FORMULA_TOKEN_INVALID',422);}if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw formulaError('FORMULA_TOKEN_INVALID',422);let payload;try{payload=JSON.parse(Buffer.from(encoded,'base64url'));}catch{throw formulaError('FORMULA_TOKEN_INVALID',422);}if(!payload||typeof payload!=='object'||Array.isArray(payload))throw formulaError('FORMULA_TOKEN_INVALID',422);try{exact(Object.keys(payload).filter((key)=>key!=='sourceText'),['v','proposalId','exp','capabilityRevision','fingerprint','ast','name']);}catch{throw formulaError('FORMULA_TOKEN_INVALID',422);}if('sourceText' in payload&&(typeof payload.sourceText!=='string'||!payload.sourceText||payload.sourceText.length>MAX_SOURCE_TEXT))throw formulaError('FORMULA_TOKEN_INVALID',422);if(payload.v!==1||typeof payload.proposalId!=='string'||!/^[0-9a-f-]{36}$/.test(payload.proposalId)||!Number.isFinite(payload.exp)||typeof payload.capabilityRevision!=='string'||typeof payload.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(payload.fingerprint)||!validName(payload.name))throw formulaError('FORMULA_TOKEN_INVALID',422);if(payload.exp<now||payload.capabilityRevision!==FORMULA_VERSION)throw formulaError('FORMULA_PROPOSAL_STALE',409);const validated=validateFormula(payload.ast);if(validated.fingerprint!==payload.fingerprint)throw formulaError('FORMULA_TOKEN_INVALID',422);return{...payload,name:payload.name.trim(),warmupBars:validated.warmupBars};}
export function evaluateFormulaSeries(node,bars){const budget={nodes:0};visit(node,1,budget);if(!Array.isArray(bars)||bars.length>MAX_BARS)throw formulaError('FORMULA_DATA_BUDGET_EXCEEDED');return series(node,{bars,cache:new Map()});}
export function evaluateFormula(ast,bars){const validated=validateFormula(ast);const result=evaluateFormulaSeries(ast,bars);const current=result.at(-1)??null;return{previous:result.at(-2)??null,current,triggered:current===true,errorCode:current==null&&bars.length>=validated.warmupBars?'formula_calculation_error':null};}
export function formulaSummary(ast){return summarize(ast);}

function visit(node,depth,budget){
  if(!node||typeof node!=='object'||Array.isArray(node)||depth>MAX_DEPTH||++budget.nodes>MAX_NODES)throw formulaError('FORMULA_COMPLEXITY_EXCEEDED');
  const keys=Object.keys(node);const number=(child)=>{if(visit(child,depth+1,budget)!=='number')throw formulaError('FORMULA_TYPE_INVALID');};
  if(node.op==='source'){exact(keys,['op','field']);if(!FORMULA_SOURCE_FIELDS.includes(node.field))throw formulaError('FORMULA_SOURCE_UNSUPPORTED');return'number';}
  if(node.op==='constant'){exact(keys,['op','value']);if(typeof node.value!=='number'||!Number.isFinite(node.value)||Math.abs(node.value)>1e9)throw formulaError('FORMULA_NUMBER_INVALID');return'number';}
  if(node.op==='tr'){exact(keys,['op']);return'number';}
  if(ARITH.includes(node.op)){exact(keys,['op','left','right']);number(node.left);number(node.right);return'number';}
  if(node.op==='abs'){exact(keys,['op','input']);number(node.input);return'number';}
  if(WINDOW.includes(node.op)){exact(keys,['op','input','period']);if(!Number.isInteger(node.period)||node.period<MIN_PERIOD||node.period>MAX_PERIOD)throw formulaError('FORMULA_PERIOD_INVALID');number(node.input);return'number';}
  if(node.op==='prev'){exact(keys,['op','input','period']);if(!Number.isInteger(node.period)||node.period<1||node.period>MAX_PREV)throw formulaError('FORMULA_PERIOD_INVALID');number(node.input);return'number';}
  if(COMPARE.includes(node.op)){exact(keys,['op','left','right']);number(node.left);number(node.right);return'boolean';}
  if(LOGIC.includes(node.op)){exact(keys,['op','items']);if(!Array.isArray(node.items)||node.items.length<MIN_ITEMS||node.items.length>MAX_ITEMS)throw formulaError('FORMULA_TYPE_INVALID');for(const item of node.items)if(visit(item,depth+1,budget)!=='boolean')throw formulaError('FORMULA_TYPE_INVALID');return'boolean';}
  throw formulaError('FORMULA_OPERATOR_UNSUPPORTED');
}
// Bars needed before the first non-null value (within one uninterrupted run of data).
function warmupBars(node){
  if(['source','constant'].includes(node.op))return 1;
  if(node.op==='tr')return 2;
  if(ARITH.includes(node.op)||COMPARE.includes(node.op))return Math.max(warmupBars(node.left),warmupBars(node.right))+(node.op.startsWith('crosses_')?1:0);
  if(node.op==='abs')return warmupBars(node.input);
  if(WINDOW.includes(node.op))return warmupBars(node.input)+node.period-1;
  if(node.op==='prev')return warmupBars(node.input)+node.period;
  if(LOGIC.includes(node.op))return Math.max(...node.items.map(warmupBars));
  return MAX_BARS+1;
}
// Identical sub-trees (e.g. K inside both K and D) are computed once per evaluation.
function series(node,context){
  const key=JSON.stringify(canonical(node));
  if(context.cache.has(key))return context.cache.get(key);
  const value=compute(node,context);context.cache.set(key,value);return value;
}
function compute(node,context){
  const {bars}=context;
  if(node.op==='source')return bars.map((bar)=>finite(bar?.[node.field]));
  if(node.op==='constant')return bars.map(()=>node.value);
  if(node.op==='tr')return bars.map((bar,index)=>{const high=finite(bar?.high),low=finite(bar?.low),prevClose=index>0?finite(bars[index-1]?.close):null;if(high==null||low==null||prevClose==null)return null;return Math.max(high-low,Math.abs(high-prevClose),Math.abs(low-prevClose));});
  if(ARITH.includes(node.op)){const a=series(node.left,context),b=series(node.right,context);return a.map((value,index)=>arith(node.op,value,b[index]));}
  if(node.op==='abs')return series(node.input,context).map((value)=>value==null?null:Math.abs(value));
  if(WINDOW.includes(node.op))return rolling(node.op,series(node.input,context),node.period);
  if(node.op==='prev'){const values=series(node.input,context);return values.map((_,index)=>index<node.period?null:values[index-node.period]);}
  if(['gte','lte','gt','lt'].includes(node.op)){const a=series(node.left,context),b=series(node.right,context);return a.map((value,index)=>!Number.isFinite(value)||!Number.isFinite(b[index])?null:compare(node.op,value,b[index]));}
  if(node.op.startsWith('crosses_')){const a=series(node.left,context),b=series(node.right,context);return a.map((value,index)=>index===0||[a[index-1],b[index-1],value,b[index]].some((x)=>!Number.isFinite(x))?null:node.op==='crosses_above'?a[index-1]<=b[index-1]&&value>b[index]:a[index-1]>=b[index-1]&&value<b[index]);}
  // all / any: null unless every item is evaluable on that bar (same rule as the warm-up count).
  const values=node.items.map((item)=>series(item,context));
  return bars.map((_,index)=>values.some((items)=>typeof items[index]!=='boolean')?null:node.op==='all'?values.every((items)=>items[index]):values.some((items)=>items[index]));
}
function compare(op,a,b){return op==='gte'?a>=b:op==='lte'?a<=b:op==='gt'?a>b:a<b;}
// Window operators restart after any non-finite value, so a data gap or a null sub-result re-warms them.
function rolling(op,values,period){
  const out=Array(values.length).fill(null);let start=0;
  while(start<values.length){
    while(start<values.length&&!Number.isFinite(values[start]))start++;
    let end=start;while(end<values.length&&Number.isFinite(values[end]))end++;
    if(end-start>=period){const segment=values.slice(start,end);const calculated=windowSeries(op,segment,period);const offset=start+period-1;calculated.forEach((value,index)=>{out[offset+index]=finite(value);});}
    start=end+1;
  }
  return out;
}
function windowSeries(op,segment,period){
  if(op==='sma'||op==='ema'){const Indicator=op==='sma'?SMA:EMA;const calculated=Indicator.calculate({period,values:segment});return op==='sma'?calculated.map((value,index)=>Number.isFinite(segment.slice(index,index+period).reduce((sum,item)=>sum+item,0))?value:null):calculated;}
  if(op==='rma'){let previous=segment.slice(0,period).reduce((sum,item)=>sum+item,0)/period;const out=[previous];for(let index=period;index<segment.length;index++){previous=(previous*(period-1)+segment[index])/period;out.push(previous);}return out;}
  const out=[];
  for(let index=period-1;index<segment.length;index++){
    const window=segment.slice(index-period+1,index+1);
    if(op==='highest')out.push(Math.max(...window));
    else if(op==='lowest')out.push(Math.min(...window));
    else{const mean=window.reduce((sum,item)=>sum+item,0)/period;out.push(Math.sqrt(window.reduce((sum,item)=>sum+(item-mean)**2,0)/period));}
  }
  return out;
}
function arith(op,a,b){if(a==null||b==null)return null;if(op==='div'&&b===0)return null;const value=op==='add'?a+b:op==='sub'?a-b:op==='mul'?a*b:op==='div'?a/b:op==='max'?Math.max(a,b):Math.min(a,b);return Number.isFinite(value)?value:null;}
function finite(value){return Number.isFinite(value)?value:null;}function exact(actual,allowed){if(actual.length!==allowed.length||actual.some((key)=>!allowed.includes(key)))throw formulaError('FORMULA_FIELD_UNKNOWN');}
function validName(value){return typeof value==='string'&&value.trim().length>=2&&value.trim().length<=100;}
function assertSecret(secret){if(typeof secret!=='string'||secret.length<8)throw formulaError('FORMULA_TOKEN_SECRET_INVALID',500);}
function rejectCertainDivisionByZero(node){if(node.op==='div'&&staticValue(node.right)===0)throw formulaError('FORMULA_DIVISION_BY_ZERO');for(const child of children(node))rejectCertainDivisionByZero(child);}
function staticValue(node){
  if(node.op==='constant')return node.value;
  if(node.op==='sub'&&formulaFingerprint(node.left)===formulaFingerprint(node.right))return 0;
  if(node.op==='abs'){const value=staticValue(node.input);return value==null?null:Math.abs(value);}
  if(!ARITH.includes(node.op))return null;
  const left=staticValue(node.left),right=staticValue(node.right);if(left==null||right==null)return null;return arith(node.op,left,right);
}
export function formulaChildren(node){return children(node);}
function children(node){if(ARITH.includes(node.op)||COMPARE.includes(node.op))return[node.left,node.right];if(node.op==='abs'||node.op==='prev'||WINDOW.includes(node.op))return[node.input];if(LOGIC.includes(node.op))return node.items;return[];}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])]));return value;}
const SOURCE_LABEL={open:'開盤價',high:'最高價',low:'最低價',close:'收盤價',volume:'成交量'};
const WINDOW_LABEL={sma:'SMA',ema:'EMA',rma:'Wilder平滑',highest:'最高值',lowest:'最低值',stddev:'標準差'};
const COMPARE_LABEL={crosses_above:'向上穿越',crosses_below:'向下穿越',gte:'≥',lte:'≤',gt:'>',lt:'<'};
// Exact structural matches of standard indicators get a readable label (parameters read from the tree,
// then the whole sub-tree is rebuilt and compared, so a near-miss falls back to the literal expansion).
function knownLabel(node){
  const same=(template)=>{try{return JSON.stringify(canonical(template))===JSON.stringify(canonical(node));}catch{return false;}};
  const rsvN=(rma)=>rma?.input?.left?.left?.right?.period;
  if(node.op==='rma'){
    const n=rsvN(node);if(Number.isInteger(n)&&same(kdK(n,node.period)))return `K值(RSV ${n}，以1/3權重平滑)`;
    const inner=node.input;const m=rsvN(inner);if(Number.isInteger(m)&&inner?.period===node.period&&same(kdD(m,node.period)))return `D值(RSV ${m}，K再以1/3權重平滑)`;
  }
  if(node.op==='mul'&&node.right?.op==='constant'){
    const p=node.left?.left?.period;if(node.right.value===100&&Number.isInteger(p)&&same(wilderRsi(p)))return `RSI(${p}, Wilder)`;
    const w=node.left?.left?.left?.period;if(node.right.value===-100&&Number.isInteger(w)&&same(williamsR(w)))return `威廉%R(${w})`;
  }
  if(node.op==='sub'){const f=node.left?.period,l=node.right?.period;if(Number.isInteger(f)&&Number.isInteger(l)&&same(macdLine(f,l)))return `MACD DIF(${f},${l})`;}
  if(node.op==='ema'){const f=node.input?.left?.period,l=node.input?.right?.period;if(Number.isInteger(f)&&Number.isInteger(l)&&same(macdSignal(f,l,node.period)))return `MACD DEA(${f},${l},${node.period})`;}
  if(node.op==='add'||node.op==='sub'){const p=node.left?.period,k=node.right?.right?.value;if(node.left?.op==='sma'&&Number.isInteger(p)&&typeof k==='number'&&same(bollinger(p,k,node.op==='add'?'upper':'lower')))return `布林${node.op==='add'?'上軌':'下軌'}(${p}, ${k}σ)`;}
  if(node.op==='rma'&&node.input?.op==='tr')return `ATR(${node.period})`;
  if(node.op==='max'&&same(ichimokuCloudTop()))return '一目雲層上緣(9,26,52)';
  if(node.op==='min'&&same(ichimokuCloudBottom()))return '一目雲層下緣(9,26,52)';
  if(node.op==='div'){const n=node.left?.left?.period;if(Number.isInteger(n)&&same(ichimokuMid(n)))return n===9?'一目轉換線(9)':n===26?'一目基準線(26)':`一目中值線(${n})`;}
  return null;
}
function summarize(node){
  const known=knownLabel(node);if(known)return known;
  if(node.op==='source')return SOURCE_LABEL[node.field];
  if(node.op==='constant')return String(node.value);
  if(node.op==='tr')return '真實波幅';
  if(WINDOW.includes(node.op))return `${WINDOW_LABEL[node.op]}(${summarize(node.input)}, ${node.period})`;
  if(node.op==='prev')return `前${node.period}根的${summarize(node.input)}`;
  if(node.op==='abs')return `|${summarize(node.input)}|`;
  if(node.op==='max'||node.op==='min')return `${node.op==='max'?'較大值':'較小值'}(${summarize(node.left)}, ${summarize(node.right)})`;
  if(['add','sub','mul','div'].includes(node.op))return `(${summarize(node.left)} ${ {add:'+',sub:'-',mul:'×',div:'÷'}[node.op]} ${summarize(node.right)})`;
  if(LOGIC.includes(node.op))return node.items.map((item)=>LOGIC.includes(item.op)?`（${summarize(item)}）`:summarize(item)).join(node.op==='all'?' 且 ':' 或 ');
  return `${summarize(node.left)} ${COMPARE_LABEL[node.op]} ${summarize(node.right)}`;
}
function formulaError(code,statusCode=400){return Object.assign(new Error(code),{code,statusCode});}
