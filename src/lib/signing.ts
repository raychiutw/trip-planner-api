/**
 * api → agent 請求簽章（ADR-0011、T17）。
 *
 * 簽的內容（canonical string，以 \n 相連）：
 *   TRIPLINE-HMAC-V1 / purpose / METHOD / path+query / timestamp(秒) / nonce / sha256hex(body)
 * 演算法 HMAC-SHA256，輸出小寫 hex。
 *
 * 三種用途（trigger / mail / mint）各用一把獨立 key；purpose 也寫進 canonical string，
 * 所以就算兩把 key 意外相同，跨用途的簽章也不會通用。
 * 輪替：api 端永遠用「新 key」簽；agent 端同時接受新舊 key（見 agent repo 的驗證器）。
 *
 * 這份格式必須與 agent 端 scripts/lib/request-signing.ts 逐字一致，
 * 兩邊的測試以同一組固定向量鎖住。
 */

export const AGENT_SIGNING_PURPOSES = ['trigger', 'mail', 'mint'] as const;
export type AgentSigningPurpose = (typeof AGENT_SIGNING_PURPOSES)[number];

export const SIGNING_HEADERS = {
  timestamp: 'X-Tripline-Timestamp',
  nonce: 'X-Tripline-Nonce',
  signature: 'X-Tripline-Signature',
} as const;

export const SIGNING_VERSION = 'TRIPLINE-HMAC-V1';
const MIN_KEY_LENGTH = 16;

export interface SignAgentRequestInput {
  purpose: AgentSigningPurpose;
  key: string;
  method: string;
  /** 完整 URL 或 path；只取 pathname + search 簽，不簽 host。 */
  url: string;
  body?: string;
  /** unix 秒；預設現在。測試用。 */
  timestamp?: number;
  /** 預設隨機 UUID。測試用。 */
  nonce?: string;
}

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

export async function signAgentRequest(input: SignAgentRequestInput): Promise<Record<string, string>> {
  if (!AGENT_SIGNING_PURPOSES.includes(input.purpose)) {
    throw new Error(`unknown signing purpose: ${String(input.purpose)}`);
  }
  if (typeof input.key !== 'string' || input.key.length < MIN_KEY_LENGTH) {
    throw new Error(`signing key for "${input.purpose}" is missing or too short`);
  }
  const u = new URL(input.url, 'http://placeholder.invalid');
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? crypto.randomUUID();

  const canonical = [
    SIGNING_VERSION,
    input.purpose,
    input.method.toUpperCase(),
    u.pathname + u.search,
    String(timestamp),
    nonce,
    await sha256Hex(input.body ?? ''),
  ].join('\n');

  const hmacKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(input.key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = toHex(await crypto.subtle.sign('HMAC', hmacKey, enc.encode(canonical)));

  return {
    [SIGNING_HEADERS.timestamp]: String(timestamp),
    [SIGNING_HEADERS.nonce]: nonce,
    [SIGNING_HEADERS.signature]: sig,
  };
}

const PURPOSE_KEY = {
  trigger: 'AGENT_SIGNING_KEY_TRIGGER',
  mail: 'AGENT_SIGNING_KEY_MAIL',
} as const;

export interface AgentAuthEnv {
  TRIPLINE_API_SECRET?: string;
  AGENT_SIGNING_KEY_TRIGGER?: string;
  AGENT_SIGNING_KEY_MAIL?: string;
}

/**
 * 呼叫 agent 的認證 header（issue #85 並存期）：該 purpose 的簽章金鑰有設 → 只回簽章 header；
 * 沒設 → 回舊的 Bearer（行為與改動前完全相同）。簽的 body 必須是實際送出的那個字串。
 */
export async function agentAuthHeaders(
  env: AgentAuthEnv,
  purpose: keyof typeof PURPOSE_KEY,
  req: { url: string; body: string; method?: string },
): Promise<Record<string, string>> {
  const key = env[PURPOSE_KEY[purpose]];
  if (!key) return { Authorization: `Bearer ${env.TRIPLINE_API_SECRET}` };
  return signAgentRequest({ purpose, key, method: req.method ?? 'POST', url: req.url, body: req.body });
}
