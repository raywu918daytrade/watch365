# 幫你盯盤 MVP

台股第一階段的本機盯盤服務。唯一正式資料來源是 Hugging Face Dataset，沒有其他資料來源或 fallback。

## 介面

`http://localhost:3650` 是唯一的前端（`public/index.html`、`public/app.js`、`public/app.css`），流程依 [`docs/ui-prototype-flow.md`](docs/ui-prototype-flow.md)：選範圍 → 條件 → 確認，並透過 `POST /api/monitor/configure` 建立真實監控。

- 條件：RSI（僅上穿）、SMA、EMA（上穿／下穿），最多組合 2 個且需同時成立；RSI 不能與其他條件組合。單一 RSI／SMA 上穿使用 registry 策略，其餘轉成 `formula_v1` 公式。
- 「用條件找股票」會設定 `scopeMode: universe`，每輪依 HF 最新系統名單重建 watchlist，不凍結結果。
- 條件頁可回查過去 7 個交易日的 M1 觸發時間點（`POST /api/history/backtest`）。
- 介面原則（2026-09 UI/UX 優化）：幫客戶盯盤、不是看盤軟體（不放線圖或外部看盤連結）；文案只描述條件，不帶「超賣／轉強」等判斷用語，並標示非投資建議；監控範圍稱「今日監控名單（有成交量的股票）」而非全市場。
- 回訪優先：首頁置頂「我的監控」摘要與今日觸發數；頂部依 Asia/Taipei 顯示盤前／盤中／已收盤／休市（國定假日需後端行事曆，尚未支援）。
- 台股慣例：上穿標紅、下穿標綠；觸發紀錄今日只顯示時間並標示上市／上櫃。

## LINE 通知

`src/line.js` 用 LINE Messaging API（LINE Notify 已於 2025 年停止）。設定 `LINE_CHANNEL_SECRET` 與 `LINE_CHANNEL_ACCESS_TOKEN`（long-lived）才會啟用，沒設定時「我的監控」不顯示 LINE 區塊；`PUBLIC_SITE_URL` 選填，放在訊息結尾（預設 https://watch365.just1stock.com）。LINE Developers 的 Webhook URL 設為 `https://<網域>/api/line/webhook` 並開啟 Use webhook，官方帳號的自動回應要關掉。

- 綁定：「我的監控 → 綁定 LINE」向 `POST /api/line/link-code` 取得 6 位數綁定碼（10 分鐘、存在記憶體），附 QR code 與預填綁定碼的 `line.me/R/oaMessage` 連結；使用者把綁定碼傳給官方帳號，webhook（驗 `X-Line-Signature`）把 `{ userId, displayName, visitor }` 存進 state 的 `line.users`。這份名單不在 `publicState` 裡，每個瀏覽器只看得到自己綁的帳號（`GET /api/line/status`）。封鎖官方帳號（unfollow）或 `POST /api/line/unlink` 會移除。
- 推播：每輪監控的新觸發合併成一則訊息，送給所有綁定的帳號（`push`／`multicast`，省每月免費額度），結果記在通知的 `line: 'sent'|'failed'`，觸發紀錄顯示「LINE 已通知」。`POST /api/line/test` 送測試訊息。

## 資料保存與備份

正式環境自 2026-10-20 起設 `STORAGE=files`：TiDB 免費額度用完後，資料改存 Railway Volume（掛在 `/app/data`，500 MB）上的 JSON 檔，`DB_*` 設定保留，拿掉 `STORAGE` 就切回資料庫。`src/backup.js` 每天 14:30（台北）後把 `data/*.json`、`*.jsonl` 備份到私人 HF dataset `HF_BACKUP_REPO`（`backups/latest/` 與 `backups/YYYY-MM-DD/`，事件紀錄只放 latest），token 用 `HF_BACKUP_TOKEN`（沒有就用 `HF_TOKEN`，需要寫入權限）；repo 不存在會建立成私人，公開的 repo 會拒絕備份（資料含 LINE userId）。

## HF-only 資料流

- 使用 `HF_REPO_ID` 與 `HF_TOKEN`，設定值不會出現在 API、log 或 capability report。
- 系統監控範圍的產品權威定義是 HF 最新 `db/tickers/tick_universe.parquet` 中的全部合法股票；不另以 `daytrade_ok`、`verify_date` 或其他欄位篩選。檔案版本時間僅作名單更新日期，不代表交易資料日期。
- D1：`db/d1/YYYY_MM.parquet`。
- 當日盤中：依 Asia/Taipei 選擇 `db/m1_live/YYYY-MM-DD.parquet`。
- 必要資產下載至 watch365 自有 `cache/hf/`；D1 cache 一小時、M1 cache 30 秒。
- 404、授權或下載失敗會產生固定 HF error code；不清空 session、不產生訊號。

## 動態指標與規則

- 策略定義位於 `config/indicators/*.json`；服務中的 `GET /api/indicators` 每次重新讀取，因此新增合法版本不需重啟。
- 執行器只接受內建白名單：既有突破量能、SMA 上穿、Wilder RSI 上穿。定義不能上傳或執行 JavaScript。
- `config/indicator-registry-lock.json` 保存每個 `id@version` 的 canonical SHA-256；同版本內容被修改會隔離並回報，不影響其他合法定義。
- SMA/RSI 使用 HF `db/m1_live/YYYY-MM-DD.parquet` 的完整 1 分鐘 K，不是日線。首次載入只暖機；只有啟用後最新完成的 bar 可觸發。
- SMA 與 Wilder RSI 核心運算使用 `technicalindicators` 3.1.0。gap 後清除該股票的指標暖機序列，但保留 cooldown。
- 任務保存 `id`、不可變 `version`、definition fingerprint、timeframe、params 與 server 產生的 `activatedAt`；缺版或 fingerprint 不符時停止該輪。

加入新版本時，建立新的 JSON 檔並使用新的 semantic version；不可修改既有 `id@version`。目前 schema 僅能引用既有 executor，不能新增任意程式。

## 指標需求 Agent

Agent 預設停用，必須明確設定 `INDICATOR_AGENT_PROVIDER` 與 `INDICATOR_AGENT_MODEL` 才會嘗試呼叫模型；不會因主機剛好存在 API key 而自動啟用。

- `INDICATOR_AGENT_PROVIDER`：`anthropic`、`openai`、`gemini`、`groq` 或 `openrouter`
- `INDICATOR_AGENT_MODEL`：由部署者指定並固定的模型 ID，專案不猜測最新版
- `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GEMINI_API_KEY`、`GROQ_API_KEY` 或 `OPENROUTER_API_KEY`：依 provider 使用，彼此不共用，也不使用 `HF_TOKEN`
- `INDICATOR_AGENT_FALLBACKS`：選填；逗號分隔的 `provider:KEY_ENV_NAME:model`（例如 `groq:GROQ_API_KEY_JUST1STOCK:openai/gpt-oss-20b,gemini:GEMINI_API_KEY:gemini-2.5-flash`），主要 provider 回 429／5xx／逾時／輸出無效時依序切換，全部 429 時回報最小等待秒數
- `INDICATOR_AGENT_BASE_URL`：選填；只套用在主要 provider，未設定時使用 provider 官方 API
- `INDICATOR_AGENT_TIMEOUT_MS`：選填，限制在 1–30 秒，預設 10 秒

Server 啟動時會載入專案根目錄的 `.env`；已由外部環境設定的變數維持優先，不會被檔案覆蓋。Gemini 使用官方 `generativelanguage.googleapis.com` REST API；Groq 使用官方 `api.groq.com/openai` chat completions API。兩者都要求結構化 JSON 輸出，且 provider 之間不會自動 fallback。

每次解析只傳送客戶輸入的條件文字，以及精簡的 indicator registry（id、version、名稱、週期、參數 schema、condition）。不傳 watchlist、HF 設定、歷史行情、signals、notifications 或 state。模型輸出必須符合 schema，之後仍由後端 registry 驗證；確認草案時會再次核對版本 fingerprint。解析與確認都不會保存或啟用監控。

若解析結果尚未支援，客戶補齊指標名稱、資料週期、參數或計算定義與觸發條件後，可以確認送出新指標需求。需求由 `POST /api/indicator-requests` 保存，並可透過 `GET /api/indicator-requests` 或 `GET /api/indicator-requests/:id` 查詢；目前唯一狀態是「待評估」，不代表正在開發，也不會建立演算法、修改監控設定或自動啟用。需求資料預設保存於 `data/indicator-requests.json`，可用 `WATCH365_INDICATOR_REQUESTS_FILE` 指定其他路徑。

目前仍是單機內部試用範圍，需求紀錄沒有多租戶帳號隔離或管理者審核介面；正式多人使用前必須補上身分驗證與租戶邊界。

成本依指定 provider/model 的輸入與輸出 token 定價計算。每次請求包含 registry 與結構化輸出 schema，因此除了客戶文字外會有固定 schema token 成本；正式啟用前應依選定模型的官方即時價格估算。

### 指標模板

產品流程是「看到指標 → 選參數 → 加入條件」，找不到指標才交給 AI 解析；解析成功套用的公式存入公式庫，下次直接用。公式庫因此不只列「寫死參數的條件」，而是把 formula_v1 的 AST 升級成「帶可調參數的指標模板」（`src/indicatorTemplates.js`）：

- `extractTemplate(ast)` 走訪 AST，把每個 window／prev 的 `period` 與有意義的 `constant` 抽成參數槽（整數期數 2–200、往前根數 1–60、門檻 ±1e6、倍數 0.01–100、標準差倍數 0.1–100，最多 6 個）。同語意同數值的槽合併為一個參數（KD 的兩個 RMA(3)、布林的 SMA(20)+標準差(20)）；0、除數（÷2、÷3）與 ×±100 的百分比縮放是結構常數，保持固定。根節點是比較運算時另給 `direction`（above／below，對應 crosses_above↔crosses_below、gt↔lt、gte↔lte）。
- `shapeKey` 是把參數值換成佔位符、方向統一為 above 後的 canonical AST 的 sha256：同 shapeKey 的公式視為同一個指標，例如「RSI(14) 上穿 30」與「RSI(14) 下穿 70」只是參數與方向不同。
- `GET /api/indicator-templates`：公式庫（active 與 pending_review，`?includePending=false` 只列 active）依 shapeKey 分組，每組有 `family`／`category`、不含具體數字的 `name`（RSI(N, Wilder) 穿越 N）、`params`、`direction`、`presets`、`members`、累計 `hitCount` 與 `representative`，依 family（均線、MACD、KD、RSI、布林、VWAP、一目、威廉、ATR、量能、漲跌幅、其他）再依 hitCount 排序，不含 AST。
- `presets`（老闆決策：刻度要粗，不是每個指標都可調）：每個 family 固定幾個變體 `{ label, values, direction }`，例如均線 5／10／20／60 各上穿下穿、RSI 上穿 20／30、下穿 70／80、量能 1.5／2／3 倍、漲跌幅 1–5%（上漲 gte×1.0X、下跌 lte×0.9X）、ATR 1–5%；沒有規則的指標（AI 新建立的）只有一個 preset＝原公式（不可調）。前端呈現為「類別 → 變體」清單即可，不必做參數輸入。
- `POST /api/indicator-templates/instantiate`：單一模板 body `{ shapeKey, values:{p1:21,…}, direction?, text? }`，或 1～2 個過濾 `{ items:[{ shapeKey, values?, direction? } | { fingerprint }], text? }`（`fingerprint` 直接使用公式庫既有成員的 AST；兩個過濾以 `all` 合併，摘要為「A 且 B」）。代入參數後重新 `validateFormula`，回傳與 `/api/indicator-agent/parse` 相同形狀的 formula 結果（`provider:{provider:'library',model:'template'}`、`library:true`、`template:true`，含簽章 `proposalToken`），可直接走既有 `/api/formula/activate`、歷史查詢流程。shapeKey／fingerprint 不存在回 404 `TEMPLATE_NOT_FOUND`；items 數量或形狀錯誤回 422 `TEMPLATE_REQUEST_INVALID`；參數型別或範圍錯誤回 422 `TEMPLATE_PARAM_INVALID` 並附 `detail`（含 `index`）。兩個大型指標（例如兩個 KD）合併可能超過公式節點上限而回 400 `FORMULA_COMPLEXITY_EXCEEDED`。
- 套用後 `recordActivation` 寫入的公式（AI 或模板產生）自然依 shapeKey 歸入同一個指標，該指標的 hitCount 隨之累加。

### 關卡順序與回查把關

條件文字進來後依序通過四道關卡（老闆決策，由零成本到有成本）：

1. **清單／公式庫比對**（零成本）：`normalizeAlias` 正規化後對公式庫別名精確比對，命中直接回 active 公式。
2. **維基百科查核**（零 token，第一道擋垃圾；`src/indicatorLookup.js`）：公式庫未命中、`detectOtherTimeframe` 未攔、registry 階段未命中後、進入 AI 公式階段之前執行。去掉參數與方向詞取出指標名；字彙全部屬於公式庫 family／別名／recipes 名稱或價格量能通用詞時（白名單）直接通過不打網路；否則對 zh 與 en 維基 `action=query&list=search` 各查一次（含中→英對照：背離→divergence、乖離率→bias ratio、能量潮→OBV、威廉→Williams %R、布林→Bollinger、一目→Ichimoku、均線→moving average…），每次逾時 4 秒，結果快取 24 小時。查不到 → 回 HTTP 200 `{ status:'unknown_indicator', message, lookup:{ candidates, indicatorName } }`，不叫 AI，記 `unknown_indicator` 事件並 upsert 到 `watch365_unknown_indicators`（無 DB：`data/unknown-indicators.json`，`WATCH365_UNKNOWN_INDICATORS_FILE`）供後台研究。查核失敗（網路／逾時／5xx）**不擋**，照常交給 AI 並 log。查到時把維基標題當 `canonicalName` 一併放進給 AI 的 user 訊息 `{ request, canonicalName }`，降低組錯率。提到籌碼／法人／昨收／其他週期等資料限制的句子不查核，直接由 AI 以 discussion 給替代條件；追問回覆（帶 context）也不查核。`INDICATOR_LOOKUP=off` 可整個關閉。
3. **AI 組公式**（`src/formulaPlanner.js`）。
4. **回查把關**：`POST /api/formula/vet { proposalToken, purpose:'watchlist'|'screen', watchlist? }` 用過去 7 個交易日重播，回 202 `{ jobId }`（之後輪詢 `/api/history/jobs/:id`）或快取命中直接 200。所有回查結果（history job done 與 backtest）都附 `verdict:{ ok, code:'ok'|'no_triggers'|'too_many'|'no_data', perSymbolPerDay, totalEvents, symbolsCount, availableDays, maxPerSymbolDay, message }`；`VET_MAX_PER_SYMBOL_DAY`（預設 10）是平均每檔每個交易日的觸發上限，0 次或超過上限即 `ok:false`，前端不套用、不入庫，後端記 `vet_blocked` 事件。token 無效回 422 `FORMULA_TOKEN_INVALID`、過期回 409 `FORMULA_PROPOSAL_STALE`。

AI 建立的公式**通過 7 日回查就立即存進公式庫**（老闆決策 2026-10，取代原本「套用後才入庫」）：前端 vet 通過後呼叫 `POST /api/formula/save { proposalToken }` → `{ fingerprint, name, summary, status:'pending_review' }`，之後這個過濾改以 `{ fingerprint }` 參照公式庫，草稿遺失或沒建立監控也不會不見，下次同樣的文字直接從公式庫命中、不再花 AI。伺服器只接受本程序內 vet 通過的公式；不是的話（例如 vet 後伺服器重啟）改用 7 日索引當場判定，同樣的 verdict 規則，不通過回 409 `FORMULA_NOT_VETTED`。存入時同步加進 7 日索引，記 `formula_saved` 事件。舊草稿裡還帶有效 token 的 AI 過濾，開啟條件頁時自動補存。

### 事件記錄與後台

`src/events.js` 的 `EventStore` 把使用者看得到的每個動作記成 `{ ts, visitor, type, payload }`：有 `DB_HOST` 時寫 `watch365_events(id, ts DATETIME(3), visitor, type, payload LONGTEXT, INDEX(type,ts), INDEX(visitor,ts))`，無 DB 時追加到 `data/events.jsonl`（`WATCH365_EVENTS_FILE`；啟動只讀最後 5 萬行）。記錄是 fire-and-forget，失敗只 log 不影響請求。

| type | 何時 | payload 重點 |
| --- | --- | --- |
| `page_view` | GET `/` | `ua:{ browser, os, mobile }`（只存粗分類，不存完整 UA） |
| `parse` | `/api/indicator-agent/parse` | `text`（前 200 字）、`status`、`provider`、`model`、`library`、`fingerprint`、`ms` |
| `template_instantiate` | `/api/indicator-templates/instantiate` | `items`、`labels`、`label`、`shapeKey`、`fingerprint`、`count` |
| `monitor_configure` | `/api/monitor/configure` | `purpose`、`symbols`、`strategyName`、`fingerprint`、`formula` |
| `monitor_start`／`monitor_stop`／`monitor_run` | 監控啟停與手動執行 | `strategyName`；run 另有 `skipped`、`reason`、`signals`、`error` |
| `backtest` | history／vet job 結束 | `kind:'backtest'|'vet'`、`days`、`totalEvents`、`perSymbolPerDay`、`verdict`、`ms`、`status` |
| `indicator_request` | `/api/indicator-requests` | `id`、`indicatorName`、`timeframe`、`duplicate` |
| `unknown_indicator` | 維基查核擋下 | `text`、`candidates`、`indicatorName` |
| `vet_blocked` | 回查 verdict 不 ok | `name`、`text`、`fingerprint`、`code`、`totalEvents`、`symbolsCount`、`availableDays`、`perSymbolPerDay` |
| `admin_login`／`admin_status_change` | 後台 | `ok`；`fingerprint`、`status` |

匿名訪客以 cookie `w365v`（22 碼隨機、HttpOnly、SameSite=Lax、一年）辨識，第一次呼叫 API 或開首頁時發放；`GET /api/me` 回 `{ visitor, firstSeen }`。**隱私**：visitor 只是瀏覽器層級的隨機 id，沒有帳號、不存 IP、不存完整 user agent；payload 只保留條件文字前 200 字與統計欄位，超過 4000 字元的 payload 會被截斷。清除 cookie 即成為新訪客。

後台 API（`src/adminApi.js`；`/admin` 頁由前端對接）：設定 `ADMIN_TOKEN`（至少 8 碼）才啟用，未設定時所有 `/api/admin/*` 回 503 `ADMIN_DISABLED`。`POST /api/admin/login { token }` 成功後設 HttpOnly cookie `w365admin`（8 小時、Path=/api/admin、SameSite=Strict，內容是 HMAC 而非 token 本身）；其他 `/api/admin/*` 需 header `x-admin-token` 或該 cookie，否則 401 `ADMIN_UNAUTHORIZED`；`POST /api/admin/logout` 清 cookie。

- `GET /api/admin/overview?days=7` → `{ visitors:{ total, active:[{day,count}] }, pageViews:[{day,count}], parses:{ total, byStatus:[{key,count}], byProvider:[{key,count}] }, monitors:{ configured:[{day,count}], current:{ strategyName, enabled, symbols, lastRunAt } }, topIndicators:[{label,count}], vetBlocked:[{key,count}], unknownIndicators:{ total, recent:[{norm,text,count,lastSeen}] }, library:{ formulas, active, pending, disabled, aliases } }`（日期為台北日）
- `GET /api/admin/events?type=&visitor=&from=&to=&limit=&offset=` → `{ items:[{id,ts,visitor,type,payload}], total }`（新→舊，limit 最多 1000）
- `GET /api/admin/visitors?days=30&limit=100` → `{ items:[{ visitor, firstSeen, lastSeen, pageViews, parses, monitors, backtests, indicators:[label…] }] }`
- `GET /api/admin/unknown-indicators?limit=200` → `{ items:[{ norm, text, candidates, count, firstSeen, lastSeen }] }`
- `GET /api/admin/indicators` → `{ items:[{ shapeKey, family, name, presets, members:[{ fingerprint, name, status, source, hitCount, uses }], uses }] }`；含 disabled 公式（歸不進模板的列在「其他」）。`POST /api/admin/indicators/:fingerprint/status { status:'active'|'pending_review'|'disabled' }` 改狀態（disabled 的公式不再被比對或列入模板），記 `admin_status_change`。

新增一個統計＝在 `ADMIN_QUERIES` 加一筆 `{ type, groupBy }`，再在 overview 放一個 key。

### 共用條件層（狀態機第 1 層，影子模式）

老闆決策（2026-10）：使用者多、指標會重複，所以監控拆成兩層——**指標是「事實」，使用者規則是「訂閱」**。本版只上第 1 層，且是影子模式：記錄狀態與翻轉，**不建立 signal、不發通知**，現有監控行為完全不變。第 2 層（規則狀態：待命／觸發／冷卻、收盤重置）與「只在進入觸發時通知」在之後的版本。

- `src/conditionState.js`：策略拆成原子條件——formula_v1 根節點是 `all` 時每個 item 是一個條件，其他布林根節點是一個條件；`sma.cross`／`rsi.cross` registry 策略轉成與結構化 UI 相同的 AST，所以兩條路徑建出來的同一條件共用一個 key。舊版突破量能規則沒有公式形式，不進這一層。
- 條件 key＝canonical AST 的 `formulaFingerprint`，同一條件不管誰建、參數順序如何都是同一個 key；每根 K 棒對每個（條件 × 股票）只算一次，同一檔股票的多個條件共用子樹快取（`evaluateFormulaSet`，例如 RSI(14) 上穿 30 與下穿 70 只算一次 RSI）。
- 狀態（每個條件 × 股票）：`value`（最後已知的真／假）、`since`（從哪根 K 棒開始是這個值）、`lastBar`、`flipsToday`。翻轉＝已完成 K 棒上 false→true 或 true→false；暖機或資料缺口（null）不算翻轉，保留最後已知值。`kind` 區分 `event`（穿越，只亮一根）與 `level`（成立期間持續為真），給第 2 層決定通知方式。
- HF m1_live 是整天的檔案，所以每輪會走過「上次處理之後的每一根」新 K 棒，兩次輪詢之間的單根穿越不會漏；重啟後從保存的 `lastBar` 接續。某條件當天第一次被計算時只建立基準（baseline），不為之前的 K 棒補發翻轉；換交易日重新建立基準。
- 引用計數與反向索引：條件只有在至少一條規則引用時才計算（`syncRules`），`rulesFor(conditionKey)` 回傳引用它的規則，第 2 層用它只更新受影響的規則。目前單機只有一條規則（啟用中的策略，`strategyIdentity`）。
- 保存：有 `DB_HOST` 時寫 `watch365_condition_state(condition_key, symbol, trading_date, value, since_bar, last_bar, flips_today, PK(condition_key, symbol))` 與 `watch365_conditions(condition_key, kind, label, ast)`，每輪只 upsert 有變的列；啟動時刪除 7 天前的列。無 DB 時寫 `data/condition-state.json`（`WATCH365_CONDITION_STATE_FILE`）。任何錯誤只 log，不影響監控。`CONDITION_LAYER=off` 整個關閉。
- 後台：`GET /api/admin/conditions?flips=50` → `{ mode:'shadow'|'off', lastRun:{ at, symbols, conditions, baselines, newBars, flips, errors, ms }, rules, conditions:[{ key, kind, label, rules, symbols, trueNow, flipsToday }], recentFlips:[{ symbol, conditionKey, label, from, to, kind, barEnd }] }`；`/admin` 的「條件狀態（影子模式）」卡片顯示同樣內容。

### 規則狀態（狀態機第 2 層）與通知

規則＝訂閱共用條件（全部成立才算成立），只讀第 1 層的每根 K 棒結果、不重算指標。每個（規則 × 股票）一個狀態（`src/ruleState.js`）。

**通知來源（2026-10 第 3 版起）**：指標類監控（RSI／SMA／EMA／公式）的 signal 與通知改由狀態機產生（`NOTIFY_ENGINE=state`，預設）：只有「待命 → 已觸發」那一刻建立一筆 signal 與通知，訊息為「代號 名稱 條件成立：規則名稱 | 收盤 X」，`signal.engine='state_machine'`。觸發的 K 棒超過 3 分鐘才被發現（重啟、資料延遲）只記 log 不通知；同一（日期、股票、規則、K 棒）以 `state.dedupe` 去重。舊的逐根引擎仍會跑來產生 decision 紀錄，但它本來會發的通知改記為 `superseded_by_state_machine` 並計數（`runtime.legacyShadow`），後台並列比較。舊版「突破今日高點＋成交量放大」規則沒有公式形式，仍由原引擎通知。緊急回退：Railway 設 `NOTIFY_ENGINE=legacy` 後重新部署，即恢復舊的逐根通知，狀態機改回影子模式。

- `idle`（待命）→ 某根 K 棒成立 → `triggered`（已觸發），**只有這一刻算一次通知（trigger）**；持續成立不再通知。
- 狀態型（≥、≤…）：`triggered` → 不成立 → `cooldown`；連續 3 根不成立才回 `idle`；冷卻中又成立 → 回 `triggered` 但不通知（suppressed）。事件型（穿越，只亮一根）：上次通知 30 分鐘後回 `idle`，期間再穿越都擋下。
- 暖機或資料缺口（未知）不改變狀態。換交易日全部重置（當沖：每天重新開始）；13:30 之後狀態保留並標示「今日已收盤」。某（規則 × 股票）當天第一次出現時，若已成立則以 `triggered` 起始但不通知（與現行 baseline_only 一致）。
- 只處理受影響的規則：該股票這輪有條件變化（第 1 層 `changedKeys` × `rulesFor`）、不在待命、或還沒有狀態；其餘待命規則只前移 last bar。
- 保存：`watch365_rule_state(rule_id, symbol, trading_date, state, since_bar, last_bar, false_bars, triggers_today, suppressed_today, last_trigger_bar, baseline, PK(rule_id, symbol))`，只 upsert 有變的列，保留 7 天；無 DB 時 `data/rule-state.json`（`WATCH365_RULE_STATE_FILE`）。與第 1 層同受 `CONDITION_LAYER=off` 控制（關閉時也強制 `NOTIFY_ENGINE=legacy`）。
- 後台：`GET /api/admin/conditions` 多了 `ruleStates:{ mode:'live'|'shadow', lastRun:{ symbols, walked, skipped, baselines, triggers, suppressed, rearmed, ms }, rules:[{ ruleId, name, kind, rearmBars, symbols, states:{ idle, triggered, cooldown }, triggersToday, suppressedToday, tradingDate, sessionClosed }], comparison:{ day, shadowTriggers, suppressed, legacySignals }, recentEvents:[{ type:'trigger'|'suppressed'|'rearm', ruleId, ruleName, symbol, barEnd }] }`。

### 7 日條件索引（選指標立即知道過去 7 天幾檔觸發）

老闆決策（2026-10）：不要每次選指標才重新計算。過去 7 個交易日的一分鐘 K 常駐在一個獨立的長駐子程序（`src/historyIndexWorker.js`，自己的 heap 上限 `HISTORY_INDEX_HEAP_MB`，預設 640），每個條件對每檔股票每天**只算一次**，存成兩組位元（已知／成立，`src/historyIndex.js`）。

- 預先計算：啟動時把指標清單每一列（每個模板的每個 preset，加上 AI 建立的成員，目前 71 個）全部算好；AI 新建立的過濾第一次被查詢時算一次，之後沿用。過去的日子不再重算；盤中（平日 08:55–13:45）每 3 分鐘只重讀今天的 m1_live 檔並重算今天；新交易日出現時最舊的一天移出。
- 查詢只做組合：選了 A、B、C → 逐根 K 棒把已存的位元做「且」，再用與即時通知相同的狀態機（`ruleState.ruleTriggerIndexes`）數觸發，不重算任何指標。
- `POST /api/history/index { purpose, watchlist?, filters:[spec], candidates?:[spec] }`，spec＝`{ shapeKey, values, direction }`｜`{ fingerprint }`｜`{ proposalToken }`（尚未入庫的 AI 過濾）｜`{ conditionKey }`。回 200 `{ status:'ready', steps:[{ triggeredSymbols, totalEvents, days, events? }], candidates:[{ index, triggeredSymbols, totalEvents }], filterKeys, verdict, availableDays, symbolsCount }`；第 i 步＝前 i 個過濾全部成立（漏斗），candidates＝把該列加在目前所有過濾之後的結果。資料準備中回 202 `{ status:'loading', progress }`。
- 下一個過濾（老闆決策：排序長條清單，不做星狀圖）：選了至少一個過濾後，清單改成「加入後剩幾檔」由多到少排序，長條＝相對目前結果還剩幾 %；檔數與次數都剩 ≥ 95% 的標灰並註明「幾乎沒有篩選效果」；加入後 0 檔的收合在最下方。可切回「依類別瀏覽」。
- 前端條件頁：已選過濾每一步顯示「過去 7 日／加上這個後：N 檔・M 次」，變成 0 檔時標紅並指出是這個過濾篩光的；清單每一列顯示「加入後 N 檔」。加入、移除都自動更新，不需要按回查。過濾上限 2 → 3 個。
- 記憶體：約 600 檔 × 7 天的一分鐘 K 以 typed array 保存，加上每個條件約 0.3 MB 位元。子程序死掉時下一個請求會自動重啟並重算記住的條件。`HISTORY_INDEX=off` 關閉。測試可用 `WATCH365_HISTORY_FIXTURE`（JSON）代替 HF 資料。

### 條件範例圖

老闆決策（2026-10）：選了過濾後，畫**一張**「所有過濾都成立時」的 K 線範例，讓客戶確認條件是不是自己理解的樣子；不指定、不顯示是哪一檔股票，不是看盤。`src/conditionExample.js`：

- 先找**全部歷史日 K**（`db/d1/*.parquet`，在索引子程序背景載入，不擋查詢，每天重讀當月）：所有股票由新到舊找「全部過濾成立」的最近一次，同一天取成交金額最大的；日 K 從沒成立過、或條件用到盤中才有意義的區塊（VWAP、當日第一根）時，改用 7 日一分鐘索引（漏斗還有檔數就一定找得到）。
- 圖：找到的那一點前 60 根、後 15（日 K）／20（分 K）根；比較式兩邊的數列（均線、VWAP…）畫在價格區，RSI／KD 等依數量級放到最多兩個副圖並畫門檻線；▲ 只標所有過濾都成立、會通知的點（與通知相同的狀態機）。
- `POST /api/history/example { filters:[spec] }` → `{ status:'ready', example:{ timeframe:'d1'|'m1', candles, price, panels, markers } | null }`；同一組合每天找一次並快取。測試可用 `WATCH365_DAILY_FIXTURE`。

狀態機冷卻修正（同版）：穿越型（事件）規則原本是「連續 30 根沒有穿越才重新待命」，一檔每 10 分鐘就穿越一次的股票會整天只通知一次；改為「上次通知後 30 分鐘重新待命」，期間再穿越的擋下（同舊引擎的 30 分鐘冷卻）。狀態型規則維持「連續 3 根不成立才重新待命」。

### 固定突破量能規則

- 市場：台股 regular session 09:00–13:30（Asia/Taipei）
- 代號：4–6 位純數字字串，市場別由 metadata 決定
- Watchlist 每檔必須從固定選項指定 `TWSE` 或 `TPEx`；缺失或非法市場會拒絕保存
- 版本：`tw_high_volume_v1`
- 前高：同交易日、當前 bar 之前的最高價
- 成交量基準：前 20 根有效 1 分 K 中位數；至少 5 根才判斷
- 觸發：當前 high 嚴格高於前高，且單根 volume 大於等於基準 2 倍
- 防護：完整 bar、120 秒 stale、gap/out-of-order/volume reset reason codes、30 分鐘冷卻與持久化去重

## 啟動與測試

```bash
npm install
npm test
npm start
```

前端樣式使用本機安裝的 Tailwind CSS 4.3.3 與 daisyUI 5.7.46，不依賴 CDN。來源檔為 `src/styles.css`，建置輸出為 `public/styles.css`；`npm start` 會先自動建置，也可單獨執行：

```bash
npm run build:css
npm run dev:css
```

開啟 `http://localhost:3650`。狀態、decision、去重鍵與通知保存於 `data/watch365.json`。

本 MVP 不做公開註冊、付款、自動下單或投資建議。
