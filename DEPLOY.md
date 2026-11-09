# watch365 部署:GitHub Pages + Cloudflare Worker + GHA(cron-job.org 觸發)

架構:
- 網站 `public/` 放 GitHub Pages(`site.yml` 建置:CSS、瀏覽器引擎、HF 日 K 資料檔)。篩選、回測都在使用者瀏覽器內算。
- `worker/`:Cloudflare Worker `watch365-api`(免費方案),存監控設定、LINE 綁定、AI 建指標,資料放 KV `W365`。
- `jobs/daily-close.mjs`:每個交易日 13:01 由 cron-job.org 觸發 `daily-close.yml`,讀 HF 當天分 K,判斷 D1 條件,推 LINE。
- 不用 GHA 內建 schedule;所有排程由 `scripts/setup-cronjob.mjs` 建在 cron-job.org。

## 一次性設定(Ray)

1. **Cloudflare Worker**(在 Mac 的 watch365 資料夾)
   ```
   npx wrangler login
   npx wrangler kv namespace create W365        # 把印出的 id 貼到 worker/wrangler.toml 的 REPLACE_WITH_KV_ID
   npx wrangler secret put LINE_CHANNEL_SECRET --config worker/wrangler.toml
   npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN --config worker/wrangler.toml
   npx wrangler secret put FORMULA_TOKEN_SECRET --config worker/wrangler.toml   # 隨機 32 字元以上
   npx wrangler secret put ADMIN_TOKEN --config worker/wrangler.toml            # 隨機 32 字元以上,GitHub 也要同一個
   npx wrangler secret put GEMINI_API_KEY --config worker/wrangler.toml         # 或原本用的 AI key 名稱
   npm run worker:deploy
   ```
   AI 供應商/模型用 `INDICATOR_AGENT_PROVIDER`、`INDICATOR_AGENT_MODEL`(可加在 wrangler.toml 的 [vars])。
2. **LINE Developers** → Messaging API → Webhook URL 改成
   `https://watch365-api.raywu918daytrade.workers.dev/api/line/webhook`,按 Verify。
3. **GitHub repo**:Settings → General → 改 Public;Settings → Pages → Source 選 GitHub Actions,Custom domain 填 `watch365.just1stock.com`。
   Settings → Secrets and variables → Actions:
   - Secrets:`HF_TOKEN`(唯讀即可)、`ADMIN_TOKEN`、`LINE_CHANNEL_SECRET`、`LINE_CHANNEL_ACCESS_TOKEN`
   - Variables:`W365_API` = `https://watch365-api.raywu918daytrade.workers.dev`
4. **GoDaddy DNS**:`watch365` 的 CNAME 改指 `raywu918daytrade.github.io`(刪掉指向 Railway 的舊紀錄)。
5. **cron-job.org**:
   ```
   CRONJOB_API_KEY=... GH_DISPATCH_TOKEN=... node scripts/setup-cronjob.mjs --test
   ```
   GH_DISPATCH_TOKEN = fine-grained token,只給 watch365 repo,Actions: Read and write。
6. 驗證:手動跑一次 `daily-close.yml`(dry_run 填 1、force 填 1);打開網站建一個監控、綁 LINE、按「傳測試訊息」。

## 本機開發
```
npm run build:css && npm run build:web          # 資料檔:npm run build:data(需能連 HF)
(cd public && python3 -m http.server 8080)
npm run worker:dev                               # 讀 worker/.dev.vars
```
本機測試時把 `public/config.js` 的 WATCH365_API 暫時改成 `http://localhost:8787`。

## 沒搬過來的
- 舊 Railway Volume 上的監控/綁定資料拿不到(服務已暫停);使用者要重新建立監控、重新綁 LINE。
- `admin.html` 後台還是舊伺服器的 API,新架構下暫不可用。
- 一分 K 盤中監控仍是第二階段(即將推出)。
