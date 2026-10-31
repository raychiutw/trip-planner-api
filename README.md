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
