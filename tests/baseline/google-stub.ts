/**
 * Google Maps Platform 的外部邊界 stub：攔截 global fetch，
 * 只放行對 Google 網域的請求（由測試提供回應），並記錄送出的請求內容供斷言。
 * 其餘任何請求一律 throw —— 測試不得對真實外部服務發請求。
 */
import { vi } from 'vitest';

export interface GoogleCall {
  url: string;
  method: string;
  headers: Headers;
  /** JSON body（無 body 時為 null） */
  body: Record<string, unknown> | null;
}

type Responder = (call: GoogleCall) => Response | Promise<Response>;

const GOOGLE_HOSTS = ['places.googleapis.com', 'routes.googleapis.com', 'maps.googleapis.com'];

export function stubGoogle() {
  const calls: GoogleCall[] = [];
  let responder: Responder | undefined;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!GOOGLE_HOSTS.includes(new URL(url).hostname)) {
      throw new Error(`測試不應對外發請求：${url}`);
    }
    const raw = typeof init?.body === 'string' ? init.body : null;
    const call: GoogleCall = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    calls.push(call);
    if (!responder) throw new Error(`沒有為此請求準備回應：${url}`);
    return responder(call);
  });
  return {
    calls,
    /** 設定之後請求的回應（取代先前的）。 */
    respond(next: Responder) { responder = next; },
    reset() { calls.length = 0; responder = undefined; },
    restore() { vi.unstubAllGlobals(); },
  };
}

export const jsonOk = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
