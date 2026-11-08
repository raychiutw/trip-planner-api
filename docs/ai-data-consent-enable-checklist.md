# AI 資料同意：啟用清單（trip-planner#1615）

本文件只列流程與驗證，**不含任何使用者可見文案**。文案內容、責任人、信箱、條款連結與啟用時機由 owner 決定。
目前狀態：`AI_CONSENT_ENFORCED` 未設定、同意文案仍含占位符，所以 staging 與 production 都**不強制**（沒有請求被攔）。

## 運作方式（以程式碼為準）

- 是否強制 = `AI_CONSENT_ENFORCED === 'true'` **且** 目前版本文案已無 `{{...}}` 占位符（`isConsentEnforced`，`src/lib/ai-data-consent.ts`）。任一不成立，三個受管制入口與 mint 檢查都與沒有此功能時完全相同。
- 受管制入口：`POST /api/requests`、`POST /api/trips/:id/health-check`、`POST /api/trips/:id/notes/:type/generate`。送出者與行程 owner 都必須是 `valid` 才放行（旅伴送出時 owner 也要同意）；服務 token 不套用。
- `POST /api/oauth/mint-restricted` 簽發 token 前再檢查一次，涵蓋旗標啟用前已排隊的請求（缺同意會被終結為 `needs_consent`）。
- 文案未填妥時 `POST /api/account/ai-data-consent` 回 409 `AI_CONSENT_NOT_READY`，使用者無法同意；GET／DELETE 不受影響。
- `ai-authorization`（owner 對 tp-request client 的 Consent grant）與 AI 資料同意是兩個獨立機制，互不取代，mint 時兩者都要成立。

## 啟用前（owner 必須完成）

1. 填妥 `src/lib/ai-data-consent-text.ts` 的三個占位符：條款連結、責任人、聯絡信箱。
2. 文案簽核。若之後有實質修改，必須遞增版本（`CURRENT_CONSENT_VERSION`），舊版同意者會變成 `stale` 並需重新同意。
3. 確認 web 與 Flutter 用戶端已有處理 `AI_CONSENT_REQUIRED`／`AI_CONSENT_OWNER_REQUIRED` 403 的畫面（否則旗標一開，使用者只看到失敗）。
4. 啟用範圍：舊入口已無 web 流量，**以新 api 為準**。舊入口不要設旗標。

## 啟用順序

1. 文案合併後由 deploy.yml 部署到 **staging**（CI 只部署 staging）。
2. 跑 `node scripts/smoke-ai-consent.ts`：此時 `enforced=false`（旗標未開），應全 PASS，其餘 SKIP。
3. 在 **staging** 的 Worker（`trip-planner-api`）設 `AI_CONSENT_ENFORCED=true`。`vars` 與 secret 擇一，不要同名並存。
4. 再跑 `node scripts/smoke-ai-consent.ts --with-requests`：`enforced=true`，強制情境（403、同意後放行、旅伴 `AI_CONSENT_OWNER_REQUIRED`、撤回後再攔）應全 PASS。`--with-requests` 會建立 trip_request 並觸發通知流程，確認 staging 沒有接到會誤處理測試請求的外部服務再加。
5. 用真實帳號在 web 與 App 各走一次：未同意被攔 → 同意 → 送出成功 → 撤回 → 再被攔。
6. staging 無異常後，才對 **production**（`trip-planner-api-production`）設 `AI_CONSENT_ENFORCED=true`。production 要手動 `--env production`（CI 不會部署）；驗上線要比對 openapi 路徑，不要只看 health。
7. 啟用當下已排隊的請求，會在 mint 時缺同意而被終結為 `needs_consent`，屬預期行為，事前先通知使用者。

## 啟用後怎麼驗

- `GET /api/account/ai-data-consent` 回 `enforced: true`。
- 沒同意的測試帳號送出請求 → 403 `AI_CONSENT_REQUIRED`，且 `trip_requests` 沒新增列。
- 同意後送出 → 201；旅伴送出而 owner 沒同意 → 403 `AI_CONSENT_OWNER_REQUIRED`。
- 觀察 `auth_audit_log` 的 `no_data_consent` 事件與 `trip_requests.terminal_reason = 'needs_consent'` 的數量是否合理。

## 怎麼關回

1. 移除 `AI_CONSENT_ENFORCED`（或改成非 `'true'`）：`vars` 版本改設定再部署；secret 版本用 `wrangler secret delete AI_CONSENT_ENFORCED [--env production]`。
2. 效果立即：三個入口與 mint 都回到不強制。已記錄的同意事件保留（只追加的資料，不需清理）；同意、撤回端點仍可用。
3. 已被終結為 `needs_consent` 的請求不會自動復原，需使用者重送。

## Staging 實跑紀錄

見 PR 說明（實跑輸出與清理後殘留為 0 的查詢）。
