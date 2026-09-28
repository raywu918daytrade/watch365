import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const root=new URL('../',import.meta.url).pathname;
const dir=await mkdtemp(join(tmpdir(),'watch365-engine-'));

async function openPort(){return new Promise((resolve,reject)=>{const server=createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close((error)=>error?reject(error):resolve(port));});});}
async function startServer(statePath,extraEnv={}){
  const port=await openPort(); const processRef=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,INDICATOR_AGENT_PROVIDER:'',INDICATOR_AGENT_MODEL:'',...extraEnv,PORT:String(port),WATCH365_DATA_FILE:statePath,WATCH365_INDICATOR_REQUESTS_FILE:`${statePath}.indicator-requests`},stdio:['ignore','pipe','pipe']}); let output='';processRef.stdout.on('data',(chunk)=>output+=chunk);processRef.stderr.on('data',(chunk)=>output+=chunk);
  const url=`http://127.0.0.1:${port}`;for(let i=0;i<100;i+=1){if(processRef.exitCode!==null)throw new Error(`engine_server_exit: ${output}`);try{if((await fetch(url)).ok)return{url,processRef};}catch{}await new Promise((resolve)=>setTimeout(resolve,50));}throw new Error(`engine_server_timeout: ${output}`);
}
async function stopServer(processRef){processRef.kill('SIGTERM');await Promise.race([new Promise((resolve)=>processRef.once('exit',resolve)),new Promise((resolve)=>setTimeout(resolve,2000))]);}
async function post(url,path,body={}){const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json()};}

try{
  const statePath=join(dir,'state.json'); let server=await startServer(statePath);
  const registry=await fetch(server.url+'/api/indicators').then((response)=>response.json());
  if(registry.items.length<3||registry.errors.length)throw new Error('indicator_registry_contract_failed');
  const agentStatus=await fetch(server.url+'/api/indicator-agent/status').then((response)=>response.json()); const beforeAgent=await fetch(server.url+'/api/state').then((response)=>response.json()); const unavailableAgent=await post(server.url,'/api/indicator-agent/parse',{text:'一分鐘SMA20價格上穿'}); const afterAgent=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(agentStatus.configured||unavailableAgent.status!==503||unavailableAgent.body.error!=='INDICATOR_AGENT_NOT_CONFIGURED'||JSON.stringify(beforeAgent.settings)!==JSON.stringify(afterAgent.settings))throw new Error('unconfigured_agent_must_not_change_settings');
  const indicatorRequest={sourceText:'請支援 MACD 黃金交叉',indicatorName:'MACD',timeframe:'1m',parameterDescription:'快線 12、慢線 26、訊號線 9',triggerCondition:'MACD 線向上穿越訊號線'};const invalidIndicatorRequest=await post(server.url,'/api/indicator-requests',{...indicatorRequest,timeframe:'',parameterDescription:''});const extraFieldRequest=await post(server.url,'/api/indicator-requests',{...indicatorRequest,adminApproved:true});const malformedResponse=await fetch(server.url+'/api/indicator-requests',{method:'POST',headers:{'content-type':'application/json'},body:'{"broken"'});const malformed={status:malformedResponse.status,body:await malformedResponse.json()};const settingsBeforeRequest=JSON.stringify(afterAgent.settings);const submitted=await Promise.all([post(server.url,'/api/indicator-requests',indicatorRequest),post(server.url,'/api/indicator-requests',indicatorRequest)]);const requestList=await fetch(server.url+'/api/indicator-requests').then((response)=>response.json());const settingsAfterRequest=JSON.stringify((await fetch(server.url+'/api/state').then((response)=>response.json())).settings);
  const requestStatus=await fetch(server.url+`/api/indicator-requests/${encodeURIComponent(requestList.items[0]?.id||'missing')}`).then(async(response)=>({status:response.status,body:await response.json()}));
  if(invalidIndicatorRequest.status!==422||invalidIndicatorRequest.body.error!=='INDICATOR_REQUEST_FIELDS_REQUIRED'||extraFieldRequest.status!==422||extraFieldRequest.body.error!=='INDICATOR_REQUEST_FIELDS_INVALID'||malformed.status!==400||malformed.body.error!=='INVALID_JSON'||submitted.some((item)=>![200,201].includes(item.status))||submitted.filter((item)=>item.body.duplicate===false).length!==1||requestList.items.length!==1||requestList.items[0].status!=='pending_evaluation'||requestStatus.status!==200||requestStatus.body.status!=='pending_evaluation'||settingsBeforeRequest!==settingsAfterRequest)throw new Error('indicator_request_persistence_or_dedupe_failed');
  const watchlist=[{symbol:'2330',name:'台積電',market:'TWSE'},{symbol:'9999',name:'測試未涵蓋',market:'TWSE'}];
  const invalidStrategy=await post(server.url,'/api/settings',{watchlist,enabled:false,strategy:{id:'sma.cross',version:'1.0.0',timeframe:'1m',params:{period:1}}});
  if(invalidStrategy.status!==400)throw new Error('indicator_params_must_be_rejected');
  const configured=await post(server.url,'/api/settings',{watchlist,enabled:false,strategy:{id:'sma.cross',version:'1.0.0',timeframe:'1m',params:{period:10},activatedAt:'1970-01-01T00:00:00.000Z'},monitorTask:{onboardingCompleted:true}});
  if(configured.body.settings.strategy.params.period!==10||configured.body.settings.strategy.activatedAt==='1970-01-01T00:00:00.000Z'||!configured.body.settings.strategy.definitionFingerprint)throw new Error('versioned_strategy_persistence_failed');
  await post(server.url,'/api/monitor/run');
  let state=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(state.settings.watchlist.length!==2||state.runtime.effectiveWatchlistCount!==1||state.runtime.uncoveredWatchlistCount!==1||state.signals.length||state.notifications.length)throw new Error(`intersection_engine_contract_failed: ${JSON.stringify({watchlist:state.settings.watchlist.length,effective:state.runtime.effectiveWatchlistCount,uncovered:state.runtime.uncoveredWatchlistCount,signals:state.signals.length,notifications:state.notifications.length,coverageStatus:state.runtime.coverageStatus})}`);
  await post(server.url,'/api/settings',{watchlist:[{symbol:'9999',name:'測試未涵蓋',market:'TWSE'}],enabled:false,monitorTask:{onboardingCompleted:true}});
  const empty=await post(server.url,'/api/monitor/run'); state=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(empty.body.reason!=='empty_scope'||state.settings.watchlist.length!==1||state.runtime.effectiveWatchlistCount!==0||state.signals.length||state.notifications.length)throw new Error('empty_scope_contract_failed');
  await stopServer(server.processRef);

  const registryLock=JSON.parse(await readFile(join(root,'config/indicator-registry-lock.json'),'utf8')); const smaFingerprint=registryLock['sma.cross@1.0.0'];
  const smaStrategy=(period,version='1.0.0')=>({id:'sma.cross',version,executor:'sma_cross',name:'價格上穿 SMA',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:smaFingerprint,params:{period},activatedAt:'2026-09-25T00:00:00.000Z'});
  await writeFile(statePath,JSON.stringify({settings:{enabled:false,watchlist:[{symbol:'2330',name:'台積電',market:'TWSE'},{symbol:'9999',name:'測試未涵蓋',market:'TWSE'}],monitorTask:{onboardingCompleted:true}},signals:[{id:'sig-covered',symbol:'2330'},{id:'sig-revoke',symbol:'2330'},{id:'sig-legacy-stale',symbol:'2330'},{id:'sig-sma-current',symbol:'2330',strategy:smaStrategy(10)},{id:'sig-sma-param',symbol:'2330',strategy:smaStrategy(20)},{id:'sig-sma-version',symbol:'2330',strategy:smaStrategy(10,'2.0.0')},{id:'sig-removed',symbol:'9999'}],notifications:[{id:'noti-covered',signalId:'sig-covered',status:'pending',title:'test',message:'test',deliveryAuthorizedAt:new Date().toISOString(),deliveryAuthorizedRevision:'stale-revision'},{id:'noti-revoke',signalId:'sig-revoke',status:'pending',title:'test',message:'test'},{id:'noti-legacy-stale',signalId:'sig-legacy-stale',status:'pending',title:'test',message:'test'},{id:'noti-sma-current',signalId:'sig-sma-current',status:'pending',title:'test',message:'test'},{id:'noti-sma-param',signalId:'sig-sma-param',status:'pending',title:'test',message:'test'},{id:'noti-sma-version',signalId:'sig-sma-version',status:'pending',title:'test',message:'test'},{id:'noti-removed',signalId:'sig-removed',status:'pending',title:'test',message:'test'}]}));
  server=await startServer(statePath);
  const pausedValidation=await post(server.url,'/api/notifications/noti-covered/validate'); state=await fetch(server.url+'/api/state').then((response)=>response.json());
  const pausedNotification=state.notifications.find((item)=>item.id==='noti-covered');
  if(pausedValidation.body.reason!=='monitor_paused'||pausedNotification.status!=='pending'||pausedNotification.deliveryAuthorizedAt!==null)throw new Error('paused_notification_must_remain_pending_without_authorization');
  await post(server.url,'/api/monitor/start'); const allowed=await post(server.url,'/api/notifications/noti-covered/validate'); const ack=await post(server.url,'/api/notifications/noti-covered/ack'); const sentRetry=await post(server.url,'/api/notifications/noti-covered/retry');
  if(!allowed.body.deliver||!ack.body.acknowledged||sentRetry.body.retried)throw new Error('notification_authorization_boundary_failed');
  const validation=await post(server.url,'/api/notifications/noti-removed/validate'); const suppressedAck=await post(server.url,'/api/notifications/noti-removed/ack'); const suppressedRetry=await post(server.url,'/api/notifications/noti-removed/retry'); state=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(validation.body.deliver!==false||validation.body.reason!=='not_covered'||state.notifications.find((item)=>item.id==='noti-removed').status!=='suppressed'||suppressedAck.body.acknowledged||suppressedRetry.body.retried)throw new Error('pending_notification_suppression_failed');
  const revokeGrant=await post(server.url,'/api/notifications/noti-revoke/validate'); if(!revokeGrant.body.deliver)throw new Error('same_strategy_prechange_authorization_failed');
  const switched=await post(server.url,'/api/settings',{watchlist:[{symbol:'2330',name:'台積電',market:'TWSE'},{symbol:'9999',name:'測試未涵蓋',market:'TWSE'}],enabled:true,strategy:{id:'sma.cross',version:'1.0.0',timeframe:'1m',params:{period:10}},monitorTask:{onboardingCompleted:true}}); if(switched.status!==200)throw new Error('strategy_switch_failed');
  const revokedAck=await post(server.url,'/api/notifications/noti-revoke/ack');
  const staleLegacy=await post(server.url,'/api/notifications/noti-legacy-stale/validate'); const staleParam=await post(server.url,'/api/notifications/noti-sma-param/validate'); const staleVersion=await post(server.url,'/api/notifications/noti-sma-version/validate');
  const sameSma=await post(server.url,'/api/notifications/noti-sma-current/validate'); const sameSmaAck=await post(server.url,'/api/notifications/noti-sma-current/ack'); state=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(revokedAck.body.acknowledged||revokedAck.body.reason!=='strategy_mismatch'||[staleLegacy,staleParam,staleVersion].some((item)=>item.body.reason!=='strategy_mismatch')||!sameSma.body.deliver||!sameSmaAck.body.acknowledged)throw new Error('strategy_notification_identity_boundary_failed');
  if(['noti-legacy-stale','noti-sma-param','noti-sma-version'].some((id)=>state.notifications.find((item)=>item.id===id).status!=='suppressed'))throw new Error('strategy_mismatch_must_suppress_pending');
  await stopServer(server.processRef);

  const unknownPath=join(dir,'unknown.json'); server=await startServer(unknownPath,{HF_REPO_ID:'invalid/repository',HF_TOKEN:'invalid-token'});
  await post(server.url,'/api/settings',{watchlist:[{symbol:'2330',name:'台積電',market:'TWSE'}],enabled:false,monitorTask:{onboardingCompleted:true}}); const unknown=await post(server.url,'/api/monitor/run'); state=await fetch(server.url+'/api/state').then((response)=>response.json());
  if(unknown.body.reason!=='coverage_unknown'||state.runtime.coverageStatus!=='unknown'||state.signals.length||state.notifications.length)throw new Error('coverage_fail_closed_failed');
  await stopServer(server.processRef);
  console.log(JSON.stringify({registry:'three-definitions',agent:'unconfigured-and-state-preserved',strategy:'versioned-and-server-activated',strategyNotifications:'legacy-version-params-rejected/same-accepted',intersection:'2/1/1',emptyScope:'closed',coverageUnknown:'closed',pausedNotification:'pending',authorizedAck:'sent',sentRetry:'rejected',suppressedNotification:'ack-and-retry-rejected',customerWatchlist:'preserved'}));
}finally{await rm(dir,{recursive:true,force:true});}
