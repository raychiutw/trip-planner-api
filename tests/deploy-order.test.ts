/// <reference types="node" />
/**
 * 部署順序守衛（拆分 T15）：migration 閘門先過、migration 先於程式碼套用、部署預設停用。
 * 只讀 workflow 與 wrangler.toml 的文字，驗「順序與條件」；真正套用 migration 需要 Cloudflare 憑證，不在這裡跑。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const deploy = read('.github/workflows/deploy.yml');
const gateWorkflow = read('.github/workflows/migrations.yml');

/** 回傳字串在 deploy.yml 中的位置；找不到就讓測試失敗並指出缺哪個。 */
function at(needle: RegExp | string): number {
  const i = typeof needle === 'string' ? deploy.indexOf(needle) : deploy.search(needle);
  expect(i, `deploy.yml 缺 ${String(needle)}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe('deploy.yml 的順序', () => {
  it('migration 閘門 → 測試 → 套用 migration → 部署，依序出現', () => {
    const gate = at('node scripts/migration-gate.ts');
    const test = at('npm test');
    const migrate = at('wrangler d1 migrations apply');
    const ship = at(/wrangler deploy\b/);
    expect(gate).toBeLessThan(test);
    expect(test).toBeLessThan(migrate);
    expect(migrate).toBeLessThan(ship);
  });

  it('套用 migration 針對遠端資料庫（--remote）', () => {
    expect(deploy).toMatch(/wrangler d1 migrations apply DB --remote/);
  });

  it('預設停用：要把 repo variable DEPLOY_ENABLED 設為 true 才會部署', () => {
    expect(deploy).toMatch(/if:\s*\$\{\{\s*vars\.DEPLOY_ENABLED == 'true'\s*\}\}/);
  });

  it('只有 main 的 push 與手動觸發會部署（PR 不會）', () => {
    expect(deploy).toMatch(/branches:\s*\[main\]/);
    expect(deploy).toMatch(/workflow_dispatch:/);
    expect(deploy).not.toMatch(/pull_request/);
  });

  it('同時只會有一個部署在跑，且不取消進行中的部署', () => {
    expect(deploy).toMatch(/concurrency:/);
    expect(deploy).toMatch(/cancel-in-progress:\s*false/);
  });

  it('Cloudflare 憑證只來自 secrets，不寫死在檔案裡', () => {
    expect(deploy).toMatch(/CLOUDFLARE_API_TOKEN:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
    expect(deploy).not.toMatch(/CLOUDFLARE_API_TOKEN:\s*(?!\$\{\{)\S+/);
  });
});

describe('migrations.yml（每個 PR 都跑閘門）', () => {
  it('PR 與 main 的 push 都會跑 migration 閘門', () => {
    expect(gateWorkflow).toMatch(/pull_request:/);
    expect(gateWorkflow).toMatch(/branches:\s*\[main\]/);
    expect(gateWorkflow).toMatch(/node scripts\/migration-gate\.ts/);
  });
});

describe('wrangler.toml', () => {
  it('明示 migrations 目錄，與閘門檢查的是同一個', () => {
    expect(read('wrangler.toml')).toMatch(/migrations_dir\s*=\s*"migrations"/);
  });
});
