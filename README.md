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
