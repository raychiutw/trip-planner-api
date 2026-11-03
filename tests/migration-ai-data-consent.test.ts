/** 0101：ai_data_consent_events（只追加的 AI 資料同意事件表）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { createD1 } from './support/d1';

let d1: ReturnType<typeof createD1>;
afterEach(() => d1?.close());

const addUser = (id: string) => d1.raw.prepare('INSERT INTO users (id, email, display_name) VALUES (?, ?, ?)').run(id, `${id}@t.com`, id);
const event = (userId: string, version: string, ev: string) =>
  d1.raw.prepare('INSERT INTO ai_data_consent_events (user_id, version, event) VALUES (?, ?, ?)').run(userId, version, ev);

describe('0101 ai_data_consent_events', () => {
  it('寫入後有遞增 id 與 UTC ISO created_at；event 只接受 accepted／withdrawn', () => {
    d1 = createD1();
    addUser('u1');
    event('u1', 'ai-data-v1', 'accepted');
    event('u1', 'ai-data-v1', 'withdrawn');
    const rows = d1.raw.prepare('SELECT id, event, created_at FROM ai_data_consent_events ORDER BY id').all() as Array<{ id: number; event: string; created_at: string }>;
    expect(rows.map((r) => r.event)).toEqual(['accepted', 'withdrawn']);
    expect(rows[1]!.id).toBeGreaterThan(rows[0]!.id);
    expect(rows[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(() => event('u1', 'ai-data-v1', 'revoked')).toThrow();
  });
  it('user_id、version 不可為 NULL；使用者不存在不可寫入', () => {
    d1 = createD1();
    expect(() => event('ghost', 'ai-data-v1', 'accepted')).toThrow();
    addUser('u2');
    expect(() => d1.raw.prepare("INSERT INTO ai_data_consent_events (user_id, version, event) VALUES ('u2', NULL, 'accepted')").run()).toThrow();
  });
  it('刪除使用者（帳號刪除）會連動清掉該人的事件，別人的不受影響', () => {
    d1 = createD1();
    addUser('u3'); addUser('u4');
    event('u3', 'ai-data-v1', 'accepted');
    event('u4', 'ai-data-v1', 'accepted');
    d1.raw.prepare("DELETE FROM users WHERE id = 'u3'").run();
    expect(d1.raw.prepare('SELECT user_id FROM ai_data_consent_events').all()).toEqual([{ user_id: 'u4' }]);
  });
  it('有 (user_id, id) 索引（查最新事件用）', () => {
    d1 = createD1();
    const idx = d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ai_data_consent_events'").all() as Array<{ name: string }>;
    expect(idx.map((i) => i.name)).toContain('idx_ai_data_consent_user_id');
  });
  it('只加不刪：不碰既有資料表（套用前的資料保留）', () => {
    d1 = createD1({ through: 100 });
    d1.raw.prepare("INSERT INTO users (id, email, display_name) VALUES ('old', 'old@t.com', 'old')").run();
    d1.applyMigrationsAfter(100);
    expect(d1.raw.prepare("SELECT email FROM users WHERE id = 'old'").get()).toEqual({ email: 'old@t.com' });
  });
});
