/**
 * GET  /api/trips/:id/notes/emergency — list trip_emergency_contacts
 * POST /api/trips/:id/notes/emergency — create new emergency contact
 * v2.34.x 行程筆記 PR2 (GET) + PR3 (POST)
 */
import type { Env } from '../../../../../env';
import { createNotesRow, listNotesSection } from './_shared';

export const onRequestGet: PagesFunction<Env> = async (context) =>
  listNotesSection(context, 'trip_emergency_contacts');

export const onRequestPost: PagesFunction<Env> = async (context) =>
  createNotesRow(context, 'trip_emergency_contacts');
