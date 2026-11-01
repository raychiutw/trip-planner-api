/**
 * GET  /api/trips/:id/health-check  — 取最新 AI 健檢結果（per-trip latest）
 * POST /api/trips/:id/health-check  — 觸發新一輪 AI 健檢
 *
 * 流程（POST）：
 * 1. INSERT trip_requests (message='[AI 健檢] ...') RETURNING id — chat trail 同步先建立
 * 2. UPSERT trip_health_reports (status='pending', request_id=<from step 1>) 一發到位
 * 3. Fire-and-forget trigger api-server processLoop
 * 4. Return { status: 'pending', requestId }
 *
 * v2.33.102 CR-7: 之前是 3-step（UPSERT report null → INSERT request → UPDATE report.request_id），
 * step 2/3 之間失敗會留下 orphan pending report 沒 request_id；orphan 永遠 stuck
 * 'pending' 把 user button disable 直到 30s 過期。Reorder 後沒 UPDATE 步驟，
 * UPSERT 直接寫死 request_id。
 *
 * Claude 完成後由 PATCH /api/requests/:id hook 把 reply JSON parse 進
 * trip_health_reports.findings_json + status='completed'。
 */

import { hasPermission, requireAuth, requireTripWrite } from '../../../../lib/permissions';
import { AppError } from '../../../../errors';
import { json } from '../../../../lib/utils';
import { recordEmailEvent } from '../../../../lib/audit';
import { alertAdminTelegram } from '../../../../lib/alert';
import { TRAVEL_MODE_LABEL, type TravelMode } from '../../../../lib/travelMode';
import type { Env } from '../../../../env';

// 識別 health-check request — 寫 trip_requests.message 時固定 prefix，
// PATCH /api/requests/:id 完成 hook 看這個 prefix 識別。修改 prefix 須
// 同步更新 functions/api/requests/[id]/index.ts。
export const HEALTH_CHECK_PREFIX = '[AI 健檢]';

const HEALTH_CHECK_MESSAGE = `${HEALTH_CHECK_PREFIX} 請以資深旅遊規劃師角度審視整份行程，產出健檢報告。

**5 個審查維度（dimension 欄位用這 5 個 key）：**
1. \`timing\` — 時間配置：過密／空檔／開閉店衝突／飯店 check-in buffer
2. \`distance\` — 移動：距離過長／繞路／來回擺盪／travel min 不合理
3. \`meals\` — 餐飲：缺午晚餐／用餐間隔過長／餐廳營業時間衝突
4. \`sights\` — 景點：漏掉必排／必看景點落空／同類景點重複
5. \`hotel\` — 住宿：飯店未連線 polyline／跨日不合理／rating 偏低

**⚠️ 距離與移動時間鐵則（timing／distance 兩維度必讀）**：
所有移動時間與距離，一律以本訊息**末端「行程表記錄的移動時間／距離」區塊**為準——那是系統實際記錄值（Google 實測或手填），等同你呼叫 \`GET /api/trips/:id/days/:num\` 時每個 entry 的 \`travel.min\`／\`travel.distance_m\`。**嚴禁**自行以地理位置、直線距離或常識估算移動時間/距離。若某段標「移動時間未記錄」，代表尚無記錄值，**不得**據此判斷過密／過長／衝突，至多提示「該段移動資料尚未計算」。標為「大眾運輸」的段，其記錄時間可能係以駕車路線估算（日本無大眾運輸實時資料），實際搭乘可能更久；評估此類段的接續是否過緊時請保守看待，但仍不得自行改算數值。

**嚴重程度**：
- \`high\` = 影響行程能否成行（時間軸物理上不可行、必排景點時間衝突）
- \`medium\` = 體驗會打折（繞路 30min+、缺餐、開閉店）
- \`low\` = 可選優化（rating 偏低、可加更順路的景點）

**用詞規定（title / description / suggestion 三欄）**：
- 一律使用繁體中文。**禁用** schema field 借詞：「entry」→「景點」、「min」→「分鐘」、「km」→「公里」、「POI」→「景點」、「check-in」→「入住」、「buffer」→「緩衝時間」、「rating」→「評分」、「travel」→「移動」、「polyline」→「路線」、「alt」→「替代」。
- 範例：禁用「Day 2 重疊 entry 877」→ 用「Day 2 第 877 號景點重疊」。

**回傳純 JSON array，不要 markdown fence、不要前後文字。**

Schema：
\`\`\`json
[{
  "severity": "high|medium|low",
  "dimension": "timing|distance|meals|sights|hotel",
  "title": "簡短中文標題（≤15 字）",
  "description": "具體描述：哪一站、為何有問題、影響為何（≤120 字）",
  "suggestion": "建議怎麼修（≤80 字，可選）",
  "action_target": { "day": 數字, "entry_id": 數字（可選） }
}]
\`\`\`

範例（1 high + 1 low，注意全中文用詞）：
\`\`\`json
[
  {"severity":"high","dimension":"timing","title":"Day 2 飯店入住衝突","description":"Day 2 末站 17:10 結束，但移動 45 分鐘後 17:30 入住物理上不可行","suggestion":"把 Day 2 末站換成更近的景點，或前移時間","action_target":{"day":2,"entry_id":42}},
  {"severity":"low","dimension":"sights","title":"可加美麗海水族館","description":"Day 5 北上路線順路 5 公里，是沖繩必排景點","suggestion":"插入 Day 5 上午","action_target":{"day":5}}
]
\`\`\`

若行程無問題，回 \`[]\`。`;

interface SegmentRecordRow {
  day_num: number;
  from_name: string | null;
  to_name: string | null;
  from_id: number;
  to_id: number;
  mode: string;
  min: number | null;
  distance_m: number | null;
  /** v2.55.46: 1 = 同一地點/免交通（刻意無移動，非「未記錄」）。 */
  no_travel: number | null;
}

/**
 * 把 trip_segments 記錄的每段移動格式化成 prompt 區塊，作為健檢 timing/distance 的
 * 唯一權威來源——直接把系統實際記錄值擺進 prompt，Claude 不需（也不得）自行估算。
 * - time/distance 分開判斷：transit 段是 min 有值、distance_m=NULL 的合法狀態（days API
 *   照樣顯示 travel.min）→ 不可整段當「未記錄」；只有 min 缺才算沒有記錄時間。
 * - POI 名稱是 user/Google 可控，未淨化直接進權威 block 會被塞換行或假記錄行偽造
 *   findings（LLM01）→ 壓成單行 + 截 60 字。名稱取 master POI（sort_order=1 → pois.name），
 *   缺則 fallback entry id。
 */
export function formatSegmentRecords(rows: SegmentRecordRow[]): string {
  if (rows.length === 0) {
    return '（此行程尚無任何移動記錄；不得報任何距離／時間問題，至多提示「移動資料尚未計算」。）';
  }
  const cleanName = (s: string | null, fallback: string) =>
    (s ? s.replace(/\s+/g, ' ').trim().slice(0, 60) : '') || fallback;
  const lines: string[] = [];
  let day = -1;
  for (const r of rows) {
    if (r.day_num !== day) {
      day = r.day_num;
      lines.push(`Day ${r.day_num}`);
    }
    const from = cleanName(r.from_name, `景點#${r.from_id}`);
    const to = cleanName(r.to_name, `景點#${r.to_id}`);
    let travel: string;
    if (r.no_travel === 1) {
      // v2.55.46: 使用者刻意標記「同一地點/免交通」→ 非缺資料。明確告知 Claude 是刻意
      // 無移動（否則 min=NULL 會落入下方「未記錄」分支、把刻意行為誤報成缺值）。
      travel = '同一地點（免交通，刻意無移動；不得據此報時程/距離問題）';
    } else if (r.min == null) {
      travel = '移動時間未記錄（不得據此報時程/距離問題）';
    } else {
      // 只用 3-mode 白名單 label（大眾運輸含 monorail/bus/metro…全塌成通用）。
      // ⚠ 不變式：若日後要餵 submode 提升 AI 準確度，submode 是使用者自由文字 →
      // 必經 cleanName()（同 from/to 名稱）壓單行+截長再內插，否則 free-text 進「權威
      // block」= LLM01 注入面（security review）。切勿直接 travelMethodLabel(mode, submode)。
      const label = TRAVEL_MODE_LABEL[r.mode as TravelMode] ?? '開車';
      const dist = r.distance_m == null ? '' : ` · ${(r.distance_m / 1000).toFixed(1)} 公里`;
      travel = `${label} ${r.min} 分鐘${dist}`;
    }
    lines.push(`  ${from} → ${to}：${travel}`);
  }
  return lines.join('\n');
}

// GET — 取最新 report
export const onRequestGet: PagesFunction<Env> = async (context) => {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;

  if (!(await hasPermission(env.DB, auth, tripId))) {
    throw new AppError('PERM_DENIED');
  }

  const row = await env.DB
    .prepare('SELECT * FROM trip_health_reports WHERE trip_id = ?')
    .bind(tripId)
    .first();

  if (!row) {
    return json({ report: null });
  }

  // 解析 findings_json（DB 是字串）。失敗回空 array 而不爆，避免 stale row
  // 卡住整個頁面。但要 surface 壞 row — 之前 v2.33.124 之前 silent fail 完全
  // 沒人知道（user 看不到健檢結果但無 log）。
  let findings: unknown[] = [];
  const rawFindings = (row as Record<string, unknown>).findings_json;
  if (typeof rawFindings === 'string' && rawFindings.trim()) {
    try {
      const parsed = JSON.parse(rawFindings);
      if (Array.isArray(parsed)) findings = parsed;
    } catch (err) {
      // findings 壞掉視為 0 項，但 alert 一次 admin 知道 DB 有壞 row
      const reportRequestId = (row as Record<string, unknown>).request_id;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[health-check GET] findings_json JSON.parse failed', {
        tripId,
        reportRequestId,
        error: msg,
        rawPreview: rawFindings.slice(0, 120),
      });
      void alertAdminTelegram(
        context.env,
        `🚨 AI 健檢 findings_json 壞 row\n` +
          `trip=${tripId} request=${reportRequestId}\n` +
          `parse 失敗 (${msg}) → 回空 array；\n` +
          `rawFindings 前 120 字：${rawFindings.slice(0, 120)}`,
      );
    }
  }

  return json({
    report: {
      tripId: row.trip_id,
      userId: row.user_id,
      status: row.status,
      requestId: row.request_id,
      findings,
      errorMessage: row.error_message,
      createdAt: row.created_at,
      completedAt: row.completed_at,
    },
  });
};

// POST — 觸發新一輪 health check
function storedFindings(raw: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // GET logs and alerts on corrupt stored rows.
  }
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { env, params } = context;
  const auth = requireAuth(context);
  const tripId = params.id as string;

  await requireTripWrite(env.DB, auth, tripId);

  // v2.31.58 guard：empty trip（沒有任何 entry）不該觸發 AI 健檢 —
  // 浪費 Claude quota + 給 user 沒用的 findings。Frontend 也 disable
  // 開始健檢 button，但 backend 多一層保護防 race condition / direct API call。
  // trip_entries 沒 trip_id 欄位，要 JOIN trip_days（沿用 _auth.ts:89 同 pattern）。
  const entryCount = await env.DB
    .prepare(
      `SELECT COUNT(*) as cnt FROM trip_entries e
       JOIN trip_days d ON e.day_id = d.id
       WHERE d.trip_id = ?`,
    )
    .bind(tripId)
    .first<{ cnt: number }>();
  if (!entryCount || entryCount.cnt === 0) {
    throw new AppError('TRIP_EMPTY');
  }

  // 防止短時間內重複觸發：若 30 秒內已有 pending report 就直接回該 report
  const existing = await env.DB
    .prepare(
      `SELECT * FROM trip_health_reports
       WHERE trip_id = ? AND status = 'pending'
         AND created_at > datetime('now', '-30 seconds')`,
    )
    .bind(tripId)
    .first();

  if (existing) {
    return json({
      report: {
        tripId: existing.trip_id,
        userId: existing.user_id,
        status: existing.status,
        requestId: existing.request_id,
        findings: storedFindings(existing.findings_json),
        createdAt: existing.created_at,
        completedAt: existing.completed_at,
      },
    }, 200);
  }

  const previous = await env.DB.prepare(
    'SELECT findings_json, completed_at FROM trip_health_reports WHERE trip_id = ?',
  ).bind(tripId).first<{ findings_json: string | null; completed_at: string | null }>();
  const previousFindings = storedFindings(previous?.findings_json);

  // v2.55.x: 把 trip_segments 記錄的移動時間/距離嵌進 prompt，作為 timing/distance
  // 的唯一權威來源。之前 prompt 只給靜態指示、沒給實際數字 → Claude 憑地理位置瞎估 →
  // 報出錯誤的時程/距離問題（user 回報）。
  // 不變式：min/distance_m 直接讀 trip_segments 原欄位，與 days API 的 travel.min/
  // distance_m 同源（_merge.ts 亦原樣 copy）→「等同 days API」由構造保證；master POI
  // 解析（sort_order=1 → pois.name）對齊 _merge.ts，若該慣例改動需同步。
  // ROW_NUMBER 每 from_entry 只留最新一段（updated_at DESC）：對齊 days API 的
  // Map<from_entry_id> 每站一段模型，並排除 reorder 後未清的 stale 非相鄰段（recompute
  // 只 upsert 相鄰對、不刪舊段），否則會把 timeline 看不到的幽靈段餵給 Claude 審查。
  const segRes = await env.DB
    .prepare(
      `WITH ranked AS (
         SELECT s.from_entry_id, s.to_entry_id, s.mode, s.min, s.distance_m, s.no_travel,
                ROW_NUMBER() OVER (
                  PARTITION BY s.from_entry_id ORDER BY s.updated_at DESC, s.id DESC
                ) AS rn
         FROM trip_segments s
         WHERE s.trip_id = ?
       )
       SELECT fd.day_num AS day_num,
              fp.name AS from_name, tp.name AS to_name,
              r.from_entry_id AS from_id, r.to_entry_id AS to_id,
              r.mode AS mode, r.min AS min, r.distance_m AS distance_m, r.no_travel AS no_travel
       FROM ranked r
       JOIN trip_entries fe ON fe.id = r.from_entry_id
       JOIN trip_days fd ON fd.id = fe.day_id
       LEFT JOIN trip_entry_pois ftep ON ftep.entry_id = r.from_entry_id AND ftep.sort_order = 1
       LEFT JOIN pois fp ON fp.id = ftep.poi_id
       LEFT JOIN trip_entry_pois ttep ON ttep.entry_id = r.to_entry_id AND ttep.sort_order = 1
       LEFT JOIN pois tp ON tp.id = ttep.poi_id
       WHERE r.rn = 1
       ORDER BY fd.day_num ASC, fe.sort_order ASC`,
    )
    .bind(tripId)
    .all<SegmentRecordRow>();

  const message = `${HEALTH_CHECK_MESSAGE}

【行程表記錄的移動時間／距離（唯一權威來源，timing/distance 一律以此為準）】
${formatSegmentRecords(segRes.results ?? [])}`;

  // 1. INSERT trip_requests — chat trail 先建立拿 id，下一步直接寫進 report
  const reqRow = await env.DB
    .prepare(
      'INSERT INTO trip_requests (trip_id, message, submitted_by) VALUES (?, ?, ?) RETURNING id',
    )
    .bind(tripId, message, auth.email)
    .first<{ id: number }>();

  if (!reqRow) {
    throw new AppError('SYS_DB_ERROR', '建立健檢 request 失敗');
  }
  const requestId = reqRow.id;

  // 2. UPSERT trip_health_reports → status='pending' 帶 request_id（v2.33.102 CR-7：
  // 一發到位，沒有 step 3 UPDATE，斷在中間不會留 orphan request_id=NULL row）
  // v2.33.85 bug fix: 之前用 auth.email 寫進 user_id（FK to users.id），
  // migration 0069 加 FK 後此 INSERT FK-fail。Email ≠ userId（users.id 是 uuid）。
  await env.DB
    .prepare(
      `INSERT INTO trip_health_reports
         (trip_id, user_id, status, request_id, findings_json, error_message, created_at, completed_at)
       VALUES (?, ?, 'pending', ?, NULL, NULL, datetime('now'), NULL)
       ON CONFLICT(trip_id) DO UPDATE SET
         user_id = excluded.user_id,
         status = 'pending',
         request_id = excluded.request_id,
         error_message = NULL,
         -- Keep the last finished report until a new completion replaces it.
         created_at = datetime('now')`,
    )
    .bind(tripId, auth.userId, requestId)
    .run();

  // 4. Fire-and-forget trigger Mac Mini API server (與 POST /api/requests 同 pattern)
  context.waitUntil(
    (async () => {
      if (!env.TRIPLINE_API_URL) {
        await recordEmailEvent(env.DB, {
          template: 'trigger',
          recipient: 'system',
          status: 'config-missing',
          tripId,
          triggeredBy: auth.email,
          error: 'TRIPLINE_API_URL not configured (health-check)',
        });
        return;
      }
      try {
        const ctrl = new AbortController();
        // v2.33.113: 3000 → 8000ms — see functions/api/requests.ts for full rationale
        // (CF edge → Tailscale Funnel cold connection setup can hit 4-5s)
        const timer = setTimeout(() => ctrl.abort(), 8000);
        const res = await fetch(env.TRIPLINE_API_URL + '/trigger?source=api', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TRIPLINE_API_SECRET}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ requestId }),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Trigger responded ${res.status}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await recordEmailEvent(env.DB, {
          template: 'trigger',
          recipient: 'system',
          status: 'trigger-failed',
          tripId,
          triggeredBy: auth.email,
          error: `health-check: ${msg}`,
        });
        await alertAdminTelegram(
          env,
          `健檢觸發失敗（cron 5min 兜底）: trip=${tripId}, request=${requestId} (${msg})`,
        );
      }
    })(),
  );

  return json(
    {
      report: {
        tripId,
        userId: auth.userId,
        status: 'pending',
        requestId,
        findings: previousFindings,
        createdAt: new Date().toISOString(),
        completedAt: previous?.completed_at ?? null,
      },
    },
    202,
  );
};
