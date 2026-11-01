/**
 * POST /api/pois/find-or-create
 *
 * Takes POI data (from Nominatim search result or manual form), upserts into
 * `pois` table via shared findOrCreatePoi helper, returns the poi id.
 *
 * Used by /explore save button flow: search → pick → find-or-create → saved-pois POST.
 */
import { AppError } from '../../../errors';
import { requireAuth } from '../../../lib/permissions';
import { json, parseJsonBody } from '../../../lib/utils';
import { findOrCreatePoi, type FindOrCreatePoiData } from '../../../lib/poi';
import type { Env } from '../../../env';

export const onRequestPost: PagesFunction<Env> = async (context) => {
  requireAuth(context);

  const body = await parseJsonBody<Partial<FindOrCreatePoiData>>(context.request);

  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    throw new AppError('DATA_VALIDATION', '缺少或無效的 name');
  }
  if (!body.type || typeof body.type !== 'string') {
    throw new AppError('DATA_VALIDATION', '缺少或無效的 type');
  }

  const data: FindOrCreatePoiData = {
    name: body.name.trim(),
    type: body.type.trim(),
    description: body.description ?? null,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    address: body.address ?? null,
    category: body.category ?? null,
    source: body.source ?? 'user-explore',
    country: body.country ?? null,
    place_id: typeof body.place_id === 'string' ? body.place_id : null,
  };

  const poiId = await findOrCreatePoi(context.env.DB, data, { policy: 'fill-null' });

  // Field name `id` 是 POI table PK 的 canonical alias — 對 frontend caller
  // (ExplorePage createResp.id) 直接 consume，避免 nested `poi.id` ↔ tripId 風格
  // 重命名造成的 breaking change。naming-rules.md「API tripId」規則 specific
  // 針對 trip identifier 避歧義，POI 單一 endpoint response 不存在歧義。
  return json({ id: poiId });
};
