import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const projectRoot = new URL('../', import.meta.url).pathname;
const output = new URL('../artifacts/', import.meta.url).pathname;
await mkdir(output, { recursive: true });
const stateDirectory = await mkdtemp(join(tmpdir(), 'watch365-ui-'));
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const baseURL = `http://127.0.0.1:${port}`;
const serverProcess = spawn(process.execPath, ['src/server.js'], {
  cwd: projectRoot,
  env: { ...process.env, INDICATOR_AGENT_PROVIDER: '', INDICATOR_AGENT_MODEL: '', PORT: String(port), WATCH365_DATA_FILE: join(stateDirectory, 'state.json'), WATCH365_INDICATOR_REQUESTS_FILE: join(stateDirectory, 'indicator-requests.json') },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk; });
serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk; });
for (let attempt = 0; attempt < 100; attempt += 1) {
  if (serverProcess.exitCode !== null) throw new Error(`ui_server_exited_${serverProcess.exitCode}: ${serverOutput}`);
  try { if ((await fetch(baseURL)).ok) break; } catch {}
  if (attempt === 99) throw new Error(`ui_server_start_timeout: ${serverOutput}`);
  await new Promise((resolve) => setTimeout(resolve, 50));
}
let browser;

try {
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await desktop.newPage();
  const assertModeSelected=async(target,selectedId)=>{const state=await target.evaluate((id)=>{const selected=document.querySelector(`#${id}`);const other=document.querySelector(`#${id==='manualModeButton'?'textModeButton':'manualModeButton'}`);const style=(node)=>{const value=getComputedStyle(node);return{background:value.backgroundColor,color:value.color,shadow:value.boxShadow};};return{selected:style(selected),other:style(other),selectedAria:selected.getAttribute('aria-selected'),otherAria:other.getAttribute('aria-selected')};},selectedId);if(state.selectedAria!=='true'||state.otherAria!=='false'||JSON.stringify(state.selected)===JSON.stringify(state.other))throw new Error(`mode_selected_style_missing_${selectedId}_${JSON.stringify(state)}`);};
  await page.route('**/api/watchlist/resolve', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.continue();
  });
  await page.goto(baseURL);
  await page.getByRole('heading', { name:'想監控哪些股票？' }).waitFor();
  const visiblePrimaryActions = await page.locator('#step1 .btn-primary:visible').count();
  if (visiblePrimaryActions !== 1) throw new Error(`step1_primary_action_count_${visiblePrimaryActions}`);
  if (await page.locator('#parseButton').evaluate((button) => button.classList.contains('btn-primary'))) throw new Error('parse_button_is_primary');
  await page.locator('#csvInput').setInputFiles({name:'watchlist.csv',mimeType:'text/csv',buffer:Buffer.from('2330\nBAD')});
  await page.getByText('找到 1 檔').waitFor();
  await page.getByPlaceholder('輸入代號，例如 2330、2454、6488').fill('2454,6488');
  await page.getByRole('button', { name: '確認股票' }).click();
  const busyButton = page.getByRole('button', { name: '確認中' });
  await busyButton.waitFor();
  if (!(await busyButton.isDisabled())) throw new Error('parse_button_not_disabled_while_busy');
  if (await busyButton.getAttribute('aria-busy') !== 'true') throw new Error('parse_button_missing_aria_busy');
  await page.getByText('找到 2 檔').waitFor();
  await page.locator('#draftCoverage').getByText('名單涵蓋 3 檔', { exact:true }).waitFor();
  await page.screenshot({ path: `${output}desktop-step1.png`, fullPage: true });
  await page.getByRole('button', { name: '下一步：設定條件' }).click();
  if(!(await page.locator('#manualMode').isVisible())||await page.locator('#agentMode').isVisible())throw new Error('step2_default_mode_not_manual');
  await assertModeSelected(page,'manualModeButton');
  await page.getByRole('tab',{name:'文字描述'}).click();
  if(!(await page.locator('#agentMode').isVisible())||await page.locator('#manualMode').isVisible())throw new Error('step2_modes_not_exclusive');
  await assertModeSelected(page,'textModeButton');
  await page.reload(); await page.getByRole('heading',{name:'什麼情況發生時通知？'}).waitFor(); await assertModeSelected(page,'textModeButton');
  await page.getByRole('tab',{name:'手動設定'}).click(); await assertModeSelected(page,'manualModeButton');
  await page.getByRole('tab',{name:'文字描述'}).click(); await assertModeSelected(page,'textModeButton');
  const indicatorRegistry=await fetch(`${baseURL}/api/indicators`).then((response)=>response.json()); const rsiDefinition=indicatorRegistry.items.find((item)=>item.id==='rsi.cross');
  await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('一分鐘 RSI 14 上穿 30');
  await page.getByRole('button',{name:'解析需求'}).click();
  await page.getByText('Agent 尚未設定模型服務，仍可使用下方手動設定。',{exact:true}).waitFor();
  if((await page.getByLabel('監控條件').inputValue())!=='legacy.breakout-volume@1.0.0')throw new Error('unconfigured_agent_changed_strategy');
  const rsiProposal={id:'rsi.cross',version:'1.0.0',timeframe:'1m',definitionFingerprint:rsiDefinition.fingerprint,params:{period:14,threshold:30}};
  let agentDelayMs=0; let requestSubmitFailure=false; let requestDelayQueue=[];
  await page.route('**/api/indicator-agent/parse',async(route)=>{if(agentDelayMs)await new Promise((resolve)=>setTimeout(resolve,agentDelayMs));const text=JSON.parse(route.request().postData()||'{}').text;const result=text.includes('公式測試')?{status:'formula',summary:'MACD 上穿訊號線 · 一分鐘',formulaSummary:'(EMA(收盤價, 12) - EMA(收盤價, 26)) 向上穿越 EMA((EMA(收盤價, 12) - EMA(收盤價, 26)), 9)',proposal:{fingerprint:'a'.repeat(64),warmupBars:35},proposalId:'11111111-1111-4111-8111-111111111111',proposalToken:'signed-test-token'}:text.includes('MACD')||text.includes('布林')?{status:'unsupported',reason:'目前尚未支援這項指標。',requestDraft:{requestedIndicator:'other',requestedTimeframe:'unknown',requestedDirection:'unknown',params:{period:null,threshold:null}}}:text.includes('新指標')?{status:'clarification',question:'請補充指標名稱、週期與條件。',proposal:null,summary:null}:{status:'matched',proposal:rsiProposal,summary:'RSI 上穿門檻（RSI 期數 14、上穿門檻 30） · M1 · v1.0.0'};await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});});
  await page.route('**/api/indicator-agent/confirm',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({proposal:rsiProposal})}));
  await page.route('**/api/indicator-requests',async(route)=>{if(route.request().method()==='POST'){const delay=requestDelayQueue.shift()||0;if(delay)await new Promise((resolve)=>setTimeout(resolve,delay));if(requestSubmitFailure){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'INDICATOR_REQUEST_SAVE_FAILED'})});return;}}await route.continue();});
  await page.getByRole('button',{name:'解析需求'}).click(); await page.getByText('需要你確認',{exact:true}).waitFor();
  if((await page.getByLabel('監控條件').inputValue())!=='legacy.breakout-volume@1.0.0')throw new Error('agent_applied_without_confirmation');
  await page.getByRole('button',{name:'確認帶入'}).click(); await page.getByLabel('上穿門檻').waitFor();
  if(!(await page.locator('#manualMode').isVisible())||await page.locator('#agentMode').isVisible())throw new Error('agent_confirmation_did_not_return_to_manual');
  if((await page.getByLabel('上穿門檻').inputValue())!=='30')throw new Error('agent_confirmation_did_not_fill_form');
  if((await fetch(`${baseURL}/api/state`).then((response)=>response.json())).settings.strategy.id!=='legacy.breakout-volume')throw new Error('agent_confirmation_persisted_without_activation');
  await page.getByRole('tab',{name:'文字描述'}).click();await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('公式測試');await page.getByRole('button',{name:'解析需求'}).click();await page.getByRole('button',{name:'套用並啟用'}).waitFor();await page.getByText(/EMA\(收盤價, 12\)/).waitFor();await page.screenshot({path:`${output}desktop-formula-confirmation.png`,fullPage:true});await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('公式測試已修改');if(await page.getByRole('button',{name:'套用並啟用'}).isVisible())throw new Error('formula_input_change_kept_stale_token');
  await page.getByRole('tab',{name:'文字描述'}).click();await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('一分鐘 RSI 14 上穿 30'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByRole('button',{name:'確認帶入'}).waitFor();
  await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('幫我做 MACD');
  if(await page.getByRole('button',{name:'確認帶入'}).isVisible())throw new Error('agent_input_change_kept_stale_proposal');
  agentDelayMs=250; await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('slow parse'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByRole('tab',{name:'手動設定'}).click();
  await page.getByLabel('監控條件').selectOption('sma.cross@1.0.0');
  if(!(await page.locator('#agentParseButton').isEnabled()))throw new Error('manual_change_left_agent_button_disabled');
  await page.waitForTimeout(350); if(await page.getByRole('button',{name:'確認帶入'}).isVisible())throw new Error('stale_parse_survived_manual_change');
  await page.getByRole('tab',{name:'文字描述'}).click(); agentDelayMs=250; await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('slow leave'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByRole('button',{name:'返回選股票'}).click(); await page.waitForTimeout(350); await page.getByRole('button',{name:'下一步：設定條件'}).click();
  if(await page.getByRole('button',{name:'確認帶入'}).isVisible())throw new Error('stale_parse_survived_step_change');
  if(!(await page.getByRole('button',{name:'解析需求'}).isEnabled()))throw new Error('step_change_left_agent_button_disabled');
  agentDelayMs=0; await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('我要新指標'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByText('請補充指標名稱、週期與條件。',{exact:true}).waitFor(); if(await page.getByRole('button',{name:'提出新指標需求'}).isVisible())throw new Error('clarification_exposed_request_submission');
  const stateBeforeIndicatorRequest=await fetch(`${baseURL}/api/state`).then((response)=>response.json()); await page.locator('#agentInput').fill('請支援 MACD 黃金交叉'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByRole('button',{name:'提出新指標需求'}).click(); await page.getByText('確認需求摘要',{exact:true}).waitFor();
  await page.getByRole('button',{name:'送出需求'}).click(); await page.getByText('請補齊指標名稱、具體資料週期、參數或定義，以及觸發條件。',{exact:true}).waitFor();
  await page.getByLabel('指標名稱').fill('MACD'); await page.getByLabel('資料週期').selectOption('1m'); await page.getByLabel('參數或計算定義').fill('快線 12、慢線 26、訊號線 9'); await page.getByLabel('觸發條件').fill('MACD 線向上穿越訊號線');
  requestSubmitFailure=true; await page.getByRole('button',{name:'送出需求'}).click(); await page.getByText(/需求未送出/).waitFor(); if(await page.getByText('需求已送出，狀態為待評估。',{exact:true}).count())throw new Error('failed_request_rendered_as_success');
  requestSubmitFailure=false; await page.getByRole('button',{name:'送出需求'}).click(); await page.getByText('需求已送出，狀態為待評估。',{exact:true}).waitFor(); await page.getByText('待評估',{exact:true}).waitFor(); await page.screenshot({path:`${output}desktop-indicator-request.png`,fullPage:true});
  const stateAfterIndicatorRequest=await fetch(`${baseURL}/api/state`).then((response)=>response.json()); if(JSON.stringify(stateBeforeIndicatorRequest.settings)!==JSON.stringify(stateAfterIndicatorRequest.settings))throw new Error('indicator_request_changed_monitor_settings');
  await page.reload(); await page.getByRole('heading',{name:'什麼情況發生時通知？'}).waitFor(); await page.getByRole('button',{name:'查看已提交需求'}).click(); await page.getByText('請支援 MACD 黃金交叉',{exact:true}).waitFor(); await page.getByText('待評估',{exact:true}).waitFor(); await page.getByText('查看完整需求',{exact:true}).click(); await page.getByText('快線 12、慢線 26、訊號線 9',{exact:true}).waitFor(); await page.getByText('MACD 線向上穿越訊號線',{exact:true}).waitFor();
  await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('請支援布林通道突破');await page.getByRole('button',{name:'解析需求'}).click();await page.getByRole('button',{name:'提出新指標需求'}).click();await page.getByLabel('指標名稱').fill('布林通道');await page.getByLabel('資料週期').selectOption('1m');await page.getByLabel('參數或計算定義').fill('期間 20、標準差 2');await page.getByLabel('觸發條件').fill('價格突破上軌');requestDelayQueue=[150,400];await page.getByRole('button',{name:'送出需求'}).click();if(!(await page.getByRole('button',{name:'取消'}).isDisabled())||!(await page.getByLabel('指標名稱').isDisabled()))throw new Error('pending_request_form_not_locked');await page.getByRole('tab',{name:'手動設定'}).click();await page.getByRole('tab',{name:'文字描述'}).click();await page.getByRole('button',{name:'解析需求'}).click();await page.getByRole('button',{name:'提出新指標需求'}).click();await page.getByLabel('指標名稱').fill('新的未送出名稱');await page.getByLabel('資料週期').selectOption('1m');await page.getByLabel('參數或計算定義').fill('期間 20、標準差 2');await page.getByLabel('觸發條件').fill('價格突破上軌');await page.getByRole('button',{name:'送出需求'}).click();await page.waitForTimeout(220);if(!(await page.locator('#requestConfirm').isVisible())||(await page.getByLabel('指標名稱').inputValue())!=='新的未送出名稱'||!(await page.getByLabel('指標名稱').isDisabled()))throw new Error('stale_request_response_overwrote_newer_form');await page.getByText('需求已送出，狀態為待評估。',{exact:true}).waitFor();
  agentDelayMs=0; await page.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('一分鐘 RSI 14 上穿 30'); await page.getByRole('button',{name:'解析需求'}).click(); await page.getByRole('button',{name:'確認帶入'}).waitFor(); await page.getByRole('tab',{name:'手動設定'}).click();
  await page.getByLabel('監控條件').selectOption('sma.cross@1.0.0');
  await page.getByLabel('SMA 期數').fill('10');
  await page.reload(); await page.getByRole('heading',{name:'什麼情況發生時通知？'}).waitFor();
  if((await page.getByLabel('SMA 期數').inputValue())!=='10')throw new Error('step2_draft_not_restored_after_reload');
  await page.locator('#strategyDescription').getByText('使用已完成的一分鐘 K', { exact:true }).waitFor();
  await page.screenshot({ path: `${output}desktop-step2.png`, fullPage: true });
  await page.getByRole('button', { name: '下一步：查看結果' }).click();
  await page.locator('#previewCoverage').getByText('3 檔涵蓋／0 檔未涵蓋', { exact:true }).waitFor();
  await page.getByText('尚未啟用', { exact: true }).waitFor();
  await page.screenshot({ path: `${output}desktop-step3.png`, fullPage: true });
  await page.getByRole('button', { name: '啟用這個監控' }).click();
  await page.getByText('監控設定已啟用').waitFor(); await page.getByRole('button',{name:'查看監控工作台'}).waitFor({state:'visible'}); if(!(await page.getByRole('button',{name:'查看監控工作台'}).isEnabled()))throw new Error('step4_workspace_button_still_disabled');
  await page.screenshot({ path: `${output}desktop-step4.png`, fullPage: true });
  await page.getByRole('button', { name: '查看監控工作台' }).click();
  await page.getByText('目前過濾結果').waitFor();
  await page.locator('#taskRule').getByText('價格上穿 SMA（SMA 期數 10） · 一分鐘', { exact:true }).waitFor();
  await page.locator('#taskCoverage').getByText('3 / 3 檔', { exact:true }).waitFor();
  await page.screenshot({ path: `${output}desktop-workspace.png`, fullPage: true });
  await page.reload();
  await page.locator('#taskRule').getByText('價格上穿 SMA（SMA 期數 10） · 一分鐘', { exact:true }).waitFor();
  const expectedUniverse=await fetch(`${baseURL}/api/system-universe?page=1&pageSize=50`).then((response)=>response.json());
  if(!expectedUniverse.total||!expectedUniverse.items?.length)throw new Error('system_universe_empty');
  const searchTarget=expectedUniverse.items[0];
  await page.getByRole('button', { name: '系統監控名單' }).click();
  await page.locator('#universeStatus strong').getByText('系統監控名單已載入', { exact:true }).waitFor();
  await page.getByText(`${expectedUniverse.total} 檔`, { exact:true }).waitFor();
  if (await page.locator('#universeRows tr').count() !== Math.min(50,expectedUniverse.total)) throw new Error('system_universe_page_size');
  await page.getByPlaceholder('搜尋代號或名稱').fill(searchTarget.symbol);
  await page.getByText(searchTarget.symbol, { exact:true }).waitFor();
  if(searchTarget.name)await page.getByText(searchTarget.name, { exact:true }).waitFor();
  await page.getByPlaceholder('搜尋代號或名稱').fill('');
  await page.getByText(`共 ${expectedUniverse.total} 檔`, { exact:true }).waitFor();
  if(expectedUniverse.pages>1){await page.getByRole('button', { name:'下一頁' }).click();await page.getByText(`第 2 / ${expectedUniverse.pages} 頁`, { exact:true }).waitFor();}
  await page.screenshot({ path: `${output}desktop-system-universe.png`, fullPage: true });
  await page.getByRole('button', { name:'返回工作台' }).click();
  const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (desktopOverflow) throw new Error('desktop_horizontal_overflow');
  await desktop.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobile.newPage();
  await mobilePage.route('**/api/indicator-agent/parse',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'unsupported',reason:'目前尚未支援 MACD。',requestDraft:{requestedIndicator:'other',requestedTimeframe:'unknown',requestedDirection:'unknown',params:{period:null,threshold:null}}})}));
  await mobilePage.goto(baseURL);
  await mobilePage.getByRole('heading', { name: '價格上穿 SMA監控' }).waitFor();
  await mobilePage.screenshot({ path: `${output}mobile-workspace.png`, fullPage: true });
  await mobilePage.getByRole('button', { name:'系統監控名單' }).click();
  await mobilePage.locator('#universeStatus strong').getByText('系統監控名單已載入', { exact:true }).waitFor();
  await mobilePage.screenshot({ path: `${output}mobile-system-universe.png`, fullPage: true });
  const universeOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (universeOverflow) throw new Error('mobile_system_universe_horizontal_overflow');
  await mobilePage.getByRole('button', { name:'返回工作台' }).click();
  const mobileOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (mobileOverflow) throw new Error('mobile_horizontal_overflow');
  await mobilePage.getByRole('button', { name: '調整設定' }).click();
  await mobilePage.getByRole('heading', { name: '想監控哪些股票？' }).waitFor();
  await mobilePage.screenshot({ path: `${output}mobile-step1.png`, fullPage: true });
  await mobilePage.getByRole('button', { name:'下一步：設定條件' }).click();
  await mobilePage.getByRole('tab',{name:'文字描述'}).click(); await mobilePage.getByPlaceholder('例如：一分鐘 RSI 14 上穿 30').fill('請支援 MACD 黃金交叉'); await mobilePage.getByRole('button',{name:'解析需求'}).click(); await mobilePage.getByRole('button',{name:'提出新指標需求'}).click(); await mobilePage.getByText('確認需求摘要',{exact:true}).waitFor(); await mobilePage.screenshot({path:`${output}mobile-indicator-request.png`,fullPage:true});
  if(await mobilePage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('mobile_indicator_request_horizontal_overflow');
  await mobilePage.getByRole('button',{name:'取消'}).click(); await mobilePage.getByRole('tab',{name:'手動設定'}).click();
  await mobilePage.getByLabel('監控條件').selectOption('rsi.cross@1.0.0');
  await mobilePage.getByLabel('RSI 期數').fill('14');
  await mobilePage.getByLabel('上穿門檻').fill('65');
  await mobilePage.getByText('Wilder RSI 由下往上穿越指定值。').waitFor();
  await mobilePage.screenshot({ path: `${output}mobile-step2-indicators.png`, fullPage: true });
  if(await mobilePage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('mobile_strategy_horizontal_overflow');
  await mobilePage.getByRole('button',{name:'下一步：查看結果'}).click(); await mobilePage.getByRole('heading',{name:'確認後開始監控'}).waitFor(); await mobilePage.locator('#previewCoverage').getByText('3 檔涵蓋／0 檔未涵蓋',{exact:true}).waitFor();
  await mobilePage.screenshot({path:`${output}mobile-step3.png`,fullPage:true});
  await mobilePage.getByRole('button',{name:'啟用這個監控'}).click(); await mobilePage.getByText('監控設定已啟用').waitFor(); await mobilePage.getByRole('button',{name:'查看監控工作台'}).waitFor();
  await mobilePage.screenshot({path:`${output}mobile-step4.png`,fullPage:true});
  if(await mobilePage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('mobile_onboarding_horizontal_overflow');
  await mobile.close();

  const baseState = await fetch(`${baseURL}/api/state`).then((response) => response.json());
  const formulaState=structuredClone(baseState);formulaState.settings.strategy={id:'formula.custom',version:'formula.v1',executor:'formula_v1',name:'MACD 上穿訊號線',timeframe:'1m',source:'db/m1_live/{tradingDate}.parquet',definitionFingerprint:'a'.repeat(64),params:{},formula:{summary:'MACD 向上穿越訊號線',warmupBars:35,ast:{op:'gte',left:{op:'source',field:'close'},right:{op:'constant',value:1}}},activatedAt:'2026-09-26T01:00:00.000Z'};formulaState.settings.monitorTask={name:'MACD 上穿訊號線監控',onboardingCompleted:true,completedAt:'2026-09-26T01:00:00.000Z'};
  const formulaContext=await browser.newContext({viewport:{width:390,height:844}});const formulaPage=await formulaContext.newPage();await formulaPage.route('**/api/state',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(formulaState)}));await formulaPage.goto(baseURL);await formulaPage.locator('#taskRule').getByText(/MACD 向上穿越訊號線/).waitFor();await formulaPage.getByRole('button',{name:'調整設定'}).click();await formulaPage.getByRole('button',{name:'下一步：設定條件'}).click();if((await formulaPage.getByLabel('監控條件').inputValue())!=='formula.custom@formula.v1')throw new Error('formula_strategy_replaced_on_edit');await formulaPage.getByText('MACD 向上穿越訊號線',{exact:false}).first().waitFor();await formulaPage.reload();if((await formulaPage.getByLabel('監控條件').inputValue())!=='formula.custom@formula.v1')throw new Error('formula_strategy_replaced_on_reload');if(await formulaPage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('mobile_formula_strategy_horizontal_overflow');await formulaPage.screenshot({path:`${output}mobile-formula-preserved.png`,fullPage:true});await formulaContext.close();
  const selectedTen=Array.from({length:10},(_,index)=>({symbol:String(1000+index),name:`股票${index}`,market:index%2?'TPEx':'TWSE'}));
  const coverageState=structuredClone(baseState); coverageState.settings.watchlist=selectedTen; coverageState.settings.monitorTask.onboardingCompleted=true;
  coverageState.runtime={...coverageState.runtime,coverageStatus:'available',coverageRevision:'fixture-rev',coverageUpdatedDate:'2026-09-25',selectedWatchlistCount:10,effectiveWatchlistCount:6,uncoveredWatchlistCount:4,effectiveWatchlist:selectedTen.slice(0,6).map((item)=>item.symbol)};
  const coverageBody=(coveredSymbols)=>({status:'available',updatedDate:'2026-09-25',universeTotal:500,counts:{selected:10,covered:coveredSymbols.length,uncovered:10-coveredSymbols.length},items:selectedTen.map((item)=>({...item,coverage:coveredSymbols.includes(item.symbol)?'covered':'uncovered'}))});
  let coverageFixture={status:200,body:coverageBody(selectedTen.slice(0,6).map((item)=>item.symbol))};
  const coverageContext=await browser.newContext({viewport:{width:1440,height:900}}); const coveragePage=await coverageContext.newPage();
  await coveragePage.route('**/api/state',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(coverageState)}));
  await coveragePage.route('**/api/system-universe/coverage',(route)=>route.fulfill({status:coverageFixture.status,contentType:'application/json',body:JSON.stringify(coverageFixture.body)}));
  await coveragePage.goto(baseURL); await coveragePage.locator('#taskCoverage').getByText('6 / 10 檔',{exact:true}).waitFor(); await coveragePage.locator('#workspaceCoverageDetails').getByText('目前未涵蓋 4 檔',{exact:true}).waitFor();
  await coveragePage.screenshot({path:`${output}desktop-coverage-10-6-4.png`,fullPage:true});
  coverageFixture={status:200,body:coverageBody(selectedTen.slice(5).map((item)=>item.symbol))}; await coveragePage.reload(); await coveragePage.locator('#taskCoverage').getByText('5 / 10 檔',{exact:true}).waitFor();
  coverageFixture={status:503,body:{status:'unknown',error:'HF_UNIVERSE_SOURCE_FAILED'}}; await coveragePage.reload(); await coveragePage.locator('#taskCoverage').getByText('未知（已選 10 檔）',{exact:true}).waitFor();
  if(await coveragePage.getByText('0 / 10 檔',{exact:true}).count())throw new Error('unknown_coverage_rendered_as_zero');
  await coverageContext.close();

  const coverageMobile=await browser.newContext({viewport:{width:390,height:844}}); const coverageMobilePage=await coverageMobile.newPage(); coverageFixture={status:200,body:coverageBody(selectedTen.slice(0,6).map((item)=>item.symbol))};
  await coverageMobilePage.route('**/api/state',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(coverageState)}));
  await coverageMobilePage.route('**/api/system-universe/coverage',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(coverageFixture.body)}));
  await coverageMobilePage.goto(baseURL); await coverageMobilePage.locator('#taskCoverage').getByText('6 / 10 檔',{exact:true}).waitFor();
  if(await coverageMobilePage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth))throw new Error('mobile_coverage_horizontal_overflow');
  await coverageMobilePage.screenshot({path:`${output}mobile-coverage-10-6-4.png`,fullPage:true}); await coverageMobile.close();
  async function checkWorkspaceState(name, state, expectedText, expectedMetrics, viewport = { width: 390, height: 844 }) {
    const context = await browser.newContext({ viewport });
    const statePage = await context.newPage();
    await statePage.route('**/api/state', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) }));
    await statePage.goto(baseURL);
    for (const text of expectedText) await statePage.getByText(text, { exact: false }).first().waitFor();
    const metrics = await Promise.all(['checkedCount','matchedCount','waitingCount'].map((id) => statePage.locator(`#${id}`).textContent()));
    if (metrics.join(',') !== expectedMetrics.join(',')) throw new Error(`${name}_metrics_${metrics.join('_')}`);
    const overflow = await statePage.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (overflow) throw new Error(`${name}_horizontal_overflow`);
    await statePage.screenshot({ path: `${output}mobile-workspace-${name}.png`, fullPage: true });
    await context.close();
  }

  const activeState = structuredClone(baseState);
  activeState.runtime = { ...activeState.runtime, lastRunAt: new Date().toISOString(), lastProviderStatus: 'ok', lastError: null, coverageStatus:'available', effectiveWatchlistCount:activeState.settings.watchlist.length, uncoveredWatchlistCount:0, effectiveWatchlist:activeState.settings.watchlist.map((item)=>item.symbol) };
  activeState.quotes = activeState.settings.watchlist.map(({ symbol }) => ({ symbol }));
  activeState.signals = [];
  await checkWorkspaceState('active-empty', activeState, ['監控運作正常', '本輪已完成檢查，目前尚未有股票符合條件。'], ['3','0','0']);

  const errorState = structuredClone(activeState);
  errorState.runtime = { ...errorState.runtime, lastProviderStatus: 'error', lastError: 'HF_DOWNLOAD_FAILED' };
  await checkWorkspaceState('provider-error', errorState, ['目前無法取得行情資料', '本輪尚未完成篩選'], ['0','0','3']);

  const scopeUnknownState=structuredClone(activeState);
  scopeUnknownState.runtime={...scopeUnknownState.runtime,lastProviderStatus:'coverage_unknown',lastError:'HF_UNIVERSE_SOURCE_FAILED',coverageStatus:'unknown',effectiveWatchlistCount:null,effectiveWatchlist:[]};
  await checkWorkspaceState('scope-unknown',scopeUnknownState,['目前無法確認系統監控範圍','本輪未執行股票條件判定'],['—','0','—']);

  const emptyScopeState=structuredClone(activeState);
  emptyScopeState.runtime={...emptyScopeState.runtime,lastProviderStatus:'empty_scope',lastError:null,coverageStatus:'available',effectiveWatchlistCount:0,uncoveredWatchlistCount:emptyScopeState.settings.watchlist.length,effectiveWatchlist:[]};
  await checkWorkspaceState('empty-scope',emptyScopeState,['目前沒有系統名單涵蓋股票','本輪沒有股票進入條件判定'],['0','0','0']);

  const signalState = structuredClone(activeState);
  signalState.signals = [{ id:'ui-test-signal', symbol:'2330', name:'台積電', market:'TWSE', price:900, triggeredAt:new Date().toISOString(), referenceHigh:895, volume:200, volumeThreshold:180 }];
  signalState.notifications = [{ id:'ui-test-notification', signalId:'ui-test-signal', status:'pending' }];
  await checkWorkspaceState('active-signal', signalState, ['目前有 1 檔', '2330 台積電'], ['3','1','0']);

  const pausedState = structuredClone(activeState);
  pausedState.settings.enabled = false;
  await checkWorkspaceState('paused-empty', pausedState, ['監控目前暫停', '本輪已完成檢查，目前尚未有股票符合條件。'], ['3','0','0']);

  const pausedWaitingState = structuredClone(baseState);
  pausedWaitingState.settings.enabled = false;
  pausedWaitingState.runtime={...pausedWaitingState.runtime,coverageStatus:'available',effectiveWatchlistCount:pausedWaitingState.settings.watchlist.length,uncoveredWatchlistCount:0,effectiveWatchlist:pausedWaitingState.settings.watchlist.map((item)=>item.symbol)};
  await checkWorkspaceState('paused-waiting-mobile', pausedWaitingState, ['監控目前暫停', '目前仍在等待今日行情', '等待今日 M1 行情；完整 K 棒到達後會自動檢查指標條件'], ['0','0','3']);
  await checkWorkspaceState('paused-waiting-desktop', pausedWaitingState, ['監控目前暫停', '目前仍在等待今日行情', '等待今日 M1 行情；完整 K 棒到達後會自動檢查指標條件'], ['0','0','3'], { width:1440, height:900 });

  const pausedErrorState = structuredClone(errorState);
  pausedErrorState.settings.enabled = false;
  await checkWorkspaceState('paused-provider-error', pausedErrorState, ['監控目前暫停', '目前行情資料異常', '本輪尚未完成篩選'], ['0','0','3']);

  const pausedSignalState = structuredClone(signalState);
  pausedSignalState.settings.enabled = false;
  await checkWorkspaceState('paused-signal', pausedSignalState, ['監控目前暫停', '目前有 1 檔', '2330 台積電'], ['3','1','0']);

  async function checkUniverseResponse(name, response, expectedText) {
    const context=await browser.newContext({viewport:{width:390,height:844}}); const statePage=await context.newPage();
    await statePage.route('**/api/state',(route)=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(activeState)}));
    await statePage.route('**/api/system-universe**',(route)=>route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(response.body)}));
    await statePage.goto(baseURL); await statePage.getByRole('button',{name:'系統監控名單'}).click();
    for(const text of expectedText)await statePage.getByText(text,{exact:false}).first().waitFor();
    await context.close();
  }
  await checkUniverseResponse('missing',{status:503,body:{status:'missing',error:'HF_UNIVERSE_NOT_FOUND'}},['目前沒有系統監控名單']);
  await checkUniverseResponse('error',{status:503,body:{status:'error',error:'HF_UNIVERSE_SOURCE_FAILED'}},['目前無法取得系統監控名單']);
  console.log(JSON.stringify({ desktop: 'ok', mobile: 'ok', onboarding: 'step1-step4', coverage:{example:'10/6/4',revisionChange:'recomputed',unknown:'not-zero'}, systemUniverse: { observedTotal:expectedUniverse.total, search:'ok', pagination:'ok', states:['available','missing','error'] }, states: ['waiting','active-empty','provider-error','scope-unknown','empty-scope','active-signal','paused-empty','paused-waiting','paused-provider-error','paused-signal'], overflow: false, isolatedState: true }));
} finally {
  await browser?.close();
  serverProcess.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => serverProcess.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2000))
  ]);
  await rm(stateDirectory, { recursive: true, force: true });
}
