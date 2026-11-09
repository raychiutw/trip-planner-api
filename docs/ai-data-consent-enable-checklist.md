# AI 資料同意：啟用清單（trip-planner#1615）

本文件只列流程與驗證，**不含任何使用者可見文案**。文案內容、責任人、信箱、條款連結與啟用時機由 owner 決定。
目前狀態：閘門**沒有旗標，永遠強制**（2026-11-09 owner 決定直接打開）。文案占位符已填妥，合併後 staging 自動部署即強制；production 要手動 `wrangler deploy --env production` 才會強制。

## 運作方式（以程式碼為準）

- 一律強制，沒有旗標，也沒有「文案未填妥就不強制」的保險（2026-11-10 移除 `isConsentEnforced`）。若日後文案又出現 `{{...}}` 占位符，使用者無法同意（POST 回 `AI_CONSENT_NOT_READY`），三個受管制入口會一律被擋，所以文案不可漏填。
- 受管制入口：`POST /api/requests`、`POST /api/trips/:id/health-check`、`POST /api/trips/:id/notes/:type/generate`。以行程 owner 的同意為準：owner 必須是 `valid`；旅伴自己不需同意，owner 同意後旅伴即可放行；owner 未同意時旅伴送出回 403 `AI_CONSENT_OWNER_REQUIRED`；服務 token 不套用。
- `POST /api/oauth/mint-restricted` 簽發 token 前再檢查一次，涵蓋強制生效前已排隊的請求（缺同意會被終結為 `needs_consent`）。
- 文案未填妥時 `POST /api/account/ai-data-consent` 回 409 `AI_CONSENT_NOT_READY`，使用者無法同意；GET／DELETE 不受影響。
- `ai-authorization`（owner 對 tp-request client 的 Consent grant）與 AI 資料同意是兩個獨立機制，互不取代，mint 時兩者都要成立。

## 上線前確認

1. 文案已簽核。若之後有實質修改，必須遞增版本（`CURRENT_CONSENT_VERSION`），舊版同意者會變成 `stale` 並需重新同意。
2. 確認 web 與 Flutter 用戶端已有處理 `AI_CONSENT_REQUIRED` 403 的畫面（否則使用者只看到失敗）。
3. 範圍：舊入口已無 web 流量，**以新 api 為準**。

## 上線順序

1. 合併後由 deploy.yml 部署到 **staging**（CI 只部署 staging），staging 隨即強制。
2. 跑 `node scripts/smoke-ai-consent.ts --with-requests`：`enforced=true`，強制情境（403、旅伴在 owner 未同意時被擋、owner 同意後旅伴免同意放行、撤回後再攔）應全 PASS。`--with-requests` 會建立 trip_request 並觸發通知流程，確認 staging 沒有接到會誤處理測試請求的外部服務再加。
3. 用真實帳號在 web 與 App 各走一次：未同意被攔 → 同意 → 送出成功 → 撤回 → 再被攔。
4. staging 無異常後，才對 **production**（`trip-planner-api-production`）手動 `wrangler deploy --env production`（CI 不會部署）；驗上線要比對 openapi 路徑，不要只看 health。
5. 強制生效當下已排隊的請求，會在 mint 時缺同意而被終結為 `needs_consent`，屬預期行為，事前先通知使用者。

## 啟用後怎麼驗

- `GET /api/account/ai-data-consent` 回 `enforced: true`。
- 沒同意的測試帳號送出請求 → 403 `AI_CONSENT_REQUIRED`，且 `trip_requests` 沒新增列。
- 同意後送出 → 201；旅伴送出：owner 已同意 → 201（旅伴自己不用同意）、owner 未同意 → 403 `AI_CONSENT_OWNER_REQUIRED`。
- 觀察 `auth_audit_log` 的 `no_data_consent` 事件與 `trip_requests.terminal_reason = 'needs_consent'` 的數量是否合理。

## 緊急關閉

已無旗標可關。緊急時只能回滾部署（`wrangler rollback`）或發 PR 暫時放行閘門。已記錄的同意事件保留（只追加的資料，不需清理）；已被終結為 `needs_consent` 的請求不會自動復原，需使用者重送。

## Staging 實跑紀錄

見 PR 說明（實跑輸出與清理後殘留為 0 的查詢）。
