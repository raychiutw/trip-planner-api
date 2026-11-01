/**
 * POST /api/oauth/mint-restricted — 由 request_id 直接簽發「只能寫單一 trip」的 owner
 * 身份 access token（Option E，取代 refresh-token vault 設計）。
 *
 * 動機：tp-request api-server 要用「trip owner 身份」讓 contained agent 寫 owner 自己的
 * trip。與其在 api-server 端存/rotate 每位 owner 的 refresh token（自家 OAuth server 對
 * 自己跑 OAuth），不如讓 **OAuth server（發證方）** 直接從既有 Consent grant 簽發受限
 * token —— caller 不需帶 owner 憑證。
 *
 * 與 downscope.ts 的差異：
 *   - downscope：caller 帶「自己的」user Bearer，換發自己 trip 的受限 token。
 *   - mint-restricted：caller 是可信 api-server（帶 `TRIPLINE_API_SECRET`），server 端由
 *     `request_id` 推 trip/owner、查 owner 對 tp-request client 的 Consent，再以 **owner**
 *     身份簽發。owner 從不需在場、refresh token 從不存在 / 不落 api-server 機器。
 *
 * ⚠️ 授權（防提權）：只收 `TRIPLINE_API_SECRET`（CF↔api-server infra secret，常數時間比對）。
 *   **不走 requireAuth** —— 這不是 user/OAuth grant，是內部 infra 呼叫；user token 無法偽造
 *   此 secret。且綁 `request_id`（須 open/processing）→ 拿到 secret 者也只能為現有 pending
 *   請求 mint 單-trip token，非任意 trip / 非 refresh。
 *
 * ⚠️ 同 downscope：這是 API 層 defense-in-depth，不是對 shell-capable agent 的 containment
 *   邊界（見 downscope.ts 註解）。真正的 containment 是 Layer A+B（tp-agent + mcp-only）。
 *   **mint 失敗時 api-server 不得 spawn**（否則走未-contained fallback，見 tripline-api-server.ts）。
 *
 * Body（form 或 JSON）：{ request_id: string | number }
 * 回：{ access_token, token_type: 'Bearer', expires_in, restrict_trip }；cache-control: no-store。
 */
import { AppError } from '../../../errors';
import { updateRequest } from '../../../lib/request-termination';
import { recordAuthEvent } from '../../../lib/auth-audit';
import { generateOpaqueToken, parseFormOrJson } from '../../../lib/utils';
import { D1Adapter } from '../../../lib/oauth-d1-adapter';
import type { Env } from '../../../env';

// 受限 token TTL 2h（同 downscope）：覆蓋單次 spawn 最長 90min + headroom；只能碰單一 trip，較長 TTL 不擴大 blast。
const MINT_TTL_SEC = 2 * 60 * 60;
// owner 授權的對象 client（provision-tp-request-client.js 預設）。issue token + Consent 查核都用它。
// 單一來源 —— 原本此處與另一檔各寫死一份。
import { TP_REQUEST_CLIENT_ID } from '../../../lib/first-party';
// 只有仍在佇列中的請求可 mint（防對已結案 / 失敗請求重簽 token）。
const MINTABLE_STATUSES = new Set(['open', 'processing']);
// no_consent park 時寫回 chat 的說明（見下方 queue-jam 防禦）。0049 CHECK 限 status 值域，
// 沿用既有 'failed'（不新增 needs_consent 值 → 免 migration）。
const NEEDS_CONSENT_REPLY =
  '這趟行程要用 AI 排程，需要行程擁有者先授權。請在聊天室重新送出訊息，於跳出的視窗點「授權並送出」即可。';

/** 常數時間字串比對（避免 API_SECRET 被 timing 分析）。長度不同直接 false。 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  // 1. API_SECRET gate（fail-closed：未設定 secret → 一律拒）。
  const secret = context.env.TRIPLINE_API_SECRET ?? '';
  const authHeader = context.request.headers.get('Authorization') ?? '';
  if (!secret || !constantTimeEqual(authHeader, `Bearer ${secret}`)) {
    throw new AppError('AUTH_REQUIRED', 'mint-restricted 需要 api-server API secret');
  }

  // 2. request_id。
  const body = await parseFormOrJson<{ request_id?: unknown }>(context.request);
  const rawId = body.request_id;
  const requestId =
    typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
  if (!requestId) throw new AppError('DATA_VALIDATION', 'request_id 必填');

  const db = context.env.DB;

  // 3. request_id → trip_id + status（必須存在且仍在佇列）。
  const reqRow = (await db
    .prepare('SELECT * FROM trip_requests WHERE id = ?')
    .bind(requestId)
    .first()) as { trip_id?: string; status?: string } | null;
  if (!reqRow || !reqRow.trip_id) throw new AppError('DATA_NOT_FOUND', 'request 不存在');
  if (!MINTABLE_STATUSES.has(reqRow.status ?? '')) {
    if (reqRow.status === 'completed' || reqRow.status === 'failed') {
      try {
        await updateRequest(db, { ...reqRow, id: requestId }, { status: reqRow.status }, {
          changedBy: 'system:mint-restricted-retry',
        });
      } catch (error) {
        console.error('[mint-restricted] terminal cleanup retry failed:', error);
      }
    }
    throw new AppError('PERM_DENIED', `request 狀態 ${reqRow.status} 不可 mint（須 open/processing）`);
  }
  const tripId = reqRow.trip_id;

  // 4. trip_id → owner。
  const tripRow = (await db
    .prepare('SELECT owner_user_id FROM trips WHERE id = ?')
    .bind(tripId)
    .first()) as { owner_user_id?: string } | null;
  if (!tripRow || !tripRow.owner_user_id) throw new AppError('DATA_NOT_FOUND', 'trip owner 查不到');
  const ownerUserId = tripRow.owner_user_id;

  // 5. owner 對 tp-request client 的既有 Consent（durable grant）—— owner 未授權 AI → 拒。
  const consent = await new D1Adapter(db, 'Consent').find(`${ownerUserId}:${TP_REQUEST_CLIENT_ID}`);
  if (!consent) {
    // 有人拿 API_SECRET 想為未授權 owner mint → 留 forensic trail（同 downscope 的 deny 記錄）。
    await recordAuthEvent(
      db,
      context.request,
      {
        eventType: 'token_issue',
        outcome: 'failure',
        userId: ownerUserId,
        clientId: TP_REQUEST_CLIENT_ID,
        failureReason: 'no_consent',
        metadata: { grant_type: 'mint-restricted', request_id: requestId, restrict_trip: tripId },
      },
      context.env,
    );
    // 拒發 token 的語意不受收尾故障影響；共用流程先解除隊列，再獨立收尾。
    try {
      await updateRequest(db, { ...reqRow, id: requestId }, {
        status: 'failed', terminalReason: 'needs_consent', reply: NEEDS_CONSENT_REPLY,
      }, { changedBy: 'system:mint-restricted', onlyIfActive: true });
    } catch (parkErr) {
      console.error('[mint-restricted] park needs-consent request failed:', parkErr);
    }
    throw new AppError('PERM_DENIED', 'owner 未授權 tp-request（無 Consent）');
  }

  // 6. 以 owner 身份簽發受限 token（無 refresh；寫入權來自 user_id + restrict_trip gate + trip_permissions，
  //    同 downscope）。scopes 空——受限 token 的能力純由 user_id + restrict_trip 決定。
  const accessToken = generateOpaqueToken(48);
  await new D1Adapter(db, 'AccessToken').upsert(
    accessToken,
    {
      client_id: TP_REQUEST_CLIENT_ID,
      user_id: ownerUserId,
      scopes: [],
      grantId: crypto.randomUUID(),
      restrict_trip: tripId,
    },
    MINT_TTL_SEC,
  );

  // owner-identity token issued（owner 不在場）— 最敏感動作，留 audit（success path，同 downscope）。
  // middleware 只記 ≥400，200 mint 在別處全不可見；API_SECRET 若外洩靠這條追。
  await recordAuthEvent(
    db,
    context.request,
    {
      eventType: 'token_issue',
      outcome: 'success',
      userId: ownerUserId,
      clientId: TP_REQUEST_CLIENT_ID,
      metadata: { grant_type: 'mint-restricted', request_id: requestId, restrict_trip: tripId },
    },
    context.env,
  );

  return new Response(
    JSON.stringify({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: MINT_TTL_SEC,
      restrict_trip: tripId,
    }),
    { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
  );
};
