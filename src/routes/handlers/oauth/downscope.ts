/**
 * POST /api/oauth/downscope — 換發「只能寫單一 trip」的 access token（v2.55.56）
 *
 * 動機（confused deputy）：tp-request 自動化 agent 帶 owner 身份 token + `--dangerously-
 * skip-permissions` 跑，而 `trip_requests.message` 是任何 trip member 都能寫的 untrusted
 * 輸入。若 agent 被 prompt injection 誘導，帶全 trip 寫入 token 就能改其他 trip。
 * 本端點讓可信的 api-server 先把 token 換成「只能碰某一 trip」的受限 token，注入
 * ephemeral session；被誘導的 agent 用這個 token 打 API 時，server 端 `hasWritePermission` /
 * `requireTripReadAccess`（見 _auth.ts）會擋掉任何 restrict_trip 以外的 tripId。
 *
 * ⚠️ 這是 **API 層 defense-in-depth，不是對 shell-capable agent 的 containment 邊界**：
 * session 有完整 shell + 檔案系統存取，能讀 `~/.tripline` state / `.env.local` 憑證重新
 * mint 一個「完整無限制」token 繞過本 scope。真正的 containment 要 OS sandbox / broker
 * process（session 不得讀到更寬憑證）— 這是開 `TP_REQUEST_USER_TOKEN` flag 前的硬前提。
 *
 * 授權：caller 必須帶 user Bearer（authorization_code grant，user_id 非 null）且對
 * trip_id 有寫權限。service token（user_id=null）與「已受限 token」一律拒絕 —
 * 受限 token 不能再換發（防止外洩的受限 token 自我提權到別的 trip）。
 *
 * Body（form 或 JSON）：{ trip_id: string }
 * 回：{ access_token, token_type: 'Bearer', expires_in, restrict_trip }
 * cache-control: no-store（token 不得被快取）。
 */
import { requireAuth, hasWritePermission } from '../../../lib/permissions';
import { AppError } from '../../../errors';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { generateOpaqueToken, parseFormOrJson } from '../../../lib/utils';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import type { Env } from '../../../env';

// 受限 token TTL 2h：覆蓋單次 spawn 最長 90min + headroom。因為只能碰單一 trip，
// 較長 TTL 不擴大 blast radius（不像全 trip token）。
const DOWNSCOPE_TTL_SEC = 2 * 60 * 60;

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  // 只有未受限的 user token 能換發。service token（user_id=null）→ 無 identity 寫入，
  // 靠下方 hasWritePermission 也會 false；此處明確擋掉並回清楚錯誤。
  if (!auth.userId) throw new AppError('PERM_DENIED', 'downscope 需要 user 身份 token');
  // 受限 token 不能再換發（防外洩受限 token 提權到別 trip）。
  if (auth.restrictTrip !== undefined) {
    throw new AppError('PERM_DENIED', '受限 token 不可再 downscope');
  }

  const body = await parseFormOrJson<{ trip_id?: unknown }>(context.request);
  const tripId = typeof body.trip_id === 'string' ? body.trip_id.trim() : '';
  if (!tripId) throw new AppError('DATA_VALIDATION', 'trip_id 必填');

  const db = context.env.DB;
  if (!(await hasWritePermission(db, auth, tripId))) {
    await recordAuthEvent(db, context.request, {
      eventType: 'token_issue',
      outcome: 'failure',
      userId: auth.userId,
      clientId: auth.clientId ?? null,
      failureReason: 'no_write_permission',
      metadata: { grant_type: 'downscope', restrict_trip: tripId },
    }, context.env);
    throw new AppError('PERM_DENIED', '對此行程無寫入權限');
  }

  // 換發受限 access token（無 refresh token — 受限 token 是 ephemeral、用完即棄；
  // 過期由 api-server 重新 downscope）。scopes 沿用 caller（tp-request client 僅
  // openid/profile，無 ops scope）；寫入權來自 user_id + restrict_trip gate + trip_permissions。
  const accessToken = generateOpaqueToken(48);
  const grantId = crypto.randomUUID();
  await new D1Adapter(db, 'AccessToken').upsert(
    accessToken,
    {
      client_id: auth.clientId ?? '',
      user_id: auth.userId,
      scopes: auth.scopes ?? [],
      grantId,
      restrict_trip: tripId,
    },
    DOWNSCOPE_TTL_SEC,
  );

  await recordAuthEvent(db, context.request, {
    eventType: 'token_issue',
    outcome: 'success',
    userId: auth.userId,
    clientId: auth.clientId ?? null,
    metadata: { grant_type: 'downscope', restrict_trip: tripId },
  }, context.env);

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: DOWNSCOPE_TTL_SEC,
      restrict_trip: tripId,
    }),
    {
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'pragma': 'no-cache',
      },
    },
  );
};
