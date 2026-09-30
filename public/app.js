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
const ERROR_TEXT={
  HISTORY_SOURCE_FAILED:'無法讀取 HF 歷史資料，請稍後再試。',HF_UNAUTHORIZED:'HF 權限不足，無法讀取資料。',HISTORY_FAILED:'回查時發生錯誤，請稍後再試。',
  FORMULA_PLAN_INVALID:'AI 這次的回覆無法轉成條件，請換個說法再試一次。',INDICATOR_AGENT_FAILED:'AI 解析失敗，請稍後再試，或改為提出需求。',INDICATOR_AGENT_TIMEOUT:'AI 回應逾時，請再試一次。',
  INDICATOR_AGENT_NOT_CONFIGURED:'AI 解析尚未設定，請改為提出需求。',INDICATOR_AGENT_INPUT_TOO_LONG:'描述太長了，請精簡到 500 字以內。',FORMULA_PROPOSAL_STALE:'AI 條件已過期，請重新解析。',FORMULA_TOKEN_INVALID:'AI 條件已失效，請重新解析。',
  FORMULA_WITH_OTHER_CONDITIONS:'AI 自訂條件目前不能與其他條件組合，請先移除。',
  retry_not_allowed:'只有送出失敗的通知可以重送。',not_found:'找不到這則通知。',
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

function initial(){return{purpose:null,selected:[],watchlist:[],conditions:[],formula:null,activeIndicator:'rsi',drafts:{},requestText:'',ai:null,history:null};}
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
  const draft=state.purpose?`<div class="proto-resume"><strong>有一份尚未完成的草案</strong><p>${state.purpose==='watchlist'?`指定股票 ${state.selected.length} 檔`:'條件選股'} · ${state.formula?'AI 自訂條件':`${state.conditions.length} 個條件`}</p><button class="proto-secondary" data-go="${state.purpose==='watchlist'&&!state.watchlist.length?'stocks':'conditions'}">繼續草案</button></div>`:'';
  shell({title:'今天想怎麼盯？',lead:'選一個目的就直接開始。建立後會用 HF 一分鐘 K 真實監控。',body:`<div class="proto-options"><button class="proto-option" data-purpose="watchlist"><span><strong>盯指定股票</strong><small>從今日系統可監控名單中搜尋並多選</small></span><span class="proto-arrow">→</span></button><button class="proto-option" data-purpose="screen"><span><strong>用條件找股票</strong><small>條件套用到每日最新系統名單，不凍結當下結果</small></span><span class="proto-arrow">→</span></button></div>${draft}<div class="proto-inline-actions" id="homeActions"></div>`});
  root.querySelectorAll('[data-purpose]').forEach((button)=>button.addEventListener('click',()=>{const purpose=button.dataset.purpose;if(purpose!==state.purpose){state.purpose=purpose;state.watchlist=[];}save();go(purpose==='watchlist'?'stocks':'conditions');}));
  try{const data=await api('/api/state');if(node()==='home'&&data.settings?.monitorTask?.onboardingCompleted){const actions=root.querySelector('#homeActions');actions.innerHTML=`<button class="proto-secondary" data-go="dashboard">我的監控${data.settings.enabled?'（運作中）':'（已暫停）'}</button>`;actions.querySelector('button').addEventListener('click',()=>go('dashboard'));}}catch{}
}

function stocks(){
  shell({step:'stocks',title:'選擇今天要盯的股票',lead:'名單來自 HF 每日最新系統名單。可用類股快速篩選，按住拖曳可以一次圈選一整塊。',back:'home',body:`<label class="proto-search"><input id="stockSearch" type="search" placeholder="搜尋代號或名稱" aria-label="搜尋股票"></label><div class="proto-groups" id="groupChips" role="group" aria-label="類股"></div><div class="proto-list-tools"><p id="universeInfo" class="proto-signature">讀取名單中…</p><span><button class="proto-link" id="selectShown" hidden></button><button class="proto-link" id="clearSelected" hidden>清除已選</button></span></div><div class="proto-stock-list" id="stockList"></div><p class="proto-hint">小技巧：按住一檔拖到另一檔，會圈選兩者之間的整個方框（從未勾選的開始＝全勾，從已勾選的開始＝全取消）；手機請長按後再拖。桌機可用 Shift＋點擊選一整段。</p><p id="stockError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span id="stockCount"></span><button id="stocksDone" class="proto-primary">選好了</button></div>`});
  const list=root.querySelector('#stockList'),search=root.querySelector('#stockSearch'),done=root.querySelector('#stocksDone'),chips=root.querySelector('#groupChips'),selectShown=root.querySelector('#selectShown'),clearSelected=root.querySelector('#clearSelected');
  let shown=[],activeGroup=state.stockGroup||'',showAllGroups=false,groups=[],lastIndex=null;
  const isSelected=(symbol)=>state.selected.some((item)=>item.symbol===symbol);
  const syncCount=()=>{
    root.querySelector('#stockCount').textContent=`已選 ${state.selected.length} 檔`;done.disabled=!state.selected.length;
    clearSelected.hidden=!state.selected.length;
    const unselected=shown.filter((item)=>!isSelected(item.symbol)).length;
    selectShown.hidden=!shown.length||(!activeGroup&&!search.value.trim());
    selectShown.textContent=unselected?`全選這 ${shown.length} 檔`:`取消這 ${shown.length} 檔`;
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
      root.querySelector('#universeInfo').textContent=`系統名單 ${data.total} 檔・更新於 ${data.updatedDate}${activeGroup||query?`・符合 ${data.filteredTotal} 檔`:''}${data.filteredTotal>data.items.length?`（顯示前 ${data.items.length} 檔，可選類股或搜尋縮小範圍）`:''}`;
      list.innerHTML=shown.length?shown.map((item,index)=>`<label class="proto-stock" data-index="${index}"><input type="checkbox" value="${escapeHtml(item.symbol)}" ${isSelected(item.symbol)?'checked':''}><span><strong>${escapeHtml(item.symbol)} ${escapeHtml(item.name||'')}</strong>${item.group&&!activeGroup?`<small>${escapeHtml(item.group)}</small>`:''}</span></label>`).join(''):'<div class="proto-status"><strong>今日系統名單找不到</strong><p>請改用其他代號、名稱或類股。</p></div>';
      syncCount();
    }catch(error){if(id!==requestId)return;root.querySelector('#universeInfo').textContent='';list.innerHTML=`<div class="proto-status"><strong>無法讀取系統名單</strong><p>${escapeHtml(errorText(error))}</p></div>`;}
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
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'每日最新系統名單';
  shell({step:'conditions',title:'設定監控條件',lead:`範圍：${scope}。條件以一分鐘 K 收盤判斷；最多組合 2 個條件，需全部同時成立才觸發。`,back:state.purpose==='watchlist'?'stocks':'home',body:`<label class="proto-search"><input id="indicatorSearch" type="search" placeholder="搜尋 RSI、SMA、EMA，或直接描述條件交給 AI" aria-label="搜尋指標" value="${escapeHtml(state.requestText)}"></label><div class="proto-library proto-inline-library" id="indicatorResults"></div><section id="aiPanel"></section><section class="proto-condition-editor"><p class="proto-eyebrow">目前參數</p><h2>${escapeHtml(item.name)}</h2><p class="proto-signature">${escapeHtml(item.desc)}</p><div class="proto-form"><label>方向<select id="direction">${item.directions.map((value)=>`<option value="${value}" ${draft.direction===value?'selected':''}>${DIRECTION_LABEL[value]}</option>`).join('')}</select></label><label>期數<input id="period" type="number" min="2" max="${item.periodMax}" value="${escapeHtml(draft.period)}"></label>${item.threshold?`<label>門檻<input id="threshold" type="number" min="1" max="99" value="${escapeHtml(draft.threshold)}"></label>`:''}<p id="paramError" class="proto-error" role="alert"></p></div><button id="addCondition" class="proto-secondary">加入這個條件</button></section>${conditionMarkup()}<section class="proto-history" id="historyPanel"></section><div class="proto-sticky-action"><span>${state.formula?'AI 自訂條件':`${state.conditions.length} 個條件`}</span><button id="confirmConditions" class="proto-primary" ${hasConditions()?'':'disabled'}>確認設定</button></div>`});
  bindConditionList();
  const search=root.querySelector('#indicatorSearch'),results=root.querySelector('#indicatorResults');
  const drawSearch=()=>{const value=search.value.trim(),needle=value.toLowerCase();state.requestText=value;save();const matches=INDICATORS.filter((entry)=>!needle||`${entry.id} ${entry.name} ${entry.desc}`.toLowerCase().includes(needle));results.innerHTML=matches.length?matches.map((entry)=>`<button class="proto-indicator-pill ${entry.id===item.id?'active':''}" data-indicator="${entry.id}"><strong>${escapeHtml(entry.name)}</strong><small>已有指標</small></button>`).join(''):`<div class="proto-status"><strong>已有指標找不到「${escapeHtml(value)}」</strong><p>可以交給 AI 解析成監控條件，或提出新指標需求。</p><div class="proto-inline-actions"><button id="aiParse" class="proto-primary">用 AI 解析</button><button id="requestNew" class="proto-secondary">提出需求</button></div></div>`;results.querySelectorAll('[data-indicator]').forEach((button)=>button.addEventListener('click',()=>{state.activeIndicator=button.dataset.indicator;state.requestText='';save();render();}));results.querySelector('#requestNew')?.addEventListener('click',()=>go('request'));results.querySelector('#aiParse')?.addEventListener('click',()=>{state.ai={text:value,context:[],result:null};save();runAi();});};
  search.addEventListener('input',drawSearch);drawSearch();drawAi();drawHistory();
  const capture=()=>{state.drafts[item.id]={direction:root.querySelector('#direction').value,period:root.querySelector('#period').value,threshold:root.querySelector('#threshold')?.value??null};save();};
  root.querySelectorAll('#direction,#period,#threshold').forEach((input)=>input.addEventListener('input',()=>{capture();root.querySelector('#paramError').textContent='';}));
  root.querySelector('#addCondition').addEventListener('click',()=>{
    capture();
    const values=state.drafts[item.id],period=Number(values.period),threshold=item.threshold?Number(values.threshold):null,hasRsi=state.conditions.some((entry)=>entry.indicator==='rsi');
    const error=!Number.isInteger(period)||period<2||period>item.periodMax?`期數需為 2–${item.periodMax} 的整數。`:item.threshold&&(!values.threshold||!Number.isFinite(threshold)||threshold<1||threshold>99)?'門檻需介於 1–99。':state.formula?ERROR_TEXT.FORMULA_WITH_OTHER_CONDITIONS:state.conditions.length>=2?'目前最多只能組合 2 個條件。':state.conditions.length&&(hasRsi||item.id==='rsi')?'RSI 目前不能與其他條件組合，請單獨使用。':'';
    if(error){root.querySelector('#paramError').textContent=error;return;}
    state.conditions.push({id:crypto.randomUUID(),indicator:item.id,direction:values.direction,period,threshold});state.history=null;save();render();
  });
  root.querySelector('#confirmConditions').addEventListener('click',()=>go('confirm'));
}
function conditionLabel(condition){const item=INDICATORS.find((entry)=>entry.id===condition.indicator);return`${item?.name||condition.indicator} ${condition.period} ${DIRECTION_LABEL[condition.direction]}${condition.threshold===null?'':` ${condition.threshold}`}`;}
function monitorSpec(){const spec={purpose:state.purpose,watchlist:state.purpose==='watchlist'?state.watchlist:undefined};if(!state.formula)spec.conditions=state.conditions.map(({indicator,direction,period,threshold})=>({indicator,direction,period,threshold}));return spec;}
function hasConditions(){return Boolean(state.formula)||state.conditions.length>0;}
function scopeText(){return state.purpose==='watchlist'?`${state.watchlist.length} 檔指定股票`:'每日最新系統名單';}
function conditionMarkup(){if(state.formula)return`<div class="proto-condition-list"><p class="proto-eyebrow">AI 自訂條件</p><div class="proto-condition"><strong>${escapeHtml(state.formula.name)}</strong><span><button aria-label="移除 ${escapeHtml(state.formula.name)}" data-remove="formula">移除</button></span></div><p class="proto-signature">${escapeHtml(state.formula.summary)}</p></div>`;return state.conditions.length?`<div class="proto-condition-list"><p class="proto-eyebrow">已加入的條件（全部成立才觸發）</p>${state.conditions.map((condition)=>`<div class="proto-condition"><strong>${escapeHtml(conditionLabel(condition))}</strong><span><button aria-label="移除 ${escapeHtml(conditionLabel(condition))}" data-remove="${condition.id}">移除</button></span></div>`).join('')}</div>`:'';}
function bindConditionList(){root.querySelectorAll('[data-remove]').forEach((button)=>button.addEventListener('click',()=>{if(button.dataset.remove==='formula')state.formula=null;else state.conditions=state.conditions.filter((item)=>item.id!==button.dataset.remove);state.history=null;save();render();}));}

// AI parsing: /api/indicator-agent/parse returns existing (registry indicator), formula (signed proposal),
// clarification (needs a reply, sent back with the conversation as context) or discussion (not computable).
async function runAi(){
  const ai=state.ai;if(!ai)return;
  ai.loading=true;ai.error=null;drawAi();
  try{const result=await api('/api/indicator-agent/parse',{text:ai.text,context:ai.context});if(state.ai!==ai)return;ai.result=result;}
  catch(error){if(state.ai!==ai)return;ai.result=null;ai.error=errorText(error);}
  ai.loading=false;save();drawAi();
}
function registryCondition(proposal){
  if(proposal?.id==='rsi.cross')return{indicator:'rsi',direction:'above',period:proposal.params.period,threshold:proposal.params.threshold};
  if(proposal?.id==='sma.cross')return{indicator:'sma',direction:'above',period:proposal.params.period,threshold:null};
  return null;
}
function drawAi(){
  const target=root.querySelector('#aiPanel');if(!target)return;
  const ai=state.ai;if(!ai){target.innerHTML='';return;}
  const head=`<div class="proto-history-head"><div><p class="proto-eyebrow">AI 解析</p><h2>${escapeHtml(ai.text)}</h2></div><button class="proto-link" id="aiClose">關閉</button></div>`;
  let body;
  if(ai.loading)body='<div class="proto-status"><strong>AI 解析中…</strong><p>通常需要幾秒鐘。</p></div>';
  else if(ai.error)body=`<div class="proto-status"><strong>解析失敗</strong><p>${escapeHtml(ai.error)}</p><div class="proto-inline-actions"><button class="proto-secondary" id="aiRetry">再試一次</button><button class="proto-secondary" id="aiRequest">改為提出需求</button></div></div>`;
  else{
    const result=ai.result||{};
    if(result.status==='existing'){const condition=registryCondition(result.proposal);body=condition?`<div class="proto-status"><strong>對應到已有指標：${escapeHtml(result.summary)}</strong><p>加入後可以和其他條件一起使用。</p><button class="proto-primary" id="aiUseExisting">加入這個條件</button></div>`:`<div class="proto-status"><strong>${escapeHtml(result.summary)}</strong><p>這個指標目前不能從這裡建立。</p><button class="proto-secondary" id="aiRequest">改為提出需求</button></div>`;}
    else if(result.status==='formula')body=`<div class="proto-status"><strong>${escapeHtml(result.summary)}</strong><p>計算方式：${escapeHtml(result.formulaSummary)}</p><p class="proto-signature">AI 自訂條件會單獨使用，會取代目前已加入的條件。</p><button class="proto-primary" id="aiUseFormula">使用這個條件</button></div>`;
    else if(result.status==='clarification')body=`<div class="proto-status"><strong>AI 需要多一點資訊</strong><p>${escapeHtml(result.message)}</p><label class="proto-search"><input id="aiReply" type="text" placeholder="回答上面的問題" aria-label="回答 AI"></label><button class="proto-primary" id="aiSendReply">送出</button></div>`;
    else body=`<div class="proto-status"><strong>目前無法直接計算</strong><p>${escapeHtml(result.message||'這個條件超出目前可計算的範圍。')}</p><button class="proto-secondary" id="aiRequest">改為提出需求</button></div>`;
  }
  target.className='proto-condition-editor';target.innerHTML=head+body;
  target.querySelector('#aiClose').addEventListener('click',()=>{state.ai=null;save();drawAi();});
  target.querySelector('#aiRetry')?.addEventListener('click',runAi);
  target.querySelector('#aiRequest')?.addEventListener('click',()=>{state.requestText=ai.text;state.ai=null;save();go('request');});
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
  const head=(right)=>`<div class="proto-history-head"><div><p class="proto-eyebrow">過去 7 個交易日</p><h2>M1 歷史觸發時間點</h2></div>${right}</div>`;
  if(!hasConditions()){target.innerHTML=head('')+'<div class="proto-status"><strong>先加入條件</strong><p>加入條件後，可以回查這組條件在過去 7 個交易日的觸發時間點。</p></div>';return;}
  const history=historyFresh();
  if(options.loading){target.innerHTML=head('<span>回查中…</span>')+'<div class="proto-status"><strong>回查中…</strong><p>第一次需要下載近兩個月的一分鐘資料（每月約 40MB），可能要 1 分鐘左右；10 分鐘內重查同一組條件會直接用快取。</p></div>';return;}
  if(options.error){target.innerHTML=head('')+`<div class="proto-status"><strong>回查失敗</strong><p>${escapeHtml(options.error)}</p><button class="proto-secondary" id="runHistory">再試一次</button></div>`;}
  else if(!history){target.innerHTML=head('')+'<div class="proto-status"><strong>看看這組條件過去的表現</strong><p>用真實 HF 一分鐘 K，套用和盤中監控相同的規則（每檔每天 30 分鐘冷卻）。</p><button class="proto-secondary" id="runHistory">回查過去 7 個交易日</button></div>';}
  else{
    const limit=options.all?history.events.length:30;
    const rows=history.events.slice(0,limit).map((event)=>`<div class="proto-history-row"><span><strong>${escapeHtml(event.symbol)}</strong> ${escapeHtml(event.name||'')}</span><time>${formatTime(event.at)}</time><span>收盤 ${escapeHtml(formatPrice(event.price))}</span></div>`).join('');
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

function confirm(){
  if(!hasConditions())return go('conditions');
  const scope=state.purpose==='watchlist'?`${state.watchlist.length} 檔：${state.watchlist.slice(0,8).map((item)=>`${item.symbol} ${item.name}`).join('、')}${state.watchlist.length>8?' …':''}`:'每日最新系統名單（每輪重新套用，不凍結結果）';
  shell({step:'confirm',title:'確認並建立監控',lead:'建立後會立即啟用，並取代目前正在運作的監控（系統一次只跑一組監控）。',back:'conditions',body:`<dl class="proto-summary"><div><dt>監控範圍</dt><dd>${escapeHtml(scope)}</dd></div><div><dt>條件</dt><dd>${state.formula?`${escapeHtml(state.formula.name)}<br><small>${escapeHtml(state.formula.summary)}</small>`:state.conditions.map((item)=>escapeHtml(conditionLabel(item))).join('；')}</dd></div><div><dt>條件組合</dt><dd>${state.formula?'AI 自訂條件':state.conditions.length>1?'全部同時成立':'單一條件'}</dd></div><div><dt>7 日回查</dt><dd>${historyFresh()?escapeHtml(historySummaryText(historyFresh())):'尚未回查（可返回條件頁回查）'}</dd></div><div><dt>資料</dt><dd>HF 一分鐘 K・台股 09:00–13:30</dd></div><div><dt>通知</dt><dd>本機瀏覽器通知</dd></div></dl><p id="createError" class="proto-error" role="alert"></p><div class="proto-sticky-action"><span>建立後可隨時暫停</span><button id="createMonitor" class="proto-primary">建立並啟用監控</button></div>`});
  root.querySelector('#createMonitor').addEventListener('click',async(event)=>{
    const button=event.currentTarget;button.disabled=true;button.textContent='建立中…';
    try{
      await withFormula(['/api/monitor/configure',monitorSpec()]);
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
    <section class="proto-history"><div class="proto-history-head"><div><p class="proto-eyebrow">最近觸發</p><h2>觸發紀錄</h2></div><span>${signals.length} 筆</span></div>${signals.length?`<div class="proto-history-table"><div class="proto-history-row header"><span>股票</span><span>時間</span><span>條件・價格</span></div>${signals.slice(0,30).map((signal)=>{const notification=notifications.find((item)=>item.signalId===signal.id);return`<div class="proto-history-row"><span><strong>${escapeHtml(signal.symbol)}</strong> ${escapeHtml(signal.name||'')}</span><time>${formatTime(signal.triggeredAt)}</time><span>${escapeHtml(signal.ruleName||'')}・${escapeHtml(formatPrice(signal.price))}${notificationBadge(notification)}</span></div>`;}).join('')}</div>`:'<div class="proto-status"><strong>目前沒有觸發紀錄</strong><p>盤中條件成立時會出現在這裡。</p></div>'}</section>`;
  target.querySelector('#newMonitor').addEventListener('click',()=>{resetDraft();go('home');});
  target.querySelector('#toggleMonitor').addEventListener('click',async(event)=>{event.currentTarget.disabled=true;try{drawDashboard(await api(settings.enabled?'/api/monitor/stop':'/api/monitor/start',{}));}catch(error){alertStatus(error);}});
  target.querySelector('#runNow').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='檢查中…';try{const result=await api('/api/monitor/run',{});drawDashboard(result.state||data);}catch(error){alertStatus(error);}});
  target.querySelector('#enableNotify')?.addEventListener('click',async()=>{await Notification.requestPermission();drawDashboard(data);});
  target.querySelectorAll('[data-retry]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;button.textContent='重送中…';try{const result=await api(`/api/notifications/${encodeURIComponent(button.dataset.retry)}/retry`,{});if(!result.retried)throw Object.assign(new Error('這則通知目前不能重送。'),{code:result.reason});seenNotifications.delete(button.dataset.retry);const fresh=await api('/api/state');drawDashboard(fresh);await deliverNotifications(fresh.notifications||[]);drawDashboard(await api('/api/state'));}catch(error){alertStatus(error);button.disabled=false;button.textContent='重送';}}));
}
function alertStatus(error){const target=root.querySelector('#dashboard');target?.insertAdjacentHTML('afterbegin',`<p class="proto-error" role="alert">${escapeHtml(errorText(error))}</p>`);}

// Same validate → show → ack handshake as public/app.js: the server decides whether a pending notification may still be delivered.
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
function formatTime(value){return new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false});}
function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
fetch('/api/version').then((response)=>response.ok?response.json():null).then((info)=>{const target=document.getElementById('appVersion');if(!info||!target)return;target.textContent=info.version;target.title=`部署時間：${formatTime(info.deployedAt)}${info.commit?`・commit ${info.commit}`:''}`;}).catch(()=>{});
if(!location.hash)location.hash='#home';else render();
