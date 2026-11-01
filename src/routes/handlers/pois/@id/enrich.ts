/**
 * POST /api/pois/:id/enrich — refresh rating + status + hours from Google Place Details.
 *
 * v2.23.0 google-maps-migration: 取代舊 src/server/poi/enrich.ts 鏈
 * (Nominatim → Overpass → OpenTripMap → Wikidata)，改直接打 Google Place Details。
 *
 * 觸發條件：
 *   - 手動：POI lightbox「重新檢查」按鈕
 *   - 排程：scripts/google-poi-refresh-30d.ts daily job
 *   - 初始：scripts/google-poi-initial-backfill.ts 一次性 backfill
 *
 * 寫入 pois 欄位：rating / status / status_reason / status_checked_at / last_refreshed_at
 *   - business_status='OPERATIONAL' → status='active'
 *   - business_status='CLOSED_PERMANENTLY' → status='closed' + reason='永久歇業'
 *   - business_status='CLOSED_TEMPORARILY' → status='active'（暫時性，不 banner 警告）
 *   - Place Details 404 → status='missing' + reason='Google Maps 查無資料'
 *
 * Auth: 同 PATCH /pois/:id — ops:poi 維運 scope OR trip owner（requirePoiWrite；Phase 3 移除全域 admin）。
 */

import { requireAuth, requirePoiWrite } from '../../../../lib/permissions';
import { logAudit } from '../../../../lib/audit';
import { AppError } from '../../../../errors';
import { json, parseIntParam } from '../../../../lib/utils';
import { assertGoogleAvailable } from '../../../../lib/maps-lock';
import { getPlaceDetails } from '../../../../lib/maps/google-client';
import type { Env } from '../../../../env';

interface PoiRow {
  id: number;
  name: string;
  place_id: string | null;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const auth = requireAuth(context);

  const poiId = parseIntParam(context.params.id as string);
  if (!poiId) throw new AppError('DATA_VALIDATION', 'POI ID 格式錯誤');

  const db = context.env.DB;
  const url = new URL(context.request.url);
  const tripId = url.searchParams.get('tripId');

  // Phase 1（移除全域 admin / F1）：master POI enrich 授權集中於 requirePoiWrite。
  await requirePoiWrite(db, auth, poiId, tripId);

  const apiKey = context.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new AppError('MAPS_UPSTREAM_FAILED', 'GOOGLE_MAPS_API_KEY not configured');
  await assertGoogleAvailable(db);

  const poi = await db
    .prepare('SELECT id, name, place_id FROM pois WHERE id = ?')
    .bind(poiId)
    .first<PoiRow>();
  if (!poi) throw new AppError('DATA_NOT_FOUND', '找不到此 POI');
  if (!poi.place_id) {
    throw new AppError(
      'DATA_VALIDATION',
      'POI 缺 place_id（migration 0051 backfill 未跑完）— 請等 backfill 或先 PATCH place_id',
    );
  }

  const details = await getPlaceDetails(apiKey, poi.place_id);
  const now = new Date().toISOString();

  let status: 'active' | 'closed' | 'missing';
  let statusReason: string | null;
  let rating: number | null = null;
  let lat: number | null = null;
  let lng: number | null = null;
  let address: string | null = null;
  let phone: string | null = null;
  let hours: string | null = null;

  if (details === null) {
    // Google 404 — POI delisted from Google Maps
    status = 'missing';
    statusReason = 'Google Maps 查無資料';
  } else {
    rating = details.rating ?? null;
    lat = details.lat;
    lng = details.lng;
    address = details.address || null;
    phone = details.phone || null;
    hours = details.weekday_descriptions?.join('\n') || null;
    if (details.business_status === 'CLOSED_PERMANENTLY') {
      status = 'closed';
      statusReason = '永久歇業';
    } else {
      status = 'active';
      statusReason = null;
    }
  }

  // COALESCE on lat/lng/address/phone/hours: only overwrite when Place Details returns
  // a value, preserving any manually-edited POI data.
  await db
    .prepare(
      `UPDATE pois SET
         rating = COALESCE(?, rating),
         lat = COALESCE(?, lat),
         lng = COALESCE(?, lng),
         address = COALESCE(?, address),
         phone = COALESCE(?, phone),
         hours = COALESCE(?, hours),
         status = ?, status_reason = ?,
         status_checked_at = ?, last_refreshed_at = ?
       WHERE id = ?`,
    )
    .bind(rating, lat, lng, address, phone, hours, status, statusReason, now, now, poiId)
    .run();

  // PR32: audit log for POI enrich（tripId 從 query param，可能 null → 用空字串 fallback）
  await logAudit(db, {
    tripId: tripId ?? '',
    tableName: 'pois',
    recordId: poiId,
    action: 'update',
    changedBy: auth.email,
    diffJson: JSON.stringify({
      op: 'enrich',
      placeId: poi.place_id,
      status,
      statusReason,
      hasRating: rating != null,
      hasCoords: lat != null && lng != null,
    }),
  });

  return json({
    poi_id: poiId,
    name: poi.name,
    place_id: poi.place_id,
    status,
    status_reason: statusReason,
    rating,
    refreshed_at: now,
  });
};
