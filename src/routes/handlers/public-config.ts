/**
 * GET /api/public-config
 *
 * Public capability probe — tells unauthenticated clients which optional providers
 * are configured for this deployment so the UI can hide buttons that would lead
 * to a 503. No secrets are exposed; we only signal "configured / not configured".
 *
 * Response: { providers: { google: boolean }, features: { passwordSignup: boolean } }
 *
 * NOTE: keep this endpoint side-effect-free (no D1 writes, no state tokens).
 * It runs on every login/signup page load, so any work done here multiplies.
 */
import type { Env } from '../../env';

export const onRequestGet: PagesFunction<Env> = (context) => {
  const env = context.env;
  return new Response(
    JSON.stringify({
      providers: {
        google: Boolean(env.GOOGLE_CLIENT_ID),
      },
      features: {
        passwordSignup: true,
        // 2026-05-02 cutover: gate on TRIPLINE_API_URL + TRIPLINE_API_SECRET
        // (mac mini Gmail SMTP via Tailscale Funnel). Resend env kept as
        // backward-compat OR fallback during rollout.
        emailVerification: Boolean(
          (env.TRIPLINE_API_URL && env.TRIPLINE_API_SECRET) ||
          (env.RESEND_API_KEY && env.EMAIL_FROM),
        ),
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Short cache; values change only on env update which redeploys.
        'cache-control': 'public, max-age=60',
      },
    },
  );
};
