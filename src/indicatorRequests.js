import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const STATUSES=['pending_evaluation'];
const TIMEFRAMES=['1m','d1','other'];
const INPUT_KEYS=['sourceText','indicatorName','timeframe','customTimeframe','parameterDescription','triggerCondition'];

export class IndicatorRequestStore {
  constructor(filePath){this.filePath=filePath;this.data={version:1,requests:[]};this.queue=Promise.resolve();}
  async load(){await mkdir(dirname(this.filePath),{recursive:true});try{const raw=JSON.parse(await readFile(this.filePath,'utf8'));if(raw.version!==1||!Array.isArray(raw.requests)||!raw.requests.every(validStoredRequest))throw requestError('INDICATOR_REQUEST_STORE_INVALID',500);this.data={version:1,requests:raw.requests};}catch(error){if(error.code!=='ENOENT')throw error;await this.save();}return this.list();}
  list(){return structuredClone(this.data.requests.slice().sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));}
  get(id){const item=this.data.requests.find((request)=>request.id===id);return item?structuredClone(item):null;}
  submit(input){const operation=this.queue.then(()=>this.submitLocked(input));this.queue=operation.catch(()=>{});return operation;}
  async submitLocked(input){const normalized=validateIndicatorRequest(input);const fingerprint=createHash('sha256').update(JSON.stringify(normalized.dedupe)).digest('hex');const existing=this.data.requests.find((item)=>item.fingerprint===fingerprint);if(existing)return{request:structuredClone(existing),duplicate:true};if(this.data.requests.length>=500)throw requestError('INDICATOR_REQUEST_LIMIT_REACHED',409);const now=new Date().toISOString();const request={id:randomUUID(),status:'pending_evaluation',sourceText:normalized.sourceText,indicatorName:normalized.indicatorName,timeframe:normalized.timeframe,customTimeframe:normalized.customTimeframe,parameterDescription:normalized.parameterDescription,triggerCondition:normalized.triggerCondition,createdAt:now,updatedAt:now,fingerprint};const next={version:1,requests:[request,...this.data.requests]};await this.save(next);this.data=next;return{request:structuredClone(request),duplicate:false};}
  async save(data=this.data){const temporary=`${this.filePath}.${process.pid}.tmp`;await writeFile(temporary,`${JSON.stringify(data,null,2)}\n`,{encoding:'utf8',mode:0o600});await rename(temporary,this.filePath);}
}

export function validateIndicatorRequest(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw requestError('INDICATOR_REQUEST_INVALID');
  if(Object.keys(input).some((key)=>!INPUT_KEYS.includes(key)))throw requestError('INDICATOR_REQUEST_FIELDS_INVALID');
  if(typeof input.sourceText!=='string')throw requestError('INDICATOR_REQUEST_FIELDS_INVALID');
  const sourceText=input.sourceText.trim().replace(/\s+/g,' ');
  if(sourceText.length<3)throw requestError('INDICATOR_REQUEST_TEXT_TOO_SHORT');
  if(sourceText.length>500)throw requestError('INDICATOR_REQUEST_TEXT_TOO_LONG');
  const indicatorName=boundedText(input.indicatorName,2,80); const timeframe=typeof input.timeframe==='string'?input.timeframe:''; const customTimeframe=timeframe==='other'?boundedText(input.customTimeframe,2,50):null; const parameterDescription=boundedText(input.parameterDescription,2,300); const triggerCondition=boundedText(input.triggerCondition,2,300);
  if(!TIMEFRAMES.includes(timeframe))throw requestError('INDICATOR_REQUEST_FIELDS_REQUIRED');
  const dedupe={sourceText:sourceText.toLocaleLowerCase('zh-Hant'),indicatorName:indicatorName.toLocaleLowerCase('zh-Hant'),timeframe,customTimeframe:customTimeframe?.toLocaleLowerCase('zh-Hant')||null,parameterDescription:parameterDescription.toLocaleLowerCase('zh-Hant'),triggerCondition:triggerCondition.toLocaleLowerCase('zh-Hant')};
  return{sourceText,indicatorName,timeframe,customTimeframe,parameterDescription,triggerCondition,dedupe};
}

function boundedText(value,min,max){if(typeof value!=='string')throw requestError('INDICATOR_REQUEST_FIELDS_INVALID');const text=value.trim().replace(/\s+/g,' ');if(text.length<min)throw requestError('INDICATOR_REQUEST_FIELDS_REQUIRED');if(text.length>max)throw requestError('INDICATOR_REQUEST_FIELDS_INVALID');return text;}
function validStoredRequest(value){if(!value||typeof value!=='object'||typeof value.id!=='string'||!STATUSES.includes(value.status)||typeof value.fingerprint!=='string'||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string')return false;try{validateIndicatorRequest(Object.fromEntries(INPUT_KEYS.filter((key)=>Object.hasOwn(value,key)).map((key)=>[key,value[key]])));return true;}catch{return false;}}
function requestError(code,statusCode=422){return Object.assign(new Error(code),{code,statusCode});}
