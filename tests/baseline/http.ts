/**
 * 基準測試的 HTTP 邊界 helper（自舊 repo tests/api/http.ts 改寫）：Request 進、Response 出。
 *
 * 目標：進程內（`env`）直接呼叫新 api 的 Hono app；外部網址（`baseUrl`）用 fetch。
 * 認證走真實的 bearer token（D1 的 AccessToken 資料列）。**新 api 沒有 cookie session**：
 * `sessionFor`／`cookie` 會直接丟錯——依賴它們的測試屬於「行為變更」，請改用 `as:`，或在 PR 內列為變更並移除。
 */
import { createApp } from '../../src/app';
import type { Env } from '../../src/env';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { userIdFor } from './helpers';

const app = createApp();

export interface RequestOptions {
  as?: string;
  scopes?: string[];
  restrictTrip?: string;
  bearer?: string;
  /** 已移除（新 api 沒有 cookie session）。 */
  cookie?: string;
  json?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface Api {
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  get(path: string, options?: RequestOptions): Promise<Response>;
  tokenFor(email: string, scopes?: string[], extra?: { restrictTrip?: string }): Promise<string>;
  /** 已移除（新 api 沒有 cookie session）。 */
  sessionFor(email: string, userId?: string): Promise<never>;
  fetch(request: Request): Promise<Response>;
}

export function createApi(target: { env: Env } | { baseUrl: string }): Api {
  const inProcess = 'env' in target ? target.env : null;
  const base = inProcess ? 'https://test.com' : (target as { baseUrl: string }).baseUrl;

  async function tokenFor(email: string, scopes = ['trips:read', 'trips:write'], extra: { restrictTrip?: string } = {}): Promise<string> {
    if (!inProcess) throw new Error('tokenFor 只能用在進程內目標；外部目標請直接傳 bearer');
    const userId = userIdFor(email);
    await inProcess.DB.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)').bind(userId, email, email.split('@')[0]).run();
    const token = `http-test-${crypto.randomUUID()}`;
    await new D1Adapter(inProcess.DB, 'AccessToken').upsert(
      token,
      { jti: token, client_id: 'http-test', user_id: userId, scopes, grantId: `grant-${token}`, ...(extra.restrictTrip ? { restrict_trip: extra.restrictTrip } : {}) },
      300,
    );
    return token;
  }

  async function doFetch(request: Request): Promise<Response> {
    if (!inProcess) return fetch(request);
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => {} } as unknown as ExecutionContext;
    const response = await app.fetch(request, inProcess, ctx);
    await Promise.allSettled(pending); // 讓 waitUntil 的寫入（api_logs 等）在回應前落地，避免時序問題
    return response;
  }

  async function request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    if (options.cookie) throw new Error('新 api 沒有 cookie session：請改用 as:／bearer，或把此測試列為「行為變更」');
    const headers = new Headers(options.headers);
    const bearer = options.bearer ?? (options.as ? await tokenFor(options.as, options.scopes, { restrictTrip: options.restrictTrip }) : undefined);
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    let body: string | undefined;
    if (options.json !== undefined) { body = JSON.stringify(options.json); headers.set('content-type', 'application/json'); }
    else if (options.form) { body = new URLSearchParams(options.form).toString(); headers.set('content-type', 'application/x-www-form-urlencoded'); }
    return doFetch(new Request(new URL(path, base), { method, headers, body, redirect: 'manual' }));
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    tokenFor,
    sessionFor: async () => { throw new Error('新 api 沒有 cookie session：請改用 as:／bearer，或把此測試列為「行為變更」'); },
    fetch: doFetch,
  };
}
