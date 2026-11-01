/**
 * Integration — migration 0079 backfill (poi_type from Google category).
 *
 * Proves the collision-safe backfill: existing pois wrongly stored as
 * type='attraction' but carrying a Google primaryType in `category` get
 * re-typed, WITHOUT violating the UNIQUE(name, type) index (0018) — a colliding
 * row is skipped, not aborted. Runs the real migration SQL against Miniflare D1.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from './setup';

let db: D1Database;
const ROOT = join(__dirname, '..', '..');

/** Run a multi-statement .sql file (split on `;`, strip `--` comments). */
async function runMigration(rel: string) {
  const sql = readFileSync(join(ROOT, rel), 'utf8').replace(/--[^\n]*/g, '');
  for (const stmt of sql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

const seed = (name: string, type: string, category: string | null) =>
  db.prepare('INSERT INTO pois (type, name, category) VALUES (?, ?, ?)').bind(type, name, category).run();

const typeOf = async (name: string) =>
  (await db.prepare('SELECT type FROM pois WHERE name = ? ORDER BY type').bind(name).all()).results.map(
    (r) => (r as { type: string }).type,
  );

beforeAll(async () => {
  db = await createTestDb();
  await seed('bf0079-cafe', 'attraction', 'cafe');
  await seed('bf0079-subway', 'attraction', 'subway_station');
  await seed('bf0079-mall', 'attraction', 'shopping_mall');
  await seed('bf0079-lodging', 'attraction', 'lodging');
  await seed('bf0079-zoo', 'attraction', 'zoo');
  await seed('bf0079-museum', 'attraction', 'museum');
  await seed('bf0079-nullcat', 'attraction', null);
  await seed('bf0079-already', 'restaurant', 'cafe');
  // snake_case token-boundary: must stay in lock-step with the JS mapper.
  await seed('bf0079-winebar', 'attraction', 'wine_bar'); // → restaurant
  await seed('bf0079-barber', 'attraction', 'barber_shop'); // 'bar' inside 'barber' → shopping, NOT restaurant
  await seed('bf0079-spanish', 'attraction', 'spanish_restaurant'); // 'spa' inside 'spanish' → restaurant, NOT activity
  await seed('bf0079-inn', 'attraction', 'inn'); // standalone inn → hotel
  // collision: a hotel row already owns (name, 'hotel'); the attraction twin maps to
  // hotel too but must be SKIPPED, not abort the migration.
  await seed('bf0079-collide', 'hotel', 'lodging');
  await seed('bf0079-collide', 'attraction', 'lodging');

  await runMigration('migrations/0079_backfill_poi_type_from_category.sql');
});

describe('migration 0079 — backfill poi_type from Google category', () => {
  it('re-types food/drink → restaurant', async () => {
    expect(await typeOf('bf0079-cafe')).toEqual(['restaurant']);
  });
  it('re-types transit station → transport', async () => {
    expect(await typeOf('bf0079-subway')).toEqual(['transport']);
  });
  it('re-types retail → shopping', async () => {
    expect(await typeOf('bf0079-mall')).toEqual(['shopping']);
  });
  it('re-types lodging → hotel', async () => {
    expect(await typeOf('bf0079-lodging')).toEqual(['hotel']);
  });
  it('re-types leisure → activity', async () => {
    expect(await typeOf('bf0079-zoo')).toEqual(['activity']);
  });
  it('leaves genuine attractions as attraction', async () => {
    expect(await typeOf('bf0079-museum')).toEqual(['attraction']);
  });
  it('leaves rows with no category untouched', async () => {
    expect(await typeOf('bf0079-nullcat')).toEqual(['attraction']);
  });
  it('never touches rows that are not attraction', async () => {
    expect(await typeOf('bf0079-already')).toEqual(['restaurant']);
  });
  it('skips a colliding re-type (UNIQUE name,type) instead of aborting', async () => {
    // both rows survive; the attraction twin is NOT promoted to a duplicate hotel
    expect(await typeOf('bf0079-collide')).toEqual(['attraction', 'hotel']);
  });
  it('re-types snake_case compound wine_bar → restaurant', async () => {
    expect(await typeOf('bf0079-winebar')).toEqual(['restaurant']);
  });
  it('does NOT misfile barber_shop as restaurant (bar inside barber) → shopping', async () => {
    expect(await typeOf('bf0079-barber')).toEqual(['shopping']);
  });
  it('does NOT misfile spanish_restaurant as activity (spa inside spanish) → restaurant', async () => {
    expect(await typeOf('bf0079-spanish')).toEqual(['restaurant']);
  });
  it('re-types standalone inn → hotel (parity with the mapper)', async () => {
    expect(await typeOf('bf0079-inn')).toEqual(['hotel']);
  });
});
