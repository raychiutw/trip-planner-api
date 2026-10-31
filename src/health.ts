import { createRoute, z } from '@hono/zod-openapi';
import type { Env } from './env';

const HealthSchema = z.object({
  status: z.enum(['healthy', 'degraded', 'unhealthy']),
  checks: z.object({
    d1: z.enum(['ok', 'fail']),
    googleMapsKey: z.enum(['ok', 'missing']),
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

export async function checkHealth(env: Env) {
  const checks = {
    d1: await checkD1(env),
    googleMapsKey: (env.GOOGLE_MAPS_API_KEY ?? '').length > 10 ? ('ok' as const) : ('missing' as const),
  };
  // D1 掛掉是關鍵故障 → 503；缺 key 只算 degraded。D1 先判：兩者都壞時必須是 unhealthy。
  if (checks.d1 === 'fail') return { code: 503 as const, body: { status: 'unhealthy' as const, checks, ts: new Date().toISOString() } };
  const status = checks.googleMapsKey === 'missing' ? ('degraded' as const) : ('healthy' as const);
  return { code: 200 as const, body: { status, checks, ts: new Date().toISOString() } };
}
