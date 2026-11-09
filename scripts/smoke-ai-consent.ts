/// <reference types="node" />
/**
 * AI 資料同意閘門的 staging smoke（trip-planner#1615）。
 *
 *   node scripts/smoke-ai-consent.ts                    # 依 staging「目前實際狀態」驗證同意端點（種測試帳號 → 驗證 → 清理）
 *   node scripts/smoke-ai-consent.ts --with-requests    # 再驗三個受管制入口之一（POST /api/requests）的放行／攔截
 *   node scripts/smoke-ai-consent.ts --cleanup    # 只清前綴資料
 *
 * ⚠ 只准對 staging：base URL 與 D1 名稱走白名單，production 字樣、--env 一律拒絕（assertStaging，有測試守住）。
 *   D1 讀寫走 wrangler 既有登入（--remote，指令不帶 --env）；不讀、不印任何機密；不修改 staging 的文案或 secret。
 * 測試資料一律以 `smoke1615-` 為前綴，結束時只刪這個前綴的列（使用者、行程、request、同意事件、audit_log、rate limit 桶）。
 *   api_logs 是每個請求都會寫的通用存取紀錄，沒有可歸屬的前綴欄位，不刪（不屬於測試資料）。
 * 預設只打同意端點（只寫前綴使用者的同意事件）。會建立 trip_request 的 AI 入口步驟需明確加 --with-requests：
 *   建立 request 會觸發通知流程（對 companion 的 trigger），staging 是否接了外部服務我們看不到，所以不預設執行。
 *
 * 判定以 staging 實際狀態為準：先 GET 同意狀態讀 `enforced`。
 *   enforced=false（目前預期）：驗證「不強制時 AI 入口放行、三個同意端點可用」；強制情境標 SKIP（只會在文案仍含占位符時發生，閘門本身沒有旗標）。
 *   enforced=true：多驗 403／同意後放行／旅伴／撤回後再被攔。
 * 結束碼：0 無失敗（SKIP 不算失敗）；1 有項目失敗；2 安全閘拒絕或腳本自己跑不起來。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STAGING_ORIGIN = 'https://trip-planner-api.lean-lean.workers.dev';
export const STAGING_D1 = 'trip-planner-db-staging';
export const PREFIX = 'smoke1615-';
const CLIENT = 'tripline-web';

export interface Target { baseUrl: string; d1: string }

/** 白名單閘：任何不是 staging 的跡象（production 字樣、--env、非白名單網址／D1）都 throw。 */
export function assertStaging(argv: string[]): Target {
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  if (argv.some((a) => /production/i.test(a) || a === '-e' || a === '--env' || a.startsWith('--env='))) {
    throw new Error('拒絕：偵測到 production／--env，本腳本只准對 staging 執行');
  }
  let origin: string;
  try { origin = new URL(arg('base-url') ?? STAGING_ORIGIN).origin; } catch { throw new Error('拒絕：base URL 無法解析'); }
  const d1 = arg('d1') ?? STAGING_D1;
  if (origin !== STAGING_ORIGIN) throw new Error(`拒絕：base URL 不在白名單（只接受 ${STAGING_ORIGIN}）`);
  if (d1 !== STAGING_D1) throw new Error(`拒絕：D1 不在白名單（只接受 ${STAGING_D1}）`);
  return { baseUrl: origin, d1 };
}

export interface Io {
  sql(statement: string): Promise<Record<string, unknown>[]>;
  http(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }>;
}

/** 只刪前綴資料；LIKE 的 `smoke1615-` 不含萬用字元。順序：先子表再 users。 */
export function cleanupSql(): string[] {
  return [
    `DELETE FROM audit_log WHERE trip_id LIKE '${PREFIX}%'`,
    `DELETE FROM trip_requests WHERE trip_id LIKE '${PREFIX}%'`,
    `DELETE FROM rate_limit_buckets WHERE bucket_key LIKE 'ai-request:user:${PREFIX}%'`,
    `DELETE FROM ai_data_consent_events WHERE user_id LIKE '${PREFIX}%'`,
    `DELETE FROM trip_permissions WHERE trip_id LIKE '${PREFIX}%' OR user_id LIKE '${PREFIX}%'`,
    `DELETE FROM trips WHERE id LIKE '${PREFIX}%'`,
    `DELETE FROM oauth_models WHERE id LIKE '${PREFIX}%' OR json_extract(payload, '$.user_id') LIKE '${PREFIX}%'`,
    `DELETE FROM users WHERE id LIKE '${PREFIX}%'`,
  ];
}

async function cleanup(io: Io): Promise<void> {
  for (const s of cleanupSql()) await io.sql(s);
}

const hex = () => randomBytes(8).toString('hex');
const FAR = 10 * 60 * 1000;

interface Actor { uid: string; token: string }

async function mkUser(io: Io, run: string, name: string): Promise<Actor> {
  const uid = `${PREFIX}${run}-${name}`;
  const token = `${uid}-tok-${hex()}${hex()}`;
  await io.sql(`INSERT INTO users (id, email, display_name) VALUES ('${uid}', '${uid}@smoke.invalid', 'smoke 1615')`);
  const payload = JSON.stringify({ client_id: CLIENT, user_id: uid, grantId: `${uid}-grant`, scopes: ['openid', 'trips:read', 'trips:write'] }).replace(/'/g, "''");
  await io.sql(`INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', '${token}', '${payload}', ${Date.now() + FAR})`);
  return { uid, token };
}

async function mkTrip(io: Io, run: string, owner: Actor, member: Actor): Promise<string> {
  const id = `${PREFIX}${run}-trip`;
  await io.sql(`INSERT INTO trips (id, name, owner_user_id, title, countries, published) VALUES ('${id}', '${id}', '${owner.uid}', 'smoke 1615', 'JP', 0)`);
  await io.sql(`INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('${owner.uid}', '${id}', 'owner')`);
  await io.sql(`INSERT INTO trip_permissions (user_id, trip_id, role) VALUES ('${member.uid}', '${id}', 'member')`);
  return id;
}

export interface Result { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail: string }

const PATH = '/api/account/ai-data-consent';
const code = (r: { json: any }) => r.json?.error?.code as string | undefined;

/**
 * 情境。每項獨立；失敗不中斷其餘項；無論如何最後清理。
 * 先讀 enforced 決定走哪組；會寫入的只有前綴使用者、前綴行程與其 request／同意事件。
 */
export async function runScenarios(io: Io, opts: { withRequests?: boolean } = {}): Promise<Result[]> {
  const run = randomBytes(3).toString('hex');
  const results: Result[] = [];
  const step = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try { const [ok, detail] = await fn(); results.push({ name, status: ok ? 'PASS' : 'FAIL', detail }); } catch (e) { results.push({ name, status: 'FAIL', detail: `例外：${(e as Error).message}` }); }
  };
  const skip = (name: string, detail: string) => results.push({ name, status: 'SKIP', detail });
  // 需要建立 trip_request 的步驟：沒帶 --with-requests 就 SKIP（見檔頭說明）
  const reqStep = async (name: string, fn: () => Promise<[boolean, string]>) =>
    opts.withRequests ? step(name, fn) : skip(name, '未帶 --with-requests（建立 request 會觸發通知流程，預設不做）');

  try {
    const owner = await mkUser(io, run, 'own');
    const collab = await mkUser(io, run, 'col');
    const trip = await mkTrip(io, run, owner, collab);
    const submit = (a: Actor) => io.http('POST', '/api/requests', a.token, { tripId: trip, message: `smoke1615 ${hex()}` });
    const get = (a: Actor) => io.http('GET', PATH, a.token);

    let enforced: boolean | null = null;
    await step('同意狀態端點 GET', async () => {
      const r = await get(owner);
      enforced = typeof r.json?.enforced === 'boolean' ? r.json.enforced : null;
      const ok = r.status === 200 && r.json?.status === 'none' && typeof r.json?.currentVersion === 'string' && enforced !== null;
      return [ok, `HTTP ${r.status}、status=${r.json?.status}、currentVersion=${r.json?.currentVersion}、enforced=${enforced}`];
    });
    if (enforced === null) return results;

    await step('版本不符 POST → 409 且不寫入', async () => {
      const r = await io.http('POST', PATH, owner.token, { version: 'ai-data-v0-smoke' });
      const after = await get(owner);
      return [r.status === 409 && code(r) === 'AI_CONSENT_VERSION_MISMATCH' && after.json?.status === 'none', `HTTP ${r.status} ${code(r)}、之後 status=${after.json?.status}`];
    });

    const version = (await get(owner)).json?.currentVersion as string;
    let accepted = false;
    await step('同意 POST（文案已填妥→200 valid；未填妥→409 AI_CONSENT_NOT_READY）', async () => {
      const r = await io.http('POST', PATH, owner.token, { version });
      accepted = r.status === 200 && r.json?.status === 'valid';
      const notReady = r.status === 409 && code(r) === 'AI_CONSENT_NOT_READY';
      return [accepted || notReady, `HTTP ${r.status} ${code(r) ?? r.json?.status}（${accepted ? '文案已填妥，同意已記錄' : '文案仍含占位符，未記錄同意'}）`];
    });

    await step('撤回 DELETE（冪等，回狀態）', async () => {
      const r = await io.http('DELETE', PATH, owner.token);
      const again = await io.http('DELETE', PATH, owner.token);
      const want = accepted ? 'withdrawn' : 'none';
      return [r.status === 200 && again.status === 200 && r.json?.status === want && again.json?.status === want, `第一次 ${r.status}/${r.json?.status}、第二次 ${again.status}/${again.json?.status}（預期 ${want}）`];
    });

    if (!enforced) {
      await reqStep('不強制：owner 沒有同意也放行（201）', async () => {
        const r = await submit(owner);
        return [r.status === 201 && !String(code(r) ?? '').startsWith('AI_CONSENT'), `HTTP ${r.status} ${code(r) ?? ''}`];
      });
      await reqStep('不強制：旅伴沒有同意、owner 也沒有 → 放行（201）', async () => {
        const r = await submit(collab);
        return [r.status === 201 && !String(code(r) ?? '').startsWith('AI_CONSENT'), `HTTP ${r.status} ${code(r) ?? ''}`];
      });
      const why = 'staging 目前不強制（文案仍含占位符；閘門已無旗標），文案填妥並部署後才能驗';
      for (const n of ['強制：未同意被攔 403 AI_CONSENT_REQUIRED', '強制：同意後放行', '強制：旅伴送出、owner 未同意 → AI_CONSENT_OWNER_REQUIRED', '強制：撤回後再次被攔']) skip(n, why);
    } else {
      await reqStep('強制：未同意被攔 403 AI_CONSENT_REQUIRED', async () => {
        await io.http('DELETE', PATH, owner.token);
        const r = await submit(owner);
        return [r.status === 403 && code(r) === 'AI_CONSENT_REQUIRED', `HTTP ${r.status} ${code(r)}`];
      });
      await reqStep('強制：旅伴送出、owner 未同意 → AI_CONSENT_OWNER_REQUIRED', async () => {
        await io.http('POST', PATH, collab.token, { version });
        const r = await submit(collab);
        return [r.status === 403 && code(r) === 'AI_CONSENT_OWNER_REQUIRED', `HTTP ${r.status} ${code(r)}`];
      });
      await reqStep('強制：同意後放行', async () => {
        await io.http('POST', PATH, owner.token, { version });
        const a = await submit(owner);
        const b = await submit(collab);
        return [a.status === 201 && b.status === 201, `owner ${a.status}、旅伴 ${b.status}`];
      });
      await reqStep('強制：撤回後再次被攔', async () => {
        await io.http('DELETE', PATH, owner.token);
        const r = await submit(owner);
        return [r.status === 403 && code(r) === 'AI_CONSENT_REQUIRED', `HTTP ${r.status} ${code(r)}`];
      });
    }
    skip('erasure 清除同意紀錄', '帳號刪除需 fresh-auth，無法由 smoke 自動觸發；由 tests/baseline/ai-data-consent.test.ts 對 eraseUserAccount 守住，清理則由本腳本的前綴刪除保證');
  } finally {
    await cleanup(io);
  }
  return results;
}

/** 真實 Io：D1 走 wrangler（--remote、不帶 --env），HTTP 走 fetch。target 只能來自 assertStaging。 */
function realIo(t: Target): Io {
  return {
    async sql(statement) {
      const out = execFileSync('npx', ['wrangler', 'd1', 'execute', t.d1, '--remote', '--json', '--command', statement], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
      const parsed = JSON.parse(out) as { results?: Record<string, unknown>[] }[];
      return parsed.flatMap((p) => p.results ?? []);
    },
    async http(method, path, token, body) {
      const res = await fetch(new URL(path, t.baseUrl), {
        method, headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
  };
}

export const OWNER_STEPS = `
要在 staging 驗強制情境（閘門已無旗標，文案完整即強制；本腳本不會改 staging 設定或 secret）：
  1. 確認同意文案（src/lib/ai-data-consent-text.ts）已無 {{...}} 占位符，並已部署到 staging。
  2. 重新跑本腳本：GET 回 enforced=true 後，上面的 SKIP 項會改為實際驗證。
`;

async function main(argv: string[]): Promise<number> {
  let target: Target;
  try { target = assertStaging(argv); } catch (e) { console.error((e as Error).message); return 2; }
  const io = realIo(target);
  if (argv.includes('--cleanup')) { await cleanup(io); console.log('已清理前綴資料'); return 0; }
  const results = await runScenarios(io, { withRequests: argv.includes('--with-requests') });
  for (const r of results) console.log(`${r.status}  ${r.name} — ${r.detail}`);
  if (results.some((r) => r.status === 'SKIP')) console.log(OWNER_STEPS);
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error((e as Error).message); process.exitCode = 2; });
}
