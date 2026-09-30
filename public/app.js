// Three-step flow (選範圍 → 條件 → 確認) documented in docs/ui-prototype-flow.md, wired to /api
// for stock lists, indicator requests and monitor creation.
// 30-day historical lookup has no backend yet, so that section is shown as unsupported.
const KEY='watch365_ui_v2';
const INDICATORS=[
  {id:'rsi',name:'RSI',desc:'Wilder RSI 由下往上穿越門檻',directions:['above'],periodMax:100,threshold:true,defaults:{period:14,threshold:30}},
  {id:'sma',name:'SMA 簡單移動平均',desc:'收盤價穿越 SMA',directions:['above','below'],periodMax:200,threshold:false,defaults:{period:20}},
  {id:'ema',name:'EMA 指數移動平均',desc:'收盤價穿越 EMA',directions:['above','below'],periodMax:200,threshold:false,defaults:{period:20}}
];
const DIRECTION_LABEL={above:'上穿',below:'下穿'};
const ERROR_TEXT={
  CONDITIONS_REQUIRED:'請至少加入一個條件。',CONDITIONS_TOO_MANY:'目前最多只能組合 2 個條件。',
  CONDITION_RSI_BELOW_UNSUPPORTED:'RSI 目前只支援上穿。',CONDITION_RSI_COMBINATION_UNSUPPORTED:'RSI 目前不能與其他條件組合，請單獨使用。',
  CONDITION_PERIOD_INVALID:'期數超出範圍。',CONDITION_THRESHOLD_INVALID:'RSI 門檻需介於 1–99。',
  WATCHLIST_REQUIRED:'請至少選一檔股票。',WATCHLIST_MARKET_REQUIRED:'有股票無法確認市場別，請移除後再試。',
  HF_UNIVERSE_SOURCE_FAILED:'無法讀取 HF 系統名單，請稍後再試。',HF_UNIVERSE_NOT_FOUND:'HF 系統名單不存在。',HF_METADATA_UNAVAILABLE:'無法讀取股票市場別資料，請稍後再試。',
  INDICATOR_REQUEST_TEXT_TOO_SHORT:'需求描述至少 3 個字。',INDICATOR_REQUEST_FIELDS_REQUIRED:'請填完所有欄位。',INDICATOR_TEXT_REQUIRED:'欄位長度不足（至少 2 個字）。'
};
const root=document.querySelector('#app');
let state=load();
let pollTimer=0,searchTimer=0,seenNotifications=new Set();
document.querySelector('#homeButton').addEventListener('click',()=>go('home'));
window.addEventListener('hashchange',render);

function initial(){return{purpose:null,selected:[],watchlist:[],conditions:[],activeIndicator:'rsi',drafts:{},requestText:''};}
function load(){try{return{...initial(),...JSON.parse(localStorage.getItem(KEY))};}catch{return initial();}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}}
function resetDraft(){state=initial();save();}
function node(){return location.hash.slice(1)||'home';}
function go(next){if(location.hash===`#${next}`)render();else location.hash=next;}
function errorText(error){return ERROR_TEXT[error?.code]||error?.message||'發生錯誤，請稍後再試。';}

async function api(url,body){
  const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(payload.error||`HTTP ${response.status}`),{code:payload.error});
  return payload;
}

function phaseFor(step){return{stocks:1,conditions:2,request:2,confirm:3}[step]||0;}
function shell({step,title,lead,body,back}){
  clearInterval(pollTimer);
  const phase=phaseFor(step),labels=['選範圍','條件','確認'];
  const progress=phase?`<div class="proto-progress"><span>${phase}/3 ${labels[phase-1]}</span><div class="proto-progress-line"><i style="width:${phase/3*100}%"></i></div><span>${labels.join(' → ')}</span></div>`:'';
  root.innerHTML=`<section class="proto-frame">${progress}${back?`<button class="proto-back" data-go="${back}">← 返回修改</button>`:''}<p class="proto-eyebrow">${phase?`階段 ${phase}・${labels[phase-1]}`:'幫你盯盤'}</p><h1>${title}</h1><p class="proto-lead">${lead}</p>${body}</section>`;
  root.querySelectorAll('[data-go]').forEach((button)=>button.addEventListener('click',()=>go(button.dataset.go)));
}
function render(){const routes={home,stocks,conditions,request,confirm,success,dashboard};(routes[node()]||home)();}

async function home(){
  const draft=state.purpose?`<div class="proto-resume"><strong>有一份尚未完成的草案</strong><p>${state.purpose==='watchlist'?`指定股票 ${state.selected.length} 檔`:'條件選股'} · ${state.conditions.length} 個條件</p><button class="proto-secondary" data-go="${state.purpose==='watchlist'&&!state.watchlist.length?'stocks':'conditions'}">繼續草案</button></div>`:'';
  shell({title:'今天想怎麼盯？',lead:'選一個目的就直接開始。建立後會用 HF 一分鐘 K 真實監控。',body:`<div class="proto-options"><button class="proto-option" data-purpose="watchlist"><span><strong>盯指定股票</strong><small>從今日系統可監控名單中搜尋並多選</small></span><span class="proto-arrow">→</span></button><button class="proto-option" data-purpose="screen"><span><strong>用條件找股票</strong><small>條件套用到每日最新系統名單，不凍結當下結果</small></span><span class="proto-arrow">→</span></button></div>${draft}<div class="proto-inline-actions" id="homeActions"></div>`});
  root.querySelectorAll('[data-purpose]').forEach((button)=>button.addEventListener('click',()=>{const purpose=button.dataset.purpose;if(purpose!==state.purpose){state.purpose=purpose;state.watchlist=[];}save();go(purpose==='watchlist'?'stocks':'conditions');}));
  try{const data=await api('/api/state');if(node()==='home'&&data.settings?.monitorTask?.onboardingCompleted){const actions=root.querySelector('#homeActions');actions.innerHTML=`<button class="proto-secondary" data-go="dashboard">我的監控${data.settings.enabled?'（運作中）':'（已暫停）'}</button>`;actions.querySelector('button').addEventListener('click',()=>go('dashboard'));}}catch{}
}

function stocks(){
  shell({step:'stocks',title:'選擇今天要盯的股票',lead:'名單來自 HF 每日最新系統名單。可搜尋代號或名稱並多選。',back:'home',body:`<label class="proto-search"><input id="stockSearch" type="search" placeholder="搜尋代號或名稱" aria-label="搜尋股票"></label><p id="universeInfo" class="proto-signature">讀取名單中…</p><div class="proto-stock-list" id="stockList"></div><p id="stockError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span id="stockCount"></span><button id="stocksDone" class="proto-primary">選好了</button></div>`});
  const list=root.querySelector('#stockList'),search=root.querySelector('#stockSearch'),done=root.querySelector('#stocksDone');
  const syncCount=()=>{root.querySelector('#stockCount').textContent=`已選 ${state.selected.length} 檔`;done.disabled=!state.selected.length;};
  let requestId=0;
  const draw=async()=>{
    const id=++requestId,query=search.value.trim();
    try{
      const data=await api(`/api/system-universe?pageSize=50&q=${encodeURIComponent(query)}`);
      if(id!==requestId)return;
      root.querySelector('#universeInfo').textContent=`系統名單 ${data.total} 檔・更新於 ${data.updatedDate}${query?`・符合 ${data.filteredTotal} 檔`:''}${data.filteredTotal>data.items.length?`（顯示前 ${data.items.length} 檔，請用搜尋縮小範圍）`:''}`;
      const selected=new Set(state.selected.map((item)=>item.symbol));
      list.innerHTML=data.items.length?data.items.map((item)=>`<label class="proto-stock"><input type="checkbox" value="${escapeHtml(item.symbol)}" data-name="${escapeHtml(item.name||'')}" ${selected.has(item.symbol)?'checked':''}><span><strong>${escapeHtml(item.symbol)} ${escapeHtml(item.name||'')}</strong></span></label>`).join(''):'<div class="proto-status"><strong>今日系統名單找不到</strong><p>請改用其他代號或名稱搜尋。</p></div>';
      list.querySelectorAll('input').forEach((input)=>input.addEventListener('change',()=>{state.selected=input.checked?[...state.selected.filter((item)=>item.symbol!==input.value),{symbol:input.value,name:input.dataset.name}]:state.selected.filter((item)=>item.symbol!==input.value);state.watchlist=[];save();syncCount();}));
    }catch(error){if(id!==requestId)return;root.querySelector('#universeInfo').textContent='';list.innerHTML=`<div class="proto-status"><strong>無法讀取系統名單</strong><p>${escapeHtml(errorText(error))}</p></div>`;}
  };
  search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(draw,250);});
  syncCount();draw();
  done.addEventListener('click',async()=>{
    done.disabled=true;root.querySelector('#stockError').textContent='';
    try{
      const result=await api('/api/watchlist/resolve',{input:state.selected.map((item)=>item.symbol).join(' ')});
      if(result.metadataStatus!=='available')throw Object.assign(new Error(),{code:'HF_METADATA_UNAVAILABLE'});
      if(result.needsCorrection.length){root.querySelector('#stockError').textContent=`無法確認市場別：${result.needsCorrection.map((item)=>item.symbol).join('、')}，請取消勾選後再試。`;syncCount();return;}
      state.watchlist=result.valid.map(({symbol,name,market})=>({symbol,name,market}));save();go('conditions');
    }catch(error){root.querySelector('#stockError').textContent=errorText(error);syncCount();}
  });
}

function conditions(){
  if(!state.purpose)return go('home');
  if(state.purpose==='watchlist'&&!state.watchlist.length)return go('stocks');
  const item=INDICATORS.find((entry)=>entry.id===state.activeIndicator)||INDICATORS[0],draft={direction:item.directions[0],...item.defaults,...state.drafts[item.id]};
  if(!item.directions.includes(draft.direction))draft.direction=item.directions[0];
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'每日最新系統名單';
  shell({step:'conditions',title:'設定監控條件',lead:`範圍：${scope}。條件以一分鐘 K 收盤判斷；最多組合 2 個條件，需全部同時成立才觸發。`,back:state.purpose==='watchlist'?'stocks':'home',body:`<label class="proto-search"><input id="indicatorSearch" type="search" placeholder="搜尋 RSI、SMA、EMA，或輸入新需求" aria-label="搜尋指標" value="${escapeHtml(state.requestText)}"></label><div class="proto-library proto-inline-library" id="indicatorResults"></div><section class="proto-condition-editor"><p class="proto-eyebrow">目前參數</p><h2>${escapeHtml(item.name)}</h2><p class="proto-signature">${escapeHtml(item.desc)}</p><div class="proto-form"><label>方向<select id="direction">${item.directions.map((value)=>`<option value="${value}" ${draft.direction===value?'selected':''}>${DIRECTION_LABEL[value]}</option>`).join('')}</select></label><label>期數<input id="period" type="number" min="2" max="${item.periodMax}" value="${escapeHtml(draft.period)}"></label>${item.threshold?`<label>門檻<input id="threshold" type="number" min="1" max="99" value="${escapeHtml(draft.threshold)}"></label>`:''}<p id="paramError" class="proto-error" role="alert"></p></div><button id="addCondition" class="proto-secondary">加入這個條件</button></section>${conditionMarkup()}<section class="proto-history"><div class="proto-history-head"><div><p class="proto-eyebrow">過去 30 個交易日</p><h2>M1 歷史觸發時間點</h2></div><span>尚未支援</span></div><div class="proto-status"><strong>歷史回查功能開發中</strong><p>目前可以直接建立監控；歷史回查會在下一階段接上 HF 真實資料。</p></div></section><div class="proto-sticky-action"><span>${state.conditions.length} 個條件</span><button id="confirmConditions" class="proto-primary" ${state.conditions.length?'':'disabled'}>確認設定</button></div>`});
  bindConditionList();
  const search=root.querySelector('#indicatorSearch'),results=root.querySelector('#indicatorResults');
  const drawSearch=()=>{const value=search.value.trim(),needle=value.toLowerCase();state.requestText=value;save();const matches=INDICATORS.filter((entry)=>!needle||`${entry.id} ${entry.name} ${entry.desc}`.toLowerCase().includes(needle));results.innerHTML=matches.length?matches.map((entry)=>`<button class="proto-indicator-pill ${entry.id===item.id?'active':''}" data-indicator="${entry.id}"><strong>${escapeHtml(entry.name)}</strong><small>已有指標</small></button>`).join(''):`<div class="proto-status"><strong>找不到「${escapeHtml(value)}」</strong><p>可以沿用這段文字提出新指標需求。</p><button id="requestNew" class="proto-secondary">提出需求</button></div>`;results.querySelectorAll('[data-indicator]').forEach((button)=>button.addEventListener('click',()=>{state.activeIndicator=button.dataset.indicator;state.requestText='';save();render();}));results.querySelector('#requestNew')?.addEventListener('click',()=>go('request'));};
  search.addEventListener('input',drawSearch);drawSearch();
  const capture=()=>{state.drafts[item.id]={direction:root.querySelector('#direction').value,period:root.querySelector('#period').value,threshold:root.querySelector('#threshold')?.value??null};save();};
  root.querySelectorAll('#direction,#period,#threshold').forEach((input)=>input.addEventListener('input',()=>{capture();root.querySelector('#paramError').textContent='';}));
  root.querySelector('#addCondition').addEventListener('click',()=>{
    capture();
    const values=state.drafts[item.id],period=Number(values.period),threshold=item.threshold?Number(values.threshold):null,hasRsi=state.conditions.some((entry)=>entry.indicator==='rsi');
    const error=!Number.isInteger(period)||period<2||period>item.periodMax?`期數需為 2–${item.periodMax} 的整數。`:item.threshold&&(!values.threshold||!Number.isFinite(threshold)||threshold<1||threshold>99)?'門檻需介於 1–99。':state.conditions.length>=2?'目前最多只能組合 2 個條件。':state.conditions.length&&(hasRsi||item.id==='rsi')?'RSI 目前不能與其他條件組合，請單獨使用。':'';
    if(error){root.querySelector('#paramError').textContent=error;return;}
    state.conditions.push({id:crypto.randomUUID(),indicator:item.id,direction:values.direction,period,threshold});save();render();
  });
  root.querySelector('#confirmConditions').addEventListener('click',()=>go('confirm'));
}
function conditionLabel(condition){const item=INDICATORS.find((entry)=>entry.id===condition.indicator);return`${item?.name||condition.indicator} ${condition.period} ${DIRECTION_LABEL[condition.direction]}${condition.threshold===null?'':` ${condition.threshold}`}`;}
function conditionMarkup(){return state.conditions.length?`<div class="proto-condition-list"><p class="proto-eyebrow">已加入的條件（全部成立才觸發）</p>${state.conditions.map((condition)=>`<div class="proto-condition"><strong>${escapeHtml(conditionLabel(condition))}</strong><span><button aria-label="移除 ${escapeHtml(conditionLabel(condition))}" data-remove="${condition.id}">移除</button></span></div>`).join('')}</div>`:'';}
function bindConditionList(){root.querySelectorAll('[data-remove]').forEach((button)=>button.addEventListener('click',()=>{state.conditions=state.conditions.filter((item)=>item.id!==button.dataset.remove);save();render();}));}

function request(){
  const text=state.requestText||'';
  shell({step:'request',title:'提出新指標需求',lead:'需求會保存為「待評估」，不會自動建立指標或啟用監控。',back:'conditions',body:`<form id="requestForm" class="proto-form"><label>需求描述<textarea name="sourceText" placeholder="例如：MACD 黃金交叉">${escapeHtml(text)}</textarea></label><label>指標名稱<input name="indicatorName" value="${escapeHtml(text)}"></label><label>資料週期<select name="timeframe"><option value="1m">一分鐘 K</option><option value="d1">日 K</option><option value="other">其他</option></select></label><label id="customTimeframeLabel" hidden>其他週期<input name="customTimeframe"></label><label>參數或計算定義<textarea name="parameterDescription" placeholder="例如：快線 12、慢線 26、訊號線 9"></textarea></label><label>觸發條件<textarea name="triggerCondition" placeholder="例如：DIF 上穿 MACD 訊號線"></textarea></label><p id="requestError" class="proto-error" role="alert"></p></form><div class="proto-sticky-action"><span>送出後狀態為「待評估」</span><button id="submitRequest" class="proto-primary">送出需求</button></div>`});
  const form=root.querySelector('#requestForm'),timeframe=form.elements.timeframe;
  timeframe.addEventListener('change',()=>{root.querySelector('#customTimeframeLabel').hidden=timeframe.value!=='other';});
  form.addEventListener('submit',(event)=>event.preventDefault());
  root.querySelector('#submitRequest').addEventListener('click',async(event)=>{
    const button=event.currentTarget,data=Object.fromEntries(new FormData(form));
    if(data.timeframe!=='other')delete data.customTimeframe;
    button.disabled=true;
    try{const result=await api('/api/indicator-requests',data);state.requestText='';save();shell({step:'request',title:result.duplicate?'這個需求已經提過了':'需求已送出',lead:`「${escapeHtml(result.request.indicatorName)}」目前狀態：待評估。評估完成前請先使用已有指標。`,body:'<div class="proto-inline-actions"><button class="proto-primary" data-go="conditions">返回設定條件</button></div>'});}
    catch(error){root.querySelector('#requestError').textContent=errorText(error);button.disabled=false;}
  });
}

function confirm(){
  if(!state.conditions.length)return go('conditions');
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔：${state.watchlist.slice(0,8).map((item)=>`${item.symbol} ${item.name}`).join('、')}${state.watchlist.length>8?' …':''}`:'每日最新系統名單（每輪重新套用，不凍結結果）';
  shell({step:'confirm',title:'確認並建立監控',lead:'建立後會立即啟用，並取代目前正在運作的監控（系統一次只跑一組監控）。',back:'conditions',body:`<dl class="proto-summary"><div><dt>監控範圍</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>條件</dt><dd>${state.conditions.map((item)=>escapeHtml(conditionLabel(item))).join('；')}</dd></div><div><dt>條件組合</dt><dd>${state.conditions.length>1?'全部同時成立':'單一條件'}</dd></div><div><dt>資料</dt><dd>HF 一分鐘 K・台股 09:00–13:30</dd></div><div><dt>通知</dt><dd>本機瀏覽器通知</dd></div></dl><p id="createError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span>建立後可隨時暫停</span><button id="createMonitor" class="proto-primary">建立並啟用監控</button></div>`});
  root.querySelector('#createMonitor').addEventListener('click',async(event)=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='建立中…';
    try{
      await api('/api/monitor/configure',{purpose:state.purpose,watchlist:state.purpose==='watchlist'?state.watchlist:undefined,conditions:state.conditions.map(({indicator,direction,period,threshold})=>({indicator,direction,period,threshold}))});
      resetDraft();go('success');
    }catch(error){root.querySelector('#createError').textContent=errorText(error);button.disabled=false;button.textContent='建立並啟用監控';}
  });
}

function success(){
  shell({title:'監控已建立',lead:'監控已啟用，盤中會依設定的頻率檢查最新一分鐘 K。',body:`<div class="proto-success"><span class="proto-check">✓</span><h1>監控已建立</h1><p>前往「我的監控」查看狀態與觸發紀錄，並開啟瀏覽器通知。</p></div><div class="proto-inline-actions"><button class="proto-secondary" data-go="home">回首頁</button><button class="proto-primary" data-go="dashboard">查看我的監控</button></div>`});
}

async function dashboard(){
  shell({title:'我的監控',lead:'每 15 秒自動更新。',body:'<div id="dashboard"><div class="proto-status"><strong>讀取中…</strong></div></div>'});
  const refresh=async()=>{
    if(node()!=='dashboard')return clearInterval(pollTimer);
    try{const data=await api('/api/state');if(node()==='dashboard'){drawDashboard(data);deliverNotifications(data.notifications||[]);}}
    catch(error){const target=root.querySelector('#dashboard');if(target)target.innerHTML=`<div class="proto-status"><strong>無法讀取狀態</strong><p>${escapeHtml(errorText(error))}</p></div>`;}
  };
  await refresh();
  pollTimer=setInterval(refresh,15000);
}
function drawDashboard(data){
  const target=root.querySelector('#dashboard');if(!target)return;
  const {settings,runtime,signals=[],notifications=[]}=data;
  const scope=settings.scopeMode==='universe'?'每日最新系統名單':`${settings.watchlist.length} 檔指定股票`;
  const conditionText=settings.conditions?.length?settings.conditions.map(conditionLabel).join(' ＋ '):settings.strategy?.name||'—';
  const permission=!('Notification' in window)?'此瀏覽器不支援通知':Notification.permission==='granted'?'已開啟':Notification.permission==='denied'?'已被封鎖（請到瀏覽器設定開啟）':'';
  target.innerHTML=`<div class="proto-dashboard-head"><div><p class="proto-eyebrow">${settings.scopeMode==='universe'?'每日條件選股':'指定股票監控'}</p><strong>${escapeHtml(settings.monitorTask?.name||'監控')}</strong></div><button id="newMonitor" class="proto-secondary">建立另一份</button></div>
    <article class="proto-monitor"><header><strong>${escapeHtml(conditionText)}</strong><span class="proto-badge">${settings.enabled?'運作中':'已暫停'}</span></header><p>${escapeHtml(scope)}${runtime.effectiveWatchlistCount!=null?`・本輪有效 ${runtime.effectiveWatchlistCount} 檔`:''}</p><p>上次檢查：${runtime.lastRunAt?formatTime(runtime.lastRunAt):'尚未執行'}・狀態：${escapeHtml(runtime.lastProviderStatus||'—')}${runtime.lastError?`・錯誤：${escapeHtml(runtime.lastError)}`:''}</p></article>
    <div class="proto-inline-actions"><button id="toggleMonitor" class="proto-secondary">${settings.enabled?'暫停監控':'啟動監控'}</button><button id="runNow" class="proto-secondary">立即檢查一次</button>${permission?`<span class="proto-signature">瀏覽器通知：${permission}</span>`:'<button id="enableNotify" class="proto-primary">開啟瀏覽器通知</button>'}</div>
    <section class="proto-history"><div class="proto-history-head"><div><p class="proto-eyebrow">最近觸發</p><h2>觸發紀錄</h2></div><span>${signals.length} 筆</span></div>${signals.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>條件・價格</span></div>${signals.slice(0,30).map((signal)=>{const sent=notifications.find((item)=>item.signalId===signal.id)?.status==='sent';return`<div class="proto-history-row"><span><strong>${escapeHtml(signal.symbol)}</strong> ${escapeHtml(signal.name||'')}</span><time>${formatTime(signal.triggeredAt)}</time><span>${escapeHtml(signal.ruleName||'')}・${escapeHtml(signal.price??'—')}${sent?'・已通知':''}</span></div>`;}).join('')}</div>`:'<div class="proto-status"><strong>目前沒有觸發紀錄</strong><p>盤中條件成立時會出現在這裡。</p></div>'}</section>`;
  target.querySelector('#newMonitor').addEventListener('click',()=>{resetDraft();go('home');});
  target.querySelector('#toggleMonitor').addEventListener('click',async(event)=>{event.currentTarget.disabled=true;try{drawDashboard(await api(settings.enabled?'/api/monitor/stop':'/api/monitor/start',{}));}catch(error){alertStatus(error);}});
  target.querySelector('#runNow').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='檢查中…';try{const result=await api('/api/monitor/run',{});drawDashboard(result.state||data);}catch(error){alertStatus(error);}});
  target.querySelector('#enableNotify')?.addEventListener('click',async()=>{await Notification.requestPermission();drawDashboard(data);});
}
function alertStatus(error){const target=root.querySelector('#dashboard');target?.insertAdjacentHTML('afterbegin',`<p class="proto-error" role="alert">${escapeHtml(errorText(error))}</p>`);}

// Same validate → show → ack handshake as public/app.js: the server decides whether a pending notification may still be delivered.
async function deliverNotifications(notifications){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  for(const notification of notifications.filter((item)=>item.status==='pending'&&!seenNotifications.has(item.id))){
    try{
      const validation=await api(`/api/notifications/${encodeURIComponent(notification.id)}/validate`,{});
      if(!validation.deliver){if(['not_selected','not_covered','signal_missing','strategy_mismatch','not_pending'].includes(validation.reason))seenNotifications.add(notification.id);continue;}
      new Notification(notification.title,{body:notification.message});
      seenNotifications.add(notification.id);
      await api(`/api/notifications/${encodeURIComponent(notification.id)}/ack`,{});
    }catch{}
  }
}

function formatTime(value){return new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});}
function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
fetch('/api/version').then((response)=>response.ok?response.json():null).then((info)=>{const target=document.getElementById('appVersion');if(!info||!target)return;target.textContent=info.version;target.title=`部署時間：${formatTime(info.deployedAt)}${info.commit?`・commit ${info.commit}`:''}`;}).catch(()=>{});
if(!location.hash)location.hash='#home';else render();
