import { createRoute, z } from '@hono/zod-openapi';
import type { Env } from './env';
import { importPrivateKey } from './lib/jwt';

const HealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  checks: z.object({
    d1: z.enum(['ok', 'fail']),
    googleMapsKey: z.enum(['ok', 'missing']),
    // OAuth 簽章金鑰：missing＝沒設、invalid＝有設但匯入失敗（格式不對）。token endpoint 簽不出 id_token 不會失敗，
    // 所以壞掉是靜默的（JWKS 空、不簽發），這裡讓它在健康檢查看得到。
    oauthSigningKey: z.enum(['ok', 'missing', 'invalid']),
  }),
  ts: z.string().datetime(),
});

export const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  summary: '伺服器健康檢查（公開、免認證）',
  responses: {
    200: { description: 'healthy 或 degraded（非關鍵項目缺失）', content: { 'application/json': { schema: HealthSchema } } },
    503: { description: 'unhealthy（D1 不可用）', content: { 'application/json': { schema: HealthSchema } } },
  },
});

async function checkD1(env: Env): Promise<'ok' | 'fail'> {
  try {
    const row = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return row?.ok === 1 ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

async function checkSigningKey(env: Env): Promise<'ok' | 'missing' | 'invalid'> {
  if (!env.OAUTH_SIGNING_PRIVATE_KEY) return 'missing';
  try {
    await importPrivateKey(env.OAUTH_SIGNING_PRIVATE_KEY);
    return 'ok';
  } catch {
    return 'invalid';
  }
}

export async function checkHealth(env: Env) {
  const checks = {
    d1: await checkD1(env),
    googleMapsKey: (env.GOOGLE_MAPS_API_KEY ?? '').length > 10 ? ('ok' as const) : ('missing' as const),
    oauthSigningKey: await checkSigningKey(env),
  };
  // D1 掛掉是關鍵故障 → 503；缺 key 或簽章金鑰無效只算 degraded。D1 先判：兩者都壞時必須是 unhealthy。
  if (checks.d1 === 'fail') return { code: 503 as const, body: { status: 'unhealthy' as const, checks, ts: new Date().toISOString() } };
  const status = checks.googleMapsKey === 'missing' || checks.oauthSigningKey !== 'ok' ? ('degraded' as const) : ('healthy' as const);
  return { code: 200 as const, body: { status, checks, ts: new Date().toISOString() } };
}
