# trip-planner-api

Tripline 的後端 **api** 專案（Cloudflare Worker + Hono）。拆分計畫見
[trip-planner#1462](https://github.com/raychiutw/trip-planner/issues/1462) 與 ADR-0011。

- 契約：由 zod schema 產出 OpenAPI，`GET /openapi.json`。
- 目前是骨架（T7）：只有 `GET /api/health`。其餘 handler 依 #1474～#1476 逐批改寫。
- 基準測試：`tests/` 的案例從舊入口原樣搬來，同一份行為舊入口與新 api 都要通過。

```bash
npm ci
npm run typecheck && npm test
npm run dev        # wrangler dev

# 換目標：同一份形狀斷言指向已啟動的 api
API_BASE_URL=http://127.0.0.1:8787 npm test
```

## 供應鏈與 CI 防護（T8）

`tests/ci-hardening.test.ts` 守住 `.github/` 的形狀：Action 一律以 commit SHA 釘版本、每個 workflow 宣告最小權限、
CI 有 `npm audit --audit-level=high` 與 PR 的 dependency review、CodeQL 靜態分析、dependabot 涵蓋 npm 與 Actions。

### GitHub 端設定（不在 repo 內，需留意是否仍成立）

- Secret scanning 與 push protection：啟用（public repo）。
- Dependabot alerts 與 security updates：啟用。
- `main` 的 branch protection：需 PR、1 位 approving review（含 CODEOWNERS）、必過檢查
  `ci`、`analyze`、`dependency-review`、不可 force push／刪除。
  `enforce_admins` 為 false：單人維護時擁有者可在緊急時繞過，但繞過本身會留在稽核紀錄。

### 部署用 Cloudflare token

Cloudflare 的 API token 只能限定到「帳號」這一層，**無法限定到單一 Worker**。目前能做到的最小範圍：

- 權限：Account → Workers Scripts → Edit；Account → D1 → Edit（migration 需要）。
- 資源：只選這個帳號，不給 Zone 層權限。
- 只放在本 repo 的 GitHub secret `CLOUDFLARE_API_TOKEN`，不放進任何 workflow 檔、log 或 `.dev.vars`。
- 要真正隔離到單一 Worker，需要獨立的 Cloudflare 帳號；這是已知的殘留風險。
## Migration（T15）

migration 歸本 repo 管理，`migrations/` 的 0001～0096 是從舊入口（trip-planner）帶來的基準線。

- **只加不刪**：`node scripts/migration-gate.ts` 擋下編號大於基準線的新 migration 出現任何 `DROP`、`RENAME`
  （含 `ALTER TABLE … RENAME／DROP COLUMN`、`PRAGMA writable_schema`）；改動或刪除基準線內的舊檔、跳號、重複編號、
  檔名格式不對也都失敗。舊入口存在期間隨時要能切回，所以新 schema 必須與舊程式碼相容。
- **fail closed**：目錄或基準線檔讀不到、沒有任何 migration，結束碼是 2（沒檢查），不是通過。
- **部署順序**：`deploy.yml` 依序跑 閘門 → 測試 → `wrangler d1 migrations apply DB --remote` → `wrangler deploy`，
  migration 一定先於程式碼。預設停用，設好 secrets 並把 repo variable `DEPLOY_ENABLED` 設為 `true` 才會跑；
  目前 `wrangler.toml` 只綁 staging D1，切換前不碰 production。
- 新增 migration：下一個編號（目前是 0097）、`NNNN_name.sql`、純加法。舊入口那邊尚未合併的 0097（#1458，只是資料更新）
  合併後，需要把它同步成本 repo 的 0097。
- 重新產生基準線（人工審查後才提交）：`node scripts/migration-gate.ts --write-baseline`。
