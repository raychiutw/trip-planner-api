/**
 * GET /api/oauth/client-info?client_id=<id> — consent 畫面用的公開 app 品牌資訊。
 *
 * ConsentPage 在使用者按「允許」前呼叫，顯示「哪個 app 要用我的帳號」（app_name / logo /
 * description / homepage）。取代先前的 placeholder：舊版把 `?client_id=` 原文當 app_name 顯，
 * attacker 可構 `?client_id=Tripline%20官方登入` 騙 user click Allow（v2.33.46 audit）。改由
 * 後端只回**已註冊 active** client 的品牌，未知/停用一律 404 讓前端保留「未知應用程式」警告。
 *
 * Auth: 無（public）。理由：這是 consent 畫面渲染前就要顯示的公開品牌，且 /api/oauth/* 走
 *   middleware public bypass；authorize 流程本身已揭露 client 是否有效，此端點不擴大列舉面。
 *   只 SELECT 公開欄位（app_name/description/logo/homepage）——**絕不回 client_secret**。只回
 *   status='active'（避免洩漏 suspended/pending app 名稱），未知/非 active → DATA_NOT_FOUND(404)。
 *
 * 回：{ app_name, app_description, app_logo_url, homepage_url }（rawJson，保 snake_case——
 *   ConsentPage 的 ClientAppInfo 用 snake_case，deepCamel 會把 app_name→appName 弄壞）。
 */
import { AppError } from '../../../errors';
import { rawJson } from '../../../lib/utils';
import type { Env } from '../../../env';

interface ClientAppRow {
  app_name: string;
  app_description: string | null;
  app_logo_url: string | null;
  homepage_url: string | null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const clientId = (new URL(context.request.url).searchParams.get('client_id') ?? '').trim();
  if (!clientId) throw new AppError('DATA_VALIDATION', 'client_id 必填');

  const row = await context.env.DB.prepare(
    `SELECT app_name, app_description, app_logo_url, homepage_url
       FROM client_apps WHERE client_id = ? AND status = 'active'`,
  )
    .bind(clientId)
    .first<ClientAppRow>();

  // 未註冊 / 非 active → 404。ConsentPage 保留「未知應用程式」保底顯示 + 警告。
  if (!row) throw new AppError('DATA_NOT_FOUND', 'client 不存在或未啟用');

  return rawJson({
    app_name: row.app_name,
    app_description: row.app_description,
    app_logo_url: row.app_logo_url,
    homepage_url: row.homepage_url,
  });
};
