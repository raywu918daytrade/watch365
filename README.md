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
