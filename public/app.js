// Three-step flow (選範圍 → 條件 → 確認) documented in docs/ui-prototype-flow.md, wired to /api
// for stock lists, indicator requests and monitor creation.
// Also: AI parsing of new indicators, 7-trading-day M1 history lookup, request progress and notification retry.
const KEY='watch365_ui_v2';
const INDICATORS=[
  {id:'rsi',name:'RSI',desc:'Wilder RSI 由下往上穿越門檻',directions:['above'],periodMax:100,threshold:true,defaults:{period:14,threshold:30}},
  {id:'sma',name:'SMA 簡單移動平均',desc:'收盤價穿越 SMA',directions:['above','below'],periodMax:200,threshold:false,defaults:{period:20}},
  {id:'ema',name:'EMA 指數移動平均',desc:'收盤價穿越 EMA',directions:['above','below'],periodMax:200,threshold:false,defaults:{period:20}}
];
const DIRECTION_LABEL={above:'上穿',below:'下穿'};
// One-tap starting points (Wantgoo quick conditions / TradingView popular screens). Every template is a
// combination the existing rules accept: single RSI, or up to two SMA/EMA conditions.
const TEMPLATES=[
  {id:'rsi-30',name:'RSI(14) 上穿 30',desc:'RSI 由下往上穿越 30',conditions:[{indicator:'rsi',direction:'above',period:14,threshold:30}]},
  {id:'ema20-up',name:'收盤上穿 EMA(20)',desc:'一分鐘 K 收盤價上穿 EMA(20)',conditions:[{indicator:'ema',direction:'above',period:20,threshold:null}]},
  {id:'sma60-up',name:'收盤上穿 SMA(60)',desc:'一分鐘 K 收盤價上穿 SMA(60)',conditions:[{indicator:'sma',direction:'above',period:60,threshold:null}]},
  {id:'sma20-down',name:'收盤下穿 SMA(20)',desc:'一分鐘 K 收盤價下穿 SMA(20)',conditions:[{indicator:'sma',direction:'below',period:20,threshold:null}]}
];
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
  HISTORY_SOURCE_FAILED:'無法讀取歷史資料，請稍後再試。',HF_UNAUTHORIZED:'資料來源權限異常，請稍後再試。',HISTORY_FAILED:'回查時發生錯誤，請稍後再試。',
  FORMULA_PLAN_INVALID:'AI 這次的回覆無法轉成條件，請換個說法再試一次。',INDICATOR_AGENT_FAILED:'AI 解析失敗，請稍後再試，或改為提出需求。',INDICATOR_AGENT_TIMEOUT:'AI 回應逾時，請再試一次。',
  INDICATOR_AGENT_NOT_CONFIGURED:'AI 解析尚未設定，請改為提出需求。',INDICATOR_AGENT_INPUT_TOO_LONG:'描述太長了，請精簡到 500 字以內。',FORMULA_PROPOSAL_STALE:'AI 條件已過期，請重新解析。',FORMULA_TOKEN_INVALID:'AI 條件已失效，請重新解析。',
  FORMULA_WITH_OTHER_CONDITIONS:'AI 自訂條件目前不能與其他條件組合，請先移除。',
  retry_not_allowed:'只有送出失敗的通知可以重送。',not_found:'找不到這則通知。',
  CONDITIONS_REQUIRED:'請至少加入一個條件。',CONDITIONS_TOO_MANY:'目前最多只能組合 2 個條件。',
  CONDITION_RSI_BELOW_UNSUPPORTED:'RSI 目前只支援上穿。',CONDITION_RSI_COMBINATION_UNSUPPORTED:'RSI 目前不能與其他條件組合，請單獨使用。',
  CONDITION_PERIOD_INVALID:'期數超出範圍。',CONDITION_THRESHOLD_INVALID:'RSI 門檻需介於 1–99。',
  WATCHLIST_REQUIRED:'請至少選一檔股票。',WATCHLIST_MARKET_REQUIRED:'有股票無法確認市場別，請移除後再試。',
  HF_UNIVERSE_SOURCE_FAILED:'無法讀取今日監控名單，請稍後再試。',HF_UNIVERSE_NOT_FOUND:'今日監控名單尚未產生。',HF_METADATA_UNAVAILABLE:'無法讀取股票市場別資料，請稍後再試。',
  INDICATOR_REQUEST_TEXT_TOO_SHORT:'需求描述至少 3 個字。',INDICATOR_REQUEST_FIELDS_REQUIRED:'請填完所有欄位。',INDICATOR_TEXT_REQUIRED:'欄位長度不足（至少 2 個字）。'
};
const root=document.querySelector('#app');
let state=load();
let pollTimer=0,searchTimer=0,aiTimer=0,seenNotifications=new Set();
// Parse results for first-turn AI requests, keyed by text, so retyping the same words doesn't re-call the model.
const aiCache=new Map();
document.querySelector('#homeButton').addEventListener('click',()=>go('home'));
window.addEventListener('hashchange',render);

function initial(){return{purpose:null,selected:[],watchlist:[],conditions:[],formula:null,activeIndicator:'rsi',drafts:{},requestText:'',ai:null,history:null};}
function load(){try{const saved={...initial(),...JSON.parse(localStorage.getItem(KEY))};if(saved.ai)saved.ai.loading=false;return saved;}catch{return initial();}}
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
  const draft=state.purpose?`<div class="proto-resume"><strong>有一份尚未完成的草案</strong><p>${state.purpose==='watchlist'?`指定股票 ${state.selected.length} 檔`:'條件選股'} · ${state.formula?'AI 自訂條件':`${state.conditions.length} 個條件`}</p><div class="proto-inline-actions"><button class="proto-link" id="discardDraft">捨棄草案</button><button class="proto-secondary" data-go="${state.purpose==='watchlist'&&!state.watchlist.length?'stocks':'conditions'}">繼續草案</button></div></div>`:'';
  shell({title:'今天想怎麼盯？',lead:'選一個方式開始，條件成立時會即時通知你。',body:`<div id="homeMonitor"><div class="proto-skeleton" aria-hidden="true"></div></div><div class="proto-options"><button class="proto-option" data-purpose="watchlist"><span><strong>盯指定股票</strong><small>從今日可監控名單搜尋、依類股多選</small></span><span class="proto-arrow">→</span></button><button class="proto-option" data-purpose="screen"><span><strong>用條件找股票</strong><small>條件套用到今日監控名單（有成交量的股票），每天自動更新</small></span><span class="proto-arrow">→</span></button></div>${draft}`});
  root.querySelectorAll('[data-purpose]').forEach((button)=>button.addEventListener('click',()=>{const purpose=button.dataset.purpose;if(purpose!==state.purpose){state.purpose=purpose;state.watchlist=[];}save();go(purpose==='watchlist'?'stocks':'conditions');}));
  root.querySelector('#discardDraft')?.addEventListener('click',()=>{resetDraft();render();});
  const target=root.querySelector('#homeMonitor');
  try{
    const data=await api('/api/state');if(node()!=='home')return;
    const settings=data.settings||{};
    if(!settings.monitorTask?.onboardingCompleted){target.innerHTML='';return;}
    const today=(data.signals||[]).filter((signal)=>isToday(signal.triggeredAt)),symbols=new Set(today.map((signal)=>signal.symbol));
    target.innerHTML=`<article class="proto-monitor proto-home-monitor"><header><span><small class="proto-eyebrow">我的監控</small><strong>${escapeHtml(monitorConditionText(settings))}</strong></span>${statusBadge(settings.enabled)}</header><p>${escapeHtml(monitorScopeText(settings))}</p><div class="proto-today"><strong>${todayCount(data.signals||[],today)}</strong><span>今日觸發${today.length?`・${symbols.size} 檔`:''}</span>${today[0]?`<small>最新：${escapeHtml(today[0].symbol)} ${escapeHtml(today[0].name||'')} ${formatClock(today[0].triggeredAt)}</small>`:''}</div><button class="proto-primary" data-go="dashboard">查看我的監控</button></article>`;
    target.querySelector('[data-go]').addEventListener('click',()=>go('dashboard'));
  }catch{target.innerHTML='';}
}
function monitorConditionText(settings){return settings.conditions?.length?settings.conditions.map(conditionLabel).join(' 且 '):settings.strategy?.name||'—';}
function monitorScopeText(settings){return settings.scopeMode==='universe'?'今日監控名單（每日自動更新）':`${settings.watchlist?.length||0} 檔指定股票`;}
// Badge follows the session so it never says 監控中 while the status bar says 已收盤.
function statusBadge(enabled){const open=marketSession().key==='open';return`<span class="proto-badge ${enabled?(open?'on':'idle'):'off'}"><i aria-hidden="true"></i>${enabled?(open?'監控中':'待命'):'已暫停'}</span>`;}
// publicState returns at most 100 signals; if all of them are today the real count is higher.
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
function conditions(){
  if(!state.purpose)return go('home');
  if(state.purpose==='watchlist'&&!state.watchlist.length)return go('stocks');
  const item=INDICATORS.find((entry)=>entry.id===state.activeIndicator)||INDICATORS[0],draft={direction:item.directions[0],...item.defaults,...state.drafts[item.id]};
  if(!item.directions.includes(draft.direction))draft.direction=item.directions[0];
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'今日監控名單';
  const blocked=addBlockReason(item.id);
  const templates=!hasConditions()?`<section class="proto-templates" aria-label="常用條件"><p class="proto-eyebrow">常用條件・一鍵帶入</p><div class="proto-template-grid">${TEMPLATES.map((template)=>`<button class="proto-template" data-template="${template.id}"><strong>${escapeHtml(template.name)}</strong><small>${escapeHtml(template.desc)}</small></button>`).join('')}</div></section>`:'';
  shell({step:'conditions',title:'設定監控條件',lead:`範圍：${scope}。以一分鐘 K 收盤判斷，最多 2 個條件、同時成立才通知。`,back:state.purpose==='watchlist'?'stocks':'home',body:`${templates}${conditionMarkup()}<label class="proto-search proto-ai-search"><span class="proto-ai-tag" aria-hidden="true">AI</span><input id="indicatorSearch" type="search" placeholder="例如：MACD 黃金交叉、KD 低檔上穿" aria-label="搜尋指標或用一句話描述條件" value="${escapeHtml(state.requestText)}"></label><p class="proto-signature proto-ai-hint">找不到想要的指標？直接用一句話描述，AI 會轉成可監控的條件；暫時做不到的會列入新指標開發。</p><div class="proto-library proto-inline-library" id="indicatorResults"></div><section id="aiPanel"></section><section class="proto-condition-editor"><details id="editorDetails" ${state.editorOpen&&!blocked?'open':''}><summary><span class="proto-eyebrow">自訂參數</span> <strong>${escapeHtml(item.name)}</strong></summary><p class="proto-signature">${escapeHtml(item.desc)}</p><div class="proto-form"><label>方向<select id="direction">${item.directions.map((value)=>`<option value="${value}" ${draft.direction===value?'selected':''}>${DIRECTION_LABEL[value]}</option>`).join('')}</select></label><label>期數<input id="period" type="number" inputmode="numeric" min="2" max="${item.periodMax}" value="${escapeHtml(draft.period)}"></label>${item.threshold?`<label>門檻<input id="threshold" type="number" inputmode="numeric" min="1" max="99" value="${escapeHtml(draft.threshold)}"></label>`:''}<p id="paramError" class="proto-error" role="alert"></p></div><button id="addCondition" class="proto-secondary" ${blocked?'disabled aria-describedby="addBlocked"':''}>加入這個條件</button>${blocked?`<p id="addBlocked" class="proto-signature">${escapeHtml(blocked)}</p>`:''}</details></section><section class="proto-history" id="historyPanel"></section><div class="proto-sticky-action"><span>${state.formula?'AI 自訂條件':`${state.conditions.length}/2 個條件`}</span><button id="confirmConditions" class="proto-primary" ${hasConditions()?'':'disabled'}>下一步：確認</button></div>`});
  bindConditionList();
  root.querySelectorAll('[data-template]').forEach((button)=>button.addEventListener('click',()=>{const template=TEMPLATES.find((entry)=>entry.id===button.dataset.template);state.conditions=template.conditions.map((condition)=>({id:crypto.randomUUID(),...condition}));state.activeIndicator=template.conditions[0].indicator;state.history=null;save();render();}));
  const search=root.querySelector('#indicatorSearch'),results=root.querySelector('#indicatorResults');
  const startAi=(value)=>{clearTimeout(aiTimer);if(state.ai&&state.ai.text===value&&!state.ai.context.length&&(state.ai.loading||state.ai.result||state.ai.error))return;state.ai={text:value,context:[],result:null};save();runAi();};
  const drawSearch=()=>{
    const value=search.value.trim(),needle=value.toLowerCase();state.requestText=value;save();clearTimeout(aiTimer);
    const matches=INDICATORS.filter((entry)=>!needle||`${entry.id} ${entry.name} ${entry.desc}`.toLowerCase().includes(needle));
    results.innerHTML=matches.length?matches.map((entry)=>`<button class="proto-indicator-pill ${entry.id===item.id?'active':''}" data-indicator="${entry.id}"><strong>${escapeHtml(entry.name)}</strong><small>已有指標</small></button>`).join(''):`<p class="proto-signature">已有指標找不到「${escapeHtml(value)}」，${value.length>=2?'已交給 AI 判斷能不能直接監控。':'再多打幾個字，AI 會幫你判斷。'}</p>`;
    results.querySelectorAll('[data-indicator]').forEach((button)=>button.addEventListener('click',()=>{state.activeIndicator=button.dataset.indicator;state.editorOpen=true;state.requestText='';save();render();}));
    // A stale first-turn AI card for different text is dropped once the search matches again or is cleared.
    if((matches.length||!value)&&state.ai&&!state.ai.context.length&&state.ai.text!==value){state.ai=null;save();drawAi();}
    if(!matches.length&&value.length>=2)aiTimer=setTimeout(()=>startAi(value),700);
  };
  search.addEventListener('keydown',(event)=>{const value=search.value.trim();if(event.key==='Enter'&&value.length>=2&&!INDICATORS.some((entry)=>`${entry.id} ${entry.name} ${entry.desc}`.toLowerCase().includes(value.toLowerCase())))startAi(value);});
  search.addEventListener('input',drawSearch);drawSearch();drawAi();drawHistory();
  const capture=()=>{state.drafts[item.id]={direction:root.querySelector('#direction').value,period:root.querySelector('#period').value,threshold:root.querySelector('#threshold')?.value??null};save();};
  root.querySelectorAll('#direction,#period,#threshold').forEach((input)=>input.addEventListener('input',()=>{capture();root.querySelector('#paramError').textContent='';}));
  root.querySelector('#addCondition').addEventListener('click',()=>{
    capture();
    const values=state.drafts[item.id],period=Number(values.period),threshold=item.threshold?Number(values.threshold):null,hasRsi=state.conditions.some((entry)=>entry.indicator==='rsi');
    const error=!Number.isInteger(period)||period<2||period>item.periodMax?`期數需為 2–${item.periodMax} 的整數。`:item.threshold&&(!values.threshold||!Number.isFinite(threshold)||threshold<1||threshold>99)?'門檻需介於 1–99。':state.formula?ERROR_TEXT.FORMULA_WITH_OTHER_CONDITIONS:state.conditions.length>=2?'目前最多只能組合 2 個條件。':state.conditions.length&&(hasRsi||item.id==='rsi')?'RSI 目前不能與其他條件組合，請單獨使用。':'';
    if(error){root.querySelector('#paramError').textContent=error;return;}
    state.conditions.push({id:crypto.randomUUID(),indicator:item.id,direction:values.direction,period,threshold});state.editorOpen=false;state.history=null;save();render();
  });
  root.querySelector('#editorDetails').addEventListener('toggle',(event)=>{state.editorOpen=event.currentTarget.open;save();});
  root.querySelector('#confirmConditions').addEventListener('click',()=>go('confirm'));
}
function conditionLabel(condition){
  const item=INDICATORS.find((entry)=>entry.id===condition.indicator),direction=DIRECTION_LABEL[condition.direction]||condition.direction;
  if(condition.indicator==='rsi')return`RSI(${condition.period}) ${condition.direction==='above'?'由下往上穿越':'由上往下穿越'} ${condition.threshold}`;
  if(item)return`收盤價${direction} ${item.id.toUpperCase()}(${condition.period})`;
  return`${condition.indicator} ${condition.period} ${direction}${condition.threshold===null?'':` ${condition.threshold}`}`;
}
// Explains up front why a condition can't be added, instead of failing after the click.
function addBlockReason(indicatorId){
  if(state.formula)return'已使用 AI 自訂條件，要加入其他條件請先移除它。';
  if(state.conditions.length>=2)return'已達 2 個條件上限，要換條件請先移除一個。';
  if(state.conditions.length&&(indicatorId==='rsi'||state.conditions.some((entry)=>entry.indicator==='rsi')))return'RSI 目前只能單獨使用，不能和其他條件組合。';
  return'';
}
function directionTag(direction){return`<span class="proto-dir ${direction==='below'?'down':'up'}">${DIRECTION_LABEL[direction]||''}</span>`;}
function monitorSpec(){const spec={purpose:state.purpose,watchlist:state.purpose==='watchlist'?state.watchlist:undefined};if(!state.formula)spec.conditions=state.conditions.map(({indicator,direction,period,threshold})=>({indicator,direction,period,threshold}));return spec;}
function hasConditions(){return Boolean(state.formula)||state.conditions.length>0;}
function scopeText(){return state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'今日監控名單';}
function conditionMarkup(){if(state.formula)return`<div class="proto-condition-list"><p class="proto-eyebrow">AI 自訂條件</p><div class="proto-condition"><strong>${escapeHtml(state.formula.name)}</strong><span><button aria-label="移除 ${escapeHtml(state.formula.name)}" data-remove="formula">移除</button></span></div><p class="proto-signature">${escapeHtml(state.formula.summary)}</p></div>`;return state.conditions.length?`<div class="proto-condition-list"><p class="proto-eyebrow">已加入的條件${state.conditions.length>1?'（全部成立才通知）':''}</p>${state.conditions.map((condition)=>`<div class="proto-condition"><strong>${directionTag(condition.direction)}${escapeHtml(conditionLabel(condition))}</strong><span><button aria-label="移除 ${escapeHtml(conditionLabel(condition))}" data-remove="${condition.id}">移除</button></span></div>`).join('')}</div>`:'';}
function bindConditionList(){root.querySelectorAll('[data-remove]').forEach((button)=>button.addEventListener('click',()=>{if(button.dataset.remove==='formula')state.formula=null;else state.conditions=state.conditions.filter((item)=>item.id!==button.dataset.remove);state.history=null;save();render();}));}

// AI parsing: /api/indicator-agent/parse returns existing (registry indicator), formula (signed proposal),
// clarification (needs a reply, sent back with the conversation as context) or discussion (not computable).
async function runAi(){
  const ai=state.ai;if(!ai)return;
  ai.loading=true;ai.error=null;drawAi();
  const cacheable=!ai.context.length,cached=cacheable?aiCache.get(ai.text):null;
  if(cached){ai.result=cached;ai.loading=false;save();drawAi();return;}
  try{const result=await api('/api/indicator-agent/parse',{text:ai.text,context:ai.context});if(cacheable)aiCache.set(ai.text,result);if(state.ai!==ai)return;ai.result=result;}
  catch(error){if(state.ai!==ai)return;ai.result=null;ai.error=errorText(error);}
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
function quickRequestCard(ai,title,message){
  if(ai.requested)return`<div class="proto-status"><strong>${ai.requested.duplicate?'這個需求已經提過了':'需求已送出'}</strong><p>「${escapeHtml(ai.requested.name)}」目前狀態：待評估。評估完成前請先使用已有指標。</p><button class="proto-link" data-go="request">查看我的需求</button></div>`;
  return`<div class="proto-status"><strong>${escapeHtml(title)}</strong>${message?`<p>${escapeHtml(message)}</p>`:''}<p class="proto-signature">送出後會列入新指標評估，不會影響目前的條件。</p><div class="proto-inline-actions"><button class="proto-primary" id="aiQuickRequest">送出需求</button><button class="proto-link" id="aiRequest">補充參數再送</button></div></div>`;
}
function drawAi(){
  const target=root.querySelector('#aiPanel');if(!target)return;
  const ai=state.ai;if(!ai){target.innerHTML='';return;}
  const head=`<div class="proto-history-head"><div><p class="proto-eyebrow">AI 解析</p><h2>${escapeHtml(ai.text)}</h2></div><button class="proto-link" id="aiClose">關閉</button></div>`;
  let body;
  if(ai.loading)body='<div class="proto-status"><strong>AI 解析中…</strong><p>通常需要幾秒鐘。</p></div>';
  else if(ai.error)body=`<div class="proto-status"><strong>解析失敗</strong><p>${escapeHtml(ai.error)}</p><div class="proto-inline-actions"><button class="proto-secondary" id="aiRetry">再試一次</button><button class="proto-secondary" id="aiQuickRequest">直接送出需求</button></div></div>`;
  else{
    const result=ai.result||{};
    if(result.status==='existing'){const condition=registryCondition(result.proposal);body=condition?`<div class="proto-status"><strong>對應到已有指標：${escapeHtml(result.summary)}</strong><p>加入後可以和其他條件一起使用。</p><button class="proto-primary" id="aiUseExisting">加入這個條件</button></div>`:quickRequestCard(ai,`${result.summary}目前不能從這裡建立`,'');}
    else if(result.status==='formula')body=`<div class="proto-status"><strong>${escapeHtml(result.summary)}</strong><p>計算方式：${escapeHtml(result.formulaSummary)}</p><p class="proto-signature">AI 自訂條件會單獨使用，會取代目前已加入的條件。</p><button class="proto-primary" id="aiUseFormula">使用這個條件</button></div>`;
    else if(result.status==='clarification')body=`<div class="proto-status"><strong>AI 需要多一點資訊</strong><p>${escapeHtml(result.message)}</p><label class="proto-search"><input id="aiReply" type="text" placeholder="回答上面的問題" aria-label="回答 AI"></label><button class="proto-primary" id="aiSendReply">送出</button></div>`;
    else body=quickRequestCard(ai,`「${ai.text}」目前還不支援`,result.message||'這個條件超出目前可計算的範圍。');
  }
  target.className='proto-condition-editor';target.innerHTML=head+body;
  target.querySelector('#aiClose').addEventListener('click',()=>{state.ai=null;save();drawAi();});
  target.querySelectorAll('[data-go]').forEach((button)=>button.addEventListener('click',()=>go(button.dataset.go)));
  target.querySelector('#aiRetry')?.addEventListener('click',runAi);
  target.querySelector('#aiRequest')?.addEventListener('click',()=>{state.requestText=ai.text;state.ai=null;save();go('request');});
  target.querySelector('#aiQuickRequest')?.addEventListener('click',async(event)=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='送出中…';
    try{const result=await api('/api/indicator-requests',quickRequestPayload(ai.text));ai.requested={duplicate:result.duplicate,name:result.request.indicatorName};save();drawAi();}
    catch(error){button.disabled=false;button.textContent='送出需求';alertInline(errorText(error));}
  });
  target.querySelector('#aiUseExisting')?.addEventListener('click',()=>{
    const condition=registryCondition(ai.result.proposal);
    if(state.formula){alertInline(ERROR_TEXT.FORMULA_WITH_OTHER_CONDITIONS);return;}
    if(state.conditions.length>=2){alertInline('目前最多只能組合 2 個條件。');return;}
    if(state.conditions.length&&(condition.indicator==='rsi'||state.conditions.some((item)=>item.indicator==='rsi'))){alertInline('RSI 目前不能與其他條件組合，請單獨使用。');return;}
    state.conditions.push({id:crypto.randomUUID(),...condition});state.ai=null;state.requestText='';state.history=null;save();render();
  });
  target.querySelector('#aiUseFormula')?.addEventListener('click',()=>{
    const result=ai.result;
    state.formula={name:result.summary.replace(/ · 一分鐘$/,''),summary:result.formulaSummary,token:result.proposalToken,text:ai.text,context:ai.context};
    state.conditions=[];state.ai=null;state.requestText='';state.history=null;save();render();
  });
  const reply=target.querySelector('#aiReply');
  const send=()=>{const text=reply.value.trim();if(!text)return;ai.context=[...ai.context,{request:ai.text,response:ai.result.message}].slice(-4);ai.text=text;ai.result=null;save();runAi();};
  target.querySelector('#aiSendReply')?.addEventListener('click',send);
  reply?.addEventListener('keydown',(event)=>{if(event.key==='Enter')send();});
}
// 7-day M1 history: replays the current conditions over HF daily one-minute files on the server.
const HISTORY_WINDOW=7;
function historySignature(){return JSON.stringify([HISTORY_WINDOW,monitorSpec(),state.formula?.summary||null]);}
function historyFresh(){return state.history&&state.history.signature===historySignature()?state.history:null;}
function historySummaryText(history){return`過去 ${history.availableDays} 個交易日，${history.symbolsCount} 檔股票共觸發 ${history.totalEvents} 次${history.failedDays?`（${history.failedDays} 天資料讀取失敗）`:''}`;}
async function drawHistory(options={}){
  const target=root.querySelector('#historyPanel');if(!target)return;
  const head=(right)=>`<div class="proto-history-head"><div><p class="proto-eyebrow">過去 7 個交易日</p><h2>這組條件會多常觸發？</h2></div>${right}</div>`;
  if(!hasConditions()){target.innerHTML=head('')+'<div class="proto-status"><strong>先加入條件</strong><p>加入條件後，可以回查這組條件在過去 7 個交易日的觸發時間點。</p></div>';return;}
  const history=historyFresh();
  if(options.loading){target.innerHTML=head('<span>回查中…</span>')+'<div class="proto-status"><strong>回查中…</strong><p>第一次回查約需 1 分鐘，之後 10 分鐘內重查同一組條件會很快。</p></div>';return;}
  if(options.error){target.innerHTML=head('')+`<div class="proto-status"><strong>回查失敗</strong><p>${escapeHtml(options.error)}</p><button class="proto-secondary" id="runHistory">再試一次</button></div>`;}
  else if(!history){target.innerHTML=head('')+'<div class="proto-status"><strong>看看這組條件過去的表現</strong><p>用真實一分鐘 K、和盤中監控相同的規則（同一檔 30 分鐘內只通知一次），先看看會不會太常或太少觸發。</p><button class="proto-secondary" id="runHistory">回查過去 7 個交易日</button></div>';}
  else{
    const limit=options.all?history.events.length:30;
    const rows=history.events.slice(0,limit).map((event)=>`<div class="proto-history-row"><span><strong>${escapeHtml(event.symbol)}</strong> ${escapeHtml(event.name||'')}</span><time>${formatWhen(event.at)}</time><span>收盤 ${escapeHtml(formatPrice(event.price))}</span></div>`).join('');
    const busiest=history.days.filter((day)=>day.count).sort((a,b)=>b.count-a.count).slice(0,3).map((day)=>`${day.date.slice(5)}：${day.count} 次`).join('、');
    target.innerHTML=head(`<button class="proto-link" id="runHistory">重新回查</button>`)+`<p class="proto-signature">${escapeHtml(historySummaryText(history))}${busiest?`・最多：${escapeHtml(busiest)}`:''}</p>${history.events.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>價格</span></div>${rows}</div>${history.events.length>limit?`<button class="proto-link" id="showAllHistory">顯示全部 ${history.events.length} 筆${history.truncated?`（共 ${history.totalEvents} 筆，只列最近 ${history.events.length} 筆）`:''}</button>`:''}`:'<div class="proto-status"><strong>這段期間沒有觸發</strong><p>條件可能太嚴格，可以調整參數再回查。</p></div>'}`;
  }
  target.querySelector('#showAllHistory')?.addEventListener('click',()=>drawHistory({all:true}));
  target.querySelector('#runHistory')?.addEventListener('click',async()=>{
    const signature=historySignature();drawHistory({loading:true});
    try{const result=await withFormula(['/api/history/backtest',monitorSpec()]);state.history={signature,sources:result.sources,availableDays:result.availableDays,failedDays:result.failedDays,symbolsCount:result.symbolsCount,totalEvents:result.totalEvents,truncated:result.truncated||result.events.length>100,days:result.days,events:result.events.slice(0,100)};save();if(node()==='conditions')drawHistory();}
    catch(error){if(node()==='conditions')drawHistory({error:errorText(error)});}
  });
}
function alertInline(message){const target=root.querySelector('#aiPanel .proto-status');if(target)target.insertAdjacentHTML('beforeend',`<p class="proto-error" role="alert">${escapeHtml(message)}</p>`);}
// Formula tokens expire after 10 minutes and after a server restart; re-plan from the saved text once.
async function refreshFormulaToken(){
  const formula=state.formula;const result=await api('/api/indicator-agent/parse',{text:formula.text,context:formula.context||[]});
  if(result.status!=='formula')throw Object.assign(new Error('AI 重新解析的結果和原本不同，請回到條件頁重新設定。'),{code:null});
  formula.token=result.proposalToken;save();return formula.token;
}
async function withFormula(body){
  if(!state.formula)return api(body[0],body[1]);
  try{return await api(body[0],{...body[1],formulaToken:state.formula.token});}
  catch(error){if(!['FORMULA_PROPOSAL_STALE','FORMULA_TOKEN_INVALID'].includes(error.code))throw error;await refreshFormulaToken();return api(body[0],{...body[1],formulaToken:state.formula.token});}
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
  if(!hasConditions())return go('conditions');
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔：${state.watchlist.slice(0,8).map((item)=>`${item.symbol} ${item.name}`).join('、')}${state.watchlist.length>8?' …':''}`:'今日監控名單（有成交量的股票，每天依最新名單重新套用條件）';
  const history=historyFresh();
  shell({step:'confirm',title:'確認並建立監控',lead:'建立後會立即啟用，之後可隨時暫停。',back:'conditions',body:`<div id="replaceNotice"></div><dl class="proto-summary"><div><dt>監控範圍</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>條件</dt><dd>${state.formula?`${escapeHtml(state.formula.name)}<br><small>${escapeHtml(state.formula.summary)}</small>`:state.conditions.map((item)=>`${directionTag(item.direction)}${escapeHtml(conditionLabel(item))}`).join('<br>')}</dd></div><div><dt>條件組合</dt><dd>${state.formula?'AI 自訂條件':state.conditions.length>1?'全部同時成立才通知':'單一條件'}</dd></div><div><dt>過去 7 日</dt><dd>${history?escapeHtml(historySummaryText(history)):'尚未回查 <button class="proto-link" data-go="conditions">去回查</button>'}</dd></div></dl><details class="proto-details"><summary>監控細節</summary><p>資料：一分鐘 K・台股 09:00–13:30（Asia/Taipei）</p><p>通知：這個瀏覽器的系統通知，需保持網頁開啟</p><p>同一檔 30 分鐘內只通知一次</p></details><p id="createError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span id="createHint">建立後可隨時暫停</span><button id="createMonitor" class="proto-primary">建立並啟用監控</button></div>`});
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
      resetDraft();go('success');
    }catch(error){root.querySelector('#createError').textContent=errorText(error);button.disabled=false;button.textContent=label();}
  });
}

function success(){
  const supported='Notification' in window,permission=supported?Notification.permission:'unsupported';
  const action=permission==='default'?'<button class="proto-primary" id="notifyAndGo">開啟通知並查看監控</button>':'<button class="proto-primary" data-go="dashboard">查看我的監控</button>';
  const note=permission==='denied'?'<p class="proto-notice" role="note"><span aria-hidden="true">!</span><span>瀏覽器已封鎖通知。請點網址列左側的鎖頭圖示，把「通知」改為允許，才收得到觸發提醒。</span></p>':permission==='granted'?'<p class="proto-signature">通知已開啟。</p>':permission==='unsupported'?'<p class="proto-signature">這個瀏覽器不支援通知，觸發紀錄會顯示在「我的監控」。</p>':'<p class="proto-signature">最後一步：允許瀏覽器通知，條件成立時才會即時提醒你。</p>';
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
  const notify=permission==='granted'?'<span class="proto-note ok">通知已開啟</span>':permission==='denied'?'<span class="proto-note bad">通知被瀏覽器封鎖（網址列左側鎖頭 → 通知 → 允許）</span>':permission==='unsupported'?'<span class="proto-note">此瀏覽器不支援通知</span>':'<button id="enableNotify" class="proto-primary">開啟瀏覽器通知</button>';
  const status=PROVIDER_STATUS[runtime.lastProviderStatus]||runtime.lastProviderStatus||'—';
  const healthy=!runtime.lastError&&!['error','coverage_unknown'].includes(runtime.lastProviderStatus);
  const today=signals.filter((signal)=>isToday(signal.triggeredAt)),todaySymbols=new Set(today.map((signal)=>signal.symbol));
  const empty=session.key==='open'?'<strong>今天還沒有觸發</strong><p>盤中條件成立時會出現在這裡並通知你。</p>':`<strong>目前沒有觸發紀錄</strong><p>${escapeHtml(session.detail)}。</p>`;
  target.innerHTML=`<div class="proto-statusbar ${settings.enabled?(session.key==='open'?'live':'idle'):'paused'}" role="status"><i aria-hidden="true"></i><span><strong>${settings.enabled?(session.key==='open'?'監控中':`待命（${session.label}）`):'已暫停'}</strong>・上次檢查 <span id="lastRun">${runtime.lastRunAt?formatWhen(runtime.lastRunAt):'尚未執行'}</span>${settings.pollIntervalSeconds?`・每 ${settings.pollIntervalSeconds} 秒檢查`:''}</span></div>
    <article class="proto-monitor"><header><span><small class="proto-eyebrow">${settings.scopeMode==='universe'?'用條件找股票':'盯指定股票'}</small><strong class="proto-cond">${conditionHtml}</strong></span>${statusBadge(settings.enabled)}</header><p>${escapeHtml(monitorScopeText(settings))}${runtime.effectiveWatchlistCount!=null?`・本輪實際監控 ${runtime.effectiveWatchlistCount} 檔`:''}</p><p class="${healthy?'':'proto-error'}">資料狀態：${escapeHtml(status)}${runtime.lastError?`・${escapeHtml(errorText({code:runtime.lastError}))}`:''}</p>
    <div class="proto-notify-row">${notify}${permission==='granted'?'<span class="proto-signature">・請保持網頁開啟才收得到</span>':''}</div>
    <div class="proto-inline-actions proto-monitor-actions"><button id="toggleMonitor" class="proto-secondary">${settings.enabled?'暫停監控':'恢復監控'}</button><button id="runNow" class="proto-secondary">立即檢查一次</button><button id="newMonitor" class="proto-link">重新設定條件</button></div><div id="resetConfirm"></div></article>
    <section class="proto-history"><div class="proto-history-head"><div><p class="proto-eyebrow">觸發紀錄</p><h2>今日觸發 ${todayCount(signals,today)} 次${today.length?`・${todaySymbols.size} 檔`:''}</h2></div><span>共 ${signals.length} 筆</span></div>${signals.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>符合條件・收盤價</span></div>${signals.slice(0,30).map((signal)=>{const notification=notifications.find((item)=>item.signalId===signal.id);return`<div class="proto-history-row ${isToday(signal.triggeredAt)?'today':''}"><span><strong>${escapeHtml(signal.symbol)}</strong> ${escapeHtml(signal.name||'')}${MARKET_LABEL[signal.market]?` <small class="proto-market">${MARKET_LABEL[signal.market]}</small>`:''}</span><time datetime="${escapeHtml(signal.triggeredAt)}">${formatWhen(signal.triggeredAt)}</time><span>${escapeHtml(signal.ruleName||'')}・${escapeHtml(formatPrice(signal.price))}${notificationBadge(notification)}</span></div>`;}).join('')}</div>`:`<div class="proto-status">${empty}</div>`}</section>`;
  target.querySelector('#newMonitor').addEventListener('click',()=>{
    const box=target.querySelector('#resetConfirm');
    box.innerHTML='<div class="proto-notice" role="alert"><span aria-hidden="true">!</span><span>系統一次只跑一組監控，新設定建立後才會取代目前這組（在那之前照常監控）。<span class="proto-inline-actions"><button class="proto-link" id="resetCancel">取消</button><button class="proto-secondary" id="resetGo">開始重新設定</button></span></span></div>';
    box.querySelector('#resetGo').addEventListener('click',()=>{resetDraft();go('home');});
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
fetch('/api/version').then((response)=>response.ok?response.json():null).then((info)=>{const target=document.getElementById('appVersion');if(!info||!target)return;target.textContent=info.version;target.title=`部署時間：${formatTime(info.deployedAt)}${info.commit?`・commit ${info.commit}`:''}`;}).catch(()=>{});
drawSessionPill();setInterval(drawSessionPill,30000);
if(!location.hash)location.hash='#home';else render();
