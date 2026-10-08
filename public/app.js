// Three-step flow (選範圍 → 條件 → 確認) documented in docs/ui-prototype-flow.md, wired to /api
// for stock lists, indicator requests and monitor creation.
// Also: AI parsing of new indicators, 7-trading-day M1 history lookup, request progress and notification retry.
const KEY='watch365_ui_v2';
const DIRECTION_LABEL={above:'上穿',below:'下穿'};
const MA_NAME={sma:'SMA',ema:'EMA'};
const MAX_FILTERS=3;
const SYNONYMS=[[/金叉/g,'黃金交叉'],[/死叉/g,'死亡交叉'],[/站上|突破/g,'上穿'],[/跌破/g,'下穿']];
const PROVIDER_STATUS={ok:'正常',empty:'本輪沒有新的一分鐘 K',error:'資料讀取異常',coverage_unknown:'無法確認今日名單',empty_scope:'今日名單沒有可監控的股票','尚未執行':'尚未執行'};
const MARKET_LABEL={TWSE:'上市',TPEx:'上櫃'};
// Taiwan regular session 09:00–13:30 Asia/Taipei. Weekends are known client-side; national holidays are not
// (needs a backend calendar), so a weekday outside the calendar still reads as a normal session.
function taipeiNow(date=new Date()){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',weekday:'short',hour:'2-digit',minute:'2-digit',year:'numeric',month:'2-digit',day:'2-digit',hourCycle:'h23'}).formatToParts(date).map((part)=>[part.type,part.value]));return{weekday:parts.weekday,minutes:Number(parts.hour)*60+Number(parts.minute),date:`${parts.year}-${parts.month}-${parts.day}`};}
function marketSession(date=new Date()){
  const {weekday,minutes}=taipeiNow(date);
  if(weekday==='Sat'||weekday==='Sun')return{key:'closed',label:'休市',detail:'週末休市，下個交易日 09:00 開盤'};
  if(minutes<9*60)return{key:'pre',label:'盤前',detail:'09:00 開盤後開始判斷'};
  if(minutes<=13*60+30)return{key:'open',label:'盤中',detail:'09:00–13:30 監控中'};
  return{key:'after',label:'已收盤',detail:'今日已收盤，下個交易日 09:00 繼續'};
}
function isToday(value){const time=Date.parse(value);return Number.isFinite(time)&&taipeiNow(new Date(time)).date===taipeiNow().date;}
let pillKey='';
function drawSessionPill(){const target=document.querySelector('#sessionPill');if(!target)return;const session=marketSession();if(session.key===pillKey)return;pillKey=session.key;target.className=`proto-mode session-${session.key}`;target.innerHTML=`<i aria-hidden="true"></i>台股${session.label}`;target.title=session.detail;}
const ERROR_TEXT={
  HISTORY_SOURCE_FAILED:'無法讀取歷史資料，請稍後再試。',HF_UNAUTHORIZED:'資料來源權限異常，請稍後再試。',HISTORY_FAILED:'回查時發生錯誤，請稍後再試。',HF_DOWNLOAD_TIMEOUT:'資料下載逾時，來源暫時較慢，請稍後再試。',HF_DOWNLOAD_FAILED:'資料下載失敗，請稍後再試。',HISTORY_JOB_NOT_FOUND:'這次回查已過期，請重新回查。',HISTORY_TIMEOUT:'回查超過 10 分鐘仍未完成，已停止。請縮小股票範圍再試。',HISTORY_OUT_OF_MEMORY:'這次回查的資料量太大，無法完成。請縮小股票範圍（例如先選一個類股）再試。',
  FORMULA_PLAN_INVALID:'AI 這次的回覆無法轉成條件，請換個說法再試一次。',INDICATOR_AGENT_FAILED:'AI 解析失敗，請稍後再試，或改為提出需求。',INDICATOR_AGENT_TIMEOUT:'AI 回應逾時，請再試一次。',
  INDICATOR_AGENT_NOT_CONFIGURED:'AI 解析尚未設定，請改為提出需求。',INDICATOR_AGENT_PROVIDER_FAILED:'AI 服務這次沒有回應成功，請再試一次。',INDICATOR_AGENT_RATE_LIMITED:'AI 服務目前請求較多，請稍等幾秒再試。',INDICATOR_AGENT_OUTPUT_INVALID:'AI 回覆的格式有誤，請再試一次或換個說法。',INDICATOR_AGENT_SCHEMA_MISSING:'AI 回覆的格式有誤，請再試一次。',INDICATOR_AGENT_CREDENTIALS_REJECTED:'AI 服務設定有誤，請聯絡管理者。',INDICATOR_AGENT_ACCESS_DENIED:'AI 服務設定有誤，請聯絡管理者。',INDICATOR_AGENT_INPUT_TOO_LONG:'描述太長了，請精簡到 500 字以內。',FORMULA_PROPOSAL_STALE:'AI 條件已過期，請重新解析。',FORMULA_TOKEN_INVALID:'AI 條件已失效，請重新解析。',
  FORMULA_VET_FAILED:'驗證這個條件時發生錯誤，請再試一次。',FORMULA_VET_TIMEOUT:'驗證超過時間仍未完成，請再試一次。',
  FORMULA_WITH_OTHER_CONDITIONS:'這幾個過濾目前無法同時監控，請換一個。',FORMULA_COMPLEXITY_EXCEEDED:'這幾個指標合起來太複雜，目前無法同時監控，請換一個。',
  TEMPLATE_NOT_FOUND:'清單裡找不到這個指標，請重新整理頁面後再選。',TEMPLATE_PARAM_INVALID:'這個指標的參數無效，請換一個變體。',TEMPLATE_REQUEST_INVALID:'過濾設定有誤，請移除後重新加入。',
  retry_not_allowed:'只有送出失敗的通知可以重送。',not_found:'找不到這則通知。',
  CONDITIONS_REQUIRED:'請至少加入一個過濾。',CONDITIONS_TOO_MANY:'目前最多只能組合 3 個過濾。',
  WATCHLIST_REQUIRED:'請至少選一檔股票。',WATCHLIST_MARKET_REQUIRED:'有股票無法確認市場別，請移除後再試。',
  HF_UNIVERSE_SOURCE_FAILED:'無法讀取今日監控名單，請稍後再試。',HF_UNIVERSE_NOT_FOUND:'今日監控名單尚未產生。',HF_METADATA_UNAVAILABLE:'無法讀取股票市場別資料，請稍後再試。',
  INDICATOR_REQUEST_TEXT_TOO_SHORT:'需求描述至少 3 個字。',INDICATOR_REQUEST_FIELDS_REQUIRED:'請填完所有欄位。',INDICATOR_TEXT_REQUIRED:'欄位長度不足（至少 2 個字）。'
};
const root=document.querySelector('#app');
let state=load();
let pollTimer=0,searchTimer=0,seenNotifications=new Set();
// Parse results for first-turn AI requests, keyed by text, so retyping the same words doesn't re-call the model.
const aiCache=new Map();
document.querySelector('#homeButton').addEventListener('click',()=>go('home'));
window.addEventListener('hashchange',render);

function initial(){return{purpose:null,selected:[],watchlist:[],filters:[],formulaToken:null,formulaTokenSignature:null,requestText:'',ai:null,history:null};}
function load(){try{const saved=migrateDraft({...initial(),...JSON.parse(localStorage.getItem(KEY))});if(saved.ai){saved.ai.loading=false;saved.ai.vetting=null;}return saved;}catch{return initial();}}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch{}}
function resetDraft(){state=initial();save();}
function node(){return location.hash.slice(1)||'home';}
function go(next){if(location.hash===`#${next}`)render();else location.hash=next;}
function errorText(error){if(error?.code==='INDICATOR_AGENT_RATE_LIMITED'&&error.payload?.retryAfterSeconds)return`AI 服務這一分鐘的用量已滿，請約 ${error.payload.retryAfterSeconds} 秒後再試。`;if(ERROR_TEXT[error?.code])return ERROR_TEXT[error.code];const message=error?.message||'';if(/^HTTP 5\d\d$/.test(message))return'伺服器暫時沒有回應，請稍後再試一次。';if(/^HTTP 4\d\d$/.test(message))return'這個請求無法處理，請重新整理頁面後再試。';return message||'發生錯誤，請稍後再試。';}

async function api(url,body){
  const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(payload.error||`HTTP ${response.status}`),{code:payload.error,payload});
  return payload;
}

// The request form is a side branch off 條件, not a required step, so it doesn't show in the progress bar.
function phaseFor(step){return{stocks:1,conditions:2,confirm:3}[step]||0;}
let lastShellNode=null;
function shell({step,title,lead,body,back}){
  clearInterval(pollTimer);
  const phase=phaseFor(step),labels=['選範圍','條件','確認'];
  const progress=phase?`<div class="proto-progress"><span>${phase}/3 ${labels[phase-1]}</span><div class="proto-progress-line"><i style="width:${phase/3*100}%"></i></div><span>${labels.join(' → ')}</span></div>`:'';
  root.innerHTML=`<section class="proto-frame">${progress}${back?`<button class="proto-back" data-go="${back}">← 返回修改</button>`:''}<p class="proto-eyebrow">${phase?`階段 ${phase}・${labels[phase-1]}`:'幫你盯盤'}</p><h1 tabindex="-1">${title}</h1>${lead?`<p class="proto-lead">${lead}</p>`:''}${body}</section>`;
  root.querySelectorAll('[data-go]').forEach((button)=>button.addEventListener('click',()=>go(button.dataset.go)));
  // Move focus to the new page heading on navigation (not on in-page re-renders) so screen readers announce it.
  const current=node();if(lastShellNode!==null&&lastShellNode!==current)root.querySelector('h1')?.focus({preventScroll:true});lastShellNode=current;
}
function render(){const routes={home,stocks,conditions,request,confirm:confirmPage,success,dashboard};(routes[node()]||home)();}

async function home(){
  const draft=state.purpose?`<div class="proto-resume"><strong>有一份尚未完成的草案</strong><p>${state.purpose==='watchlist'?`指定股票 ${state.selected.length} 檔`:'條件選股'} · ${state.filters.length} 個過濾</p><div class="proto-inline-actions"><button class="proto-link" id="discardDraft">捨棄草案</button><button class="proto-secondary" data-go="${state.purpose==='watchlist'&&!state.watchlist.length?'stocks':'conditions'}">繼續草案</button></div></div>`:'';
  shell({title:'今天想怎麼盯？',lead:'選一個方式開始，條件成立時會即時通知你。',body:`<div id="homeMonitor"><div class="proto-skeleton" aria-hidden="true"></div></div><div class="proto-options"><button class="proto-option" data-purpose="watchlist"><span><strong>盯指定股票</strong><small>從今日可監控名單搜尋、依類股多選</small></span><span class="proto-arrow">→</span></button><button class="proto-option" data-purpose="screen"><span><strong>用條件找股票</strong><small>條件套用到今日監控名單（有成交量的股票），每天自動更新</small></span><span class="proto-arrow">→</span></button></div>${draft}`});
  root.querySelectorAll('[data-purpose]').forEach((button)=>button.addEventListener('click',()=>{const purpose=button.dataset.purpose;if(purpose!==state.purpose){state.purpose=purpose;state.watchlist=[];}save();go(purpose==='watchlist'?'stocks':'conditions');}));
  root.querySelector('#discardDraft')?.addEventListener('click',()=>{resetDraft();render();});
  const target=root.querySelector('#homeMonitor');
  try{
    const data=await api('/api/state');if(node()!=='home')return;
    const settings=data.settings||{};
    if(!settings.monitorTask?.onboardingCompleted){target.innerHTML='';return;}
    const today=(data.signals||[]).filter((signal)=>isToday(signal.triggeredAt));
    target.innerHTML=`<article class="proto-monitor proto-home-monitor"><header><span><small class="proto-eyebrow">我的監控</small><strong>${escapeHtml(monitorConditionText(settings))}</strong></span>${statusBadge(settings.enabled)}</header><p>${escapeHtml(monitorScopeText(settings))}</p>${state.purpose?'<p class="proto-notice proto-notice-compact" role="note"><span aria-hidden="true">i</span><span>正在重新設定中。這組會照常監控，直到新監控建立並取代它。</span></p>':''}<div class="proto-today"><strong>${todayCount(data.signals||[],today)}</strong><span>今日觸發</span>${today.length?`<small>${todayBreakdown(today,3)}・最新 ${formatClock(today[0].triggeredAt)}</small>`:''}</div><button class="proto-primary" data-go="dashboard">查看我的監控</button></article>`;
    target.querySelector('[data-go]').addEventListener('click',()=>go('dashboard'));
  }catch{target.innerHTML='';}
}
function monitorConditionText(settings){return settings.conditions?.length?settings.conditions.map(conditionLabel).join(' 且 '):settings.strategy?.name||'—';}
function monitorScopeText(settings){return settings.scopeMode==='universe'?'今日監控名單（每日自動更新）':`${settings.watchlist?.length||0} 檔指定股票`;}
// Badge follows the session so it never says 監控中 while the status bar says 已收盤.
function statusBadge(enabled){const open=marketSession().key==='open';return`<span class="proto-badge ${enabled?(open?'on':'idle'):'off'}"><i aria-hidden="true"></i>${enabled?(open?'監控中':'待命'):'已暫停'}</span>`;}
// publicState returns at most 100 signals; if all of them are today the real count is higher.
// "友達 8・聯電 6・…": per-symbol counts for today's signals, busiest first.
function todayBreakdown(today,limit=4){const counts=new Map();for(const signal of today){const key=`${signal.symbol} ${signal.name||''}`.trim();counts.set(key,(counts.get(key)||0)+1);}const sorted=[...counts].sort((a,b)=>b[1]-a[1]);const shown=sorted.slice(0,limit).map(([key,count])=>`${escapeHtml(key.split(' ')[1]||key)} ${count}`).join('・');return shown+(sorted.length>limit?`・其他 ${sorted.length-limit} 檔`:'');}
// iOS Safari only delivers web notifications from a home-screen app, never from a normal tab.
function isIosSafari(){return /iP(hone|ad|od)/.test(navigator.userAgent)&&!window.matchMedia?.('(display-mode: standalone)').matches&&!navigator.standalone;}
function iosNotifyHint(){return'<span class="proto-note">iPhone／iPad 請在 Safari 點「分享」→「加入主畫面」，再從主畫面開啟，才收得到通知</span>';}
function todayCount(signals,today){return today.length>=100&&today.length===signals.length?'100+':String(today.length);}

function stocks(){
  shell({step:'stocks',title:'選擇今天要盯的股票',lead:'名單為今日有成交量、可監控的上市櫃股票，可搜尋或用類股快速篩選。',back:'home',body:`<label class="proto-search"><input id="stockSearch" type="search" placeholder="搜尋代號或名稱" aria-label="搜尋股票"></label><div class="proto-groups" id="groupChips" role="group" aria-label="類股"></div><div class="proto-list-tools"><p id="universeInfo" class="proto-signature">讀取名單中…</p><span><button class="proto-link" id="selectShown" hidden></button><button class="proto-link" id="clearSelected" hidden>清除已選</button></span></div><div class="proto-stock-list" id="stockList"></div><details class="proto-hint"><summary>小技巧：一次選一整塊</summary><p>按住一檔拖到另一檔，會圈選兩者之間的整個方框（從未勾選的開始＝全勾，從已勾選的開始＝全取消）；手機請長按後再拖。桌機可用 Shift＋點擊選一整段。</p></details><p id="stockError" class="proto-error" role="alert"></p><div class="proto-sticky-action proto-stock-action"><div class="proto-tray" id="selectedTray" hidden></div><span><span id="stockCount"></span> <button class="proto-link" id="toggleTray" hidden aria-expanded="false" aria-controls="selectedTray">查看</button></span><button id="stocksDone" class="proto-primary">選好了</button></div>`});
  const list=root.querySelector('#stockList'),search=root.querySelector('#stockSearch'),done=root.querySelector('#stocksDone'),chips=root.querySelector('#groupChips'),selectShown=root.querySelector('#selectShown'),clearSelected=root.querySelector('#clearSelected');
  let shown=[],activeGroup=state.stockGroup||'',showAllGroups=false,groups=[],lastIndex=null;
  const isSelected=(symbol)=>state.selected.some((item)=>item.symbol===symbol);
  const tray=root.querySelector('#selectedTray'),toggleTray=root.querySelector('#toggleTray');
  // 已選匣: selections outside the current filter stay visible and can be removed one by one.
  const drawTray=()=>{
    toggleTray.hidden=!state.selected.length;if(!state.selected.length){tray.hidden=true;toggleTray.setAttribute('aria-expanded','false');}
    toggleTray.textContent=tray.hidden?'查看':'收合';
    if(tray.hidden)return;
    tray.innerHTML=state.selected.map((item)=>`<button class="proto-chip" data-unselect="${escapeHtml(item.symbol)}" aria-label="移除 ${escapeHtml(item.symbol)} ${escapeHtml(item.name)}">${escapeHtml(item.symbol)} ${escapeHtml(item.name)} <span aria-hidden="true">×</span></button>`).join('');
  };
  toggleTray.addEventListener('click',()=>{tray.hidden=!tray.hidden;toggleTray.setAttribute('aria-expanded',String(!tray.hidden));drawTray();});
  tray.addEventListener('click',(event)=>{const button=event.target.closest('[data-unselect]');if(!button)return;const index=[...tray.children].indexOf(button),item=state.selected.find((entry)=>entry.symbol===button.dataset.unselect);if(item){setSelected(item,false);commit();(tray.children[Math.min(index,tray.children.length-1)]||toggleTray).focus();}});
  const syncCount=()=>{
    root.querySelector('#stockCount').textContent=`已選 ${state.selected.length} 檔`;done.disabled=!state.selected.length;
    clearSelected.hidden=!state.selected.length;
    const unselected=shown.filter((item)=>!isSelected(item.symbol)).length;
    selectShown.hidden=!shown.length||(!activeGroup&&!search.value.trim());
    selectShown.textContent=unselected?`全選這 ${shown.length} 檔`:`取消這 ${shown.length} 檔`;
    drawTray();
  };
  const setSelected=(item,on)=>{
    const has=isSelected(item.symbol);if(has===on)return;
    state.selected=on?[...state.selected,{symbol:item.symbol,name:item.name||''}]:state.selected.filter((entry)=>entry.symbol!==item.symbol);
    const input=list.querySelector(`input[value="${CSS.escape(item.symbol)}"]`);if(input)input.checked=on;
  };
  const commit=()=>{state.watchlist=[];state.history=null;save();syncCount();};
  const drawChips=()=>{
    if(!groups.length){chips.innerHTML='';return;}
    const limit=12,visible=showAllGroups||groups.length<=limit?groups:groups.slice(0,limit);
    if(activeGroup&&!visible.some((group)=>group.name===activeGroup))visible.push(groups.find((group)=>group.name===activeGroup)||{name:activeGroup,count:0});
    chips.innerHTML=`<button class="proto-chip ${activeGroup?'':'active'}" data-group="">全部</button>${visible.map((group)=>`<button class="proto-chip ${group.name===activeGroup?'active':''}" data-group="${escapeHtml(group.name)}">${escapeHtml(group.name)} <small>${group.count}</small></button>`).join('')}${groups.length>limit?`<button class="proto-chip ghost" id="moreGroups">${showAllGroups?'收合':`更多類股（${groups.length-limit}）`}</button>`:''}`;
    chips.querySelectorAll('[data-group]').forEach((button)=>button.addEventListener('click',()=>{activeGroup=button.dataset.group;state.stockGroup=activeGroup;save();drawChips();draw();}));
    chips.querySelector('#moreGroups')?.addEventListener('click',()=>{showAllGroups=!showAllGroups;drawChips();});
  };
  let requestId=0;
  const draw=async()=>{
    const id=++requestId,query=search.value.trim();
    try{
      const data=await api(`/api/system-universe?pageSize=${activeGroup?1000:50}&q=${encodeURIComponent(query)}&group=${encodeURIComponent(activeGroup)}`);
      if(id!==requestId)return;
      if(!groups.length&&data.groups?.length){groups=data.groups;drawChips();}
      shown=data.items;lastIndex=null;
      root.querySelector('#universeInfo').textContent=`今日名單 ${data.total} 檔・更新於 ${data.updatedDate}${activeGroup||query?`・符合 ${data.filteredTotal} 檔`:''}${data.filteredTotal>data.items.length?`（顯示前 ${data.items.length} 檔，可選類股或搜尋縮小範圍）`:''}`;
      list.innerHTML=shown.length?shown.map((item,index)=>`<label class="proto-stock" data-index="${index}"><input type="checkbox" value="${escapeHtml(item.symbol)}" ${isSelected(item.symbol)?'checked':''}><span><strong>${escapeHtml(item.symbol)} ${escapeHtml(item.name||'')}</strong>${item.group&&!activeGroup?`<small>${escapeHtml(item.group)}</small>`:''}</span></label>`).join(''):'<div class="proto-status"><strong>今日監控名單找不到</strong><p>請改用其他代號、名稱或類股。</p></div>';
      syncCount();
    }catch(error){if(id!==requestId)return;root.querySelector('#universeInfo').textContent='';list.innerHTML=`<div class="proto-status"><strong>無法讀取今日監控名單</strong><p>${escapeHtml(errorText(error))}</p></div>`;}
  };

  // 圈選 (box select): press on a card and drag to another; every card inside the rectangle between
  // them (rows × columns of the grid) takes the mode decided by the first card (select if it was
  // unchecked, otherwise deselect). Cards leaving the box return to their state before the drag.
  // Mouse starts immediately; touch needs a short long-press so normal scrolling still works.
  let drag=null,suppressClick=false;
  const cardAt=(x,y)=>document.elementFromPoint(x,y)?.closest?.('.proto-stock[data-index]');
  const columns=()=>Math.max(1,getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length);
  const applyBox=(endIndex)=>{
    if(!drag||endIndex===drag.end)return;drag.end=endIndex;
    const cols=columns(),[r1,c1]=[Math.floor(drag.start/cols),drag.start%cols],[r2,c2]=[Math.floor(endIndex/cols),endIndex%cols];
    const [rMin,rMax,cMin,cMax]=[Math.min(r1,r2),Math.max(r1,r2),Math.min(c1,c2),Math.max(c1,c2)];
    shown.forEach((item,index)=>{const r=Math.floor(index/cols),c=index%cols;const inside=r>=rMin&&r<=rMax&&c>=cMin&&c<=cMax;setSelected(item,inside?drag.mode:drag.original.has(item.symbol));list.querySelector(`[data-index="${index}"]`)?.classList.toggle('in-box',inside);});
  };
  const endDrag=()=>{if(!drag)return;const moved=drag.end!==null;if(drag.timer)clearTimeout(drag.timer);list.classList.remove('dragging');list.querySelectorAll('.in-box').forEach((card)=>card.classList.remove('in-box'));drag=null;if(moved){suppressClick=true;commit();}};
  list.addEventListener('pointerdown',(event)=>{
    const card=event.target.closest('.proto-stock[data-index]');if(!card||event.button>0)return;
    const index=Number(card.dataset.index),item=shown[index];
    if(event.shiftKey&&lastIndex!==null){event.preventDefault();const on=!isSelected(item.symbol);const [from,to]=[Math.min(lastIndex,index),Math.max(lastIndex,index)];for(let i=from;i<=to;i++)setSelected(shown[i],on);lastIndex=index;commit();suppressClick=true;return;}
    suppressClick=false;drag={mode:!isSelected(item.symbol),original:new Set(state.selected.map((entry)=>entry.symbol)),start:index,end:null,active:event.pointerType==='mouse',x:event.clientX,y:event.clientY};
    if(event.pointerType==='mouse')event.preventDefault();
    else drag.timer=setTimeout(()=>{if(!drag)return;drag.active=true;list.classList.add('dragging');navigator.vibrate?.(15);applyBox(index);},280);
  });
  list.addEventListener('pointermove',(event)=>{
    if(!drag)return;
    if(!drag.active){if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>8){clearTimeout(drag.timer);drag=null;}return;}
    const card=cardAt(event.clientX,event.clientY);if(!card)return;
    const index=Number(card.dataset.index);
    if(drag.end===null&&index===drag.start)return;
    list.classList.add('dragging');applyBox(index);
  });
  // While a touch drag is active, stop the page from scrolling.
  list.addEventListener('touchmove',(event)=>{if(drag?.active)event.preventDefault();},{passive:false});
  window.addEventListener('pointerup',endDrag);window.addEventListener('pointercancel',endDrag);
  list.addEventListener('click',(event)=>{
    const card=event.target.closest('.proto-stock[data-index]');if(!card)return;
    if(event.detail===0)return; // keyboard (space on the checkbox): let the change handler run
    event.preventDefault();
    if(suppressClick){suppressClick=false;return;}
    const index=Number(card.dataset.index);setSelected(shown[index],!isSelected(shown[index].symbol));lastIndex=index;commit();
  });
  list.addEventListener('change',(event)=>{const input=event.target;if(input.type!=='checkbox')return;const index=Number(input.closest('[data-index]').dataset.index);setSelected(shown[index],input.checked);lastIndex=index;commit();});

  selectShown.addEventListener('click',()=>{const on=shown.some((item)=>!isSelected(item.symbol));shown.forEach((item)=>setSelected(item,on));commit();});
  clearSelected.addEventListener('click',()=>{state.selected.forEach((item)=>{const input=list.querySelector(`input[value="${CSS.escape(item.symbol)}"]`);if(input)input.checked=false;});state.selected=[];commit();});
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
// ---- 條件頁 (#conditions) ----
// Product model: see an indicator → pick a coarse preset → add it as a 過濾 (filter). Each filter is one
// formula; up to 2 filters are joined with 且 by /api/indicator-templates/instantiate. The AI is only the
// fallback for indicators the list doesn't have; once such a formula is used it enters the library and
// shows up in the list next time.
let templateCache=null,templateError='',autoHistory=false,historyBusy=false,openFamily=null,templateRows=[],rankAll=false,familyPicked=false;
// Daily chart patterns (日線型態) come from a precomputed HF dataset that is not wired up yet. The family is shown so the
// place is reserved; rows are disabled until the data source is connected.
const PATTERN_FAMILY='型態（日線）';
const PATTERNS=['三角收斂','M 頭','W 底','頭肩頂','頭肩底','上升旗形','下降旗形','上升楔形','下降楔形','箱型整理'];
function patternRows(tokens){return PATTERNS.filter((name)=>!tokens.length||tokens.every((token)=>normalizeQuery(name).includes(token)));}
function normalizeQuery(text){let value=String(text||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');for(const [pattern,replacement]of SYNONYMS)value=value.replace(pattern,replacement);return value;}
function queryTokens(text){return String(text||'').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean).map(normalizeQuery).filter(Boolean);}
async function loadTemplates(){if(!templateCache){try{templateCache=((await api('/api/indicator-templates')).items||[]).filter((item)=>item&&item.shapeKey);templateError='';}catch(error){templateCache=[];templateError=errorText(error);}}return templateCache;}
function showToast(text){document.querySelectorAll('.proto-toast').forEach((node)=>node.remove());const toast=document.createElement('div');toast.className='proto-toast';toast.setAttribute('role','status');toast.textContent=text;document.body.appendChild(toast);setTimeout(()=>toast.remove(),3500);}
function focusSearch({select=false,scroll=true}={}){const search=root.querySelector('#indicatorSearch');if(!search)return;if(scroll)search.scrollIntoView({block:'center',behavior:'smooth'});search.focus({preventScroll:true});if(select)search.select();}

// Filters: { id, label, formulaSummary, spec } where spec is {shapeKey,values,direction} (a preset),
// {fingerprint} (a library formula as is), {ai:{text,context}} (AI-built, not in the library yet) or
// {legacy:{indicator,direction,period,threshold}} (an old structured condition with no matching preset).
function specKey(spec){return JSON.stringify(spec.shapeKey?['s',spec.shapeKey,spec.values||{},spec.direction??null]:spec.fingerprint?['f',spec.fingerprint]:spec.ai?['a',spec.ai.text]:['l',spec.legacy]);}
function filterSignature(){return JSON.stringify(state.filters.map((filter)=>specKey(filter.spec)));}
function hasSpec(spec){return state.filters.some((filter)=>specKey(filter.spec)===specKey(spec));}
function legacyFilters(){return state.filters.filter((filter)=>filter.spec.legacy);}
function hasFilters(){return state.filters.length>0&&!legacyFilters().length;}
function filtersFull(){return state.filters.length>=MAX_FILTERS;}
// Why the list's 加入 buttons are disabled right now, or '' when they aren't.
function addBlockReason(){return filtersFull()?'已滿，要換請先移除一個':'';}
function invalidateToken(){state.formulaToken=null;state.formulaTokenSignature=null;state.history=null;}
function monitorSpec(){return{purpose:state.purpose,watchlist:state.purpose==='watchlist'?state.watchlist:undefined};}
function scopeText(){return state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'今日監控名單';}
function instantiateItem(spec){return spec.shapeKey?{shapeKey:spec.shapeKey,values:spec.values||{},direction:spec.direction??null}:{fingerprint:spec.fingerprint};}
// Old saved drafts (structured conditions / a single AI formula) become filters once, at load time.
function migrateDraft(saved){
  if(!Array.isArray(saved.filters))saved.filters=[];
  if(saved.formula&&saved.formula.text){saved.filters=[{id:crypto.randomUUID(),label:saved.formula.name||saved.formula.text,formulaSummary:saved.formula.summary||'',spec:{ai:{text:saved.formula.text,context:saved.formula.context||[]}}}];if(saved.formula.token){saved.formulaToken=saved.formula.token;saved.formulaTokenSignature=JSON.stringify(saved.filters.map((filter)=>specKey(filter.spec)));}}
  else if(!saved.filters.length&&Array.isArray(saved.conditions)&&saved.conditions.length)saved.filters=saved.conditions.slice(0,MAX_FILTERS).map((condition)=>({id:condition.id||crypto.randomUUID(),label:conditionLabel(condition),formulaSummary:'',spec:{legacy:{indicator:condition.indicator,direction:condition.direction,period:condition.period,threshold:condition.threshold}}}));
  saved.filters=saved.filters.filter((filter)=>filter&&filter.spec&&typeof filter.label==='string').slice(0,MAX_FILTERS);
  for(const key of['conditions','formula','activeIndicator','drafts','panel'])delete saved[key];
  return saved;
}
// A legacy RSI/SMA/EMA condition maps to the preset with the same period / threshold / direction, if the library has one.
function presetFor(condition){
  const ma={sma:'sma',ema:'ema'}[condition.indicator],rsi=condition.indicator==='rsi';if(!ma&&!rsi)return null;
  for(const template of templateCache||[]){
    if((ma&&template.family!=='均線')||(rsi&&template.family!=='RSI'))continue;
    for(const preset of template.presets||[]){
      if(preset.direction!==condition.direction)continue;
      const label=normalizeQuery(preset.label);
      const hit=ma?label.startsWith('收盤')&&label.includes(`${ma}(${condition.period})`):label.includes(`rsi(${condition.period})`)&&Object.values(preset.values||{}).includes(Number(condition.threshold));
      if(hit)return{label:preset.label,spec:{shapeKey:template.shapeKey,values:preset.values||{},direction:preset.direction}};
    }
  }
  return null;
}
function resolveLegacy(){
  let changed=false;
  for(const filter of legacyFilters()){const preset=presetFor(filter.spec.legacy);if(!preset)continue;Object.assign(filter,{label:preset.label,spec:preset.spec});changed=true;}
  if(changed){invalidateToken();save();}
  return changed;
}

function conditions(){
  if(!state.purpose)return go('home');
  if(state.purpose==='watchlist'&&!state.watchlist.length)return go('stocks');
  shell({step:'conditions',title:'要盯什麼狀況？',lead:'從清單選指標加入過濾，最多 3 個，全部成立才通知。每一列都標出過去 7 個交易日會觸發幾檔。',back:state.purpose==='watchlist'?'stocks':'home',body:`<div class="proto-cond-top"><section id="examplePanel" class="proto-example" hidden></section><div id="addedPanel">${filterMarkup()}</div></div><div class="proto-ai-box"><label class="proto-search proto-ai-search"><input id="indicatorSearch" type="search" autocomplete="off" placeholder="找指標，例如 KD、均線、VWAP" aria-label="找指標" aria-controls="templatePanel" value="${escapeHtml(state.requestText)}"></label><p class="proto-signature proto-ai-hint">找不到的指標，AI 會幫你建立並加進清單</p><div id="aiRow"></div><section id="aiPanel" aria-live="polite"></section></div><section class="proto-templates" id="templatePanel" aria-label="指標清單"></section><section class="proto-history" id="historyPanel"></section><div class="proto-sticky-action"><span id="stickyText"></span><button id="confirmConditions" class="proto-primary">下一步：確認</button></div>`});
  const search=root.querySelector('#indicatorSearch');
  bindFilterList();drawSticky();
  // Typing again drops a first-turn AI card for other text, so the list comes back.
  search.addEventListener('input',()=>{const value=search.value.trim();state.requestText=value;if(state.ai&&!state.ai.context.length&&state.ai.text!==value){state.ai=null;drawAi();}save();drawTemplates();});
  search.addEventListener('keydown',(event)=>{
    const value=search.value.trim();
    if(event.key==='Enter'){event.preventDefault();if(value.length>=2&&!templateRows.length)startAi(value);else root.querySelector('#templatePanel [data-add]:not(:disabled)')?.focus();}
    if(event.key==='Escape'&&value){search.value='';state.requestText='';save();drawTemplates();}
  });
  root.querySelector('#confirmConditions').addEventListener('click',()=>{if(!hasFilters())return;go('confirm');});
  drawAi();drawTemplates();drawHistory();
  loadTemplates().then(()=>{if(node()!=='conditions')return;if(resolveLegacy())drawFilters();drawTemplates();scheduleIndex();});
  autoHistory=false;scheduleIndex();persistDraftAiFilters();
}
function startAi(value){
  const text=String(value||'').trim();if(text.length<2)return;
  const same=state.ai&&state.ai.text===text&&!state.ai.context.length&&(state.ai.loading||state.ai.result||state.ai.error);
  if(!same)state.ai={text,context:[],result:null};
  const search=root.querySelector('#indicatorSearch');if(search&&search.value.trim()!==text){search.value=text;state.requestText=text;}
  save();drawTemplates();
  if(same)drawAi();else runAi();
}
function drawSticky(){
  const text=root.querySelector('#stickyText'),button=root.querySelector('#confirmConditions');if(!text||!button)return;
  text.textContent=legacyFilters().length?'有舊版條件，請先移除':historyBusy?'回查中…可先下一步':`${state.filters.length}/${MAX_FILTERS} 個過濾`;
  button.disabled=!hasFilters();
}
// A. Selected filters, pinned at the top.
function filterMarkup(){
  if(!state.filters.length)return'';
  const rows=state.filters.map((filter,index)=>{
    const legacy=Boolean(filter.spec.legacy);
    const small=legacy?'舊版條件，清單裡沒有對應的指標，請移除後重新加入':filter.formulaSummary;
    return`${index?'<div class="proto-and-row"><span class="proto-and-pill">且</span><small>全部成立才通知</small></div>':''}<div class="proto-condition ${legacy?'legacy':''}"><span class="proto-condition-text"><strong>${filter.spec.ai?'<span class="proto-tag-ai">AI 建立</span>':''}${escapeHtml(filter.label)}</strong>${small?`<small>${escapeHtml(small)}</small>`:''}${legacy?'':stepLine(index)}</span><span class="proto-condition-actions"><button type="button" aria-label="移除 ${escapeHtml(filter.label)}" data-remove="${escapeHtml(filter.id)}">移除</button></span></div>`;
  }).join('');
  const reason=addBlockReason();const foot=reason?`<p class="proto-signature proto-full-note">${escapeHtml(reason)}</p>`:'';
  return`<div class="proto-condition-list"><p class="proto-eyebrow">已選過濾 ${state.filters.length}/${MAX_FILTERS}</p>${rows}${foot}</div>`;
}
function drawFilters(){const target=root.querySelector('#addedPanel');if(!target)return;target.innerHTML=filterMarkup();bindFilterList();drawSticky();drawTemplates();drawHistory();scheduleIndex();}
function bindFilterList(){
  root.querySelectorAll('#addedPanel [data-remove]').forEach((button)=>button.addEventListener('click',()=>{state.filters=state.filters.filter((item)=>item.id!==button.dataset.remove);invalidateToken();save();drawFilters();focusSearch({scroll:false});}));
}
// Adds a filter; a preset / library filter then fetches its own formulaSummary (and validates the pair) from instantiate.
async function addFilter(filter,{withHistory=false,replace=false}={}){
  if(replace)state.filters=[];
  if(addBlockReason()){showToast(`${addBlockReason()}。`);return false;}
  if(hasSpec(filter.spec)){showToast('這個過濾已經加入了。');return false;}
  state.filters.push(filter);invalidateToken();state.requestText='';state.ai=null;
  if(filter.token){if(filter.spec.ai)filter.spec.ai.token=filter.token;if(state.filters.length===1){state.formulaToken=filter.token;state.formulaTokenSignature=filterSignature();}delete filter.token;}
  autoHistory=withHistory;save();render();
  if(!filter.spec.shapeKey&&!filter.spec.fingerprint)return true;
  const current=()=>state.filters.find((item)=>item.id===filter.id);
  try{
    const single=await api('/api/indicator-templates/instantiate',{items:[instantiateItem(filter.spec)],text:filter.label});
    if(!current())return false;
    filter.formulaSummary=single.formulaSummary||'';
    if(state.filters.length===1){state.formulaToken=single.proposalToken;state.formulaTokenSignature=filterSignature();}
    else await buildFormulaToken(); // surfaces FORMULA_COMPLEXITY_EXCEEDED for the pair right away
    save();if(node()==='conditions')drawFilters();return true;
  }catch(error){
    if(!current())return false;
    state.filters=state.filters.filter((item)=>item.id!==filter.id);invalidateToken();save();
    if(node()==='conditions')drawFilters();
    showToast(`無法加入「${filter.label}」：${errorText(error)}`);return false;
  }
}
// C. Indicator list: one accordion per family, preset rows inside; AI-built members listed under their family.
function templateRowsFor(template,tokens){
  const base=normalizeQuery([template.family,template.name,...(template.members||[]).flatMap((member)=>member.aliases||[])].join(' '));
  const match=(extra)=>!tokens.length||tokens.every((token)=>(base+normalizeQuery(extra)).includes(token));
  const rows=[];
  if(template.source!=='ai')for(const preset of template.presets||[])if(match(preset.label))rows.push({family:template.family,label:preset.label,ai:false,spec:{shapeKey:template.shapeKey,values:preset.values||{},direction:preset.direction??null}});
  for(const member of template.members||[])if(member.source==='ai'&&match(`${member.name} ${(member.aliases||[]).join(' ')}`))rows.push({family:template.family,label:member.name,summary:member.summary||'',ai:true,spec:{fingerprint:member.fingerprint}});
  return rows;
}
function drawTemplates(){
  const target=root.querySelector('#templatePanel'),aiRow=root.querySelector('#aiRow'),search=root.querySelector('#indicatorSearch');if(!target||!aiRow||!search)return;
  const value=search.value.trim(),tokens=queryTokens(value);
  if(!templateCache){target.hidden=false;target.innerHTML='<p class="proto-eyebrow">指標清單</p><div class="proto-skeleton" aria-hidden="true"></div>';aiRow.innerHTML='';aiRow.hidden=true;templateRows=[];return;}
  const groups=new Map(),totals=new Map();
  for(const template of templateCache){
    totals.set(template.family,(totals.get(template.family)||0)+templateRowsFor(template,[]).length);
    const rows=templateRowsFor(template,tokens);if(!rows.length)continue;
    if(!groups.has(template.family))groups.set(template.family,[]);groups.get(template.family).push(...rows);
  }
  templateRows=[...groups.values()].flat();
  // AI row only when the search found nothing in the list (and no AI card is already open).
  const showAi=Boolean(value)&&!templateRows.length&&!state.ai;
  aiRow.hidden=!showAi;
  aiRow.innerHTML=showAi?(value.length>=2?`<button type="button" class="proto-row proto-row-ai" id="aiCreateRow"><strong><span class="proto-ai-tag" aria-hidden="true">AI</span>清單沒有這個指標，用 AI 建立：『${escapeHtml(value)}』</strong><small>按 Enter 也可以</small></button>`:'<p class="proto-dropdown-head">再多打一個字</p>'):'';
  aiRow.querySelector('#aiCreateRow')?.addEventListener('click',()=>startAi(value));
  if(!templateCache.length){target.hidden=false;target.innerHTML=`<p class="proto-eyebrow">指標清單</p><div class="proto-status"><strong>${templateError?'無法讀取指標清單':'清單還是空的'}</strong><p>${escapeHtml(templateError||'描述你要的指標，AI 會建立並加進清單。')}</p></div>`;return;}
  const patterns=patternRows(tokens);
  if(value&&!templateRows.length&&!patterns.length){target.innerHTML='';target.hidden=true;return;} // the AI row says it
  if(value&&!templateRows.length){aiRow.hidden=true;aiRow.innerHTML='';}
  const block=addBlockReason(),full=Boolean(block),families=[...groups.keys()];
  // With at least one filter picked and counts ready, rows become ranked bars (owner decision 2026-10): stocks left
  // after adding the row, against the current result, most to least.
  const base=rankBase(full);
  const tabs=value?[]:[...(base?[RANK_TAB]:[]),...families,...(patterns.length?[PATTERN_FAMILY]:[])];
  // Categories are a horizontal strip of chips (owner decision 2026-10); only the picked one's rows are listed below.
  // The ranking is the default view once it exists, until the user picks a category themselves.
  if(!value&&(!tabs.includes(openFamily)||(!familyPicked&&base)))openFamily=tabs[0]||null;
  const tab=value?null:openFamily;
  let rows=value?templateRows:tab===RANK_TAB?templateRows:groups.get(tab)||[];
  let body;
  if(tab===PATTERN_FAMILY)body=`<p class="proto-signature proto-soon-note">以日線型態篩出今天帶型態的股票，再搭配一分鐘 K 的條件通知。資料接上後開放。</p><div class="proto-preset-list">${patterns.map((name)=>`<div class="proto-preset soon"><span class="proto-preset-text"><strong>${escapeHtml(name)}</strong></span><button type="button" class="proto-add" disabled title="資料接上後開放">即將推出</button></div>`).join('')}</div>`;
  else if(base){
    const items=rows.filter((row)=>!hasSpec(row.spec)).map((row)=>({row,count:base.data.counts.get(specKey(row.spec))})).filter((item)=>item.count);
    items.sort((a,b)=>b.count.triggeredSymbols-a.count.triggeredSymbols||b.count.totalEvents-a.count.totalEvents||a.row.label.localeCompare(b.row.label,'zh-Hant'));
    const live=items.filter((item)=>item.count.triggeredSymbols>0),zero=items.filter((item)=>!item.count.triggeredSymbols);
    const line=(item)=>rankLine(item,base);
    if(tab===RANK_TAB){
      const shown=rankAll?live:live.slice(0,RANK_TOP);
      body=`<div class="proto-rank-list">${shown.map(line).join('')||'<div class="proto-status"><p>加入任何一個都會變成 0 檔。</p></div>'}</div>${live.length>shown.length?`<button type="button" class="proto-link proto-rank-more" data-rank-all>顯示全部 ${live.length} 個</button>`:''}${zero.length?`<p class="proto-signature proto-rank-zero-note">另有 ${zero.length} 個加入後 0 檔，未列出</p>`:''}`;
    }else body=`<div class="proto-rank-list">${[...live,...zero].map(line).join('')||'<div class="proto-status"><p>這一類都已經加入了。</p></div>'}</div>`;
  }else body=`<div class="proto-preset-list proto-family-rows">${rows.map(presetLine(full,block)).join('')}</div>`;
  const tabCount=(name)=>name===RANK_TAB?'':name===PATTERN_FAMILY?`<small>${patterns.length}</small>`:`<small>${(groups.get(name)||[]).length}</small>`;
  const strip=tabs.length?`<div class="proto-family-tabs" role="tablist" aria-label="指標類別">${tabs.map((name)=>`<button type="button" role="tab" class="proto-family-tab ${name===PATTERN_FAMILY?'soon':''}" aria-selected="${name===tab}" data-tab="${escapeHtml(name)}">${name===RANK_TAB?'剩餘最多':escapeHtml(name)}${tabCount(name)}</button>`).join('')}</div>`:'';
  const head=base?`<p class="proto-signature proto-rank-base">以「${state.filters.map((filter)=>escapeHtml(filter.label)).join(' 且 ')}」為基準：過去 7 日 <strong>${base.count} 檔・${base.events} 次</strong>。長條＝加入後還剩幾檔。</p>`:'';
  const note=full?`<small class="proto-signature">${escapeHtml(block)}</small>`:value?`<small class="proto-signature">符合 ${templateRows.length+patterns.length} 個</small>`:'';
  const previous=target.querySelector('.proto-family-tabs')?.scrollLeft||0;
  target.hidden=false;
  target.innerHTML=`<div class="proto-list-head"><p class="proto-eyebrow">${base?'下一個過濾':'指標清單'}</p>${note}</div>${head}${strip}${body}${value&&patterns.length?`<div class="proto-preset-list">${patterns.map((name)=>`<div class="proto-preset soon"><span class="proto-preset-text"><strong>${escapeHtml(name)}</strong><small>${PATTERN_FAMILY}</small></span><button type="button" class="proto-add" disabled>即將推出</button></div>`).join('')}</div>`:''}`;
  const strip2=target.querySelector('.proto-family-tabs');if(strip2)strip2.scrollLeft=previous;
  target.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>{openFamily=button.dataset.tab;familyPicked=true;rankAll=false;drawTemplates();target.querySelector('.proto-family-tab[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});}));
  target.querySelector('[data-rank-all]')?.addEventListener('click',()=>{rankAll=true;drawTemplates();});
  target.querySelectorAll('[data-add]').forEach((button)=>button.addEventListener('click',()=>{const row=templateRows[Number(button.dataset.add)];if(!row)return;addFilter({id:crypto.randomUUID(),label:row.label,formulaSummary:row.summary||'',spec:row.spec});}));
}
// Ranked rows: base = stocks left after all current filters; each row = stocks left if it were added next.
// ≥ 95 % of the base is flagged as barely filtering.
const NEAR_ALL=0.95; // barely filtering = keeps ≥ 95 % of both the stocks and the triggers
const RANK_TAB='剩餘最多',RANK_TOP=10;
function rankBase(full){
  if(!state.filters.length||full)return null;
  const data=indexFresh(),step=data?.steps?.at(-1);
  if(!data||!data.counts||!step)return null;
  return{data,count:step.triggeredSymbols||0,events:step.totalEvents||0};
}
function rankLine(item,base){
  const i=templateRows.indexOf(item.row),n=item.count.triggeredSymbols,share=base.count?Math.min(1,n/base.count):0,pct=Math.round(share*100),eventShare=base.events?item.count.totalEvents/base.events:0,weak=n&&share>=NEAR_ALL&&eventShare>=NEAR_ALL;
  return`<div class="proto-rank ${weak?'weak':''} ${n?'':'zero'}"><span class="proto-rank-text"><strong>${item.row.ai?'<span class="proto-tag-ai">AI 建立</span>':''}${escapeHtml(item.row.label)}</strong><span class="proto-rank-bar" aria-hidden="true"><i style="width:${n?Math.max(2,pct):0}%"></i></span><small>${n?`${n} 檔・${item.count.totalEvents} 次・剩 ${pct}%`:'加入後 0 檔'}${weak?'・幾乎沒有篩選效果':''}</small></span><button type="button" class="proto-add" data-add="${i}" aria-label="加入 ${escapeHtml(item.row.label)}">加入</button></div>`;
}
function presetLine(full,block){
  return(row)=>{const i=templateRows.indexOf(row);const added=hasSpec(row.spec);const title=added?'已加入':full?block:`加入 ${row.label}`;return`<div class="proto-preset ${row.ai?'ai':''}"><span class="proto-preset-text">${row.ai?'<span class="proto-tag-ai">AI 建立</span>':''}<strong>${escapeHtml(row.label)}</strong>${row.ai&&row.summary?`<small>${escapeHtml(row.summary)}</small>`:''}${added?'':candidateLine(row.spec)}</span><button type="button" class="proto-add" data-add="${i}" ${added||full?'disabled':''} aria-label="${escapeHtml(title)}" title="${escapeHtml(title)}">${added?'已加入':'加入'}</button></div>`;};
}
// Labels for the server's structured conditions (dashboard / home) and for legacy drafts.
function conditionLabel(condition){
  const direction=DIRECTION_LABEL[condition.direction]||condition.direction;
  if(condition.indicator==='rsi')return`RSI(${condition.period}) ${condition.direction==='above'?'由下往上穿越':'由上往下穿越'} ${condition.threshold}`;
  if(MA_NAME[condition.indicator])return`收盤價${direction} ${MA_NAME[condition.indicator]}(${condition.period})`;
  return`${condition.indicator} ${condition.period} ${direction}${condition.threshold==null?'':` ${condition.threshold}`}`;
}
function directionTag(direction){return`<span class="proto-dir ${direction==='below'?'down':'up'}">${DIRECTION_LABEL[direction]||''}</span>`;}

// AI parsing: /api/indicator-agent/parse returns existing (registry indicator), formula (signed proposal,
// library:true when the text hit the formula library), clarification (needs a reply, sent back with the
// conversation as context) or discussion (not computable).
async function runAi(){
  const ai=state.ai;if(!ai)return;
  ai.loading=true;ai.error=null;ai.errorCode=null;drawAi();
  const cacheable=!ai.context.length,cached=cacheable?aiCache.get(ai.text):null;
  if(cached){ai.result=cached;ai.loading=false;save();drawAi();return;}
  try{const result=await api('/api/indicator-agent/parse',{text:ai.text,context:ai.context});if(cacheable)aiCache.set(ai.text,result);if(state.ai!==ai)return;ai.result=result;}
  catch(error){if(state.ai!==ai)return;ai.result=null;ai.error=errorText(error);ai.errorCode=error?.code||null;}
  ai.loading=false;save();drawAi();
}
function registryCondition(proposal){
  if(proposal?.id==='rsi.cross')return{indicator:'rsi',direction:'above',period:proposal.params.period,threshold:proposal.params.threshold};
  if(proposal?.id==='sma.cross')return{indicator:'sma',direction:'above',period:proposal.params.period,threshold:null};
  return null;
}
// Unsupported / uncomputable AI results end in a single click: the request is filed from the search text,
// with the detailed form still one link away for people who want to spell out parameters.
function quickRequestPayload(text){return{sourceText:text.length>=3?text:`${text} 指標`,indicatorName:text.slice(0,80),timeframe:'1m',parameterDescription:'未指定，評估時確認',triggerCondition:'未指定，評估時確認'};}
function requestedCard(ai){return`<div class="proto-ai-body"><strong>${ai.requested.duplicate?'這個需求已經提過了':'需求已送出'}</strong><p>「${escapeHtml(ai.requested.name)}」目前狀態：待評估。評估完成前請先使用其他過濾。</p><div class="proto-inline-actions"><button type="button" class="proto-link" data-go="request">查看我的需求</button><button type="button" class="proto-secondary" id="aiRephrase">換個說法</button></div></div>`;}
function alternativeOf(message){const match=/可改用[:：]\s*([^。\n]+)/.exec(String(message||''));return match?match[1].trim().replace(/[「『」』]/g,''):'';}
function warmupText(proposal){return Number.isFinite(proposal?.warmupBars)?`<p class="proto-signature">開盤後約 ${proposal.warmupBars} 分鐘開始有判斷結果</p>`:'';}
// D. AI card, right under the search box.
function drawAi(){
  const target=root.querySelector('#aiPanel');if(!target)return;
  const ai=state.ai;if(!ai){target.innerHTML='';target.hidden=true;return;}
  let eyebrow='AI 解析',body;
  const existingPreset=ai.result?.status==='existing'?(()=>{const condition=registryCondition(ai.result.proposal);return condition?presetFor(condition):null;})():null;
  if(ai.loading)body=`<div class="proto-ai-body"><div class="proto-skeleton proto-skeleton-line" aria-hidden="true"></div><div class="proto-skeleton proto-skeleton-line short" aria-hidden="true"></div><p>正在把『${escapeHtml(ai.text)}』轉成可監控的過濾…</p><p class="proto-signature">通常幾秒鐘</p></div>`;
  else if(ai.error){const systemSide=['INDICATOR_AGENT_PROVIDER_FAILED','INDICATOR_AGENT_RATE_LIMITED','INDICATOR_AGENT_TIMEOUT','INDICATOR_AGENT_CREDENTIALS_REJECTED','INDICATOR_AGENT_ACCESS_DENIED','INDICATOR_AGENT_NOT_CONFIGURED','INDICATOR_AGENT_SCHEMA_MISSING'].includes(ai.errorCode);
    body=`<div class="proto-ai-body"><strong>${systemSide?'AI 服務這次沒回應':'這次沒有解析成功'}</strong><p>${escapeHtml(ai.error)}</p>${systemSide?'<p class="proto-signature">和你的描述無關，稍等再試即可</p>':''}<div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiRephrase">換個說法</button><button type="button" class="proto-primary" id="aiRetry">再試一次</button></div></div>`;}
  else{
    const result=ai.result||{};
    if(result.status==='existing'){eyebrow='內建指標';body=existingPreset?`<div class="proto-ai-body"><strong>${escapeHtml(existingPreset.label)}</strong><p class="proto-signature">清單裡有這個指標，直接加入即可。</p><div id="aiConfirmBox"></div><div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiRephrase">不是這個？換個說法</button><button type="button" class="proto-primary" id="aiUseExisting">加入過濾</button></div></div>`:`<div class="proto-ai-body"><strong>${escapeHtml(result.summary||'')}目前不能從這裡建立</strong><div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiRephrase">換個說法</button><button type="button" class="proto-primary" id="aiQuickRequest">送出需求，之後通知我</button></div></div>`;}
    else if(result.status==='formula'&&ai.vetting){
      // Vetting an AI-built formula: replay it over the last 7 trading days before it may be added.
      eyebrow='AI 新建立・驗證中';const name=String(result.summary||'').replace(/ · 一分鐘$/,'');
      body=`<div class="proto-ai-body"><strong>${escapeHtml(name)}</strong><div class="proto-skeleton proto-skeleton-line" aria-hidden="true"></div><div class="proto-skeleton proto-skeleton-line short" aria-hidden="true"></div><p>正在用過去 7 個交易日驗證這個條件…</p><p id="vetProgress" class="proto-signature" aria-live="polite">${escapeHtml(ai.vetting.progress||'準備中')}</p><p class="proto-signature">第一次驗證要下載近期的一分鐘資料，可能需要 1～3 分鐘。</p></div>`;}
    else if(result.status==='formula'&&ai.vet&&ai.vet.verdict&&!ai.vet.verdict.ok){
      // Blocked by the vet: 0 triggers or far too many over 7 days. Not added, not saved to the library.
      const verdict=ai.vet.verdict,name=String(result.summary||'').replace(/ · 一分鐘$/,'');eyebrow='AI 新建立・未通過驗證';
      body=`<div class="proto-ai-body"><strong>這個條件沒有通過驗證</strong><p>${escapeHtml(verdict.message||VERDICT_TEXT[verdict.code]||'這個條件目前不適合用來監控。')}</p><p class="proto-signature">${escapeHtml(name)}</p>${vetStats(verdict)}<div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiQuickRequest">送出需求，之後通知我</button><button type="button" class="proto-primary" id="aiRephrase">換個說法</button></div></div>`;}
    else if(result.status==='formula'){
      const name=String(result.summary||'').replace(/ · 一分鐘$/,'');eyebrow=result.library?'公式庫・已驗證':'AI 新建立';
      body=`<div class="proto-ai-body"><strong>${escapeHtml(name)}</strong><p><span class="proto-how">怎麼判斷</span>${escapeHtml(result.formulaSummary||'')}</p>${warmupText(result.proposal)}${result.library?'':'<p class="proto-signature proto-ai-foot">加入前會先用過去 7 個交易日驗證；建立監控後會進入清單，下次直接選。</p>'}${ai.vetError?`<p class="proto-error" role="alert">${escapeHtml(ai.vetError)}</p>`:''}<div id="aiConfirmBox"></div><div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiRephrase">不是這個？換個說法</button><button type="button" class="proto-primary" id="aiUseFormula">${ai.vetError?'再驗證一次':'加入過濾'}</button></div></div>`;}
    else if(result.status==='unknown_indicator'){
      // The AI could not find a public definition for the indicator name; show what it looked up.
      eyebrow='查不到這個指標';const candidates=(result.lookup?.candidates||[]).filter(Boolean).slice(0,8);
      body=`<div class="proto-ai-body"><strong>查不到這個指標的公開定義</strong><p>${escapeHtml(result.message||'目前找不到這個名稱對應的公開計算方式，無法建立條件。')}</p>${candidates.length?`<p class="proto-signature">查過的關鍵字</p><div class="proto-candidates">${candidates.map((item)=>`<span class="proto-chip">${escapeHtml(item)}</span>`).join('')}</div>`:''}<div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiQuickRequest">送出需求，之後通知我</button><button type="button" class="proto-primary" id="aiRephrase">換個名稱再試</button></div></div>`;}
    else if(result.status==='clarification'){eyebrow='AI 想確認一件事';body=`<div class="proto-ai-body"><strong>AI 想確認一件事</strong><p>${escapeHtml(result.message||result.question||'')}</p><label class="proto-search"><input id="aiReply" type="text" placeholder="回答這裡" aria-label="回答 AI 的問題"></label><div class="proto-inline-actions"><button type="button" class="proto-secondary" id="aiRephrase">換個說法</button><button type="button" class="proto-primary" id="aiSendReply">送出</button></div></div>`;}
    else if(ai.requested)body=requestedCard(ai);
    else{const message=result.message||'這個條件超出目前可計算的範圍。',alternative=alternativeOf(message);eyebrow='這個目前還算不出來';
      body=`<div class="proto-ai-body"><p>${escapeHtml(message)}</p>${alternative?`<p class="proto-signature">可改用：${escapeHtml(alternative)}</p>`:''}<div class="proto-inline-actions"><button type="button" class="${alternative?'proto-secondary':'proto-primary'}" id="aiQuickRequest">送出需求，之後通知我</button>${alternative?`<button type="button" class="proto-primary" data-alt="${escapeHtml(alternative)}">改用這個條件</button>`:''}</div></div>`;}
  }
  target.hidden=false;target.className='proto-ai-card';
  target.innerHTML=`<div class="proto-history-head"><div><p class="proto-eyebrow">${escapeHtml(eyebrow)}</p><h2>『${escapeHtml(ai.text)}』</h2></div><button type="button" class="proto-link" id="aiClose">關閉</button></div>${body}`;
  const dismiss=()=>{state.ai=null;save();drawAi();drawTemplates();};
  target.querySelector('#aiClose').addEventListener('click',()=>{dismiss();focusSearch({scroll:false});});
  target.querySelector('#aiRephrase')?.addEventListener('click',()=>{dismiss();focusSearch({select:true});});
  target.querySelectorAll('[data-go]').forEach((button)=>button.addEventListener('click',()=>go(button.dataset.go)));
  target.querySelector('#aiRetry')?.addEventListener('click',()=>{aiCache.delete(ai.text);runAi();});
  target.querySelectorAll('[data-alt]').forEach((button)=>button.addEventListener('click',()=>{const text=button.dataset.alt;const search=root.querySelector('#indicatorSearch');if(search)search.value=text;state.requestText=text;save();startAi(text);}));
  target.querySelector('#aiQuickRequest')?.addEventListener('click',async(event)=>{
    const button=event.currentTarget,label=button.textContent;button.disabled=true;button.textContent='送出中…';
    try{const result=await api('/api/indicator-requests',quickRequestPayload(ai.text));ai.requested={duplicate:result.duplicate,name:result.request.indicatorName};save();drawAi();}
    catch(error){button.disabled=false;button.textContent=label;alertInline(errorText(error));}
  });
  // An AI-built formula isn't in the library yet, so the backend can't join it with other filters: confirm the replacement inline.
  const confirmReplace=(count,go)=>{const box=target.querySelector('#aiConfirmBox');if(!box)return go();box.innerHTML=`<div class="proto-notice proto-replace" role="alert"><span aria-hidden="true">!</span><span>已有 ${count} 個過濾（上限 ${MAX_FILTERS} 個），加入會取代它們，繼續？<span class="proto-inline-actions"><button type="button" class="proto-link" id="replaceCancel">取消</button><button type="button" class="proto-secondary" id="replaceGo">取代</button></span></span></div>`;box.querySelector('#replaceGo').addEventListener('click',go);box.querySelector('#replaceCancel').addEventListener('click',()=>{box.innerHTML='';});box.querySelector('#replaceGo').focus();};
  target.querySelector('#aiUseExisting')?.addEventListener('click',()=>{if(!existingPreset)return;addFilter({id:crypto.randomUUID(),label:existingPreset.label,formulaSummary:'',spec:existingPreset.spec});});
  // Library hits are already vetted and go straight in. A brand-new AI formula is first replayed over the
  // last 7 trading days (/api/formula/vet); it is only added when the verdict is ok.
  const useFormula=()=>{
    const result=ai.result,name=String(result.summary||'').replace(/ · 一分鐘$/,'');
    if(result.library&&result.proposal?.fingerprint){addFilter({id:crypto.randomUUID(),label:name,formulaSummary:result.formulaSummary||'',spec:{fingerprint:result.proposal.fingerprint}});return;}
    const filter={id:crypto.randomUUID(),label:name,formulaSummary:result.formulaSummary||'',spec:{ai:{text:ai.text,context:ai.context}},token:result.proposalToken};
    if(filtersFull())return confirmReplace(state.filters.length,()=>vetAndAdd(ai,filter,true));
    vetAndAdd(ai,filter,false);
  };
  target.querySelector('#aiUseFormula')?.addEventListener('click',useFormula);
  const reply=target.querySelector('#aiReply');
  const send=()=>{const text=reply.value.trim();if(!text)return;if(ai.result?.message)ai.context=[...ai.context,{request:ai.text.slice(0,500),response:String(ai.result.message).slice(0,500)}].slice(-4);else ai.context=[];ai.text=text;ai.result=null;ai.error=null;save();runAi();};
  target.querySelector('#aiSendReply')?.addEventListener('click',send);
  reply?.addEventListener('keydown',(event)=>{if(event.key==='Enter')send();});
  reply?.focus({preventScroll:true});
}
// Vet verdicts (/api/formula/vet and every backtest result): ok, no_triggers, too_many, no_data.
const VERDICT_TEXT={no_triggers:'過去 7 個交易日完全沒有觸發，這個條件可能太嚴格，監控不到東西。',too_many:'過去 7 個交易日觸發太頻繁，通知會多到沒有參考價值。',no_data:'沒有可用的歷史資料，無法驗證這個條件。'};
function perDayText(verdict){const value=Number(verdict?.perSymbolPerDay);return Number.isFinite(value)?(value>=10?String(Math.round(value)):String(Math.round(value*10)/10)):'—';}
function vetStats(verdict){return`<div class="proto-vet-stats"><div><strong>${escapeHtml(String(verdict.totalEvents??'—'))}</strong><span>總觸發次數</span></div><div><strong>${escapeHtml(String(verdict.symbolsCount??'—'))}</strong><span>檔數</span></div><div><strong>${escapeHtml(String(verdict.availableDays??'—'))}</strong><span>交易日</span></div><div><strong>${escapeHtml(perDayText(verdict))}</strong><span>平均每檔每天</span></div></div>`;}
async function persistAiFilter(filter){
  const token=filter.token||filter.spec.ai?.token;if(!token)return false;
  try{
    const saved=await api('/api/formula/save',{proposalToken:token});
    filter.spec={fingerprint:saved.fingerprint};filter.formulaSummary=filter.formulaSummary||saved.summary||'';filter.saved=true;delete filter.token;delete filter.conditionKey;
    templateCache=null;loadTemplates().then(()=>{if(node()==='conditions'){drawTemplates();scheduleIndex();}});
    return true;
  }catch(error){console.warn('save AI indicator failed',error.code||error.message);return false;}
}
// Drafts from before indicators were saved on creation: an AI filter still holding a valid token is saved now.
async function persistDraftAiFilters(){
  const pending=state.filters.filter((filter)=>filter.spec.ai&&filter.spec.ai.token&&!filter.saving);
  for(const filter of pending){filter.saving=true;const ok=await persistAiFilter(filter);delete filter.saving;if(ok){invalidateToken();save();if(node()==='conditions')drawFilters();}}
}
async function vetAndAdd(ai,filter,replace){
  if(state.ai!==ai||ai.vetting)return;
  ai.vetting={progress:'準備中'};ai.vet=null;ai.vetError=null;save();drawAi();
  let result;
  try{
    const first=await api('/api/formula/vet',{proposalToken:filter.token,...monitorSpec()});
    result=await pollJob(first,(text)=>{const node=root.querySelector('#vetProgress');if(node)node.textContent=text;if(ai.vetting)ai.vetting.progress=text;});
  }catch(error){
    if(state.ai!==ai)return;
    // An expired proposal needs a fresh parse; everything else is shown on the card with a retry.
    if(['FORMULA_PROPOSAL_STALE','FORMULA_TOKEN_INVALID'].includes(error.code)){ai.vetting=null;aiCache.delete(ai.text);ai.result=null;save();runAi();return;}
    ai.vetting=null;ai.vetError=errorText(error);save();drawAi();return;
  }
  if(state.ai!==ai)return;
  ai.vetting=null;
  const verdict=result.verdict||{ok:true,code:'ok',totalEvents:result.totalEvents,symbolsCount:result.symbolsCount,availableDays:result.availableDays};
  if(!verdict.ok){ai.vet={verdict};save();drawAi();return;}
  // Owner decision: a vetted AI indicator is kept right away (library, pending review) so it survives without a draft
  // or a monitor; the filter then refers to the library formula instead of the short-lived AI token.
  await persistAiFilter(filter);
  const added=await addFilter(filter,{replace});
  if(!added)return;
  // The vet already replayed this very filter, so its result is the 7-day history (only when it is the sole filter).
  if(state.filters.length===1&&Array.isArray(result.days)){state.history=historyFrom(historySignature(),result);save();if(node()==='conditions')drawHistory();}
  showToast(`已加入。過去 7 日觸發 ${verdict.totalEvents??result.totalEvents??0} 次`);
}
// D2. 7-day index (/api/history/index): every list row is precomputed on the server, so picking a filter only combines
// stored results. One request returns the funnel of the selected filters (step i = filters 1..i all met) and, for
// every list row, how many stocks would trigger if it were added next. Counted like live notifications (state machine).
let indexData=null,indexTimer=null,indexSeq=0;
function indexSpec(filter){const spec=filter.spec;if(spec.shapeKey)return{shapeKey:spec.shapeKey,values:spec.values||{},direction:spec.direction??null};if(spec.fingerprint)return{fingerprint:spec.fingerprint};if(spec.ai)return{conditionKey:filter.conditionKey||undefined,proposalToken:spec.ai.token||undefined};return null;}
function candidateSpecs(){if(!templateCache)return[];const rows=templateCache.flatMap((template)=>templateRowsFor(template,[]));return rows.filter((row)=>!hasSpec(row.spec));}
function indexSignature(){return JSON.stringify([monitorSpec(),filterSignature(),templateCache?templateCache.length:0]);}
function scheduleIndex({force=false}={}){
  if(node()!=='conditions'||!state.purpose||legacyFilters().length)return;
  if(!force&&indexData&&indexData.signature===indexSignature()&&!indexData.loading&&!indexData.error)return;
  clearTimeout(indexTimer);indexTimer=setTimeout(runIndex,force?0:250);
}
async function runIndex(){
  const signature=indexSignature(),seq=++indexSeq;
  const filters=state.filters.map(indexSpec);if(filters.some((item)=>!item))return;
  const candidates=candidateSpecs();
  indexData={...(indexData&&indexData.signature===signature?indexData:{}),signature,loading:true,error:null,candidateKeys:candidates.map((row)=>specKey(row.spec))};drawIndexViews();
  try{
    const result=await api('/api/history/index',{...monitorSpec(),filters,candidates:candidates.map((row)=>row.spec)});
    if(seq!==indexSeq)return;
    if(result.status==='loading'){indexData={...indexData,loading:true,progress:result.progress};drawIndexViews();indexTimer=setTimeout(runIndex,3000);return;}
    (result.filterKeys||[]).forEach((key,index)=>{if(state.filters[index])state.filters[index].conditionKey=key;});
    const counts=new Map();(result.candidates||[]).forEach((item)=>{const key=indexData.candidateKeys[item.index];if(key&&!item.error)counts.set(key,item);});
    indexData={signature,loading:false,error:null,steps:result.steps||[],counts,availableDays:result.availableDays,symbolsCount:result.symbolsCount};
    const last=(result.steps||[]).at(-1);
    if(last){state.history=historyFrom(historySignature(),{availableDays:result.availableDays,symbolsCount:result.symbolsCount,totalEvents:last.totalEvents,triggeredSymbols:last.triggeredSymbols,days:last.days,events:last.events||[],truncated:last.truncated,verdict:result.verdict,failedDays:0});}
    save();drawIndexViews();
  }catch(error){if(seq!==indexSeq)return;indexData={...indexData,loading:false,error:errorText(error)};drawIndexViews();}
}
function drawIndexViews(){if(node()!=='conditions')return;scheduleExample();const target=root.querySelector('#addedPanel');if(target){target.innerHTML=filterMarkup();bindFilterList();}drawTemplates();drawHistory();drawSticky();}
function indexFresh(){return indexData&&indexData.signature===indexSignature()?indexData:null;}
function countText(item){return item.triggeredSymbols?`${item.triggeredSymbols} 檔・${item.totalEvents} 次`:'0 檔';}
function stepLine(index){
  const data=indexFresh();
  if(!data||(data.loading&&!data.steps))return`<small class="proto-count muted">過去 7 日：${data?.progress?escapeHtml(data.progress):'計算中…'}</small>`;
  if(data.error&&!data.steps)return`<small class="proto-count muted">過去 7 日：無法計算</small>`;
  const step=data.steps?.[index];if(!step)return'';
  const head=index?'加上這個後':'過去 7 日';
  if(!step.triggeredSymbols)return`<small class="proto-count zero">${head}：0 檔觸發${index?'，是這個過濾把股票全部篩掉了':'，這個過濾可能太嚴格'}</small>`;
  return`<small class="proto-count">${head}：${countText(step)}</small>`;
}
function candidateLine(spec){
  const data=indexFresh();if(!data||!data.counts)return'';
  const item=data.counts.get(specKey(spec));if(!item)return'';
  const prefix=state.filters.length?'加入後':'過去 7 日';
  return`<small class="proto-count ${item.triggeredSymbols?'':'zero'}">${prefix} ${countText(item)}</small>`;
}
// D3. Example chart (owner decision 2026-10): one candlestick example of what a stock looks like when ALL selected
// filters hold — any stock, not named; daily history first, one-minute bars when daily never met it. Only the bars
// where the whole combination becomes met are marked. It explains the condition; it is not a quote screen.
let exampleData=null,exampleTimer=null,exampleSeq=0;
function scheduleExample(){
  if(node()!=='conditions')return;
  const signature=filterSignature();
  if(!hasFilters()){exampleData=null;drawExample();return;}
  if(exampleData&&exampleData.signature===signature)return;
  exampleData={signature,loading:true};drawExample();
  clearTimeout(exampleTimer);exampleTimer=setTimeout(runExample,300);
}
async function runExample(){
  const signature=filterSignature(),seq=++exampleSeq;
  const filters=state.filters.map(indexSpec);if(!filters.length||filters.some((item)=>!item))return;
  try{
    const result=await api('/api/history/example',{filters});
    if(seq!==exampleSeq||signature!==filterSignature())return;
    if(result.status==='loading'){exampleData={signature,loading:true};drawExample();exampleTimer=setTimeout(runExample,3000);return;}
    exampleData={signature,example:result.example};
  }catch(error){if(seq!==exampleSeq)return;exampleData={signature,error:errorText(error)};}
  drawExample();
}
function drawExample(){
  const target=root.querySelector('#examplePanel');if(!target)return;
  if(!hasFilters()||!exampleData){target.hidden=true;target.innerHTML='';return;}
  target.hidden=false;
  const head=`<p class="proto-eyebrow">條件範例</p>`;
  if(exampleData.loading){target.innerHTML=`${head}<div class="proto-skeleton" aria-hidden="true"></div><p class="proto-signature">找一段所有過濾都成立的 K 線…</p>`;return;}
  if(exampleData.error){target.innerHTML=`${head}<p class="proto-signature">範例暫時無法顯示：${escapeHtml(exampleData.error)}</p>`;return;}
  const example=exampleData.example;
  if(!example){target.innerHTML=`${head}<div class="proto-status"><strong>找不到範例</strong><p>歷史資料裡沒有股票同時符合這${state.filters.length>1?'幾個':'個'}過濾。</p></div>`;return;}
  target.innerHTML=`${head}${exampleSvg(example)}<p class="proto-signature">${example.timeframe==='d1'?'日 K ':'一分鐘 K '}範例・▲ 為所有過濾都成立、會通知的時間點。只用來說明條件長什麼樣子，不是投資建議。</p>`;
}
const EXAMPLE_COLORS=['#2f6fbf','#c47f12','#7a4bb3','#1c8a8a'];
function exampleSvg(example){
  const W=360,PAD_L=4,PAD_R=40,PRICE_H=170,SUB_H=64,GAP=10;
  const candles=example.candles,n=candles.length;if(!n)return'';
  const panels=example.panels||[];const H=PRICE_H+panels.length*(SUB_H+GAP)+18;
  const step=(W-PAD_L-PAD_R)/n,body=Math.max(1,step*0.62),x=(i)=>PAD_L+step*i+step/2;
  const priceValues=[...candles.flatMap((c)=>[c.high,c.low]),...(example.price||[]).flatMap((line)=>line.values)].filter(Number.isFinite);
  let lo=Math.min(...priceValues),hi=Math.max(...priceValues);if(hi===lo){hi+=1;lo-=1;}const padP=(hi-lo)*0.06;lo-=padP;hi+=padP;
  const y=(v)=>4+(PRICE_H-8)*(1-(v-lo)/(hi-lo));
  const fmt=(v)=>Math.abs(v)>=1000?Math.round(v).toLocaleString('zh-TW'):Number(v.toPrecision(4)).toString();
  let svg='';
  // price grid labels
  for(const v of [hi-padP,(hi+lo)/2,lo+padP])svg+=`<line x1="${PAD_L}" x2="${W-PAD_R}" y1="${y(v)}" y2="${y(v)}" class="ex-grid"/><text x="${W-PAD_R+3}" y="${y(v)+3}" class="ex-axis">${fmt(v)}</text>`;
  // markers (vertical guides first, so candles stay on top)
  const markers=example.markers||[];
  for(const i of markers)svg+=`<line x1="${x(i)}" x2="${x(i)}" y1="2" y2="${H-18}" class="ex-guide"/>`;
  candles.forEach((c,i)=>{if(![c.open,c.high,c.low,c.close].every(Number.isFinite))return;const up=c.close>=c.open;const cls=up?'ex-up':'ex-down';const top=y(Math.max(c.open,c.close)),bottom=y(Math.min(c.open,c.close));svg+=`<line x1="${x(i)}" x2="${x(i)}" y1="${y(c.high)}" y2="${y(c.low)}" class="${cls}"/><rect x="${x(i)-body/2}" y="${top}" width="${body}" height="${Math.max(0.8,bottom-top)}" class="${cls}"/>`;});
  const path=(values,scale)=>{let d='',pen=false;values.forEach((v,i)=>{if(!Number.isFinite(v)){pen=false;return;}d+=`${pen?'L':'M'}${x(i).toFixed(1)},${scale(v).toFixed(1)}`;pen=true;});return d;};
  let color=0;const legend=[];
  for(const line of example.price||[]){const c=EXAMPLE_COLORS[color++%EXAMPLE_COLORS.length];svg+=`<path d="${path(line.values,y)}" class="ex-line" stroke="${c}"/>`;legend.push([c,line.label]);}
  for(const i of markers){const c=candles[i];if(c&&Number.isFinite(c.low))svg+=`<path d="M${x(i)},${y(c.low)+4} l-4.5,8 h9 z" class="ex-marker"/>`;}
  panels.forEach((panel,p)=>{
    const top=PRICE_H+GAP+p*(SUB_H+GAP);
    const vals=[...panel.lines.flatMap((line)=>line.values),...(panel.thresholds||[])].filter(Number.isFinite);
    let a=Math.min(...vals),b=Math.max(...vals);if(a===b){a-=1;b+=1;}
    const sy=(v)=>top+4+(SUB_H-8)*(1-(v-a)/(b-a));
    svg+=`<rect x="${PAD_L}" y="${top}" width="${W-PAD_L-PAD_R}" height="${SUB_H}" class="ex-panel"/>`;
    for(const t of panel.thresholds||[])svg+=`<line x1="${PAD_L}" x2="${W-PAD_R}" y1="${sy(t)}" y2="${sy(t)}" class="ex-threshold"/><text x="${W-PAD_R+3}" y="${sy(t)+3}" class="ex-axis">${fmt(t)}</text>`;
    for(const line of panel.lines){const c=EXAMPLE_COLORS[color++%EXAMPLE_COLORS.length];svg+=`<path d="${path(line.values,sy)}" class="ex-line" stroke="${c}"/>`;legend.push([c,line.label]);}
  });
  const first=candles[0].label||'',last=candles[n-1].label||'';
  svg+=`<text x="${PAD_L}" y="${H-4}" class="ex-axis">${escapeHtml(first)}</text><text x="${W-PAD_R}" y="${H-4}" text-anchor="end" class="ex-axis">${escapeHtml(last)}</text>`;
  const legendHtml=legend.length?`<ul class="proto-example-legend">${legend.map(([c,label])=>`<li><i style="background:${c}"></i>${escapeHtml(label)}</li>`).join('')}</ul>`:'';
  return`<svg class="proto-example-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="所有過濾都成立時的 K 線範例，共 ${markers.length} 個成立點">${svg}</svg>${legendHtml}`;
}
// E. 7-day M1 history: replays the current filters over HF daily one-minute files on the server.
// Shown as a one-line summary; details expand on request. Never runs on its own unless the AI card asked for it.
const HISTORY_WINDOW=7;
let historyDetail=false,historyAll=false;
function historySignature(){return JSON.stringify([HISTORY_WINDOW,monitorSpec(),filterSignature()]);}
function historyFresh(){return state.history&&state.history.signature===historySignature()?state.history:null;}
function historySummaryText(history){return`過去 ${history.availableDays} 個交易日，${history.symbolsCount} 檔股票中${history.triggeredSymbols!=null?` ${history.triggeredSymbols} 檔觸發、`:""}共 ${history.totalEvents} 次${history.failedDays?`（${history.failedDays} 天資料讀取失敗）`:""}`;}
function drawHistory(options={}){
  const target=root.querySelector('#historyPanel');if(!target)return;
  if(!hasFilters()){target.innerHTML='';target.hidden=true;return;}
  target.hidden=false;
  const history=historyFresh(),stale=state.history&&!history;
  const live=indexFresh();
  if(!history&&!options.loading&&!options.error&&live?.loading)options={loading:true,progress:live.progress||'計算中'};
  if(!history&&!options.loading&&!options.error&&live?.error)options={error:live.error};
  const row=(text,action,extra='')=>`<div class="proto-history-line"><span>${text}</span>${action}</div>${extra}`;
  if(options.loading)target.innerHTML=row('過去 7 個交易日：',`<span class="proto-note">回查中…</span>`,`<p id="historyProgress" class="proto-signature" aria-live="polite">${escapeHtml(options.progress||'準備中')}</p><p class="proto-signature">伺服器剛啟動時要先準備 7 日資料（約 1～3 分鐘），之後每次選指標都是立即顯示。可以先繼續下一步。</p>`);
  else if(options.error)target.innerHTML=row(`回查失敗：${escapeHtml(options.error)}`,'<button type="button" class="proto-link" id="runHistory">再試一次</button>');
  else if(!history)target.innerHTML=row(stale?'<strong>過濾已變，重新回查</strong>':'過去 7 個交易日：尚未回查','<button type="button" class="proto-link" id="runHistory">回查</button>');
  else{
    const busiest=history.days.filter((day)=>day.count).sort((a,b)=>b.count-a.count)[0];
    const code=history.verdict?.code;
    const hint=code==='too_many'?`<span class="proto-vet-hint warn">太頻繁：平均每檔每天 ${escapeHtml(perDayText(history.verdict))} 次</span>`:code==='no_triggers'||(!code&&!history.totalEvents)?'<span class="proto-vet-hint">沒有觸發</span>':code==='no_data'?'<span class="proto-vet-hint">沒有資料</span>':'';
    const summary=`過去 7 個交易日：${history.triggeredSymbols!=null?`${history.triggeredSymbols} 檔、`:''}共觸發 ${history.totalEvents} 次${busiest?`・最多 ${escapeHtml(busiest.date.slice(5).replace('-','/'))} ${busiest.count} 次`:''}${hint}`;
    let detail='';
    if(historyDetail){
      const limit=historyAll?history.events.length:30;
      const rows=history.events.slice(0,limit).map((event)=>`<div class="proto-history-row"><span><strong>${escapeHtml(event.symbol)}</strong> ${escapeHtml(event.name||'')}</span><time>${formatWhen(event.at)}</time><span>收盤 ${escapeHtml(formatPrice(event.price))}</span></div>`).join('');
      detail=`<p class="proto-signature">${escapeHtml(historySummaryText(history))}</p>${history.events.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>價格</span></div>${rows}</div>${history.events.length>limit?`<button type="button" class="proto-link" id="showAllHistory">顯示全部 ${history.events.length} 筆${history.truncated?`（共 ${history.totalEvents} 筆，只列最近 ${history.events.length} 筆）`:''}</button>`:''}`:'<div class="proto-status"><strong>這段期間沒有觸發</strong><p>過濾可能太嚴格，可以換一個變體再回查。</p></div>'}<p class="proto-signature"><button type="button" class="proto-link" id="runHistory">重新回查</button></p>`;
    }
    target.innerHTML=row(summary,`<button type="button" class="proto-link" id="toggleHistory" aria-expanded="${historyDetail}">${historyDetail?'收合':'看明細'}</button>`,detail);
  }
  target.querySelector('#toggleHistory')?.addEventListener('click',()=>{historyDetail=!historyDetail;drawHistory();});
  target.querySelector('#showAllHistory')?.addEventListener('click',()=>{historyAll=true;drawHistory();});
  target.querySelector('#runHistory')?.addEventListener('click',runHistory);
}
async function runHistory(){scheduleIndex({force:true});}
async function runHistoryLegacy(){
  if(!hasFilters()||historyBusy)return;
  const signature=historySignature();historyBusy=true;historyAll=false;historyDetail=false;drawHistory({loading:true});drawSticky();
  try{const result=await runHistoryJob();state.history=historyFrom(signature,result);save();historyBusy=false;if(node()==='conditions'){drawHistory();drawSticky();}}
  catch(error){historyBusy=false;if(node()==='conditions'){drawHistory({error:errorText(error)});drawSticky();}}
}
// What we keep of a backtest / vet result (events capped at 100; the verdict drives the summary row's hint).
function historyFrom(signature,result){const events=Array.isArray(result.events)?result.events:[];return{signature,sources:result.sources,availableDays:result.availableDays,failedDays:result.failedDays,symbolsCount:result.symbolsCount,triggeredSymbols:result.triggeredSymbols??null,totalEvents:result.totalEvents,truncated:result.truncated||events.length>100,days:result.days||[],events:events.slice(0,100),verdict:result.verdict||null};}
// Backtest runs as a server job: POST returns 202 + jobId (or 200 when cached), then poll until done/failed.
async function runHistoryJob(){
  const first=await withFormula(['/api/history/backtest',monitorSpec()]);
  return pollJob(first,(text)=>{const node=root.querySelector('#historyProgress');if(node)node.textContent=text;});
}
// Shared poller for /api/history/jobs/:id (backtest and vet): every 2 seconds, reporting progress text.
async function pollJob(data,onProgress){
  const started=Date.now();
  while(data.status&&data.status!=='done'){
    if(data.status==='failed')throw Object.assign(new Error(ERROR_TEXT[data.error]||'回查失敗'),{code:data.error});
    const seconds=Math.round((Date.now()-started)/1000);
    onProgress(`${data.progress?.message||'處理中'}${seconds>=5?`・已 ${seconds} 秒`:''}`);
    await new Promise((resolve)=>setTimeout(resolve,2000));
    data=await api(`/api/history/jobs/${encodeURIComponent(data.jobId)}`);
  }
  return data;
}
function alertInline(message){const target=root.querySelector('#aiPanel .proto-ai-body');if(target)target.insertAdjacentHTML('beforeend',`<p class="proto-error" role="alert">${escapeHtml(message)}</p>`);}
// One path for history, confirm and configure: the filters become a signed formula token.
// Preset / library filters → /api/indicator-templates/instantiate {items}; a single AI-built filter → parse again.
// Tokens expire after 10 minutes and after a server restart, so withFormula rebuilds once on a stale token.
async function buildFormulaToken(){
  if(legacyFilters().length)throw Object.assign(new Error('有舊版條件無法沿用，請移除後重新加入。'),{code:'LEGACY_FILTER'});
  if(!state.filters.length)throw Object.assign(new Error(ERROR_TEXT.CONDITIONS_REQUIRED),{code:'CONDITIONS_REQUIRED'});
  const signature=filterSignature();
  if(state.formulaToken&&state.formulaTokenSignature===signature)return state.formulaToken;
  const specs=state.filters.map((filter)=>filter.spec);let result;
  // AI-built filters carry their own signed token; the server verifies it and combines it like any library filter.
  // A lone AI filter whose token expired is re-parsed from its text.
  const resolved=[];
  for(const spec of specs){
    if(spec.shapeKey||spec.fingerprint){resolved.push(instantiateItem(spec));continue;}
    let token=spec.ai?.token||null;
    if(!token){const parsed=await api('/api/indicator-agent/parse',{text:spec.ai.text,context:spec.ai.context||[]});if(parsed.status!=='formula')throw Object.assign(new Error('AI 重新解析的結果和原本不同，請移除這個過濾後重新建立。'),{code:'FORMULA_REPARSE_MISMATCH'});token=parsed.proposalToken;spec.ai.token=token;}
    resolved.push({proposalToken:token});
  }
  try{result=await api('/api/indicator-templates/instantiate',{items:resolved,text:state.filters.map((filter)=>filter.label).join(' 且 ')});}
  catch(error){
    // An expired AI token: drop it and rebuild once from the text.
    if(['FORMULA_TOKEN_INVALID','FORMULA_PROPOSAL_STALE'].includes(error.code)&&specs.some((spec)=>spec.ai?.token)){for(const spec of specs)if(spec.ai)spec.ai.token=null;save();return buildFormulaToken();}
    throw error;
  }
  if(!result.proposalToken)throw Object.assign(new Error('沒有拿到可用的條件，請重新加入過濾。'),{code:'FORMULA_TOKEN_MISSING'});
  state.formulaToken=result.proposalToken;state.formulaTokenSignature=signature;save();return state.formulaToken;
}
async function withFormula([url,body]){
  let token=await buildFormulaToken();
  try{return await api(url,{...body,formulaToken:token});}
  catch(error){if(!['FORMULA_PROPOSAL_STALE','FORMULA_TOKEN_INVALID'].includes(error.code))throw error;state.formulaToken=null;token=await buildFormulaToken();return api(url,{...body,formulaToken:token});}
}

function request(){
  const text=state.requestText||'';
  shell({step:'request',title:'提出新指標需求',lead:'需求會保存為「待評估」，不會自動建立指標或啟用監控。',back:'conditions',body:`<form id="requestForm" class="proto-form"><label>需求描述<textarea name="sourceText" placeholder="例如：MACD 黃金交叉">${escapeHtml(text)}</textarea></label><label>指標名稱<input name="indicatorName" value="${escapeHtml(text)}"></label><label>資料週期<select name="timeframe"><option value="1m">一分鐘 K</option><option value="d1">日 K</option><option value="other">其他</option></select></label><label id="customTimeframeLabel" hidden>其他週期<input name="customTimeframe"></label><label>參數或計算定義<textarea name="parameterDescription" placeholder="例如：快線 12、慢線 26、訊號線 9"></textarea></label><label>觸發條件<textarea name="triggerCondition" placeholder="例如：DIF 上穿 MACD 訊號線"></textarea></label><p id="requestError" class="proto-error" role="alert"></p></form><section class="proto-history" id="requestList"></section><div class="proto-sticky-action"><span>送出後狀態為「待評估」</span><button id="submitRequest" class="proto-primary">送出需求</button></div>`});
  drawRequests(root.querySelector('#requestList'));
  const form=root.querySelector('#requestForm'),timeframe=form.elements.timeframe;
  timeframe.addEventListener('change',()=>{root.querySelector('#customTimeframeLabel').hidden=timeframe.value!=='other';});
  form.addEventListener('submit',(event)=>event.preventDefault());
  root.querySelector('#submitRequest').addEventListener('click',async(event)=>{
    const button=event.currentTarget,data=Object.fromEntries(new FormData(form));
    if(data.timeframe!=='other')delete data.customTimeframe;
    button.disabled=true;
    try{const result=await api('/api/indicator-requests',data);state.requestText='';save();shell({step:'request',title:result.duplicate?'這個需求已經提過了':'需求已送出',lead:`「${escapeHtml(result.request.indicatorName)}」目前狀態：待評估。評估完成前請先使用已有指標。`,body:'<div class="proto-inline-actions"><button class="proto-primary" data-go="conditions">返回設定條件</button></div><section class="proto-history" id="requestList"></section>'});drawRequests(root.querySelector('#requestList'));}
    catch(error){root.querySelector('#requestError').textContent=errorText(error);button.disabled=false;}
  });
}

function confirmPage(){
  if(!hasFilters())return go('conditions');
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔：${state.watchlist.slice(0,8).map((item)=>`${item.symbol} ${item.name}`).join('、')}${state.watchlist.length>8?' …':''}`:'今日監控名單（有成交量的股票，每天依最新名單重新套用條件）';
  const history=historyFresh();
  shell({step:'confirm',title:'確認並建立監控',lead:'建立後會立即啟用，之後可隨時暫停。',back:'conditions',body:`<div id="replaceNotice"></div><dl class="proto-summary"><div><dt>監控範圍</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>過濾</dt><dd class="proto-filter-summary">${state.filters.map((filter)=>`<span>${filter.spec.ai?'<span class="proto-tag-ai">AI 建立</span>':''}${escapeHtml(filter.label)}${filter.formulaSummary?`<br><small>${escapeHtml(filter.formulaSummary)}</small>`:''}</span>`).join('<span class="proto-and-pill">且</span>')}</dd></div><div><dt>組合方式</dt><dd>${state.filters.length>1?'全部成立才通知':'單一過濾'}</dd></div><div><dt>過去 7 日</dt><dd>${history?escapeHtml(historySummaryText(history)):'尚未回查 <button class="proto-link" data-go="conditions">去回查</button>'}</dd></div></dl><details class="proto-details"><summary>監控細節</summary><p>資料：一分鐘 K・台股 09:00–13:30（Asia/Taipei）</p><p>通知：這個瀏覽器的系統通知，需保持網頁開啟</p><p>條件從不成立變成立時通知一次；持續成立不重複通知</p></details><p id="createError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span id="createHint">建立後可隨時暫停</span><button id="createMonitor" class="proto-primary">建立並啟用監控</button></div>`});
  const button=root.querySelector('#createMonitor'),label=()=>button.dataset.replace?'取代並啟用':'建立並啟用監控';
  // The system runs one monitor at a time; warn before silently replacing a running one.
  api('/api/state').then((data)=>{
    const settings=data.settings||{};if(node()!=='confirm'||!settings.monitorTask?.onboardingCompleted)return;
    root.querySelector('#replaceNotice').innerHTML=`<p class="proto-notice" role="note"><span aria-hidden="true">!</span><span>系統一次只跑一組監控。建立後會<strong>取代</strong>${settings.enabled?'正在運作的':'目前暫停的'}「${escapeHtml(monitorConditionText(settings))}」（${escapeHtml(monitorScopeText(settings))}）。</span></p>`;
    button.dataset.replace='1';if(!button.disabled)button.textContent=label();root.querySelector('#createHint').textContent='舊的觸發紀錄會保留';
  }).catch(()=>{});
  button.addEventListener('click',async()=>{
    button.disabled=true;button.textContent='建立中…';
    try{
      await withFormula(['/api/monitor/configure',monitorSpec()]);
      templateCache=null; // an AI-built formula is now in the library; reload the list next time
      resetDraft();go('success');
    }catch(error){root.querySelector('#createError').textContent=errorText(error);button.disabled=false;button.textContent=label();}
  });
}

function success(){
  const supported='Notification' in window,permission=supported?Notification.permission:'unsupported';
  const action=permission==='default'?'<button class="proto-primary" id="notifyAndGo">開啟通知並查看監控</button>':'<button class="proto-primary" data-go="dashboard">查看我的監控</button>';
  const note=permission==='denied'?'<p class="proto-notice" role="note"><span aria-hidden="true">!</span><span>瀏覽器已封鎖通知。請點網址列左側的鎖頭圖示，把「通知」改為允許，才收得到觸發提醒。</span></p>':permission==='granted'?'<p class="proto-signature">通知已開啟。</p>':permission==='unsupported'?(isIosSafari()?`<p class="proto-notice" role="note"><span aria-hidden="true">i</span>${iosNotifyHint()}</p>`:'<p class="proto-signature">這個瀏覽器不支援通知，觸發紀錄會顯示在「我的監控」。</p>'):'<p class="proto-signature">最後一步：允許瀏覽器通知，條件成立時才會即時提醒你。</p>';
  shell({title:'監控已建立',lead:'',body:`<div class="proto-success"><span class="proto-check" aria-hidden="true">✓</span><p>盤中會持續檢查最新一分鐘 K，條件成立就通知你。</p></div><p class="proto-notice" role="note"><span aria-hidden="true">i</span><span>目前通知透過瀏覽器送出，<strong>請保持這個網頁開啟</strong>（手機請勿關閉分頁）。觸發紀錄也會保存在「我的監控」。</span></p>${note}<div class="proto-inline-actions"><button class="proto-secondary" data-go="home">回首頁</button>${action}</div>`});
  root.querySelector('#notifyAndGo')?.addEventListener('click',async()=>{try{await Notification.requestPermission();}catch{}go('dashboard');});
}

let dashboardSignature='',dashboardToken=null;
async function dashboard(){
  shell({title:'我的監控',lead:'',body:'<div id="dashboard"><div class="proto-skeleton" aria-hidden="true"></div></div>'});
  dashboardSignature='';clearInterval(pollTimer);
  const token=Symbol('dashboard');dashboardToken=token;
  const refresh=async()=>{
    if(dashboardToken!==token)return;
    if(node()!=='dashboard')return clearInterval(pollTimer);
    try{const data=await api('/api/state');if(node()==='dashboard'){drawDashboard(data);deliverNotifications(data.notifications||[]);}}
    catch(error){const target=root.querySelector('#dashboard');if(target)target.innerHTML=`<div class="proto-status"><strong>無法讀取狀態</strong><p>${escapeHtml(errorText(error))}</p></div>`;dashboardSignature='';}
  };
  await refresh();
  if(dashboardToken!==token)return;clearInterval(pollTimer);pollTimer=setInterval(refresh,15000);
}
function drawDashboard(data,{force=false}={}){
  const target=root.querySelector('#dashboard');if(!target)return;
  // Only redraw when something changed, so polling doesn't steal focus or re-announce the page.
  const {settings,runtime,signals=[],notifications=[]}=data;
  const session=marketSession();
  // Only what's on screen goes into the signature; lastRunAt is patched in place so each poll doesn't redraw the page.
  const signature=JSON.stringify([settings,signals.map((signal)=>signal.id),notifications.map((item)=>[item.id,item.status]),runtime.lastProviderStatus,runtime.lastError,runtime.effectiveWatchlistCount,session.key,typeof Notification==='undefined'?'':Notification.permission]);
  if(!force&&signature===dashboardSignature){const clock=target.querySelector('#lastRun');if(clock)clock.textContent=runtime.lastRunAt?formatWhen(runtime.lastRunAt):'尚未執行';return;}
  dashboardSignature=signature;
  const conditionHtml=settings.conditions?.length?settings.conditions.map((condition)=>`<span class="proto-cond-line">${directionTag(condition.direction)}${escapeHtml(conditionLabel(condition))}</span>`).join('<span class="proto-and">且</span>'):escapeHtml(settings.strategy?.name||'—');
  const supported='Notification' in window,permission=supported?Notification.permission:'unsupported';
  const notify=permission==='granted'?'<span class="proto-note ok">通知已開啟</span>':permission==='denied'?'<span class="proto-note bad">通知被瀏覽器封鎖（網址列左側鎖頭 → 通知 → 允許）</span>':permission==='unsupported'?(isIosSafari()?iosNotifyHint():'<span class="proto-note">此瀏覽器不支援通知</span>'):'<button id="enableNotify" class="proto-primary">開啟瀏覽器通知</button>';
  const status=PROVIDER_STATUS[runtime.lastProviderStatus]||runtime.lastProviderStatus||'—';
  const healthy=!runtime.lastError&&!['error','coverage_unknown'].includes(runtime.lastProviderStatus);
  const today=signals.filter((signal)=>isToday(signal.triggeredAt));
  const empty=session.key==='open'?'<strong>今天還沒有觸發</strong><p>盤中條件成立時會出現在這裡並通知你。</p>':`<strong>目前沒有觸發紀錄</strong><p>${escapeHtml(session.detail)}。</p>`;
  target.innerHTML=`<div class="proto-statusbar ${settings.enabled?(session.key==='open'?'live':'idle'):'paused'}" role="status"><i aria-hidden="true"></i><span><strong>${settings.enabled?(session.key==='open'?'監控中':`待命（${session.label}）`):'已暫停'}</strong>・上次檢查 <span id="lastRun">${runtime.lastRunAt?formatWhen(runtime.lastRunAt):'尚未執行'}</span>${settings.pollIntervalSeconds?`・每 ${settings.pollIntervalSeconds} 秒檢查`:''}</span></div>
    <article class="proto-monitor"><header><span><small class="proto-eyebrow">${settings.scopeMode==='universe'?'用條件找股票':'盯指定股票'}</small><strong class="proto-cond">${conditionHtml}</strong></span>${statusBadge(settings.enabled)}</header><p>${escapeHtml(monitorScopeText(settings))}${runtime.effectiveWatchlistCount!=null?`・本輪實際監控 ${runtime.effectiveWatchlistCount} 檔`:''}</p><p class="${healthy?'':'proto-error'}">資料狀態：${escapeHtml(status)}${runtime.lastError?`・${escapeHtml(errorText({code:runtime.lastError}))}`:''}</p>
    <div class="proto-notify-row">${notify}${permission==='granted'?'<span class="proto-signature">・請保持網頁開啟才收得到</span>':''}</div>
    <div class="proto-inline-actions proto-monitor-actions"><button id="toggleMonitor" class="proto-secondary">${settings.enabled?'暫停監控':'恢復監控'}</button><button id="runNow" class="proto-secondary">立即檢查一次</button><button id="newMonitor" class="proto-link">重新設定條件</button></div><div id="resetConfirm"></div></article>
    <section class="proto-history"><div class="proto-history-head"><div><p class="proto-eyebrow">觸發紀錄</p><h2>今日觸發 ${todayCount(signals,today)} 次</h2>${today.length?`<p class="proto-signature">${todayBreakdown(today)}</p>`:''}</div><span>共 ${signals.length} 筆</span></div>${signals.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>符合條件・收盤價</span></div>${signals.slice(0,30).map((signal)=>{const notification=notifications.find((item)=>item.signalId===signal.id);return`<div class="proto-history-row ${isToday(signal.triggeredAt)?'today':''}"><span><strong>${escapeHtml(signal.symbol)}</strong> ${escapeHtml(signal.name||'')}${MARKET_LABEL[signal.market]?` <small class="proto-market">${MARKET_LABEL[signal.market]}</small>`:''}</span><time datetime="${escapeHtml(signal.triggeredAt)}">${formatWhen(signal.triggeredAt)}</time><span>${escapeHtml(signal.ruleName||'')}・${escapeHtml(formatPrice(signal.price))}${notificationBadge(notification)}</span></div>`;}).join('')}</div>`:`<div class="proto-status">${empty}</div>`}</section>`;
  target.querySelector('#newMonitor').addEventListener('click',()=>{
    const box=target.querySelector('#resetConfirm');
    box.innerHTML='<div class="proto-notice" role="alert"><span aria-hidden="true">!</span><span>系統一次只跑一組監控，新設定建立後才會取代目前這組（在那之前照常監控）。<span class="proto-inline-actions"><button class="proto-link" id="resetCancel">取消</button><button class="proto-secondary" id="resetGo">開始重新設定</button></span></span></div>';
    box.querySelector('#resetGo').addEventListener('click',()=>{resetDraft();state.purpose=settings.scopeMode==='universe'?'screen':'watchlist';state.selected=(settings.watchlist||[]).map(({symbol,name})=>({symbol,name:name||''}));save();go(state.purpose==='watchlist'?'stocks':'conditions');});
    box.querySelector('#resetCancel').addEventListener('click',()=>{box.innerHTML='';target.querySelector('#newMonitor').focus();});
    box.querySelector('#resetGo').focus();
  });
  target.querySelector('#toggleMonitor').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;try{drawDashboard(await api(settings.enabled?'/api/monitor/stop':'/api/monitor/start',{}),{force:true});}catch(error){alertStatus(error);button.disabled=false;}});
  target.querySelector('#runNow').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='檢查中…';try{const result=await api('/api/monitor/run',{});drawDashboard(result.state||data,{force:true});}catch(error){alertStatus(error);button.disabled=false;button.textContent='立即檢查一次';}});
  target.querySelector('#enableNotify')?.addEventListener('click',async()=>{try{await Notification.requestPermission();}catch{}drawDashboard(data,{force:true});});
  target.querySelectorAll('[data-retry]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;button.textContent='重送中…';try{const result=await api(`/api/notifications/${encodeURIComponent(button.dataset.retry)}/retry`,{});if(!result.retried)throw Object.assign(new Error('這則通知目前不能重送。'),{code:result.reason});seenNotifications.delete(button.dataset.retry);const fresh=await api('/api/state');drawDashboard(fresh,{force:true});await deliverNotifications(fresh.notifications||[]);drawDashboard(await api('/api/state'),{force:true});}catch(error){alertStatus(error);button.disabled=false;button.textContent='重送';}}));
}
function alertStatus(error){const target=root.querySelector('#dashboard');target?.insertAdjacentHTML('afterbegin',`<p class="proto-error" role="alert">${escapeHtml(errorText(error))}</p>`);}

// validate → show → ack handshake: the server decides whether a pending notification may still be delivered.
async function deliverNotifications(notifications){
  if(!('Notification' in window)||Notification.permission!=='granted')return;
  for(const notification of notifications.filter((item)=>item.status==='pending'&&!seenNotifications.has(item.id))){
    try{
      const validation=await api(`/api/notifications/${encodeURIComponent(notification.id)}/validate`,{});
      if(!validation.deliver){if(['not_selected','not_covered','signal_missing','strategy_mismatch','not_pending'].includes(validation.reason))seenNotifications.add(notification.id);continue;}
      try{new Notification(notification.title,{body:notification.message});}
      catch(error){seenNotifications.add(notification.id);await api(`/api/notifications/${encodeURIComponent(notification.id)}/fail`,{reason:String(error?.name||'notification_error')}).catch(()=>{});continue;}
      seenNotifications.add(notification.id);
      await api(`/api/notifications/${encodeURIComponent(notification.id)}/ack`,{});
    }catch{}
  }
}

const REQUEST_STATUS={pending_evaluation:'待評估'};
const TIMEFRAME_LABEL={'1m':'一分鐘 K',d1:'日 K'};
async function drawRequests(target){
  if(!target)return;
  target.innerHTML='<div class="proto-history-head"><div><p class="proto-eyebrow">需求進度</p><h2>我提出的需求</h2></div></div><div class="proto-status"><strong>讀取中…</strong></div>';
  try{
    const {items=[]}=await api('/api/indicator-requests');
    target.innerHTML=`<div class="proto-history-head"><div><p class="proto-eyebrow">需求進度</p><h2>我提出的需求</h2></div><span>${items.length} 筆</span></div>${items.length?`<div class="proto-history-table">${items.slice(0,20).map((item)=>`<div class="proto-history-row"><span><strong>${escapeHtml(item.indicatorName)}</strong> ${escapeHtml(item.timeframe==='other'?item.customTimeframe||'其他':TIMEFRAME_LABEL[item.timeframe]||item.timeframe)}</span><time>${formatTime(item.createdAt)}</time><span><span class="proto-note">${escapeHtml(REQUEST_STATUS[item.status]||item.status)}</span>・${escapeHtml(item.triggerCondition)}</span></div>`).join('')}</div>`:'<div class="proto-status"><strong>還沒有提出過需求</strong><p>找不到想要的指標時，可以在這裡提出。</p></div>'}`;
  }catch(error){target.innerHTML=`<div class="proto-status"><strong>無法讀取需求</strong><p>${escapeHtml(errorText(error))}</p></div>`;}
}
function notificationBadge(notification){
  if(!notification)return'';
  if(notification.status==='sent')return'・<span class="proto-note ok">已通知</span>';
  if(notification.status==='failed')return`・<span class="proto-note bad">通知失敗</span> <button class="proto-link" data-retry="${escapeHtml(notification.id)}">重送</button>`;
  if(notification.status==='suppressed')return'・<span class="proto-note">未通知（條件已變更）</span>';
  return'・<span class="proto-note">待通知</span>';
}
function formatPrice(value){const number=Number(value);return value==null||value===''||!Number.isFinite(number)?'—':String(Math.round(number*100)/100);}
function formatClock(value){return new Date(value).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,hour:'2-digit',minute:'2-digit'});}
// Today's events only need the clock time; older ones get M/D in front.
function formatWhen(value){if(!value)return'—';const date=new Date(value);return isToday(value)?formatClock(value):`${date.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric'})} ${formatClock(value)}`;}
function formatTime(value){return new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});}
function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
fetch('/api/version').then((response)=>response.ok?response.json():null).then((info)=>{const target=document.getElementById('appVersion');if(!info||!target)return;target.textContent=info.commit?`${info.version}・${info.commit}`:info.version;target.title=`部署時間：${formatTime(info.deployedAt)}${info.commit?`・commit ${info.commit}`:''}`;}).catch(()=>{});
drawSessionPill();setInterval(drawSessionPill,30000);
if(!location.hash)location.hash='#home';else render();
