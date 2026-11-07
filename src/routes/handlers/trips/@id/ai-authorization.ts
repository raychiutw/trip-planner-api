/**
 * GET /api/trips/:id/ai-authorization — 這個行程的「擁有者」是否已授權 Tripline AI（#1600）。
 *
 * mint-restricted 簽發 token 查的是行程擁有者的 Consent，旅伴送出前要查的也是擁有者，
 * 不是自己（/api/account/ai-authorization 查登入者本人）。只回兩個布林，不洩露擁有者身分或其他資訊；
 * 僅限對該行程有權限者（hasPermission，service／受限 token 一律拒）。
 */
import { hasPermission, requireAuth } from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import { json } from '../../../../lib/utils';
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { TP_REQUEST_CLIENT_ID } from '../../../../lib/first-party';
import type { Env } from '../../../../env';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);
  const tripId = context.params.id as string;
  const db = context.env.DB;
  if (!(await hasPermission(db, auth, tripId))) throw new AppError('PERM_DENIED');

  const trip = await db.prepare('SELECT owner_user_id FROM trips WHERE id = ?').bind(tripId).first<{ owner_user_id: string | null }>();
  if (!trip?.owner_user_id) throw new AppError('DATA_NOT_FOUND');
  const consent = await new D1Adapter(db, 'Consent').find(`${trip.owner_user_id}:${TP_REQUEST_CLIENT_ID}`);
  return json({ ownerAuthorized: Boolean(consent), isOwner: trip.owner_user_id === auth.userId });
};
