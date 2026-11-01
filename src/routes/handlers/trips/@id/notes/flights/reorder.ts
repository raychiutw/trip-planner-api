/**
 * PATCH /api/trips/:id/notes/flights/reorder — bulk sort_order update
 * body: { items: [{ id, sortOrder }, ...] }
 * v2.34.x 行程筆記 PR3
 */
import type { Env } from '../../../../../../env';
import { reorderNotesRows } from '../_shared';

export const onRequestPatch: PagesFunction<Env> = async (context) =>
  reorderNotesRows(context, 'trip_flights');
