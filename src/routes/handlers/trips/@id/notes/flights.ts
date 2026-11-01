/**
 * GET  /api/trips/:id/notes/flights — list trip_flights
 * POST /api/trips/:id/notes/flights — create new flight
 * v2.34.x 行程筆記 PR2 (GET) + PR3 (POST)
 */
import type { Env } from '../../../../../env';
import { createNotesRow, listNotesSection } from './_shared';

export const onRequestGet: PagesFunction<Env> = async (context) =>
  listNotesSection(context, 'trip_flights');

export const onRequestPost: PagesFunction<Env> = async (context) =>
  createNotesRow(context, 'trip_flights');
