/**
 * GET /api/account/connected-apps
 *
 * V2-P5 — User-side list of granted OAuth client apps（mockup section 4
 * 「已連結的應用」）。配 client_apps registry + Consent payload。
 *
 * Auth: requireSessionUser
 *
 * Response: { apps: [{ client_id, app_name, app_logo_url?, app_description?,
 *                       homepage_url?, status, scopes[], granted_at }] }
 *
 * Note: 不顯示 access_tokens / refresh_tokens — 那是內部實作細節。User 看到
 * 的是「我同意了什麼 app 用我的帳號」。
 */
import { requireAccountUser } from '../../../lib/account-user';
import { rawJson } from '../../../lib/utils';
import type { Env } from '../../../env';

interface ConsentPayloadShape {
  user_id: string;
  client_id: string;
  scopes: string[];
  grantedAt: number;
}

interface ConnectedAppRow {
  consent_payload: string;
  client_id: string;
  app_name: string;
  app_description: string | null;
  app_logo_url: string | null;
  homepage_url: string | null;
  status: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);

  const result = await context.env.DB
    .prepare(
      `SELECT
         om.payload AS consent_payload,
         ca.client_id, ca.app_name, ca.app_description, ca.app_logo_url,
         ca.homepage_url, ca.status
       FROM oauth_models om
       JOIN client_apps ca ON json_extract(om.payload, '$.client_id') = ca.client_id
       WHERE om.name = 'Consent'
         AND json_extract(om.payload, '$.user_id') = ?
         AND (om.expires_at > ? OR om.expires_at IS NULL)
       ORDER BY json_extract(om.payload, '$.grantedAt') DESC`,
    )
    .bind(session.uid, Date.now())
    .all<ConnectedAppRow>();

  const apps = (result.results ?? [])
    .map((row) => {
      let payload: ConsentPayloadShape;
      try {
        payload = JSON.parse(row.consent_payload) as ConsentPayloadShape;
      } catch {
        // Corrupt consent_payload — skip this row rather than 500 the whole list.
        return null;
      }
      return {
        client_id: row.client_id,
        app_name: row.app_name,
        app_description: row.app_description,
        app_logo_url: row.app_logo_url,
        homepage_url: row.homepage_url,
        status: row.status,
        scopes: payload.scopes,
        granted_at: payload.grantedAt,
      };
    })
    .filter(Boolean);

  return rawJson({ apps });
};
