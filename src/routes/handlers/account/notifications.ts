/**
 * GET /api/account/notifications   — read current user's notification preferences
 * PATCH /api/account/notifications — update current user's notification preferences
 *
 * Body: { tripUpdates?: boolean, invitations?: boolean, system?: boolean }
 * Defaults are enabled for all groups when a user has not saved preferences yet.
 */
import { requireAccountUser } from '../../../lib/account-user';
import { AppError } from '../../../errors';
import { json, parseJsonBody } from '../../../lib/utils';
import type { Env } from '../../../env';

interface NotificationPreferenceRow {
  trip_updates: number;
  invitations: number;
  system: number;
  updated_at: string | null;
}

interface NotificationPreferences {
  tripUpdates: boolean;
  invitations: boolean;
  system: boolean;
  updatedAt: string | null;
}

type PreferencePatchKey = 'tripUpdates' | 'invitations' | 'system';

type NotificationPatchBody = Record<string, unknown>;

const PATCH_KEYS: PreferencePatchKey[] = ['tripUpdates', 'invitations', 'system'];

const DEFAULT_PREFERENCES: NotificationPreferences = {
  tripUpdates: true,
  invitations: true,
  system: true,
  updatedAt: null,
};

function isMissingPreferencesTableError(err: unknown): boolean {
  return /no such table:\s*account_notification_preferences/i.test((err as Error).message);
}

function isRecord(value: unknown): value is NotificationPatchBody {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mapRow(row: NotificationPreferenceRow | null): NotificationPreferences {
  if (!row) return DEFAULT_PREFERENCES;
  return {
    tripUpdates: row.trip_updates === 1,
    invitations: row.invitations === 1,
    system: row.system === 1,
    updatedAt: row.updated_at,
  };
}

async function readPreferences(
  db: Env['DB'],
  userId: string,
): Promise<NotificationPreferences> {
  try {
    const row = await db
      .prepare(
        `SELECT trip_updates, invitations, system, updated_at
         FROM account_notification_preferences
         WHERE user_id = ?`,
      )
      .bind(userId)
      .first<NotificationPreferenceRow>();
    return mapRow(row ?? null);
  } catch (err) {
    // Multi-phase deploy safety: new code can deploy before D1 migration lands.
    if (isMissingPreferencesTableError(err)) {
      return DEFAULT_PREFERENCES;
    }
    throw err;
  }
}

function validatePatchBody(body: unknown): Partial<Record<PreferencePatchKey, boolean>> {
  if (!isRecord(body)) {
    throw new AppError('DATA_VALIDATION', '通知設定必須是 JSON object');
  }

  const unknownKey = Object.keys(body).find(
    (key) => !PATCH_KEYS.includes(key as PreferencePatchKey),
  );
  if (unknownKey) {
    throw new AppError('DATA_VALIDATION', `${unknownKey} 不是有效通知設定欄位`);
  }

  const patch: Partial<Record<PreferencePatchKey, boolean>> = {};
  for (const key of PATCH_KEYS) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean') {
      throw new AppError('DATA_VALIDATION', `${key} 必須是 boolean`);
    }
    patch[key] = body[key];
  }

  if (Object.keys(patch).length === 0) {
    throw new AppError('DATA_VALIDATION', '至少提供一個通知設定欄位');
  }
  return patch;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const preferences = await readPreferences(context.env.DB, session.uid);
  return json({ preferences });
};

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  const session = await requireAccountUser(context);
  const body = await parseJsonBody<unknown>(context.request);
  const patch = validatePatchBody(body);
  const current = await readPreferences(context.env.DB, session.uid);

  const next: NotificationPreferences = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  try {
    await context.env.DB
      .prepare(
        `INSERT INTO account_notification_preferences
           (user_id, trip_updates, invitations, system, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           trip_updates = excluded.trip_updates,
           invitations = excluded.invitations,
           system = excluded.system,
           updated_at = excluded.updated_at`,
      )
      .bind(
        session.uid,
        next.tripUpdates ? 1 : 0,
        next.invitations ? 1 : 0,
        next.system ? 1 : 0,
        next.updatedAt,
      )
      .run();
  } catch (err) {
    if (isMissingPreferencesTableError(err)) {
      throw new AppError('SYS_DB_ERROR', '通知偏好資料表尚未完成部署');
    }
    throw err;
  }

  return json({ preferences: next });
};
