# agent-contract.json

`trip-planner-agent` 產生、本 repo 驗證的契約快照（agent issue #5：單一 repo 的 CI 看不到對方）。

- 來源 repo：`raychiutw/trip-planner-agent`
- 來源 commit：`910b76c130a14851af6a362e179abe0378f47d9d`（`contract/api-contract.json`）
- 內容：`dailyCheckSql`（daily-check 實際送給 D1 的 SQL）、`companionTools`（MCP server 中 `companion: true` 的工具）
- 驗證：`tests/agent-contract/*.test.ts`

## 更新方式

1. 在 agent repo 執行 `npm run export:contract`（agent 端的測試在快照過期時會紅）。
2. 把 `contract/api-contract.json` 複製成本 repo 的 `tests/fixtures/agent-contract.json`。
3. 更新上面的「來源 commit」。
4. 執行 `npm test`：若 api 的 migration 或 companion 白名單與新快照不一致，測試會紅——這正是守衛要抓的，請修 agent 或 api，不要弱化測試。

快照內不得含個資（email、chat id、tailnet 名、token）；agent repo 是公開的。
