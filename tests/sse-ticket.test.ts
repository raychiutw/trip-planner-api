/**
 * T10：一次性 SSE ticket 與即時推送。
 * 即時推送（EventSource）無法附認證標頭，所以用 ticket：向 api 換取，30 秒有效、只對單一 request、用過即失效；
 * 憑證中途過期／被撤銷時，串流以 `event: reconnect` 告知 client 重新換 ticket 並接續（Last-Event-ID）。
 * 走 HTTP 邊界（app.request），真 SQLite。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createApp } from '../src/app';
import type { Env } from '../src/env';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
let env: Env;
const NOW = () => Date.now();
const TIMINGS = { pollMs: 15, keepaliveMs: 40, maxMs: 3000 };
const app = (t = TIMINGS) => createApp({ sse: t });

beforeEach(() => {
  d1 = createD1();
  env = { DB: d1.db, ALLOWED_ORIGINS: '' } as Env;
  const u = d1.raw.prepare('INSERT INTO users (id, email, status) VALUES (?, ?, ?)');
  u.run('u1', 'a@example.com', 'active'); u.run('u2', 'b@example.com', 'active');
  d1.raw.prepare("INSERT INTO trips (id, name, owner_user_id) VALUES ('t1', 'T1', 'u1'), ('t2', 'T2', 'u1')").run();
  d1.raw.prepare("INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('u1','t1','owner'), ('u1','t2','owner')").run();
  d1.raw.prepare("INSERT INTO trip_requests (id, trip_id, message, status) VALUES (1, 't1', 'hi', 'processing'), (2, 't2', 'hi', 'processing')").run();
  token('tok-u1', { client_id: 'web', user_id: 'u1', scopes: ['openid', 'trips:read'], grantId: 'g1' });
  token('tok-u2', { client_id: 'web', user_id: 'u2', scopes: ['openid', 'trips:read'], grantId: 'g2' });
});
afterEach(() => { d1.close(); vi.restoreAllMocks(); });

function token(id: string, payload: Record<string, unknown>, expiresAt = NOW() + 3600_000) {
  d1.raw.prepare("INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', ?, ?, ?)").run(id, JSON.stringify(payload), expiresAt);
}
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const ticketRows = () => d1.raw.prepare("SELECT id, payload, expires_at FROM oauth_models WHERE name = 'SseTicket'").all() as { id: string; payload: string; expires_at: number }[];
const setStatus = (id: number, status: string) => d1.raw.prepare("UPDATE trip_requests SET status = ?, updated_at = datetime('now', '+' || abs(random() % 1000) || ' seconds') WHERE id = ?").run(status, id);

const issue = (reqId: number | string, tok: string | null = 'tok-u1', a = app()) =>
  a.request(`/api/requests/${reqId}/sse-ticket`, { method: 'POST', headers: tok ? { Authorization: `Bearer ${tok}` } : {} }, env);
async function ticketFor(reqId: number | string, tok = 'tok-u1'): Promise<string> {
  return ((await (await issue(reqId, tok)).json()) as { ticket: string }).ticket;
}
const events = (reqId: number | string, init: { ticket?: string; bearer?: string; lastEventId?: string; signal?: AbortSignal } = {}, a = app()) => {
  const headers: Record<string, string> = {};
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  if (init.lastEventId) headers['Last-Event-ID'] = init.lastEventId;
  const qs = init.ticket === undefined ? '' : `?ticket=${encodeURIComponent(init.ticket)}`;
  return a.request(`/api/requests/${reqId}/events${qs}`, { headers, signal: init.signal }, env);
};

interface Sse { event: string; data: unknown; id?: string }
/** 讀串流直到關閉（或超過 limitMs），回傳解析後的事件；onEvent 可在收到事件時動手腳。 */
async function readSse(res: Response, onEvent?: (e: Sse, all: Sse[]) => void, limitMs = 3000): Promise<{ events: Sse[]; closed: boolean }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const out: Sse[] = [];
  let buf = '';
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    const r = await Promise.race([reader.read(), new Promise<null>((r2) => setTimeout(() => r2(null), 100))]);
    if (r === null) continue;
    if (r.done) return { events: out, closed: true };
    buf += dec.decode(r.value);
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      if (block.startsWith(':')) continue; // keepalive
      const e: Sse = { event: 'message', data: null };
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) e.event = line.slice(7);
        else if (line.startsWith('id: ')) e.id = line.slice(4);
        else if (line.startsWith('data: ')) e.data = JSON.parse(line.slice(6));
      }
      out.push(e); onEvent?.(e, out);
    }
  }
  await reader.cancel();
  return { events: out, closed: false };
}
const err401 = async (res: Response) => { expect(res.status).toBe(401); expect(await res.json()).toEqual({ error: { code: 'AUTH_REQUIRED', message: '請先登入' } }); };

describe('換取 ticket', () => {
  it('成員換到 ticket：30 秒有效、no-store；資料庫只存雜湊，不存明文', async () => {
    const res = await issue(1);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json() as { ticket: string; expires_in: number };
    expect(body.expires_in).toBe(30);
    expect(body.ticket.length).toBeGreaterThanOrEqual(40);
    const [row] = ticketRows();
    expect(row!.id).toBe(sha(body.ticket));
    expect(row!.id).not.toBe(body.ticket);
    expect(row!.payload).not.toContain(body.ticket);
    expect(Math.abs(row!.expires_at - (NOW() + 30_000))).toBeLessThan(2000);
  });
  it('每次換到的 ticket 都不同', async () => {
    expect(await ticketFor(1)).not.toBe(await ticketFor(1));
  });
  it('沒登入 → 401', async () => { await err401(await issue(1, null)); });
  it('不是成員、request 不存在 → 同樣的 404（不洩漏 request 是否存在）', async () => {
    const a = await issue(1, 'tok-u2'); const b = await issue(999);
    expect(a.status).toBe(404); expect(b.status).toBe(404);
    expect(await a.json()).toEqual(await b.json());
    expect(ticketRows()).toHaveLength(0);
  });
  it('service token、受限於別的行程的 token、缺 trips:read scope 的第三方 token → 404，不發 ticket', async () => {
    token('svc', { client_id: 'cron', user_id: null, scopes: ['ops:read'], grantId: 'gs' });
    token('restricted', { client_id: 'web', user_id: 'u1', scopes: ['openid'], grantId: 'gr', restrict_trip: 't2' });
    token('thirdparty', { client_id: 'partner', user_id: 'u1', scopes: ['openid'], grantId: 'gp' });
    for (const t of ['svc', 'restricted', 'thirdparty']) expect((await issue(1, t)).status, t).toBe(404);
    expect(ticketRows()).toHaveLength(0);
  });
  it('request id 不是整數 → 404（不進 SQL）', async () => {
    expect((await issue("1 OR 1=1")).status).toBe(404);
    expect((await issue('abc')).status).toBe(404);
  });
  it('每位使用者每分鐘 30 張，超過 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 33; i++) statuses.push((await issue(1)).status);
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const last = await issue(1);
    expect(last.headers.get('retry-after')).toMatch(/^\d+$/);
    expect((await issue(1, 'tok-u2')).status).toBe(404); // 別人不受影響（只是沒權限）
  });
});

describe('兌換 ticket', () => {
  it('成功：text/event-stream，先送出目前狀態（含 id），完成時關閉', async () => {
    const t = await ticketFor(1);
    const res = await events(1, { ticket: t });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(res.headers.get('cache-control')).toMatch(/no-cache|no-store/);
    const { events: evs, closed } = await readSse(res, (e) => { if (evs0(e)) setStatus(1, 'completed'); });
    expect(closed).toBe(true);
    expect(evs[0]).toMatchObject({ event: 'message', data: { status: 'processing' } });
    expect(evs[0]!.id).toBeTruthy();
    expect(evs.at(-1)).toMatchObject({ data: { status: 'completed' } });
    function evs0(e: Sse) { return (e.data as { status: string }).status === 'processing'; }
  });
  it('已完成的 request：送一次狀態就關閉', async () => {
    setStatus(1, 'completed');
    const { events: evs, closed } = await readSse(await events(1, { ticket: await ticketFor(1) }));
    expect(closed).toBe(true);
    expect(evs).toHaveLength(1);
  });
  it('用過即失效：第二次兌換 401', async () => {
    setStatus(1, 'completed');
    const t = await ticketFor(1);
    expect((await events(1, { ticket: t })).status).toBe(200);
    await err401(await events(1, { ticket: t }));
    expect(ticketRows()).toHaveLength(0);
  });
  it('過期的 ticket → 401', async () => {
    const t = await ticketFor(1);
    d1.raw.prepare("UPDATE oauth_models SET expires_at = ? WHERE name = 'SseTicket'").run(NOW() - 1);
    await err401(await events(1, { ticket: t }));
  });
  it('跨 request：拿 request 1 的 ticket 去連 request 2 → 401，且該 ticket 作廢', async () => {
    const t = await ticketFor(1);
    await err401(await events(2, { ticket: t }));
    await err401(await events(1, { ticket: t }));
  });
  it('換 ticket 之後權限被撤銷 → 兌換時重新檢查，401', async () => {
    const t = await ticketFor(1);
    d1.raw.prepare("DELETE FROM trip_permissions WHERE user_id = 'u1' AND trip_id = 't1'").run();
    await err401(await events(1, { ticket: t }));
  });
  it('換 ticket 之後使用者被停權 → 401', async () => {
    const t = await ticketFor(1);
    d1.raw.prepare("UPDATE users SET status = 'suspended' WHERE id = 'u1'").run();
    await err401(await events(1, { ticket: t }));
  });
  it('換 ticket 之後憑證被撤銷（grant 已不存在）→ 401', async () => {
    const t = await ticketFor(1);
    d1.raw.prepare("DELETE FROM oauth_models WHERE name = 'AccessToken'").run();
    await err401(await events(1, { ticket: t }));
  });
  it('亂猜、空字串、SQL 樣式、超長的 ticket → 一律同樣的 401', async () => {
    for (const t of ['nope', '', "' OR '1'='1", 'a'.repeat(5000), sha('x')]) await err401(await events(1, { ticket: t }));
  });
  it('過長的 ticket 在碰資料庫之前就被拒絕', async () => {
    const spy = vi.spyOn(d1.db, 'prepare');
    await err401(await events(1, { ticket: 'a'.repeat(200) }));
    expect(spy).not.toHaveBeenCalled();
  });
  it('用 access token 當 ticket、用 ticket 當 access token 都不行', async () => {
    await err401(await events(1, { ticket: 'tok-u1' }));
    const t = await ticketFor(1);
    expect((await events(1, { bearer: t })).status).toBe(401);
  });
  it('什麼憑證都沒帶 → 401', async () => { await err401(await events(1)); });
});

describe('以 Authorization 標頭直連（能帶標頭的 client，例如 Flutter）', () => {
  it('成員 → 200 串流；不需要 ticket', async () => {
    setStatus(1, 'completed');
    const res = await events(1, { bearer: 'tok-u1' });
    expect(res.status).toBe(200);
    expect((await readSse(res)).events).toHaveLength(1);
  });
  it('非成員 → 404；無效 token → 401', async () => {
    expect((await events(1, { bearer: 'tok-u2' })).status).toBe(404);
    expect((await events(1, { bearer: 'nope' })).status).toBe(401);
  });
});

describe('串流行為', () => {
  it('狀態變更時送出新事件', async () => {
    const res = await events(1, { ticket: await ticketFor(1) });
    let changed = false;
    const { events: evs } = await readSse(res, (e) => {
      if (!changed) { changed = true; setStatus(1, 'completed'); }
      void e;
    });
    expect(evs.map((e) => (e.data as { status: string }).status)).toEqual(['processing', 'completed']);
  });
  it('Last-Event-ID 與目前狀態相同 → 不重送（接續，不重複）', async () => {
    const first = await readSse(await events(1, { ticket: await ticketFor(1) }), undefined, 200);
    const lastId = first.events[0]!.id!;
    const res = await events(1, { ticket: await ticketFor(1), lastEventId: lastId });
    const resumed = await readSse(res, undefined, 300);
    expect(resumed.events).toHaveLength(0);
  });
  it('斷線期間狀態變了：用 Last-Event-ID 重連，第一個事件就是新狀態', async () => {
    const first = await readSse(await events(1, { ticket: await ticketFor(1) }), undefined, 200);
    const lastId = first.events[0]!.id!;
    setStatus(1, 'completed');
    const resumed = await readSse(await events(1, { ticket: await ticketFor(1), lastEventId: lastId }));
    expect(resumed.events[0]).toMatchObject({ data: { status: 'completed' } });
    expect(resumed.events[0]!.id).not.toBe(lastId);
  });
  it('憑證到期：串流送 reconnect（token_expired）後關閉，client 換新 ticket 接續', async () => {
    token('short', { client_id: 'web', user_id: 'u1', scopes: ['trips:read'], grantId: 'g3' }, NOW() + 500);
    const t = await ticketFor(1, 'short');
    const { events: evs, closed } = await readSse(await events(1, { ticket: t }), undefined, 3000);
    expect(closed).toBe(true);
    expect(evs.at(-1)).toMatchObject({ event: 'reconnect', data: { reason: 'token_expired' } });
  });
  it('憑證在串流中途被撤銷 → reconnect（grant_revoked）', async () => {
    const res = await events(1, { ticket: await ticketFor(1) });
    let done = false;
    const { events: evs, closed } = await readSse(res, () => { if (!done) { done = true; d1.raw.prepare("DELETE FROM oauth_models WHERE name = 'AccessToken'").run(); } });
    expect(closed).toBe(true);
    expect(evs.at(-1)).toMatchObject({ event: 'reconnect', data: { reason: 'grant_revoked' } });
  });
  it('權限在串流中途被撤銷 → 立即結束，不再推送', async () => {
    const res = await events(1, { ticket: await ticketFor(1) });
    let done = false;
    const { events: evs, closed } = await readSse(res, () => { if (!done) { done = true; d1.raw.prepare("DELETE FROM trip_permissions WHERE user_id = 'u1' AND trip_id = 't1'").run(); } });
    expect(closed).toBe(true);
    expect(evs.at(-1)).toMatchObject({ event: 'reconnect', data: { reason: 'grant_revoked' } });
    expect(evs.filter((e) => e.event === 'message')).toHaveLength(1);
  });
  it('超過最長時間 → reconnect（max_duration）後關閉', async () => {
    const { events: evs, closed } = await readSse(await events(1, { ticket: await ticketFor(1) }, app({ ...TIMINGS, maxMs: 120 })));
    expect(closed).toBe(true);
    expect(evs.at(-1)).toMatchObject({ event: 'reconnect', data: { reason: 'max_duration' } });
  });
  it('client 中斷連線後伺服器停止輪詢（不留殘餘計時器查 DB）', async () => {
    const ac = new AbortController();
    // keepalive 設很大：否則殘餘迴圈會因寫入已取消的串流而自己死掉，掩蓋「沒有清理計時器」的缺陷
    const res = await events(1, { ticket: await ticketFor(1), signal: ac.signal }, app({ ...TIMINGS, keepaliveMs: 100_000 }));
    const spy = vi.spyOn(d1.db, 'prepare');
    const reader = res.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 80));
    const after = spy.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(spy.mock.calls.length).toBe(after);
  });
});

describe('不外洩憑證', () => {
  it('整個流程（含各種失敗）下，任何 console 輸出都不含 ticket 或 access token', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const t = await ticketFor(1);
    setStatus(1, 'completed');
    await readSse(await events(1, { ticket: t }));
    await events(1, { ticket: t });                 // 重用
    await events(2, { ticket: await ticketFor(1) }); // 跨 request
    await events(1, { bearer: 'tok-u1' });
    // 兌換時 DB 壞掉
    const broken = { prepare: () => { throw new Error('D1 boom'); } } as unknown as D1Database;
    await app().request('/api/requests/1/events?ticket=zzz-secret-ticket', {}, { DB: broken } as Env);
    const all = spies.flatMap((s) => s.mock.calls.flat()).map((x) => (x instanceof Error ? `${x.message}` : String(x))).join('\n');
    for (const secret of [t, 'tok-u1', 'zzz-secret-ticket']) expect(all).not.toContain(secret);
  });
  it('錯誤回應內容不含 ticket', async () => {
    const t = await ticketFor(1);
    const body = await (await events(2, { ticket: t })).text();
    expect(body).not.toContain(t);
  });
});
