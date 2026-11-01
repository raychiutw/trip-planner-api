/**
 * 帳號類測試的「登入」替身（取代舊測試的 api.sessionFor）。
 * 舊入口是 cookie session；新 api 只有 bearer，所以改成直接發一組第一方 client（tripline-web，
 * migration 0099 內建且 first_party=1）的 AccessToken + RefreshToken，兩者共用同一個 grantId。
 */
import { D1Adapter } from '../../src/lib/oauth-d1-adapter';
import { userIdFor } from './helpers';

export interface TestSession {
  /** 帶進 `api.request(..., { bearer })` 的 access token。 */
  bearer: string;
  grantId: string;
  userId: string;
}

export async function sessionFor(
  db: D1Database,
  email: string,
  userId: string = userIdFor(email),
  opts: { clientId?: string; scopes?: string[]; restrictTrip?: string } = {},
): Promise<TestSession> {
  await db.prepare('INSERT OR IGNORE INTO users (id, email, display_name) VALUES (?, ?, ?)')
    .bind(userId, email, email.split('@')[0]).run();
  const tag = crypto.randomUUID();
  const grantId = `grant-${tag}`;
  const bearer = `acct-test-${tag}`;
  const payload = {
    client_id: opts.clientId ?? 'tripline-web',
    user_id: userId,
    scopes: opts.scopes ?? ['openid', 'profile', 'email'],
    grantId,
    ...(opts.restrictTrip ? { restrict_trip: opts.restrictTrip } : {}),
  };
  await new D1Adapter(db, 'AccessToken').upsert(bearer, payload, 3600);
  await new D1Adapter(db, 'RefreshToken').upsert(`acct-refresh-${tag}`, payload, 30 * 24 * 3600);
  return { bearer, grantId, userId };
}
