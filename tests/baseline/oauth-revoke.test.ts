/**
 * POST /api/oauth/revoke — V2-P5 RFC 7009
 * 走 HTTP 邊界（tests/api/http.ts）：原本檢查 mock 的 DELETE 呼叫形狀，
 * 改成直接讀真實 D1 的 oauth_models 看 token 資料列有沒有被刪。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDb, disposeMiniflare } from './setup';
import { mockEnv } from './helpers';
import { createApi, type Api } from './http';
import { hashPassword } from '../../src/lib/password';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';

// 專用 client id：共用 D1 下只動自己的資料列
const CLIENT = 'revoke-http-client';
const OTHER = 'revoke-http-other';
const CONFIDENTIAL = 'revoke-http-confidential';
const CLIENTS = [CLIENT, OTHER, CONFIDENTIAL];

let db: D1Database;
let api: Api;

beforeAll(async () => {
  db = await createTestDb();
  api = createApi({ env: mockEnv(db) });
  const secretHash = await hashPassword('revoke-secret-1');
  for (const [id, type, hash] of [[CLIENT, 'public', null], [OTHER, 'public', null], [CONFIDENTIAL, 'confidential', secretHash]] as const) {
    await db
      .prepare(`INSERT OR REPLACE INTO client_apps (client_id, client_type, client_secret_hash, app_name, redirect_uris, allowed_scopes, status)
        VALUES (?, ?, ?, ?, '["https://client.test/cb"]', '["openid"]', 'active')`)
      .bind(id, type, hash, id)
      .run();
  }
});

afterAll(async () => {
  for (const id of CLIENTS) {
    await db.prepare("DELETE FROM oauth_models WHERE json_extract(payload, '$.client_id') = ?").bind(id).run();
    await db.prepare('DELETE FROM client_apps WHERE client_id = ?').bind(id).run();
  }
  await disposeMiniflare();
});

function revoke(fields: Record<string, string>) {
  return api.fetch(new Request('https://x.com/api/oauth/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  }));
}

async function seedToken(model: 'AccessToken' | 'RefreshToken', id: string, clientId: string, grantId: string) {
  await new D1Adapter(db, model).upsert(id, { client_id: clientId, user_id: 'revoke-user', scopes: ['openid'], grantId }, 600);
}

async function exists(model: 'AccessToken' | 'RefreshToken', id: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM oauth_models WHERE name = ? AND id = ?').bind(model, id).first();
  return row !== null;
}

describe('POST /api/oauth/revoke', () => {
  it('400 invalid_request when token missing', async () => {
    const res = await revoke({ client_id: CLIENT });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_request');
  });

  it('401 invalid_client when client_id unknown', async () => {
    const res = await revoke({ token: 't', client_id: 'revoke-http-unknown' });
    expect(res.status).toBe(401);
  });

  it('200 silent when token unknown (RFC 7009 anti-scanning)', async () => {
    const res = await revoke({ token: 'revoke-http-no-such-token', client_id: CLIENT });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('200 + DELETE access_token row when found', async () => {
    await seedToken('AccessToken', 'revoke-access-1', CLIENT, 'revoke-grant-1');
    expect(await exists('AccessToken', 'revoke-access-1')).toBe(true);
    const res = await revoke({ token: 'revoke-access-1', client_id: CLIENT });
    expect(res.status).toBe(200);
    expect(await exists('AccessToken', 'revoke-access-1')).toBe(false);
  });

  it('200 silent when token belongs to different client (anti-leak) and the row survives', async () => {
    await seedToken('AccessToken', 'revoke-access-other', OTHER, 'revoke-grant-other');
    const res = await revoke({ token: 'revoke-access-other', client_id: CLIENT });
    expect(res.status).toBe(200);
    // 不可刪別的 client 的 token
    expect(await exists('AccessToken', 'revoke-access-other')).toBe(true);
  });

  it('honors token_type_hint=refresh_token (look up RefreshToken first)', async () => {
    // 同一個 token 字串同時存在 AccessToken 與 RefreshToken（不同 grant），
    // 只有被優先查到的那一種會被撤銷，由資料列的存廢看出查詢順序。
    await seedToken('AccessToken', 'revoke-dup', CLIENT, 'revoke-grant-access-side');
    await seedToken('RefreshToken', 'revoke-dup', CLIENT, 'revoke-grant-refresh-side');
    expect((await revoke({ token: 'revoke-dup', client_id: CLIENT, token_type_hint: 'refresh_token' })).status).toBe(200);
    expect(await exists('RefreshToken', 'revoke-dup')).toBe(false);
    expect(await exists('AccessToken', 'revoke-dup')).toBe(true);
    // 沒有 hint 時預設先查 AccessToken
    await seedToken('RefreshToken', 'revoke-dup', CLIENT, 'revoke-grant-refresh-side');
    expect((await revoke({ token: 'revoke-dup', client_id: CLIENT })).status).toBe(200);
    expect(await exists('AccessToken', 'revoke-dup')).toBe(false);
    expect(await exists('RefreshToken', 'revoke-dup')).toBe(true);
  });

  it('falls back to the other token store when the hint misses (RFC 7009 §4.1.2)', async () => {
    await seedToken('AccessToken', 'revoke-fallback', CLIENT, 'revoke-grant-fallback');
    const res = await revoke({ token: 'revoke-fallback', client_id: CLIENT, token_type_hint: 'refresh_token' });
    expect(res.status).toBe(200);
    expect(await exists('AccessToken', 'revoke-fallback')).toBe(false);
  });

  it('revoking a refresh_token also revokes the access tokens of the same grant only', async () => {
    await seedToken('RefreshToken', 'revoke-refresh-fam', CLIENT, 'revoke-grant-fam');
    await seedToken('AccessToken', 'revoke-access-fam', CLIENT, 'revoke-grant-fam');
    await seedToken('AccessToken', 'revoke-access-bystander', CLIENT, 'revoke-grant-bystander');
    const res = await revoke({ token: 'revoke-refresh-fam', client_id: CLIENT, token_type_hint: 'refresh_token' });
    expect(res.status).toBe(200);
    expect(await exists('RefreshToken', 'revoke-refresh-fam')).toBe(false);
    expect(await exists('AccessToken', 'revoke-access-fam')).toBe(false);
    expect(await exists('AccessToken', 'revoke-access-bystander')).toBe(true);
  });

  it('confidential client: wrong or missing secret → 401 and the token survives; correct secret revokes', async () => {
    await seedToken('AccessToken', 'revoke-conf-token', CONFIDENTIAL, 'revoke-grant-conf');
    const wrong = await revoke({ token: 'revoke-conf-token', client_id: CONFIDENTIAL, client_secret: 'wrong-secret' });
    expect(wrong.status).toBe(401);
    const missing = await revoke({ token: 'revoke-conf-token', client_id: CONFIDENTIAL });
    expect(missing.status).toBe(401);
    expect(await exists('AccessToken', 'revoke-conf-token')).toBe(true);
    const ok = await revoke({ token: 'revoke-conf-token', client_id: CONFIDENTIAL, client_secret: 'revoke-secret-1' });
    expect(ok.status).toBe(200);
    expect(await exists('AccessToken', 'revoke-conf-token')).toBe(false);
  }, 60_000);
});
