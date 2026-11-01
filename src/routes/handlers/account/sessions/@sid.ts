/**
 * DELETE /api/account/sessions/:sid — 撤銷指定的連線（sid = OAuth grantId）
 *
 * ⚠ 行為變更：舊入口 sid 是 cookie session 的 id（session_devices.sid）；
 * 新 api 以 grantId 為單位，撤銷 = D1Adapter.revokeByGrantId（刪該 grant 的 AccessToken 與 RefreshToken）。
 *
 * Auth: requireAccountUser
 * Ownership：撤銷前先確認該 grantId 底下確有「屬於目前使用者」的有效 token；
 *   revokeByGrantId 本身只看 grantId、不看 user，所以所有權檢查必須在這裡做。
 *   他人的 grantId／不存在／已撤銷 → 一律 404 SESSION_NOT_FOUND（不洩漏存在與否）。
 * 撤銷自己當前的連線：允許（等同登出，此後該 token 立即失效）。
 *
 * Response: 200 { ok: true, revoked_sid } ／ 404 { error: { code: 'SESSION_NOT_FOUND' } }
 */
import { requireAccountUser } from '../../../../lib/account-user';
import { D1Adapter } from '../../../../lib/oauth-d1-adapter';
import { rawJson } from '../../../../lib/utils';
import { AppError } from '../../../../errors';
import type { Env } from '../../../../env';
import { listUserGrants } from '../sessions';

export const onRequestDelete: PagesFunction<Env> = async (context) => {
  const user = await requireAccountUser(context);
  const sid = (context.params as { sid?: string }).sid;
  if (!sid || typeof sid !== 'string') {
    throw new AppError('DATA_VALIDATION', 'sid 必填');
  }

  const owned = (await listUserGrants(context.env, user.uid)).some((g) => g.grantId === sid);
  if (!owned) {
    return rawJson(
      { error: { code: 'SESSION_NOT_FOUND', message: '找不到此連線（可能已登出或不屬於你）' } },
      404,
    );
  }

  await new D1Adapter(context.env.DB, 'AccessToken').revokeByGrantId(sid);
  return rawJson({ ok: true, revoked_sid: sid });
};
