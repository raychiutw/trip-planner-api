/// <reference types="node" />
/**
 * 帳號刪除 fresh-auth（delete-reauth）的可重跑 staging smoke（trip-planner#1616）。
 *
 *   node scripts/smoke-delete-reauth.ts                       # 自動情境（種測試帳號 → 驗證 → 清理）
 *   node scripts/smoke-delete-reauth.ts --manual-start --google-sub=<受控 Google 帳號的 sub>
 *   node scripts/smoke-delete-reauth.ts --manual-check        # 人工授權後確認 challenge 狀態
 *   node scripts/smoke-delete-reauth.ts --cleanup             # 只清前綴資料
 *
 * ⚠ 只准對 staging：base URL 與 D1 名稱走白名單，production 字樣、--env 一律拒絕（assertStaging，有測試守住）。
 *   D1 讀寫走 wrangler 既有登入（--remote，指令不帶 --env）；不讀、不印任何機密。
 * 測試資料一律以 `smoke1616-` 為前綴，結束時只刪這個前綴的列（使用者、登入身分、oauth_models）與自己建的 trigger。
 * 真實 Google 往返無法自動化：--manual-start 只印授權連結，授權成功＝callback 已驗過 auth_time（缺或過舊會是 failed）。
 * 結束碼：0 全過；1 有項目失敗；2 安全閘拒絕或腳本自己跑不起來。
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const STAGING_ORIGIN = 'https://trip-planner-api.lean-lean.workers.dev';
export const STAGING_D1 = 'trip-planner-db-staging';
export const PREFIX = 'smoke1616-';
const CLIENT = 'tripline-web';
const TRIGGER_PREFIX = 'smoke1616_';

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

/** 只刪前綴資料；LIKE 的 `smoke1616-` 不含萬用字元。 */
export function cleanupSql(): string[] {
  return [
    `DELETE FROM oauth_models WHERE id LIKE '${PREFIX}%' OR json_extract(payload, '$.uid') LIKE '${PREFIX}%' OR json_extract(payload, '$.user_id') LIKE '${PREFIX}%'`,
    `DELETE FROM auth_identities WHERE user_id LIKE '${PREFIX}%'`,
    `DELETE FROM users WHERE id LIKE '${PREFIX}%'`,
  ];
}

async function cleanup(io: Io): Promise<void> {
  for (const t of await io.sql(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${TRIGGER_PREFIX}%'`)) {
    await io.sql(`DROP TRIGGER IF EXISTS "${String(t.name).replace(/"/g, '')}"`);
  }
  for (const s of cleanupSql()) await io.sql(s);
}

const hex = () => randomBytes(8).toString('hex');
const FAR = 10 * 60 * 1000;

interface Actor { uid: string; token: string; grantId: string }

async function mkUser(io: Io, run: string, name: string, google: string | null = `${PREFIX}${run}-${name}`): Promise<Actor> {
  const uid = `${PREFIX}${run}-${name}`;
  const token = `${uid}-tok-${hex()}${hex()}`;
  const grantId = `${uid}-grant`;
  const now = Date.now();
  await io.sql(`INSERT INTO users (id, email, display_name) VALUES ('${uid}', '${uid}@smoke.invalid', 'smoke 1616')`);
  if (google) await io.sql(`INSERT INTO auth_identities (user_id, provider, provider_user_id) VALUES ('${uid}', 'google', '${google}')`);
  const payload = JSON.stringify({ client_id: CLIENT, user_id: uid, grantId, scopes: ['openid'] }).replace(/'/g, "''");
  await io.sql(`INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccessToken', '${token}', '${payload}', ${now + FAR})`);
  return { uid, token, grantId };
}

async function mkChallenge(io: Io, a: Actor, status: string, expiresAt = Date.now() + FAR): Promise<string> {
  const id = `${a.uid}-ch-${hex()}`;
  const payload = JSON.stringify({ uid: a.uid, grantId: a.grantId, clientId: CLIENT, status, surface: 'web' });
  await io.sql(`INSERT INTO oauth_models (name, id, payload, expires_at) VALUES ('AccountDeleteChallenge', '${id}', '${payload}', ${expiresAt})`);
  return id;
}

const userExists = async (io: Io, uid: string) => (await io.sql(`SELECT 1 AS x FROM users WHERE id = '${uid}'`)).length === 1;
const chStatus = async (io: Io, id: string) =>
  String((await io.sql(`SELECT json_extract(payload, '$.status') AS s FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND id = '${id}'`))[0]?.s);
const tokenRows = async (io: Io, uid: string) =>
  (await io.sql(`SELECT 1 AS x FROM oauth_models WHERE json_extract(payload, '$.user_id') = '${uid}' OR json_extract(payload, '$.uid') = '${uid}'`)).length;

export interface Result { name: string; ok: boolean; detail: string }

/** 自動情境。每項獨立（各用自己的測試帳號），失敗不中斷其餘項；無論如何最後清理。 */
export async function runScenarios(io: Io): Promise<Result[]> {
  const run = hex();
  const results: Result[] = [];
  const del = (a: Actor, body: unknown) => io.http('DELETE', '/api/account', a.token, body);
  const step = async (name: string, fn: () => Promise<[boolean, string]>) => {
    try { const [ok, detail] = await fn(); results.push({ name, ok, detail }); } catch (e) { results.push({ name, ok: false, detail: `例外：${(e as Error).message}` }); }
  };

  try {
    await step('無 challenge', async () => {
      const a = await mkUser(io, run, 'nochal');
      const r1 = await del(a, {});
      const r2 = await del(a, { challengeId: `${PREFIX}${run}-nonexistent` });
      const kept = await userExists(io, a.uid);
      return [[400, 403].includes(r1.status) && r2.status === 403 && kept, `空 body ${r1.status}、不存在的 challengeId ${r2.status}、帳號仍在=${kept}`];
    });

    await step('challenge 未完成', async () => {
      const a = await mkUser(io, run, 'pending');
      const created = await io.http('POST', '/api/account/delete-reauth', a.token);
      const id = created.json?.challengeId as string | undefined;
      if (created.status !== 200 || !id) return [false, `建立 challenge 回 ${created.status}`];
      const r = await del(a, { challengeId: id });
      const status = await chStatus(io, id);
      const kept = await userExists(io, a.uid);
      return [r.status === 403 && status === 'pending' && kept, `DELETE ${r.status}、challenge=${status}、帳號仍在=${kept}`];
    });

    await step('challenge 過期', async () => {
      const a = await mkUser(io, run, 'expired');
      const id = await mkChallenge(io, a, 'verified', Date.now() - 1000);
      const r = await del(a, { challengeId: id });
      const kept = await userExists(io, a.uid);
      return [r.status === 403 && kept, `DELETE ${r.status}、帳號仍在=${kept}`];
    });

    await step('跨帳號', async () => {
      const a = await mkUser(io, run, 'owner');
      const b = await mkUser(io, run, 'thief');
      const id = await mkChallenge(io, a, 'verified');
      const r = await del(b, { challengeId: id });
      const status = await chStatus(io, id);
      const kept = (await userExists(io, a.uid)) && (await userExists(io, b.uid));
      return [r.status === 403 && status === 'verified' && kept, `別人的 token 帶 A 的 challenge：${r.status}、challenge=${status}、兩帳號仍在=${kept}`];
    });

    await step('重放', async () => {
      const a = await mkUser(io, run, 'replay');
      const id = await mkChallenge(io, a, 'used');
      const r = await del(a, { challengeId: id });
      const kept = await userExists(io, a.uid);
      return [r.status === 403 && kept, `已 used 的 challenge：${r.status}、帳號仍在=${kept}`];
    });

    await step('失敗回滾後可重試', async () => {
      const a = await mkUser(io, run, 'rollback');
      const id = await mkChallenge(io, a, 'verified');
      const trig = `${TRIGGER_PREFIX}${run}_block`;
      // 讓抹除 batch 最後一句（DELETE users）失敗，驗證整批回滾與 challenge 還原。
      await io.sql(`CREATE TRIGGER "${trig}" BEFORE DELETE ON users WHEN OLD.id = '${a.uid}' BEGIN SELECT RAISE(ABORT, 'smoke1616'); END`);
      let first;
      try { first = await del(a, { challengeId: id }); } finally { await io.sql(`DROP TRIGGER IF EXISTS "${trig}"`); }
      const mid = { kept: await userExists(io, a.uid), status: await chStatus(io, id), tokens: await tokenRows(io, a.uid) };
      const second = await del(a, { challengeId: id });
      const gone = !(await userExists(io, a.uid));
      return [first.status >= 500 && mid.kept && mid.status === 'verified' && mid.tokens >= 2 && second.status === 200 && gone,
        `失敗那次 ${first.status}（帳號仍在=${mid.kept}、challenge=${mid.status}、token/challenge 列=${mid.tokens}）；重試 ${second.status}、帳號已刪=${gone}`];
    });

    await step('並行兩次 DELETE', async () => {
      const a = await mkUser(io, run, 'race');
      const id = await mkChallenge(io, a, 'verified');
      const rs = await Promise.all([del(a, { challengeId: id }), del(a, { challengeId: id })]);
      const codes = rs.map((r) => r.status).sort();
      const gone = !(await userExists(io, a.uid));
      // 輸家可能是 403（challenge 已 used）或 401（token 已被撤銷），但不可能兩個都成功。
      return [codes.filter((c) => c === 200).length === 1 && codes.every((c) => [200, 401, 403].includes(c)) && gone, `狀態碼 ${codes.join('／')}、帳號已刪=${gone}`];
    });

    await step('成功後 token 撤銷', async () => {
      const a = await mkUser(io, run, 'revoke');
      const id = await mkChallenge(io, a, 'verified');
      const ok = await del(a, { challengeId: id });
      const after = await io.http('GET', '/api/account', a.token);
      const rows = await tokenRows(io, a.uid);
      return [ok.status === 200 && after.status === 401 && rows === 0, `刪除 ${ok.status}、舊 token 再用 ${after.status}、殘留 token/challenge 列=${rows}`];
    });
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

async function manual(io: Io, argv: string[]): Promise<number> {
  const uid = `${PREFIX}manual`;
  if (argv.includes('--manual-start')) {
    const sub = argv.find((a) => a.startsWith('--google-sub='))?.slice(13);
    if (!sub) { console.error('需要 --google-sub=<受控 Google 帳號的 sub>'); return 2; }
    await cleanup(io);
    const a = await mkUser(io, 'x', 'manual', sub);
    const r = await io.http('POST', '/api/account/delete-reauth', a.token);
    if (r.status !== 200) { console.error(`建立 challenge 失敗：${r.status}`); await cleanup(io); return 1; }
    console.log(`1. 用受控 Google 帳號開啟（5 分鐘內）：\n   ${r.json.authorizeUrl}\n2. 完成授權後執行：node scripts/smoke-delete-reauth.ts --manual-check\n3. 全部確認完再跑 --cleanup（不會實際刪除帳號）`);
    return 0;
  }
  const rows = await io.sql(`SELECT json_extract(payload, '$.status') AS s, expires_at FROM oauth_models WHERE name = 'AccountDeleteChallenge' AND json_extract(payload, '$.uid') = '${uid}'`);
  const s = rows[0]?.s;
  console.log(`challenge 狀態：${s ?? '找不到'}（verified＝Google 已回傳符合時效的 auth_time；failed＝缺少或過舊／身分不符）`);
  return s === 'verified' ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  let target: Target;
  try { target = assertStaging(argv); } catch (e) { console.error((e as Error).message); return 2; }
  const io = realIo(target);
  if (argv.includes('--cleanup')) { await cleanup(io); console.log('已清理前綴資料'); return 0; }
  if (argv.includes('--manual-start') || argv.includes('--manual-check')) return manual(io, argv);
  const results = await runScenarios(io);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error((e as Error).message); process.exitCode = 2; });
}
