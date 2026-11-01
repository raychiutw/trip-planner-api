/**
 * GET  /api/trips/:id/notes/pretrip — list trip_pretrip_notes
 * POST /api/trips/:id/notes/pretrip — create new pretrip note
 * v2.34.x 行程筆記 PR2 (GET) + PR3 (POST)
 */
import type { Env } from '../../../../../env';
import { createNotesRow, listNotesSection } from './_shared';

export const onRequestGet: PagesFunction<Env> = async (context) =>
  listNotesSection(context, 'trip_pretrip_notes');

export const onRequestPost: PagesFunction<Env> = async (context) =>
  createNotesRow(context, 'trip_pretrip_notes');
