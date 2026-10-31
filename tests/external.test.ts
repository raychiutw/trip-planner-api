/**
 * 換目標：同一份形狀斷言指向已啟動的 api（本機 wrangler dev 或部署後的網址）。
 * 沒設 API_BASE_URL 時整個檔案略過；進程內的版本在 health.test.ts。
 *
 *   API_BASE_URL=http://127.0.0.1:8799 npm test
 *
 * 外部目標沒辦法注入故障的 D1，所以只驗不依賴注入的案例（形狀、狀態碼與 status 一致、契約可取得）。
 */
import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL;

describe.skipIf(!API_BASE_URL)('外部目標：GET /api/health', () => {
  it('key 集合是 status / checks / ts，狀態碼與 status 一致', async () => {
    const resp = await fetch(new URL('/api/health', API_BASE_URL));
    const body = (await resp.json()) as { status: string; checks: object; ts: string };
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'ts']);
    expect(Object.keys(body.checks).sort()).toEqual(['d1', 'googleMapsKey']);
    expect(Number.isNaN(Date.parse(body.ts))).toBe(false);
    expect(resp.status).toBe(body.status === 'unhealthy' ? 503 : 200);
  });

  it('GET /openapi.json 可取得並描述 /api/health', async () => {
    const resp = await fetch(new URL('/openapi.json', API_BASE_URL));
    expect(resp.status).toBe(200);
    const doc = (await resp.json()) as { paths: Record<string, unknown> };
    expect(Object.keys(doc.paths)).toContain('/api/health');
  });
});
