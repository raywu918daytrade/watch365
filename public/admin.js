// 後台 (/admin): usage overview, unknown-indicator research list, parse log, visitors, formula library
// management and a generic event query. Talks to /api/admin/*; a 401 anywhere returns to the login screen.
const root=document.querySelector('#admin');
const tools=document.querySelector('#adminTools'),periodSelect=document.querySelector('#periodSelect'),refreshButton=document.querySelector('#refreshButton');
const EVENT_TYPES=['page_view','parse','template_instantiate','monitor_configure','backtest','vet_blocked','unknown_indicator','indicator_request'];
const EVENT_LABEL={page_view:'頁面瀏覽',parse:'AI 解析',template_instantiate:'加入過濾',monitor_configure:'建立監控',backtest:'回查',vet_blocked:'驗證未通過',unknown_indicator:'查無指標',indicator_request:'提出需求'};
const PARSE_STATUS_LABEL={formula:'公式',existing:'內建指標',clarification:'需確認',discussion:'不可計算',unknown_indicator:'查無指標',error:'錯誤',unsupported:'不支援'};
const MEMBER_STATUS={active:'啟用',pending_review:'待審核',disabled:'停用'};
const SOURCE_LABEL={ai:'AI 建立',preset:'內建',seed:'內建',builtin:'內建',manual:'手動'};
const VERDICT_LABEL={ok:'通過',no_triggers:'沒有觸發',too_many:'太頻繁',no_data:'沒有資料'};
let days=Number(localStorage.getItem('watch365_admin_days'))||7;
periodSelect.value=String(days);
let loadToken=0;

async function api(url,body){
  const response=await fetch(url,body===undefined?{credentials:'same-origin'}:{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw Object.assign(new Error(payload.error||`HTTP ${response.status}`),{code:payload.error,status:response.status,payload});
  return payload;
}
function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
function showToast(text,bad=false){document.querySelectorAll('.adm-toast').forEach((node)=>node.remove());const toast=document.createElement('div');toast.className=`adm-toast ${bad?'bad':''}`;toast.setAttribute('role','status');toast.textContent=text;document.body.appendChild(toast);setTimeout(()=>toast.remove(),3500);}
function errorText(error){
  if(error?.code==='ADMIN_UNAUTHORIZED')return'登入已失效，請重新登入。';
  if(error?.code==='ADMIN_DISABLED')return'後台尚未設定 ADMIN_TOKEN。';
  if(error?.code==='ADMIN_LOGIN_FAILED'||error?.status===401)return'管理密碼不正確。';
  if(/^HTTP 5\d\d$/.test(error?.message||''))return'伺服器暫時沒有回應，請稍後再試。';
  return error?.message||'發生錯誤，請稍後再試。';
}
// Every section calls this on failure: auth problems reset the whole page, anything else stays local.
function authFailure(error){if(error?.status===401||error?.code==='ADMIN_UNAUTHORIZED'){showLogin('登入已失效，請重新登入。');return true;}if(error?.status===503||error?.code==='ADMIN_DISABLED'){showDisabled();return true;}return false;}
const fmt=new Intl.NumberFormat('zh-TW');
function num(value){const number=Number(value);return Number.isFinite(number)?fmt.format(number):'—';}
function formatTime(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}
function formatDate(value){if(!value)return'—';const date=new Date(value);return Number.isNaN(date.getTime())?String(value):date.toLocaleDateString('zh-TW',{timeZone:'Asia/Taipei',month:'numeric',day:'numeric'});}
function shortId(value){return String(value||'').slice(0,8)||'—';}
function dayLabel(day){return String(day||'').slice(5).replace('-','/');}
function sumCounts(rows){return (rows||[]).reduce((total,row)=>total+(Number(row.count)||0),0);}

// ---- Login / disabled ----
function showLogin(message=''){
  loadToken++;tools.hidden=true;
  root.innerHTML=`<form class="adm-login" id="loginForm"><h1>後台登入</h1><p>這個頁面只給團隊使用。</p><label>管理密碼<input id="adminToken" type="password" autocomplete="current-password" required></label><p class="adm-error" id="loginError" role="alert">${escapeHtml(message)}</p><button type="submit" class="adm-primary" id="loginButton">登入</button></form>`;
  const form=root.querySelector('#loginForm'),input=root.querySelector('#adminToken'),button=root.querySelector('#loginButton'),error=root.querySelector('#loginError');
  input.focus();
  form.addEventListener('submit',async(event)=>{
    event.preventDefault();const token=input.value.trim();if(!token)return;
    button.disabled=true;button.textContent='登入中…';error.textContent='';
    try{await api('/api/admin/login',{token});showDashboard();}
    catch(err){if(err.status===503||err.code==='ADMIN_DISABLED')return showDisabled();error.textContent=err.status===401?'管理密碼不正確。':errorText(err);button.disabled=false;button.textContent='登入';input.select();}
  });
}
function showDisabled(){loadToken++;tools.hidden=true;root.innerHTML='<div class="adm-login disabled"><h1>後台尚未設定</h1><p>後台尚未設定 ADMIN_TOKEN。請在伺服器環境變數設定後重新整理這一頁。</p></div>';}

// ---- Dashboard ----
function card({id,title,lead,wide=false,highlight=false,meta=''}){return`<section class="adm-card ${wide?'wide':''} ${highlight?'highlight':''}" id="${id}" aria-labelledby="${id}Title"><div class="adm-card-head"><div><h2 id="${id}Title">${escapeHtml(title)}</h2>${lead?`<p>${escapeHtml(lead)}</p>`:''}</div><span id="${id}Meta">${meta}</span></div><div class="adm-card-body" id="${id}Body"><div class="adm-skeleton" aria-hidden="true"></div></div></section>`;}
function body(id){return root.querySelector(`#${id}Body`);}
function meta(id,text){const target=root.querySelector(`#${id}Meta`);if(target)target.textContent=text;}
function fail(id,error){const target=body(id);if(target)target.innerHTML=`<div class="adm-empty">無法讀取：${escapeHtml(errorText(error))} <button type="button" class="adm-link" data-retry="${id}">再試一次</button></div>`;target?.querySelector('[data-retry]')?.addEventListener('click',()=>SECTION_LOADERS[id]?.(loadToken));}
function showDashboard(){
  tools.hidden=false;
  root.innerHTML=`<div class="adm-grid">${card({id:'overview',title:'總覽',lead:'訪客、頁面瀏覽、AI 解析與建立監控的數量，以及每日趨勢。',wide:true})}${card({id:'unknown',title:'查無指標',lead:'使用者找過、但 AI 查不到公開定義的指標名稱。研究要不要納入清單的依據。',wide:true,highlight:true})}${card({id:'conditions',title:'監控狀態機（影子模式）',lead:'上：每條規則對每檔股票的狀態（待命／已觸發／冷卻），與現行通知數比較。下：所有使用者共用的條件，每個條件對每檔股票只算一次。目前只記錄、不發通知。',wide:true})}${card({id:'top',title:'指標使用排行',lead:'期間內被加入過濾最多次的指標，前 20。'})}${card({id:'parses',title:'AI 解析',lead:'依狀態與 provider 的計數，與最近 50 筆解析。'})}${card({id:'visitors',title:'訪客',lead:'點一列展開該訪客的最近事件。',wide:true})}${card({id:'library',title:'公式庫管理',lead:'指標模板與成員。切換成員狀態會立即生效。',wide:true})}${card({id:'events',title:'事件查詢',lead:'依類型、訪客與日期範圍查詢原始事件。',wide:true})}</div>`;
  loadAll();
}
function loadAll(){const token=++loadToken;for(const loader of Object.values(SECTION_LOADERS))loader(token);}
function stale(token){return token!==loadToken;}

// 1. 總覽
async function loadOverview(token){
  const target=body('overview');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  try{
    const data=await api(`/api/admin/overview?days=${days}`);if(stale(token))return;
    const visitors=data.visitors||{},parses=data.parses||{},monitors=data.monitors||{},library=data.library||{};
    const pageViews=sumCounts(data.pageViews),configured=sumCounts(monitors.configured);
    const current=monitors.current;
    const monitorLine=current&&(current.strategyName||current.symbols!=null)?`<p class="adm-monitor-line"><span class="adm-badge ${current.enabled?'on':''}">${current.enabled?'監控中':'已暫停'}</span><strong>${escapeHtml(current.strategyName||'—')}</strong><span class="adm-muted">${current.symbols!=null?`${num(current.symbols)} 檔`:''}${current.lastRunAt?`・上次檢查 ${escapeHtml(formatTime(current.lastRunAt))}`:''}</span></p>`:'<p class="adm-monitor-line adm-muted">目前沒有設定中的監控。</p>';
    target.innerHTML=`<div class="adm-stats"><div class="adm-stat"><strong>${num(visitors.total)}</strong><span>訪客數</span></div><div class="adm-stat"><strong>${num(pageViews)}</strong><span>頁面瀏覽</span></div><div class="adm-stat"><strong>${num(parses.total)}</strong><span>AI 解析次數</span></div><div class="adm-stat"><strong>${num(configured)}</strong><span>建立監控次數</span></div></div><div class="adm-charts">${barChart('每日活躍訪客',visitors.active)}${barChart('每日建立監控',monitors.configured)}</div>${monitorLine}<p class="adm-muted" style="margin:.6rem 0 0">公式庫：${num(library.formulas)} 條公式・啟用 ${num(library.active)}・待審核 ${num(library.pending)}・別名 ${num(library.aliases)}</p>`;
    meta('overview',`最近 ${days} 天`);
    drawTop(data.topIndicators||[]);
    drawParseCounts(parses);
  }catch(error){if(stale(token))return;if(authFailure(error))return;fail('overview',error);body('top')&&fail('top',error);}
}
function barChart(title,rows){
  const series=(rows||[]).slice(-days);
  if(!series.length)return`<div class="adm-chart"><div class="adm-chart-head"><span>${escapeHtml(title)}</span></div><div class="adm-empty">沒有資料</div></div>`;
  const max=Math.max(1,...series.map((row)=>Number(row.count)||0)),total=sumCounts(series);
  const bars=series.map((row)=>{const count=Number(row.count)||0;const height=Math.max(count?4:2,Math.round(count/max*100));return`<span class="adm-bar ${count?'':'zero'}" title="${escapeHtml(row.day)}：${count}" role="img" aria-label="${escapeHtml(row.day)} ${count}"><i style="height:${height}%"></i></span>`;}).join('');
  return`<div class="adm-chart"><div class="adm-chart-head"><span>${escapeHtml(title)}</span><small>合計 ${num(total)}・最高 ${num(max)}</small></div><div class="adm-bars">${bars}</div><div class="adm-bar-labels"><span>${escapeHtml(dayLabel(series[0].day))}</span><span>${escapeHtml(dayLabel(series[series.length-1].day))}</span></div></div>`;
}
// 2. 指標使用排行 (from overview)
function drawTop(rows){
  const target=body('top');if(!target)return;
  const items=rows.slice(0,20);meta('top',`最近 ${days} 天`);
  if(!items.length){target.innerHTML='<div class="adm-empty">期間內還沒有加入過濾的紀錄。</div>';return;}
  target.innerHTML=`<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>#</th><th>指標</th><th class="adm-num">次數</th></tr></thead><tbody>${items.map((row,index)=>`<tr><td class="adm-num">${index+1}</td><td class="wrap">${escapeHtml(row.label)}</td><td class="adm-num">${num(row.count)}</td></tr>`).join('')}</tbody></table></div>`;
}
// 4. AI 解析: counts (from overview) + recent 50 (events?type=parse)
function drawParseCounts(parses){
  const target=body('parses');if(!target)return;
  const table=(title,rows,label)=>`<div><p class="adm-sub">${title}</p>${rows?.length?`<div class="adm-table-wrap"><table class="adm-table"><tbody>${rows.map((row)=>`<tr><td>${escapeHtml(label(row.key))}</td><td class="adm-num">${num(row.count)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="adm-empty">沒有資料</div>'}</div>`;
  target.innerHTML=`<div class="adm-two">${table('依狀態',parses.byStatus,(key)=>PARSE_STATUS_LABEL[key]||key||'—')}${table('依 provider',parses.byProvider,(key)=>key||'—')}</div><p class="adm-sub">最近 50 筆</p><div id="recentParses"><div class="adm-skeleton" aria-hidden="true"></div></div>`;
  meta('parses',`共 ${num(parses.total)} 次`);
}
async function loadRecentParses(token){
  const wait=()=>new Promise((resolve)=>setTimeout(resolve,50));
  // The container is drawn by loadOverview; wait for it (bounded) before filling.
  for(let i=0;i<100&&!root.querySelector('#recentParses');i++){await wait();if(stale(token))return;}
  const target=root.querySelector('#recentParses');if(!target)return;
  try{
    const data=await api('/api/admin/events?type=parse&limit=50');if(stale(token))return;
    const items=data.items||[];
    if(!items.length){target.innerHTML='<div class="adm-empty">還沒有解析紀錄。</div>';return;}
    target.innerHTML=`<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>時間</th><th>文字</th><th>狀態</th><th>provider</th><th class="adm-num">耗時</th></tr></thead><tbody>${items.map((item)=>{const payload=item.payload||{};const ms=payload.durationMs??payload.elapsedMs??payload.ms;return`<tr><td><small>${escapeHtml(formatTime(item.ts))}</small></td><td class="wrap">${escapeHtml(payload.text||payload.request||'—')}</td><td>${escapeHtml(PARSE_STATUS_LABEL[payload.status]||payload.status||'—')}</td><td>${escapeHtml(payload.provider||'—')}</td><td class="adm-num">${ms!=null?`${num(Math.round(ms/100)/10)} 秒`:'—'}</td></tr>`;}).join('')}</tbody></table></div>`;
  }catch(error){if(stale(token))return;if(authFailure(error))return;target.innerHTML=`<div class="adm-empty">無法讀取：${escapeHtml(errorText(error))}</div>`;}
}
// 3. 查無指標
let unknownSort='count';
async function loadUnknown(token){
  const target=body('unknown');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  try{
    const data=await api('/api/admin/unknown-indicators?limit=200');if(stale(token))return;
    const items=data.items||[];meta('unknown',`${num(items.length)} 個名稱`);
    const draw=()=>{
      const rows=[...items].sort((a,b)=>unknownSort==='count'?(Number(b.count)||0)-(Number(a.count)||0):String(b.lastSeen||'').localeCompare(String(a.lastSeen||'')));
      if(!rows.length){target.innerHTML='<div class="adm-empty">目前沒有查無指標的紀錄。</div>';return;}
      const sortButton=(key,label)=>`<button type="button" data-sort="${key}" aria-sort="${unknownSort===key?'descending':'none'}">${label}</button>`;
      target.innerHTML=`<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>文字</th><th>候選關鍵字</th><th class="adm-num">${sortButton('count','次數')}</th><th>首次</th><th>${sortButton('lastSeen','最後出現')}</th></tr></thead><tbody>${rows.map((row)=>`<tr><td class="wrap"><strong>${escapeHtml(row.text||row.norm)}</strong>${row.norm&&row.norm!==row.text?`<br><small class="adm-mono">${escapeHtml(row.norm)}</small>`:''}</td><td><div class="adm-chips">${(row.candidates||[]).slice(0,8).map((item)=>`<span class="adm-chip">${escapeHtml(item)}</span>`).join('')||'<small>—</small>'}</div></td><td class="adm-num">${num(row.count)}</td><td><small>${escapeHtml(formatDate(row.firstSeen))}</small></td><td><small>${escapeHtml(formatTime(row.lastSeen))}</small></td></tr>`).join('')}</tbody></table></div>`;
      target.querySelectorAll('[data-sort]').forEach((button)=>button.addEventListener('click',()=>{unknownSort=button.dataset.sort;draw();}));
    };
    draw();
  }catch(error){if(stale(token))return;if(authFailure(error))return;fail('unknown',error);}
}
// 條件狀態（共用條件層，影子模式）
async function loadConditions(token){
  const target=body('conditions');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  try{
    const data=await api('/api/admin/conditions?flips=50');if(stale(token))return;
    const run=data.lastRun,items=data.conditions||[],flips=data.recentFlips||[];
    meta('conditions',data.mode==='off'?'已停用':run?`上次計算 ${formatTime(run.at)}・${num(run.ms)} ms`:'尚未執行');
    if(data.mode==='off'){target.innerHTML='<div class="adm-empty">條件層已停用（CONDITION_LAYER=off）。</div>';return;}
    const kind=(value)=>value==='event'?'事件（穿越，只亮一根）':'狀態（成立期間持續為真）';
    const runLine=run?`<p class="adm-muted" style="margin:0 0 .6rem">上次計算：${num(run.symbols)} 檔 × ${num(run.conditions)} 個條件・新 K 棒 ${num(run.newBars)}・翻轉 ${num(run.flips)}・基準建立 ${num(run.baselines)}${run.errors?`・錯誤 ${num(run.errors)}`:''}</p>`:'';
    const table=items.length?`<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>條件</th><th>類型</th><th class="adm-num">引用規則</th><th class="adm-num">股票數</th><th class="adm-num">目前成立</th><th class="adm-num">今日翻轉</th></tr></thead><tbody>${items.map((row)=>`<tr><td class="wrap">${escapeHtml(row.label||'—')}<br><small class="adm-mono">${escapeHtml(String(row.key).slice(0,12))}</small></td><td><small>${kind(row.kind)}</small></td><td class="adm-num">${num(row.rules)}</td><td class="adm-num">${num(row.symbols)}</td><td class="adm-num">${num(row.trueNow)}</td><td class="adm-num">${num(row.flipsToday)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="adm-empty">目前沒有啟用中的條件（監控未啟動，或使用舊版突破量能規則）。</div>';
    const flipTable=flips.length?`<p class="adm-sub">最近翻轉</p><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>K 棒</th><th>股票</th><th>條件</th><th>變化</th></tr></thead><tbody>${flips.map((flip)=>`<tr><td><small>${escapeHtml(formatTime(flip.barEnd))}</small></td><td>${escapeHtml(flip.symbol)}</td><td class="wrap">${escapeHtml(flip.label||'—')}</td><td>${flip.to?'不成立 → 成立':'成立 → 不成立'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="adm-muted" style="margin:.6rem 0 0">還沒有翻轉紀錄。</p>';
    const rs=data.ruleStates;let rulesBlock='';
    if(rs){
      const cmp=rs.comparison||{};
      const ruleRows=(rs.rules||[]).map((rule)=>`<tr><td class="wrap">${escapeHtml(rule.name||rule.ruleId)}<br><small>${rule.kind==='event'?'事件型':'狀態型'}・離開 ${num(rule.rearmBars)} 根後重新待命${rule.sessionClosed?'・今日已收盤':''}</small></td><td class="adm-num">${num(rule.states?.idle)}</td><td class="adm-num">${num(rule.states?.triggered)}</td><td class="adm-num">${num(rule.states?.cooldown)}</td><td class="adm-num">${num(rule.triggersToday)}</td><td class="adm-num">${num(rule.suppressedToday)}</td></tr>`).join('');
      const label={trigger:'觸發（會通知）',suppressed:'冷卻中再成立（不通知）',rearm:'重新待命'};
      const evRows=(rs.recentEvents||[]).map((event)=>`<tr><td><small>${escapeHtml(formatTime(event.barEnd))}</small></td><td>${escapeHtml(event.symbol)}</td><td class="wrap">${escapeHtml(event.ruleName||'—')}</td><td>${escapeHtml(label[event.type]||event.type)}</td></tr>`).join('');
      rulesBlock=`<div class="adm-stats"><div class="adm-stat"><strong>${num(cmp.shadowTriggers)}</strong><span>今日新方式通知數</span></div><div class="adm-stat"><strong>${cmp.legacySignals==null?'—':num(cmp.legacySignals)}</strong><span>今日現行通知數</span></div><div class="adm-stat"><strong>${num(cmp.suppressed)}</strong><span>冷卻擋下</span></div></div>`
        +(ruleRows?`<p class="adm-sub">規則狀態（股票數）</p><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>規則</th><th class="adm-num">待命</th><th class="adm-num">已觸發</th><th class="adm-num">冷卻</th><th class="adm-num">今日觸發</th><th class="adm-num">今日擋下</th></tr></thead><tbody>${ruleRows}</tbody></table></div>`:'')
        +(evRows?`<p class="adm-sub">最近規則事件</p><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>K 棒</th><th>股票</th><th>規則</th><th>事件</th></tr></thead><tbody>${evRows}</tbody></table></div>`:'')
        +'<p class="adm-sub">共用條件</p>';
    }
    target.innerHTML=rulesBlock+runLine+table+flipTable;
  }catch(error){if(stale(token))return;if(authFailure(error))return;fail('conditions',error);}
}
// 5. 訪客
async function loadVisitors(token){
  const target=body('visitors');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  try{
    const data=await api(`/api/admin/visitors?days=${days}&limit=100`);if(stale(token))return;
    const items=data.items||[];meta('visitors',`最近 ${days} 天・${num(items.length)} 位`);
    if(!items.length){target.innerHTML='<div class="adm-empty">期間內沒有訪客。</div>';return;}
    target.innerHTML=`<div class="adm-table-wrap"><table class="adm-table" id="visitorTable"><thead><tr><th>訪客</th><th>首次</th><th>最後</th><th class="adm-num">頁面瀏覽</th><th class="adm-num">解析</th><th class="adm-num">監控</th><th>用過的指標</th></tr></thead><tbody>${items.map((row,index)=>`<tr class="clickable" data-visitor="${escapeHtml(row.visitor)}" data-index="${index}" tabindex="0" aria-expanded="false"><td><span class="adm-mono">${escapeHtml(shortId(row.visitor))}</span></td><td><small>${escapeHtml(formatTime(row.firstSeen))}</small></td><td><small>${escapeHtml(formatTime(row.lastSeen))}</small></td><td class="adm-num">${num(row.pageViews)}</td><td class="adm-num">${num(row.parses)}</td><td class="adm-num">${num(row.monitors)}</td><td><div class="adm-chips">${(row.indicators||[]).slice(0,6).map((item)=>`<span class="adm-chip">${escapeHtml(item)}</span>`).join('')}${(row.indicators||[]).length>6?`<span class="adm-chip">+${row.indicators.length-6}</span>`:''}${(row.indicators||[]).length?'':'<small>—</small>'}</div></td></tr>`).join('')}</tbody></table></div>`;
    const toggle=async(row)=>{
      const next=row.nextElementSibling;
      if(next?.classList.contains('detail')){next.remove();row.classList.remove('expanded');row.setAttribute('aria-expanded','false');return;}
      row.classList.add('expanded');row.setAttribute('aria-expanded','true');
      const detail=document.createElement('tr');detail.className='detail';detail.innerHTML='<td colspan="7"><div class="adm-skeleton" aria-hidden="true" style="height:3rem"></div></td>';row.after(detail);
      try{const events=await api(`/api/admin/events?visitor=${encodeURIComponent(row.dataset.visitor)}&limit=30`);if(stale(token))return;detail.innerHTML=`<td colspan="7">${eventTable(events.items||[],{compact:true})}</td>`;}
      catch(error){if(stale(token))return;if(authFailure(error))return;detail.innerHTML=`<td colspan="7"><small class="adm-error">無法讀取事件：${escapeHtml(errorText(error))}</small></td>`;}
    };
    target.querySelectorAll('tr.clickable').forEach((row)=>{row.addEventListener('click',()=>toggle(row));row.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle(row);}});});
  }catch(error){if(stale(token))return;if(authFailure(error))return;fail('visitors',error);}
}
// 6. 公式庫管理
async function loadLibrary(token){
  const target=body('library');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  try{
    const data=await api('/api/admin/indicators');if(stale(token))return;
    const items=(data.items||[]).filter((item)=>item&&item.shapeKey);
    const members=items.reduce((total,item)=>total+(item.members||[]).length,0);meta('library',`${num(items.length)} 個模板・${num(members)} 個成員`);
    if(!items.length){target.innerHTML='<div class="adm-empty">公式庫還是空的。</div>';return;}
    target.innerHTML=items.map((item,index)=>`<details class="adm-family" ${index<2?'open':''}><summary><span>${escapeHtml(item.family||'—')}・${escapeHtml(item.name||item.shapeKey)}</span><small>${num((item.presets||[]).length)} 個預設・${num((item.members||[]).length)} 個成員・使用 ${num(item.uses)} 次</small></summary><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>名稱</th><th>來源</th><th class="adm-num">使用次數</th><th>狀態</th></tr></thead><tbody>${(item.members||[]).map((member)=>`<tr><td class="wrap">${escapeHtml(member.name||member.fingerprint)}<br><small class="adm-mono">${escapeHtml(String(member.fingerprint||'').slice(0,12))}</small></td><td><span class="adm-chip ${member.source==='ai'?'ai':''}">${escapeHtml(SOURCE_LABEL[member.source]||member.source||'—')}</span></td><td class="adm-num">${num(member.hitCount)}</td><td><select class="adm-status-select" data-fingerprint="${escapeHtml(member.fingerprint)}" aria-label="${escapeHtml(member.name||'')} 的狀態">${Object.entries(MEMBER_STATUS).map(([value,label])=>`<option value="${value}" ${member.status===value?'selected':''}>${label}</option>`).join('')}</select></td></tr>`).join('')||'<tr><td colspan="4"><small>沒有成員</small></td></tr>'}</tbody></table></div></details>`).join('');
    target.querySelectorAll('.adm-status-select').forEach((select)=>{
      let previous=select.value;
      select.addEventListener('change',async()=>{
        const status=select.value;select.disabled=true;
        try{await api(`/api/admin/indicators/${encodeURIComponent(select.dataset.fingerprint)}/status`,{status});previous=status;showToast(`已更新為「${MEMBER_STATUS[status]||status}」`);}
        catch(error){select.value=previous;if(!authFailure(error))showToast(`更新失敗：${errorText(error)}`,true);}
        select.disabled=false;
      });
    });
  }catch(error){if(stale(token))return;if(authFailure(error))return;fail('library',error);}
}
// 7. 事件查詢 (generic; the easy place to extend)
const PAGE_SIZE=50;
let query={type:'',visitor:'',from:'',to:'',offset:0};
function loadEvents(){
  const target=body('events');if(!target)return;
  target.innerHTML=`<form class="adm-form" id="eventForm"><label>類型<select name="type"><option value="">全部</option>${EVENT_TYPES.map((type)=>`<option value="${type}" ${query.type===type?'selected':''}>${escapeHtml(EVENT_LABEL[type]||type)}</option>`).join('')}</select></label><label>訪客 ID<input name="visitor" value="${escapeHtml(query.visitor)}" placeholder="完整或前幾碼"></label><label>從<input name="from" type="date" value="${escapeHtml(query.from)}"></label><label>到<input name="to" type="date" value="${escapeHtml(query.to)}"></label><label>每頁<select name="limit" disabled><option>${PAGE_SIZE}</option></select></label><button type="submit" class="adm-primary">查詢</button></form><div id="eventResults"><div class="adm-empty">選好條件後按「查詢」。</div></div>`;
  target.querySelector('#eventForm').addEventListener('submit',(event)=>{event.preventDefault();const data=Object.fromEntries(new FormData(event.currentTarget));query={type:data.type||'',visitor:String(data.visitor||'').trim(),from:data.from||'',to:data.to||'',offset:0};runEventQuery();});
}
async function runEventQuery(){
  const target=root.querySelector('#eventResults');if(!target)return;target.innerHTML='<div class="adm-skeleton" aria-hidden="true"></div>';
  const token=loadToken;
  const params=new URLSearchParams();
  if(query.type)params.set('type',query.type);if(query.visitor)params.set('visitor',query.visitor);
  if(query.from)params.set('from',new Date(`${query.from}T00:00:00+08:00`).toISOString());
  if(query.to)params.set('to',new Date(`${query.to}T23:59:59.999+08:00`).toISOString());
  params.set('limit',String(PAGE_SIZE));params.set('offset',String(query.offset));
  try{
    const data=await api(`/api/admin/events?${params}`);if(stale(token))return;
    const items=data.items||[],total=Number(data.total)||items.length;
    const start=query.offset+1,end=query.offset+items.length;
    target.innerHTML=`${eventTable(items)}<div class="adm-pager"><span>${items.length?`第 ${num(start)}–${num(end)} 筆・共 ${num(total)} 筆`:`共 ${num(total)} 筆`}</span><span><button type="button" class="adm-link" id="prevPage" ${query.offset?'':'disabled'}>上一頁</button><button type="button" class="adm-link" id="nextPage" ${end<total?'':'disabled'}>下一頁</button></span></div>`;
    target.querySelector('#prevPage').addEventListener('click',()=>{query.offset=Math.max(0,query.offset-PAGE_SIZE);runEventQuery();});
    target.querySelector('#nextPage').addEventListener('click',()=>{query.offset+=PAGE_SIZE;runEventQuery();});
  }catch(error){if(stale(token))return;if(authFailure(error))return;target.innerHTML=`<div class="adm-empty">無法讀取：${escapeHtml(errorText(error))}</div>`;}
}
// One line per event: a short reading of the payload, the raw JSON one click away.
function payloadSummary(type,payload={}){
  const parts=[];
  if(payload.text)parts.push(`「${payload.text}」`);
  if(payload.label)parts.push(payload.label);
  if(payload.path)parts.push(payload.path);
  if(payload.status)parts.push(PARSE_STATUS_LABEL[payload.status]||payload.status);
  if(payload.provider)parts.push(payload.provider);
  if(payload.verdict)parts.push(`驗證：${VERDICT_LABEL[payload.verdict.code||payload.verdict]||payload.verdict.code||payload.verdict}`);
  if(payload.totalEvents!=null)parts.push(`${payload.totalEvents} 次`);
  if(payload.symbols!=null)parts.push(`${payload.symbols} 檔`);
  if(payload.indicatorName)parts.push(payload.indicatorName);
  if(!parts.length){const keys=Object.keys(payload);if(keys.length)parts.push(keys.slice(0,3).map((key)=>`${key}=${typeof payload[key]==='object'?'…':String(payload[key]).slice(0,40)}`).join('・'));}
  return parts.join('・')||'—';
}
function eventTable(items,{compact=false}={}){
  if(!items.length)return'<div class="adm-empty">沒有符合的事件。</div>';
  return`<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>時間</th><th>類型</th>${compact?'':'<th>訪客</th>'}<th>內容</th></tr></thead><tbody>${items.map((item)=>{const payload=item.payload||{};const raw=JSON.stringify(payload,null,1);return`<tr><td><small>${escapeHtml(formatTime(item.ts))}</small></td><td><span class="adm-chip">${escapeHtml(EVENT_LABEL[item.type]||item.type||'—')}</span></td>${compact?'':`<td><span class="adm-mono">${escapeHtml(shortId(item.visitor))}</span></td>`}<td class="wrap">${escapeHtml(payloadSummary(item.type,payload))}${raw&&raw!=='{}'?`<details><summary>原始資料</summary><pre class="adm-payload">${escapeHtml(raw)}</pre></details>`:''}</td></tr>`;}).join('')}</tbody></table></div>`;
}

const SECTION_LOADERS={overview:loadOverview,parses:loadRecentParses,unknown:loadUnknown,conditions:loadConditions,visitors:loadVisitors,library:loadLibrary,events:(token)=>{if(!stale(token))loadEvents();}};
periodSelect.addEventListener('change',()=>{days=Number(periodSelect.value)||7;try{localStorage.setItem('watch365_admin_days',String(days));}catch{}loadAll();});
refreshButton.addEventListener('click',loadAll);

// Boot: a probe decides between login, disabled and dashboard.
(async()=>{
  try{await api('/api/admin/overview?days=7');showDashboard();}
  catch(error){if(error.status===503||error.code==='ADMIN_DISABLED')showDisabled();else showLogin();}
})();
