import {chromium} from 'playwright';
import {mkdir,readFile} from 'node:fs/promises';

const base=process.env.PROTOTYPE_URL||'http://localhost:3666/ui-prototype.html';
const output=new URL('../artifacts/',import.meta.url).pathname;
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let apiRequests=0;
const watchApi=(page)=>page.on('request',(request)=>{if(new URL(request.url()).pathname.startsWith('/api/'))apiRequests++;});
const expect=(value,message)=>{if(!value)throw new Error(message);};

try{
  const desktop=await browser.newContext({viewport:{width:1440,height:900}}),page=await desktop.newPage();watchApi(page);
  await page.goto(base);await page.getByRole('button',{name:/盯指定股票/}).click();
  await page.getByLabel('搜尋股票').fill('台積');await page.getByText('2330 台積電').click();await page.getByRole('button',{name:'選好了'}).click();
  expect(page.url().endsWith('#conditions'),'conditions_route_missing');
  await page.getByLabel('搜尋指標').fill('RSI');await page.getByRole('button',{name:/RSI 上穿/}).click();
  await page.getByLabel('期數').fill('12');await page.getByLabel('期數').fill('13');await page.getByLabel('期數').fill('14');await page.waitForTimeout(240);
  expect((await page.locator('#historySignature').textContent()).includes('RSI 上穿／下穿 14'),'latest_edit_not_rendered');
  await page.getByLabel('期數').fill('1');await page.getByText('歷史事件已清空').waitFor();
  expect(await page.locator('#historyRows .proto-history-row').count()===0,'stale_history_not_cleared');
  expect(await page.getByRole('button',{name:'確認設定'}).isDisabled(),'invalid_confirm_enabled');
  expect(await page.getByRole('button',{name:'加入這個條件'}).isDisabled(),'invalid_add_enabled');
  await page.getByLabel('期數').fill('37');await page.getByLabel('門檻').fill('44');await page.waitForTimeout(240);
  await page.getByRole('button',{name:'加入這個條件'}).click();
  await page.getByLabel('期數').fill('38');expect(await page.getByRole('button',{name:'確認設定'}).isDisabled(),'debounce_confirm_enabled');await page.waitForTimeout(240);
  await page.getByText(/RSI 上穿／下穿 38 上穿 44/).first().waitFor();
  const rows=page.locator('#historyRows .proto-history-row:not(.header)'),triggerCount=Number(await page.locator('#historyMetrics strong').nth(0).textContent());
  expect(await rows.count()===triggerCount,'trigger_count_mismatch');
  const times=await rows.locator('time').allTextContents();expect(times.every((value)=>/^2026-\d\d-\d\d \d\d:\d\d:00$/.test(value)),'timestamp_format_invalid');
  const fixtureSource=await readFile(new URL('../public/ui-prototype.js',import.meta.url),'utf8');
  const fixtureDays=[...fixtureSource.match(/const FIXTURE_DAYS=\[([^\]]+)\]/)?.[1].matchAll(/\d{4}-\d\d-\d\d/g)||[]].map((match)=>match[0]);
  expect(fixtureDays.length===30&&new Set(fixtureDays).size===30,'fixture_day_count_invalid');
  expect(times.every((value)=>fixtureDays.includes(value.slice(0,10))),'event_outside_fixture_days');
  const symbols=await rows.locator('span:first-child strong').allTextContents();expect(new Set(symbols).size<symbols.length,'expected_repeated_stock_times');
  await page.reload();expect(await page.getByLabel('期數').inputValue()==='38','refresh_lost_params');
  await page.getByLabel('搜尋指標').fill('MA20 上穿');await page.getByRole('button',{name:'提出需求'}).click();
  expect(await page.getByLabel('需求描述').inputValue()==='MA20 上穿','query_not_carried');await page.getByRole('button',{name:'送出示例驗證'}).click();
  await page.getByRole('heading',{name:'MA 要使用哪種算法？'}).waitFor();await page.getByRole('button',{name:/EMA 指數/}).click();
  await page.getByText(/EMA 移動平均線 已通過示例驗證/).waitFor();expect(page.url().endsWith('#conditions'),'autoadd_not_returned');
  await page.getByRole('button',{name:'加入這個條件'}).click();
  expect((await page.locator('#historySignature').textContent()).includes('＋'),'multi_condition_history_missing');
  await page.getByRole('button',{name:'確認設定'}).click();await page.getByText(/固定 30 個原型示例交易日・M1・Asia\/Taipei/).waitFor();
  expect((await page.locator('.proto-summary').textContent()).includes('RSI 上穿／下穿 38 上穿 44'),'confirm_missing_rsi');
  expect((await page.locator('.proto-summary').textContent()).includes('EMA 移動平均線'),'confirm_missing_ema');
  await page.getByRole('button',{name:'返回修改'}).click();await page.locator('.proto-history').waitFor();await page.screenshot({path:`${output}ui-prototype-desktop-conditions.png`,fullPage:true});
  await page.locator('[data-remove]').nth(1).click();expect(!(await page.locator('#historySignature').textContent()).includes('EMA 移動平均線'),'deleted_condition_still_in_history');
  for(const legacy of ['library','params','preview']){await page.goto(`${base}#${legacy}`);await page.waitForURL((url)=>url.hash==='#conditions');expect(await page.locator('#historyStatus').textContent()==='已更新',`legacy_${legacy}_history_stale`);}
  const stored=await page.evaluate(()=>({prototype:localStorage.getItem('watch365_ui_prototype_v1'),product:localStorage.getItem('watch365_draft_v3')}));
  expect(stored.prototype&&!stored.product,'prototype_storage_isolation_failed');expect(!(await page.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)),'desktop_overflow');await desktop.close();

  const mobile=await browser.newContext({viewport:{width:390,height:844}}),mobilePage=await mobile.newPage();watchApi(mobilePage);
  await mobilePage.goto(base);await mobilePage.getByRole('button',{name:/用條件找股票/}).click();await mobilePage.getByRole('button',{name:'加入這個條件'}).click();
  await mobilePage.screenshot({path:`${output}ui-prototype-mobile-conditions.png`,fullPage:true});
  expect(!(await mobilePage.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth)),'mobile_overflow');await mobile.close();
  expect(apiRequests===0,`prototype_api_requests:${apiRequests}`);
  console.log(JSON.stringify({phases:3,canonicalRoute:'conditions',fixedFixtureDays:30,debounceLatestOnly:true,invalidClears:true,multiCondition:true,apiRequests,desktop:'1440x900',mobile:'390x844',overflow:false}));
}finally{await browser.close();}
