const STORAGE_KEY = 'watch365_onboarding_v2';
const app = { data: null, step: 1, draft: [], busy: false, editing: false, indicators:[], strategy:null, inputMode:'manual', agent:{requestId:0,busyRequestId:null,requestSubmitId:0,activationId:0,proposal:null,proposalInput:null,formulaToken:null,formulaFingerprint:null,formulaProposalId:null,context:[],requestDraft:null,requestInput:null}, seenNotifications: new Set(), universe: { page:1, pages:1, query:'', requestId:0, revision:null }, coverage:{requestId:0,lastCheckedAt:0,data:null} };
const $ = (selector) => document.querySelector(selector);
const el = Object.fromEntries([...document.querySelectorAll('[id]')].map((node) => [node.id, node]));
const scheduleDraftCoverage=debounce(()=>loadCoverage(app.draft),250);

bind();
await init();
setInterval(refreshWorkspace, 5000);

function bind() {
  el.parseButton.addEventListener('click', parseInput);
  el.csvInput.addEventListener('change', importCsv);
  el.step1Next.addEventListener('click', () => goStep(2));
  el.step2Next.addEventListener('click', () => { if (readStrategyParams()) goStep(3); });
  el.strategySelect.addEventListener('change', () => selectStrategy(el.strategySelect.value));
  el.agentParseButton.addEventListener('click', parseAgentRequest);
  el.agentConfirmButton.addEventListener('click', confirmAgentProposal);
  el.agentFormulaActivateButton.addEventListener('click', activateFormulaProposal);
  el.agentRequestButton.addEventListener('click', showRequestConfirmation);
  el.requestCancelButton.addEventListener('click', () => { el.requestConfirm.hidden=true; });
  el.requestSubmitButton.addEventListener('click', submitIndicatorRequest);
  el.requestListButton.addEventListener('click', loadIndicatorRequests);
  el.requestTimeframe.addEventListener('change', renderCustomTimeframe);
  el.agentInput.addEventListener('input', invalidateAgentProposal);
  el.manualModeButton.addEventListener('click', () => setInputMode('manual'));
  el.textModeButton.addEventListener('click', () => setInputMode('text'));
  el.activateButton.addEventListener('click', activateTask);
  el.openWorkspace.addEventListener('click', openWorkspace);
  el.adjustButton.addEventListener('click', adjustSettings);
  el.toggleButton.addEventListener('click', toggleMonitoring);
  el.openUniverseButton.addEventListener('click', openSystemUniverse);
  el.closeUniverseButton.addEventListener('click', closeSystemUniverse);
  el.universeSearch.addEventListener('input', debounce(() => { app.universe.query=el.universeSearch.value.trim(); app.universe.page=1; loadSystemUniverse(); }, 250));
  el.universePrev.addEventListener('click', () => { if(app.universe.page>1){app.universe.page-=1;loadSystemUniverse();} });
  el.universeNext.addEventListener('click', () => { if(app.universe.page<app.universe.pages){app.universe.page+=1;loadSystemUniverse();} });
  for (const button of document.querySelectorAll('[data-back]')) button.addEventListener('click', () => goStep(Number(button.dataset.back)));
}

async function init() {
  [app.data, {items:app.indicators}] = await Promise.all([fetchJson('/api/state'), fetchJson('/api/indicators')]);
  const saved = readDraft();
  app.draft = saved?.draft?.length ? saved.draft : structuredClone(app.data.settings.watchlist || []);
  app.step = saved?.step || 1;
  app.editing = Boolean(saved?.editing);
  app.inputMode = saved?.inputMode === 'text' ? 'text' : 'manual';
  app.strategy = saved?.strategy || structuredClone(app.data.settings.strategy || defaultStrategy());
  renderStrategyForm();
  if (app.data.settings.monitorTask?.onboardingCompleted && !app.editing) openWorkspace();
  else { showOnboarding(); goStep(app.step); }
}

async function parseInput() {
  const input = el.symbolInput.value.trim();
  if (!input) return setParseStatus('請先輸入股票代號。', 'warn');
  setBusy(true); setParseStatus('正在確認股票名稱與市場…');
  try {
    const result = await fetchJson('/api/watchlist/resolve', { input });
    app.draft = merge(app.draft, result.valid.map(({ symbol, name, market }) => ({ symbol, name, market })));
    renderDraft(); renderCorrections(result.needsCorrection || []);
    const notes = [result.valid.length ? `找到 ${result.valid.length} 檔` : '', result.duplicates.length ? `略過重複 ${result.duplicates.length} 檔` : '', result.invalid.map((item) => `${item.raw} 格式不正確`).join('、'), result.needsCorrection.length ? `${result.needsCorrection.length} 檔需確認市場` : ''].filter(Boolean);
    setParseStatus(notes.join('；'), result.invalid.length || result.needsCorrection.length ? 'warn' : 'success');
    el.symbolInput.value = ''; saveDraft();
  } catch (error) { setParseStatus(`目前無法確認股票資料。錯誤碼：${error.message}`, 'warn'); }
  finally { setBusy(false); }
}

function renderCorrections(items) {
  el.correctionList.replaceChildren(...items.map((item) => {
    const row = document.createElement('div'); row.className = 'correction-row';
    row.innerHTML = `<span><strong>${escapeHtml(item.raw)}</strong> 無法確認市場</span><select class="select select-bordered select-sm" aria-label="${escapeHtml(item.raw)} 市場"><option value="">選擇市場</option><option value="TWSE">上市</option><option value="TPEx">上櫃</option></select><button class="btn btn-sm" type="button">加入清單</button>`;
    row.querySelector('button').addEventListener('click', () => { const market = row.querySelector('select').value; if (!market) return setParseStatus(`${item.raw}：請選擇市場。`, 'warn'); app.draft = merge(app.draft, [{ symbol:item.symbol, name:item.symbol, market }]); row.remove(); renderDraft(); saveDraft(); });
    return row;
  }));
}

function renderDraft() {
  el.draftList.replaceChildren(...app.draft.map((item) => {
    const row = document.createElement('div'); row.className = 'stock-row';
    row.innerHTML = `<span><strong>${escapeHtml(item.symbol)} ${escapeHtml(item.name)}</strong><small>${marketLabel(item.market)}</small></span>`;
    const remove = document.createElement('button'); remove.className = 'btn btn-ghost btn-square btn-sm'; remove.type = 'button'; remove.textContent = '×'; remove.title = `移除 ${item.symbol}`; remove.setAttribute('aria-label', `移除 ${item.symbol}`); remove.addEventListener('click', () => { app.draft = app.draft.filter((entry) => entry.symbol !== item.symbol); renderDraft(); saveDraft(); }); row.append(remove); return row;
  }));
  el.step1Next.disabled = app.draft.length === 0;
  el.draftCount.textContent = `已選 ${app.draft.length} 檔`;
  scheduleDraftCoverage();
}

function goStep(step) {
  if (step > 1 && !app.draft.length) return goStep(1);
  if (app.step === 2 && step !== 2) invalidateAgentProposal();
  app.step = step; showOnboarding();
  for (let index = 1; index <= 4; index += 1) el[`step${index}`].hidden = index !== step;
  el.stepLabel.textContent = `第 ${step} 步，共 4 步`; el.remainingLabel.textContent = step === 4 ? '全部完成' : `還剩 ${4-step} 步`;
  document.querySelectorAll('.stepper .step').forEach((item, index) => item.classList.toggle('step-primary', index < step));
  if (step === 1) renderDraft();
  if (step === 2) { renderStrategyForm(); renderInputMode(); }
  if (step === 3) { renderPreview(); loadCoverage(app.draft); }
  saveDraft(); window.scrollTo({ top:0, behavior:'smooth' });
}

function renderPreview() {
  el.previewCount.textContent = `已選 ${app.draft.length} 檔`;
  el.previewRule.textContent = strategySummary(app.strategy);
  el.previewDataStatus.textContent = '啟用後取得最新一分鐘行情';
  el.previewResult.className = 'preview-result alert alert-info';
  el.previewResult.innerHTML = '<strong>尚未啟用</strong><span>按下啟用後，系統才會依這份條件與最新資料開始檢查。</span>';
}

function defaultStrategy(){const definition=app.indicators.find((item)=>item.id==='legacy.breakout-volume')||app.indicators[0];return strategyFromDefinition(definition);}
function strategyFromDefinition(definition){return{id:definition.id,version:definition.version,timeframe:definition.timeframe,params:Object.fromEntries(definition.params.map((param)=>[param.key,param.default]))};}
function selectStrategy(identity){invalidateAgentProposal();const definition=app.indicators.find((item)=>`${item.id}@${item.version}`===identity);if(!definition)return;app.strategy=strategyFromDefinition(definition);renderStrategyForm();saveDraft();}
function renderStrategyForm(){
  if(app.strategy?.executor==='formula_v1'){
    const option=document.createElement('option');option.value='formula.custom@formula.v1';option.textContent=`目前公式：${app.strategy.name}`;option.selected=true;
    const switchOption=document.createElement('option');switchOption.value=`${app.indicators[0].id}@${app.indicators[0].version}`;switchOption.textContent='改用手動條件';el.strategySelect.replaceChildren(option,switchOption);
    el.strategyDescription.innerHTML=`<div><strong>${escapeHtml(app.strategy.name)}</strong><span>${escapeHtml(app.strategy.formula?.summary||'受限公式')}</span><small>使用已完成的一分鐘 K</small></div><b class="badge badge-success badge-outline">已套用</b>`;el.strategyParams.replaceChildren();el.strategyError.textContent='切換成手動條件後，需重新確認並啟用才會生效。';return;
  }
  if(!app.indicators.length)return;
  const selected=app.indicators.find((item)=>item.id===app.strategy?.id&&item.version===app.strategy?.version)||app.indicators[0];
  if(selected.id!==app.strategy?.id||selected.version!==app.strategy?.version)app.strategy=strategyFromDefinition(selected);
  el.strategySelect.replaceChildren(...app.indicators.map((item)=>{const option=document.createElement('option');option.value=`${item.id}@${item.version}`;option.textContent=item.name;option.selected=item.id===selected.id&&item.version===selected.version;return option;}));
  el.strategyDescription.innerHTML=`<div><strong>${escapeHtml(selected.name)}</strong><span>${escapeHtml(selected.description)}</span><small>使用已完成的一分鐘 K</small></div><b class="badge badge-success badge-outline">已選擇</b>`;
  el.strategyParams.replaceChildren(...selected.params.map((schema)=>{const label=document.createElement('label');const value=app.strategy.params?.[schema.key]??schema.default;label.innerHTML=`<span>${escapeHtml(schema.label)}</span><input class="input input-bordered" type="number" name="${escapeHtml(schema.key)}" min="${schema.min}" max="${schema.max}" step="${schema.type==='integer'?'1':'any'}" value="${value}"><small>${schema.min}–${schema.max}</small>`;label.querySelector('input').addEventListener('input',()=>{invalidateAgentProposal();el.strategyError.textContent='';readStrategyParams(false);saveDraft();});return label;}));
  el.strategyError.textContent='';
}
function readStrategyParams(showError=true){if(app.strategy?.executor==='formula_v1')return true;const definition=app.indicators.find((item)=>item.id===app.strategy.id&&item.version===app.strategy.version);const params={};for(const schema of definition.params){const input=el.strategyParams.querySelector(`[name="${schema.key}"]`);const value=Number(input.value);if(!Number.isFinite(value)||value<schema.min||value>schema.max||(schema.type==='integer'&&!Number.isInteger(value))){if(showError)el.strategyError.textContent=`${schema.label}需介於 ${schema.min} 到 ${schema.max}。`;return false;}params[schema.key]=value;}app.strategy={...app.strategy,params};return true;}
function strategySummary(strategy){if(strategy?.executor==='formula_v1')return `${strategy.name}（${strategy.formula?.summary||'受限公式'}） · 一分鐘`;const definition=app.indicators.find((item)=>item.id===strategy?.id&&item.version===strategy?.version);if(!definition)return '目前無法使用這項條件';const params=definition.params.map((schema)=>`${schema.label} ${strategy.params?.[schema.key]??schema.default}`).join('、');return `${definition.name}${params?`（${params}）`:''} · 一分鐘`;}

function setInputMode(mode){
  if(!['manual','text'].includes(mode)||app.inputMode===mode)return;
  invalidateAgentProposal(); app.inputMode=mode; renderInputMode(); saveDraft();
}
function renderInputMode(){
  const manual=app.inputMode!=='text'; el.manualMode.hidden=!manual; el.agentMode.hidden=manual;
  el.step2Next.hidden=!manual;
  el.manualModeButton.classList.toggle('active',manual); el.textModeButton.classList.toggle('active',!manual);
  el.manualModeButton.setAttribute('aria-selected',String(manual)); el.textModeButton.setAttribute('aria-selected',String(!manual));
}

async function parseAgentRequest(){
  const text=el.agentInput.value.trim();if(!text){el.agentStatus.textContent='請先描述想監控的條件。';return;}
  invalidateAgentProposal();const requestId=app.agent.requestId;app.agent.busyRequestId=requestId;el.agentParseButton.disabled=true;el.agentParseButton.innerHTML='<span class="loading loading-spinner loading-sm" aria-hidden="true"></span>解析中';el.agentStatus.textContent='Agent 正在比對目前支援的指標…';
  try{const result=await fetchJson('/api/indicator-agent/parse',{text,context:app.agent.context});if(requestId!==app.agent.requestId||app.step!==2||text!==el.agentInput.value.trim())return;renderAgentResult(result,text);}
  catch(error){if(requestId!==app.agent.requestId)return;el.agentStatus.textContent=agentErrorMessage(error.message);el.agentResult.hidden=true;}
  finally{if(app.agent.busyRequestId===requestId){app.agent.busyRequestId=null;resetAgentButtons();}}
}
function renderAgentResult(result,text){el.agentStatus.textContent='';el.agentResult.hidden=false;el.agentRequestButton.hidden=true;el.agentConfirmButton.hidden=true;el.agentFormulaActivateButton.hidden=true;app.agent.requestDraft=null;app.agent.requestInput=null;app.agent.proposal=null;app.agent.formulaToken=null;app.agent.proposalInput=text;if(result.status==='clarification'){const message=result.message||result.question;app.agent.context=[...app.agent.context,{request:text,response:message}].slice(-4);el.agentInput.value='';el.agentInput.placeholder='直接回答上面的問題';el.agentResultTitle.textContent='需要補充資訊';el.agentResultText.textContent=message;return;}if(result.status==='discussion'||result.status==='unsupported'){app.agent.context=[...app.agent.context,{request:text,response:result.message||result.reason}].slice(-4);app.agent.requestDraft=result.requestDraft?structuredClone(result.requestDraft):null;app.agent.requestInput=text;el.agentResultTitle.textContent='這項需求需要討論';el.agentResultText.textContent=result.message||result.reason;el.agentRequestButton.hidden=!app.agent.requestDraft;return;}app.agent.context=[];el.agentInput.placeholder='例如：一分鐘 RSI 14 上穿 30';if(result.status==='formula'){app.agent.formulaToken=result.proposalToken;app.agent.formulaFingerprint=result.proposal?.fingerprint||null;app.agent.formulaProposalId=result.proposalId||null;el.agentResultTitle.textContent='確認公式後啟用';el.agentResultText.textContent=`${result.summary}：${result.formulaSummary}。使用當日完整一分鐘 K，需暖機 ${result.proposal?.warmupBars??'—'} 根；行情不足時會等待，不會產生訊號。`;el.agentFormulaActivateButton.hidden=false;return;}app.agent.proposal=result.proposal?structuredClone(result.proposal):null;el.agentResultTitle.textContent='需要你確認';el.agentResultText.textContent=result.summary;el.agentConfirmButton.hidden=!app.agent.proposal;}
async function confirmAgentProposal(){const input=el.agentInput.value.trim();if(!app.agent.proposal||app.agent.proposalInput!==input||app.step!==2){invalidateAgentProposal();return;}const requestId=app.agent.requestId;el.agentConfirmButton.disabled=true;try{const result=await fetchJson('/api/indicator-agent/confirm',{proposal:app.agent.proposal});if(requestId!==app.agent.requestId||app.step!==2||input!==el.agentInput.value.trim()||app.agent.proposalInput!==input)return;app.strategy=result.proposal;app.agent.proposal=null;app.agent.proposalInput=null;app.inputMode='manual';renderStrategyForm();renderInputMode();el.strategyError.textContent='已從文字描述帶入，尚未儲存或啟用。';saveDraft();}catch(error){if(requestId!==app.agent.requestId)return;invalidateAgentProposal();el.agentStatus.textContent=error.message==='INDICATOR_AGENT_PROPOSAL_STALE'?'指標版本已更新，請重新解析。':'無法確認解析結果，原設定未變更。';}finally{if(requestId===app.agent.requestId)el.agentConfirmButton.disabled=false;}}
async function activateFormulaProposal(){const input=el.agentInput.value.trim();if(!app.agent.formulaToken||app.agent.proposalInput!==input||app.step!==2)return invalidateAgentProposal();const activationId=++app.agent.activationId;const token=app.agent.formulaToken;const fingerprint=app.agent.formulaFingerprint;const proposalId=app.agent.formulaProposalId;const requestedWatchlist=structuredClone(app.draft);el.agentFormulaActivateButton.disabled=true;el.agentFormulaActivateButton.textContent='正在啟用…';try{const result=await fetchJson('/api/formula/activate',{proposalToken:token,watchlist:requestedWatchlist});if(activationId!==app.agent.activationId)return;finishFormulaActivation(result);}catch(error){if(activationId!==app.agent.activationId)return;try{const state=await fetchJson('/api/state');if(activationId!==app.agent.activationId)return;if(proposalId&&fingerprint&&state.settings.enabled&&state.settings.formulaActivationId===proposalId&&state.settings.strategy?.definitionFingerprint===fingerprint&&sameWatchlist(state.settings.watchlist,requestedWatchlist)){finishFormulaActivation(state);return;}}catch{}el.agentStatus.textContent=error.message==='FORMULA_PROPOSAL_STALE'?'公式提案已逾時，請重新解析。':`目前無法確認是否已啟用，請重新整理查看監控狀態。錯誤碼：${error.message}`;}finally{if(activationId===app.agent.activationId){el.agentFormulaActivateButton.disabled=false;el.agentFormulaActivateButton.textContent='套用並啟用';}}}
function sameWatchlist(left,right){return JSON.stringify((left||[]).map(({symbol,market})=>({symbol,market})))===JSON.stringify((right||[]).map(({symbol,market})=>({symbol,market})));}
function finishFormulaActivation(result){app.data=result;app.editing=false;localStorage.removeItem(STORAGE_KEY);el.completeTitle.textContent='公式監控已啟用';const completion=completionState(app.data);el.completeText.textContent=completion.text;el.completeStatus.textContent=completion.status;goStep(4);loadCoverage(app.data.settings.watchlist);}
function invalidateAgentProposal(){app.agent.requestId+=1;app.agent.requestSubmitId+=1;app.agent.activationId+=1;app.agent.busyRequestId=null;app.agent.proposal=null;app.agent.proposalInput=null;app.agent.formulaToken=null;app.agent.formulaFingerprint=null;app.agent.formulaProposalId=null;app.agent.requestDraft=null;app.agent.requestInput=null;if(el.agentStatus)el.agentStatus.textContent='';if(el.agentResult)el.agentResult.hidden=true;if(el.agentConfirmButton){el.agentConfirmButton.hidden=true;el.agentConfirmButton.disabled=false;}if(el.agentFormulaActivateButton){el.agentFormulaActivateButton.hidden=true;el.agentFormulaActivateButton.disabled=false;}if(el.agentRequestButton){el.agentRequestButton.hidden=true;el.agentRequestButton.disabled=false;}if(el.requestConfirm){el.requestConfirm.hidden=true;setRequestFormBusy(false);}resetAgentButtons();}
function resetAgentButtons(){if(!el.agentParseButton)return;el.agentParseButton.disabled=false;el.agentParseButton.textContent='解析需求';}
function agentErrorMessage(code){return code==='INDICATOR_AGENT_NOT_CONFIGURED'?'Agent 尚未設定模型服務，仍可使用下方手動設定。':code==='INDICATOR_AGENT_CREDENTIALS_REJECTED'?'Agent 模型服務憑證無效，原設定未變更。':code==='INDICATOR_AGENT_ACCESS_DENIED'?'Agent 模型服務尚未取得生成權限，原設定未變更。':code==='INDICATOR_AGENT_TIMEOUT'?'Agent 回應逾時，原設定未變更，請稍後再試。':code==='INDICATOR_AGENT_RATE_LIMITED'?'Agent 目前忙碌，原設定未變更，請稍後再試。':'Agent 暫時無法解析，原設定未變更。';}

function showRequestConfirmation(){if(!app.agent.requestDraft||app.agent.requestInput!==el.agentInput.value.trim())return invalidateAgentProposal();const draft=app.agent.requestDraft;el.requestOriginalText.textContent=`原始需求：${app.agent.requestInput}`;el.requestIndicatorName.value={legacy:'突破量能',sma:'SMA',rsi:'RSI'}[draft.requestedIndicator]||'';el.requestTimeframe.value=['1m','d1'].includes(draft.requestedTimeframe)?draft.requestedTimeframe:'';el.requestCustomTimeframe.value='';renderCustomTimeframe();el.requestParameters.value=Object.entries(draft.params||{}).filter(([,value])=>value!==null).map(([key,value])=>`${key} ${value}`).join('、');el.requestTrigger.value={crosses_above:'向上穿越',crosses_below:'向下穿越'}[draft.requestedDirection]||'';el.requestFormError.textContent='';el.requestConfirm.hidden=false;}
function renderCustomTimeframe(){const custom=el.requestTimeframe.value==='other';el.requestCustomTimeframeWrap.hidden=!custom;if(!custom)el.requestCustomTimeframe.value='';}
async function submitIndicatorRequest(){if(!app.agent.requestDraft||app.agent.requestInput!==el.agentInput.value.trim())return invalidateAgentProposal();const payload={sourceText:app.agent.requestInput,indicatorName:el.requestIndicatorName.value.trim(),timeframe:el.requestTimeframe.value,customTimeframe:el.requestTimeframe.value==='other'?el.requestCustomTimeframe.value.trim():null,parameterDescription:el.requestParameters.value.trim(),triggerCondition:el.requestTrigger.value.trim()};if(!payload.indicatorName||!payload.timeframe||(payload.timeframe==='other'&&!payload.customTimeframe)||!payload.parameterDescription||!payload.triggerCondition){el.requestFormError.textContent='請補齊指標名稱、具體資料週期、參數或定義，以及觸發條件。';return;}const requestId=app.agent.requestId;const submitId=++app.agent.requestSubmitId;el.requestFormError.textContent='';setRequestFormBusy(true);try{const result=await fetchJson('/api/indicator-requests',payload);if(requestId!==app.agent.requestId||submitId!==app.agent.requestSubmitId||app.step!==2)return;el.requestConfirm.hidden=true;el.agentResult.hidden=true;el.agentStatus.textContent=result.duplicate?'這項需求已提交，狀態仍為待評估。':'需求已送出，狀態為待評估。';await loadIndicatorRequests();}catch(error){if(requestId===app.agent.requestId&&submitId===app.agent.requestSubmitId)el.agentStatus.textContent=`需求未送出，請稍後再試。錯誤碼：${error.message}`;}finally{if(submitId===app.agent.requestSubmitId)setRequestFormBusy(false);}}
function setRequestFormBusy(busy){for(const control of el.requestConfirm.querySelectorAll('input,select,textarea,button'))control.disabled=busy;el.agentRequestButton.disabled=busy;el.requestSubmitButton.textContent=busy?'送出中…':'送出需求';}
async function loadIndicatorRequests(){const requestId=app.agent.requestId;el.requestList.hidden=false;el.requestList.innerHTML='<p class="request-empty">正在取得已提交需求…</p>';try{const data=await fetchJson('/api/indicator-requests');if(requestId!==app.agent.requestId||app.step!==2||app.inputMode!=='text')return;el.requestList.replaceChildren(...(data.items.length?data.items.map(renderRequestRow):[requestEmpty('尚未提交新指標需求。')]));}catch(error){if(requestId===app.agent.requestId)el.requestList.replaceChildren(requestEmpty(`目前無法取得需求狀態。錯誤碼：${error.message}`));}}
function renderRequestRow(request){const timeframe=request.timeframe==='1m'?'一分鐘':request.timeframe==='d1'?'日線':request.customTimeframe;const row=document.createElement('article');row.className='request-row';row.innerHTML=`<p>${escapeHtml(request.sourceText)}</p><span class="badge badge-outline">${request.status==='pending_evaluation'?'待評估':'狀態未知'}</span><time datetime="${escapeHtml(request.createdAt)}">送出於 ${escapeHtml(formatDateTime(request.createdAt))}</time><details><summary>查看完整需求</summary><dl><div><dt>指標</dt><dd>${escapeHtml(request.indicatorName)}</dd></div><div><dt>週期</dt><dd>${escapeHtml(timeframe)}</dd></div><div><dt>參數／定義</dt><dd>${escapeHtml(request.parameterDescription)}</dd></div><div><dt>觸發條件</dt><dd>${escapeHtml(request.triggerCondition)}</dd></div></dl></details>`;return row;}
function requestEmpty(text){const node=document.createElement('p');node.className='request-empty';node.textContent=text;return node;}

async function activateTask() {
  setBusy(true); el.activateButton.textContent = '正在啟用…';
  try {
    app.data = await apiPost('/api/settings', { watchlist:app.draft, strategy:app.strategy, enabled:false, monitorTask:{ onboardingCompleted:true, completedAt:new Date().toISOString() } });
    app.data = await apiPost('/api/monitor/start');
    app.editing = false; localStorage.removeItem(STORAGE_KEY); el.completeTitle.textContent = '監控設定已啟用';
    const completion=completionState(app.data); el.completeText.textContent=completion.text; el.completeStatus.textContent=completion.status; goStep(4); loadCoverage(app.data.settings.watchlist);
  } catch (error) { el.previewResult.innerHTML = `<strong>啟用未完成</strong><span>請重試。錯誤碼：${escapeHtml(error.message)}</span>`; }
  finally { el.activateButton.textContent = '啟用這個監控'; setBusy(false); }
}

function openWorkspace() { invalidateAgentProposal(); el.onboarding.hidden = true; el.workspace.hidden = false; renderWorkspace(); loadCoverage(app.data.settings.watchlist); }
function showOnboarding() { el.onboarding.hidden = false; el.workspace.hidden = true; }
function adjustSettings() { app.editing = true; app.draft = structuredClone(app.data.settings.watchlist); app.strategy=structuredClone(app.data.settings.strategy); el.symbolInput.value = ''; goStep(1); }

function openSystemUniverse(){ el.workspace.hidden=true; el.systemUniverse.hidden=false; app.universe.page=1; app.universe.query=''; app.universe.revision=null; el.universeSearch.value=''; loadSystemUniverse(); window.scrollTo({top:0}); }
function closeSystemUniverse(){ el.systemUniverse.hidden=true; el.workspace.hidden=false; renderWorkspace(); window.scrollTo({top:0}); }
async function loadSystemUniverse(){
  const requestId=++app.universe.requestId;
  el.universeStatus.className='universe-status alert alert-info'; el.universeStatus.innerHTML='<span class="loading loading-spinner loading-sm" aria-hidden="true"></span><div><strong>正在取得系統監控名單</strong><p>確認最新來源版本與股票清單中。</p></div>'; el.universeContent.hidden=true;
  try{
    const params=new URLSearchParams({page:String(app.universe.page),pageSize:'50'}); if(app.universe.query)params.set('q',app.universe.query); if(app.universe.revision)params.set('revision',app.universe.revision);
    const data=await fetchJson(`/api/system-universe?${params}`); if(requestId!==app.universe.requestId)return;
    app.universe.page=data.page; app.universe.pages=data.pages; app.universe.revision=data.sourceRevision;
    el.universeStatus.className='universe-status alert alert-success';
    el.universeStatus.innerHTML='<div><strong>系統監控名單已載入</strong><p>目前顯示 HF 最新成功取得的完整監控範圍。</p></div>';
    el.universeDate.textContent=formatDate(data.updatedDate); el.universeTotal.textContent=`${data.total} 檔`; el.universeMatches.textContent=app.universe.query?`找到 ${data.filteredTotal} 檔`:`共 ${data.total} 檔`;
    el.universeRows.replaceChildren(...data.items.map((item)=>{const row=document.createElement('tr');const symbol=document.createElement('th');symbol.scope='row';symbol.textContent=item.symbol;const name=document.createElement('td');name.textContent=item.name||'名稱未提供';row.append(symbol,name);return row;}));
    el.universeEmpty.hidden=data.filteredTotal!==0; el.universePage.textContent=`第 ${data.page} / ${data.pages} 頁`; el.universePrev.disabled=data.page<=1; el.universeNext.disabled=data.page>=data.pages; el.universeContent.hidden=false;
  }catch(error){ if(requestId!==app.universe.requestId)return; const missing=error.message==='HF_UNIVERSE_NOT_FOUND'; el.universeStatus.className='universe-status alert alert-error'; el.universeStatus.innerHTML=`<div><strong>${missing?'目前沒有系統監控名單':'目前無法取得系統監控名單'}</strong><p>${missing?'HF 來源中尚未找到監控名單。':'資料來源暫時無法連線，請稍後再試。'}</p></div>`; }
}

async function refreshWorkspace() { if (!app.data?.settings?.monitorTask?.onboardingCompleted || !el.workspace || el.workspace.hidden) return; try { app.data = await fetchJson('/api/state'); renderWorkspace(); if(Date.now()-app.coverage.lastCheckedAt>60_000)await loadCoverage(app.data.settings.watchlist); await deliverPendingNotifications(app.data.notifications || []); } catch {} }

function renderWorkspace() {
  if (!app.data) return;
  const { settings, runtime, signals=[], notifications=[] } = app.data;
  const scopeUnknown = settings.enabled && runtime.coverageStatus === 'unknown' && runtime.lastProviderStatus === 'coverage_unknown';
  const emptyScope = settings.enabled && runtime.coverageStatus === 'available' && runtime.effectiveWatchlistCount === 0;
  const providerError = runtime.lastProviderStatus === 'error' && runtime.lastError && runtime.lastError !== 'HF_ASSET_NOT_FOUND';
  const waitingForData = !providerError && isWaiting(app.data);
  const state = !settings.enabled ? 'paused' : scopeUnknown ? 'scopeUnknown' : emptyScope ? 'emptyScope' : providerError ? 'error' : waitingForData ? 'waiting' : 'active';
  const states = {
    active: { label:'監控中', title:'監控運作正常', message:'系統正在持續檢查，符合條件時會立即通知。', tone:'alert-success', dot:'active' },
    waiting: { label:'等待行情', title:'已啟用，等待今日行情', message:'資料開始更新後會自動篩選，不需要保持此頁開啟。', tone:'alert-warning', dot:'waiting' },
    error: { label:'資料異常', title:'目前無法取得行情資料', message:'監控設定仍已保留；資料恢復後會自動繼續檢查。', tone:'alert-error', dot:'error' },
    scopeUnknown: { label:'範圍待確認', title:'目前無法確認系統監控範圍', message:'本輪已停止，不會產生新訊號或通知；來源恢復後會自動繼續。', tone:'alert-error', dot:'error' },
    emptyScope: { label:'零交集', title:'目前沒有系統名單涵蓋股票', message:'客戶選股已完整保留；名單出現交集後才會進行條件判定。', tone:'alert-warning', dot:'waiting' },
    paused: { label:'已暫停', title:'監控目前暫停', message:'設定與既有結果都已保留，重新開始後會繼續檢查。', tone:'alert-neutral', dot:'' }
  };
  const view = states[state];
  if (state === 'paused' && waitingForData) view.message = '設定已保留，目前仍在等待今日行情；重新開始後會自動檢查。';
  if (state === 'paused' && providerError) view.message = '設定已保留，目前行情資料異常；資料恢復並重新開始後會繼續檢查。';
  el.topDot.className = view.dot; el.topText.textContent = view.label;
  el.workspaceStatus.className = `workspace-status alert ${view.tone}`;
  el.taskStatus.className = `badge ${state === 'active' ? 'badge-success' : ['waiting','emptyScope'].includes(state) ? 'badge-warning' : ['error','scopeUnknown'].includes(state) ? 'badge-error' : 'badge-neutral'}`;
  el.taskStatus.textContent = view.label; el.statusTitle.textContent = view.title; el.statusMessage.textContent = view.message;
  el.taskCount.textContent = `${settings.watchlist.length} 檔股票`;
  const twse = settings.watchlist.filter((item) => item.market === 'TWSE').length; const tpex = settings.watchlist.filter((item) => item.market === 'TPEx').length;
  el.taskMarkets.textContent = [twse ? `上市 ${twse} 檔` : '', tpex ? `上櫃 ${tpex} 檔` : ''].filter(Boolean).join('、') || '尚未設定';
  el.taskTitle.textContent=settings.monitorTask.name;
  el.taskRule.textContent=strategySummary(settings.strategy);
  el.taskUpdated.textContent = runtime.lastRunAt ? `最近更新 ${formatTime(runtime.lastRunAt)}` : '尚未取得今日資料';
  el.taskSubtitle.textContent = `${settings.watchlist.length} 檔股票持續依同一條件篩選。`; el.toggleButton.textContent = settings.enabled ? '暫停監控' : '開始監控';
  const effectiveSymbols=new Set(runtime.effectiveWatchlist||[]); const effectiveCount=runtime.effectiveWatchlistCount ?? 0;
  const checked = scopeUnknown ? '—' : waitingForData || providerError || emptyScope ? 0 : new Set((app.data.quotes||[]).filter((item)=>effectiveSymbols.has(item.symbol)).map((item) => item.symbol)).size; const matched = signals.length; const waitingCount = scopeUnknown ? '—' : waitingForData || providerError ? effectiveCount : Math.max(0,effectiveCount-Number(checked));
  el.checkedCount.textContent = checked; el.matchedCount.textContent = matched; el.waitingCount.textContent = waitingCount; el.resultTime.textContent = runtime.lastRunAt ? `最近檢查 ${formatTime(runtime.lastRunAt)}` : '尚未檢查';
  el.resultMessage.textContent = scopeUnknown ? '系統範圍待確認，本輪未執行股票條件判定。' : emptyScope ? '目前交集為 0，本輪沒有股票進入條件判定。' : providerError ? '行情資料暫時無法更新，因此本輪尚未完成篩選。' : waitingForData ? '等待今日 M1 行情；完整 K 棒到達後會自動檢查指標條件。' : matched ? `目前有 ${matched} 檔符合指標條件。` : '本輪已完成檢查，目前尚未有股票符合條件。';
  el.emptySignals.textContent = scopeUnknown ? '範圍確認恢復後才會繼續產生新訊號。' : emptyScope ? '目前沒有系統名單涵蓋股票，因此不會產生新訊號。' : providerError ? '資料恢復後會繼續更新訊號。' : waitingForData ? '行情開始更新後，符合條件的股票會顯示在這裡。' : '目前尚未出現符合條件的新訊號。';
  renderSignals(signals, notifications);
}

async function loadCoverage(watchlist){
  const requestId=++app.coverage.requestId; renderCoverageUnknown(watchlist.length,'正在確認系統名單涵蓋狀態。');
  try{
    const data=await fetchJson('/api/system-universe/coverage',{watchlist}); if(requestId!==app.coverage.requestId)return;
    app.coverage={requestId,lastCheckedAt:Date.now(),data}; renderCoverage(data);
  }catch(error){if(requestId!==app.coverage.requestId)return;app.coverage={requestId,lastCheckedAt:Date.now(),data:null};renderCoverageUnknown(watchlist.length,'目前無法確認系統名單涵蓋狀態，已選股票仍完整保留。');}
}

function renderCoverage(data){
  const {selected,covered,uncovered}=data.counts; const date=`名單更新 ${formatDate(data.updatedDate)}`;
  const metrics=`<div class="coverage-metrics"><span><strong>${selected}</strong>客戶已選</span><span><strong>${covered}</strong>名單涵蓋</span><span><strong>${uncovered}</strong>目前未涵蓋</span></div>`;
  const details=coverageDetails(data.items);
  el.draftCoverage.className='coverage-panel coverage-known'; el.draftCoverage.innerHTML=`<div><strong>系統名單涵蓋狀態</strong><small>${date}</small></div>${metrics}${details}`;
  el.previewCoverage.textContent=`${covered} 檔涵蓋／${uncovered} 檔未涵蓋`; el.previewCoverageDetails.innerHTML=details;
  el.taskCoverage.textContent=`${covered} / ${selected} 檔`; el.workspaceCoverageDetails.innerHTML=`<p>${date}</p>${details}`;
}

function renderCoverageUnknown(selected,message){
  el.draftCoverage.className='coverage-panel coverage-unknown'; el.draftCoverage.innerHTML=`<div><strong>涵蓋狀態未知</strong><small>${escapeHtml(message)}</small></div><div class="coverage-metrics"><span><strong>${selected}</strong>客戶已選</span><span><strong>—</strong>名單涵蓋</span><span><strong>—</strong>目前未涵蓋</span></div>`;
  el.previewCoverage.textContent='涵蓋狀態未知'; el.previewCoverageDetails.innerHTML=`<p>${escapeHtml(message)}</p>`; el.taskCoverage.textContent=`未知（已選 ${selected} 檔）`; el.workspaceCoverageDetails.innerHTML=`<p>${escapeHtml(message)}</p>`;
}

function coverageDetails(items){
  const groups=[['covered','名單涵蓋'],['uncovered','目前未涵蓋']];
  return `<div class="coverage-groups">${groups.map(([status,label])=>{const matches=items.filter((item)=>item.coverage===status);return `<details${status==='uncovered'&&matches.length?' open':''}><summary>${label} ${matches.length} 檔</summary><ul>${matches.map((item)=>`<li><strong>${escapeHtml(item.symbol)}</strong><span>${escapeHtml(item.name||'名稱未提供')}</span></li>`).join('')}</ul></details>`;}).join('')}</div>`;
}

async function toggleMonitoring() { setBusy(true); try { app.data = await apiPost(app.data.settings.enabled ? '/api/monitor/stop' : '/api/monitor/start'); renderWorkspace(); } finally { setBusy(false); } }
function renderSignals(signals, notifications) { el.signalCount.textContent = signals.length; el.emptySignals.hidden = signals.length>0; el.signalsList.replaceChildren(...signals.slice(0,20).map((signal) => { const notification=notifications.find((item)=>item.signalId===signal.id); const indicator=signal.executor==='sma_cross'?`${signal.indicatorLabel} ${formatNumber(signal.currentIndicator)}`:signal.executor==='rsi_wilder_cross'?`${signal.indicatorLabel} ${formatNumber(signal.currentValue)} / 門檻 ${formatNumber(signal.threshold)}`:`前高 ${formatNumber(signal.referenceHigh)} · 成交量 ${formatNumber(signal.volume)} / ${formatNumber(signal.volumeThreshold)}`; const row=document.createElement('article'); row.className='signal-row'; row.innerHTML=`<div><strong>${escapeHtml(signal.symbol)} ${escapeHtml(signal.name||'')}</strong><span>${marketLabel(signal.market)}</span></div><p>${escapeHtml(signal.ruleName||'監控條件成立')}</p><div><strong>${formatNumber(signal.price)}</strong><span>${formatTime(signal.triggeredAt)} · ${notification?.status==='sent'?'已通知':'待通知'}</span></div><details><summary>詳情</summary><small>${escapeHtml(indicator)}</small></details>`; return row; })); }
async function importCsv(event) { const file=event.target.files?.[0]; if(!file)return; const text=await file.text(); el.symbolInput.value=text.split(/\r?\n/).map((line)=>line.split(',')[0].trim()).filter(Boolean).join('\n'); event.target.value=''; await parseInput(); }
function saveDraft(){ localStorage.setItem(STORAGE_KEY,JSON.stringify({step:app.step,draft:app.draft,strategy:app.strategy,editing:app.editing,inputMode:app.inputMode})); } function readDraft(){ try{return JSON.parse(localStorage.getItem(STORAGE_KEY));}catch{return null;} }
function merge(existing, additions){ const map=new Map(existing.map((item)=>[item.symbol,item])); for(const item of additions)map.set(item.symbol,item); return [...map.values()]; }
function isWaiting(data){ return !data.runtime.lastRunAt || (data.runtime.lastProviderStatus==='error' && data.runtime.lastError==='HF_ASSET_NOT_FOUND'); }
function completionState(data){const runtime=data.runtime||{};if(runtime.coverageStatus==='unknown'||runtime.lastProviderStatus==='coverage_unknown')return{status:'監控範圍待確認',text:'設定已啟用；系統確認監控範圍後才會開始條件檢查。'};if(runtime.coverageStatus==='available'&&runtime.effectiveWatchlistCount===0)return{status:'目前沒有涵蓋股票',text:'設定已啟用，但目前沒有股票落在系統監控名單內。'};if(runtime.lastProviderStatus==='error'&&runtime.lastError!=='HF_ASSET_NOT_FOUND')return{status:'行情資料暫時異常',text:'設定已啟用；行情資料恢復後會自動繼續檢查。'};if(isWaiting(data))return{status:'等待今日行情',text:'設定已啟用，取得今日一分鐘行情後會自動開始檢查。'};return{status:'監控中',text:'設定已啟用，系統正在依最新一分鐘資料檢查。'};}
function setBusy(busy){
  app.busy=busy;
  for(const button of document.querySelectorAll('button'))button.disabled=busy;
  el.parseButton.setAttribute('aria-busy', String(busy));
  el.parseButton.innerHTML=busy?'<span class="loading loading-spinner loading-sm" aria-hidden="true"></span>確認中':'確認股票';
  if(!busy)renderDraft();
}
function setParseStatus(text,tone=''){ el.parseStatus.textContent=text; el.parseStatus.className=tone; }
function debounce(callback,delay){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>callback(...args),delay);};}
function formatDate(value){const date=new Date(`${value}T00:00:00+08:00`);return Number.isNaN(date.getTime())?String(value||'未知'):new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Taipei'}).format(date);}
function formatDateTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?String(value||'未知'):new Intl.DateTimeFormat('zh-TW',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Taipei'}).format(date);}
async function fetchJson(url,body){ const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}); const payload=await response.json(); if(!response.ok)throw new Error(payload.error||'REQUEST_FAILED'); return payload; }
async function apiPost(url,body={}){ const payload=await fetchJson(url,body); return payload.state||payload; }
function marketLabel(market){ return market==='TPEx'?'上櫃':'上市'; } function formatTime(value){if(!value)return'尚未更新';const date=new Date(value);return Number.isNaN(date.getTime())?value:new Intl.DateTimeFormat('zh-TW',{hour:'2-digit',minute:'2-digit'}).format(date);} function formatNumber(value){const number=Number(value);return Number.isFinite(number)?new Intl.NumberFormat('zh-TW',{maximumFractionDigits:2}).format(number):'-';} function escapeHtml(value){return String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');}
async function deliverPendingNotifications(notifications){if(!('Notification'in window)||Notification.permission!=='granted')return;for(const notification of notifications.filter((item)=>item.status==='pending')){if(app.seenNotifications.has(notification.id))continue;try{const validation=await fetchJson(`/api/notifications/${encodeURIComponent(notification.id)}/validate`,{});if(!validation.deliver){if(['not_selected','not_covered','signal_missing','strategy_mismatch','not_pending'].includes(validation.reason))app.seenNotifications.add(notification.id);continue;}new Notification(notification.title,{body:notification.message});app.seenNotifications.add(notification.id);await fetch(`/api/notifications/${encodeURIComponent(notification.id)}/ack`,{method:'POST'});}catch{}}}
