import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createProbe } from 'node:net';

const root=new URL('../',import.meta.url).pathname;const dir=await mkdtemp(join(tmpdir(),'watch365-formula-e2e-'));const appPort=await freePort();const modelPort=await freePort();
const nodes=[
  {id:'close',op:'source',field:'close',value:null,period:null,inputId:null,leftId:null,rightId:null},
  {id:'fast',op:'ema',field:null,value:null,period:12,inputId:'close',leftId:null,rightId:null},
  {id:'slow',op:'ema',field:null,value:null,period:26,inputId:'close',leftId:null,rightId:null},
  {id:'macd',op:'sub',field:null,value:null,period:null,inputId:null,leftId:'fast',rightId:'slow'},
  {id:'signal',op:'ema',field:null,value:null,period:9,inputId:'macd',leftId:null,rightId:null},
  {id:'cross',op:'crosses_above',field:null,value:null,period:null,inputId:null,leftId:'macd',rightId:'signal'}
];
const model=createServer(async(request,response)=>{for await(const _ of request){}response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({choices:[{message:{content:JSON.stringify({status:'formula',message:'',name:'MACD 上穿訊號線',timeframe:'1m',indicatorId:null,version:null,params:{period:null,threshold:null},nodes,rootId:'cross'})}}]}));});await new Promise((resolve)=>model.listen(modelPort,'127.0.0.1',resolve));
let processHandle;
try{
  await start();const base=`http://127.0.0.1:${appPort}`;const watchlist=[{symbol:'2330',name:'台積電',market:'TWSE'}];
  const planned=await post(`${base}/api/indicator-agent/parse`,{text:'一分鐘 MACD 12 26 9 向上穿越訊號線'});if(planned.status!=='formula'||!planned.proposalToken||!planned.proposalId)throw new Error('signed_formula_plan_missing');
  const beforeRejected=await fetch(`${base}/api/state`).then((response)=>response.json());const rejected=await fetch(`${base}/api/formula/activate`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({proposalToken:planned.proposalToken,watchlist,adminApproved:true})});if(rejected.status!==422||(await rejected.json()).error!=='FORMULA_ACTIVATION_INVALID')throw new Error('formula_unknown_field_not_rejected');const afterRejected=await fetch(`${base}/api/state`).then((response)=>response.json());if(JSON.stringify(beforeRejected.settings)!==JSON.stringify(afterRejected.settings))throw new Error('rejected_formula_activation_changed_state');
  const activated=await post(`${base}/api/formula/activate`,{proposalToken:planned.proposalToken,watchlist});if(!activated.settings.enabled||activated.settings.strategy.executor!=='formula_v1'||activated.settings.formulaActivationId!==planned.proposalId)throw new Error('formula_activation_not_committed');
  await stop();await start();const restarted=await fetch(`${base}/api/state`).then((response)=>response.json());if(restarted.settings.strategy.executor!=='formula_v1'||restarted.settings.strategy.formula.warmupBars!==35||restarted.settings.strategy.formula.summary.includes('undefined'))throw new Error('formula_restart_invalid');
  const run=await post(`${base}/api/monitor/run`,{});if(run.state?.runtime?.lastError==='INDICATOR_VERSION_UNAVAILABLE'||run.state?.runtime?.lastError==='INDICATOR_VERSION_MUTATED')throw new Error('formula_restart_registry_rejected');
  console.log(JSON.stringify({signedProposal:'ok',unknownField:'rejected-without-state-change',activation:'persisted',restart:'verified',warmupBars:35,monitor:'formula-accepted'}));
}finally{await stop();await new Promise((resolve)=>model.close(resolve));await rm(dir,{recursive:true,force:true});}

async function start(){processHandle=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,PORT:String(appPort),WATCH365_DATA_FILE:join(dir,'state.json'),WATCH365_INDICATOR_REQUESTS_FILE:join(dir,'requests.json'),INDICATOR_AGENT_PROVIDER:'groq',INDICATOR_AGENT_MODEL:'fixture',GROQ_API_KEY:'fixture',INDICATOR_AGENT_BASE_URL:`http://127.0.0.1:${modelPort}`},stdio:['ignore','pipe','pipe']});for(let i=0;i<100;i++){try{if((await fetch(`http://127.0.0.1:${appPort}/api/state`)).ok)return;}catch{}await new Promise((resolve)=>setTimeout(resolve,50));}throw new Error('app_start_timeout');}
async function stop(){if(!processHandle)return;processHandle.kill('SIGTERM');await Promise.race([new Promise((resolve)=>processHandle.once('exit',resolve)),new Promise((resolve)=>setTimeout(resolve,2000))]);processHandle=null;}
async function post(url,body){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(`${response.status}:${JSON.stringify(data)}`);return data;}
async function freePort(){return new Promise((resolve,reject)=>{const probe=createProbe();probe.once('error',reject);probe.listen(0,'127.0.0.1',()=>{const {port}=probe.address();probe.close((error)=>error?reject(error):resolve(port));});});}
