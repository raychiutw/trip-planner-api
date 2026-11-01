/**
 * PATCH /api/trips/:id/notes/emergency/reorder — bulk sort_order
 * v2.34.x 行程筆記 PR3
 */
import type { Env } from '../../../../../../env';
import { reorderNotesRows } from '../_shared';

export const onRequestPatch: PagesFunction<Env> = async (context) =>
  reorderNotesRows(context, 'trip_emergency_contacts');
