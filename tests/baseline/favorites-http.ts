/**
 * poi-favorites HTTP 邊界測試共用：真實 bearer token（含 companion／service／受限 token）與清理。
 * 認證一律經過 middleware，不直接塞 auth。
 */
import type { Env } from '../../src/env';
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { seedUser, userIdFor } from './helpers';
import { cleanupTrips } from './cleanup-trips';

export const TP_REQUEST_CLIENT_ID = 'tripline-internal-cli';

interface MintOptions {
  /** 有值 → 綁使用者的 token；省略 → service token（user_id = null）。 */
  email?: string;
  clientId?: string;
  scopes?: string[];
  restrictTrip?: string;
}

/** 在進程內的 D1 建立一顆真實的 AccessToken，回傳 bearer 字串。 */
export async function mintToken(env: Env, options: MintOptions = {}): Promise<string> {
  const userId = options.email ? await seedUser(env.DB, options.email) : null;
  const token = `fav-test-${crypto.randomUUID()}`;
  await new D1Adapter(env.DB, 'AccessToken').upsert(
    token,
    {
      jti: token,
      client_id: options.clientId ?? 'http-test',
      user_id: userId,
      scopes: options.scopes ?? ['trips:read', 'trips:write'],
      grantId: `grant-${token}`,
      ...(options.restrictTrip ? { restrict_trip: options.restrictTrip } : {}),
    },
    300,
  );
  return token;
}

/** companion service token：user_id 為 null、帶 companion scope、client 為 tp-request 的 client。 */
export function companionToken(env: Env, overrides: Pick<MintOptions, 'scopes' | 'clientId'> = {}): Promise<string> {
  return mintToken(env, { clientId: TP_REQUEST_CLIENT_ID, scopes: ['companion'], ...overrides });
}

/** 建立一筆 trip_request，回 id（預設 processing）。 */
export async function seedTripRequest(
  db: D1Database,
  opts: { tripId: string; submittedBy: string; status?: string },
): Promise<number> {
  const row = await db
    .prepare('INSERT INTO trip_requests (trip_id, message, submitted_by, status) VALUES (?, ?, ?, ?) RETURNING id')
    .bind(opts.tripId, 'favorites http test', opts.submittedBy, opts.status ?? 'processing')
    .first<{ id: number }>();
  return row!.id;
}

/**
 * 共用 D1 下清掉自己的資料。`prefix` 同時是 email、trip id、POI 名稱的專屬前綴
 * （email 前綴經 userIdFor 轉成 user id 前綴；前綴不含 `_` 與 `%`）。
 */
export async function cleanupFavorites(db: D1Database, prefix: string, requestIds: number[]): Promise<void> {
  const userLike = `${userIdFor(prefix)}%`;
  for (const id of requestIds) {
    await db.prepare('DELETE FROM companion_request_actions WHERE request_id = ?').bind(id).run();
    await db.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id).run();
    await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%:companion:${id}`).run();
  }
  await db.prepare('DELETE FROM trip_requests WHERE trip_id LIKE ?').bind(`${prefix}%`).run();
  await db.prepare('DELETE FROM poi_favorites WHERE user_id LIKE ?').bind(userLike).run();
  await db.prepare('DELETE FROM rate_limit_buckets WHERE bucket_key LIKE ?').bind(`%:user:${userLike}`).run();
  await cleanupTrips(db, [`${prefix}%`], [`${prefix}%`]);
}
