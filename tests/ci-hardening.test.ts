/// <reference types="node" />
/**
 * 供應鏈與 CI 防護的守衛（拆分 T8）。
 * 只讀 .github/ 底下的檔案，驗「設定長什麼樣」；它擋的是之後有人把 Action 改回浮動版本、
 * 放寬權限或拿掉漏洞檢查。GitHub 端的設定（branch protection、secret scanning）不在這裡，
 * 見 README 的「GitHub 設定」。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const workflowDir = path.join(root, '.github/workflows');
const workflows = fs
  .readdirSync(workflowDir)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(workflowDir, f), 'utf8') }));

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('GitHub Actions', () => {
  it('至少有 CI 與靜態分析兩個 workflow', () => {
    const names = workflows.map((w) => w.name);
    expect(names).toContain('ci.yml');
    expect(names).toContain('codeql.yml');
  });

  it('所有第三方 Action 都以 40 碼 commit SHA 釘版本', () => {
    const offenders: string[] = [];
    for (const w of workflows) {
      for (const m of w.text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
        const ref = m[1]!;
        if (ref.startsWith('./')) continue;
        if (!/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(ref)) offenders.push(`${w.name}: ${ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('每個 workflow 都在最上層宣告 permissions，且不是 write-all', () => {
    for (const w of workflows) {
      expect(w.text, `${w.name} 缺最上層 permissions`).toMatch(/^permissions:/m);
      expect(w.text, `${w.name} 不可 write-all`).not.toMatch(/permissions:\s*write-all/);
    }
  });

  it('CI 的最上層權限只有 contents: read', () => {
    const ci = workflows.find((w) => w.name === 'ci.yml')!.text;
    const block = ci.match(/^permissions:\n((?:[ \t]+\S.*\n)+)/m)?.[1] ?? '';
    expect(block.trim().split('\n').map((l) => l.trim())).toEqual(['contents: read']);
  });

  it('CI 會做相依漏洞檢查（npm audit，high 以上失敗）', () => {
    const ci = workflows.find((w) => w.name === 'ci.yml')!.text;
    expect(ci).toMatch(/npm audit --audit-level=high/);
  });

  it('PR 上有 dependency review', () => {
    const ci = workflows.find((w) => w.name === 'ci.yml')!.text;
    expect(ci).toMatch(/actions\/dependency-review-action@[0-9a-f]{40}/);
  });

  it('靜態分析用 CodeQL 掃 JavaScript／TypeScript', () => {
    const codeql = workflows.find((w) => w.name === 'codeql.yml')!.text;
    expect(codeql).toMatch(/github\/codeql-action\/init@[0-9a-f]{40}/);
    expect(codeql).toMatch(/github\/codeql-action\/analyze@[0-9a-f]{40}/);
    expect(codeql).toMatch(/languages:\s*javascript-typescript/);
  });
});

describe('CodeQL 版本一致', () => {
  it('init 與 analyze 必須是同一個 commit（不同版本 CodeQL 會直接失敗）', () => {
    const codeql = workflows.find((w) => w.name === 'codeql.yml')!.text;
    const shas = [...codeql.matchAll(/github\/codeql-action\/[\w-]+@([0-9a-f]{40})/g)].map((m) => m[1]);
    expect(shas.length).toBeGreaterThanOrEqual(2);
    expect(new Set(shas).size, `codeql-action 的步驟用了不同版本：${[...new Set(shas)].join(', ')}`).toBe(1);
  });

  it('dependabot 把 codeql-action 群組成同一個 PR（否則 init 與 analyze 會被拆開升級）', () => {
    const d = fs.readFileSync(path.join(root, '.github/dependabot.yml'), 'utf8');
    expect(d).toMatch(/github\/codeql-action\*/);
  });
});

describe('相依更新與審查設定', () => {
  it('dependabot 涵蓋 npm 與 github-actions', () => {
    const d = read('.github/dependabot.yml');
    expect(d).toMatch(/package-ecosystem:\s*["']?npm["']?/);
    expect(d).toMatch(/package-ecosystem:\s*["']?github-actions["']?/);
  });

  it('CODEOWNERS 把所有路徑指派給擁有者', () => {
    expect(read('.github/CODEOWNERS')).toMatch(/^\*\s+@raychiutw\s*$/m);
  });
});
