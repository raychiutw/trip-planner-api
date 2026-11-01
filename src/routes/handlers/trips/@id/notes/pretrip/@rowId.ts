/**
 * PATCH  /api/trips/:id/notes/pretrip/:rowId — update pretrip note
 * DELETE /api/trips/:id/notes/pretrip/:rowId
 * v2.34.x 行程筆記 PR3
 */
import type { Env } from '../../../../../../env';
import { deleteNotesRow, updateNotesRow } from '../_shared';

export const onRequestPatch: PagesFunction<Env> = async (context) =>
  updateNotesRow(context, 'trip_pretrip_notes');

export const onRequestDelete: PagesFunction<Env> = async (context) =>
  deleteNotesRow(context, 'trip_pretrip_notes');
