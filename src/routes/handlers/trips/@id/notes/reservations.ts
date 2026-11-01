/**
 * GET  /api/trips/:id/notes/reservations — list trip_reservations
 * POST /api/trips/:id/notes/reservations — create new reservation
 * v2.34.x 行程筆記 PR2 (GET) + PR3 (POST)
 */
import type { Env } from '../../../../../env';
import { createNotesRow, listNotesSection } from './_shared';

export const onRequestGet: PagesFunction<Env> = async (context) =>
  listNotesSection(context, 'trip_reservations');

export const onRequestPost: PagesFunction<Env> = async (context) =>
  createNotesRow(context, 'trip_reservations');
