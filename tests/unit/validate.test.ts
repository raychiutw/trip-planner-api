/**
 * 純函式測試 — _validate.ts
 * validateDayBody, validateEntryBody, validateRestaurantBody, detectGarbledText, sanitizeReply
 */
import { describe, it, expect } from 'vitest';
import {
  validateDayBody,
  validateEntryBody,
  detectGarbledText,
  sanitizeReply,
} from '../../src/lib/validate';

describe('validateDayBody', () => {
  it('通過：完整合法 body', () => {
    expect(validateDayBody({ date: '2026-04-01', dayOfWeek: '三', label: 'Day 1' }))
      .toEqual({ ok: true, status: 200 });
  });

  it('失敗：缺 date', () => {
    const r = validateDayBody({ dayOfWeek: '三', label: 'Day 1' });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toContain('date');
  });

  it('失敗：缺多個欄位', () => {
    const r = validateDayBody({});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('date');
    expect(r.error).toContain('dayOfWeek');
    expect(r.error).toContain('label');
  });

  it('失敗：date 格式錯誤', () => {
    const r = validateDayBody({ date: '04/01/2026', dayOfWeek: '三', label: 'Day 1' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('YYYY-MM-DD');
  });

  it('失敗：label 超過 8 字', () => {
    const r = validateDayBody({ date: '2026-04-01', dayOfWeek: '三', label: '這是一個超過八個字的標籤' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('8');
  });

  it('通過：label 剛好 8 字', () => {
    expect(validateDayBody({ date: '2026-04-01', dayOfWeek: '三', label: '12345678' }).ok).toBe(true);
  });
});

describe('validateEntryBody', () => {
  it('通過：有 name', () => {
    expect(validateEntryBody({ name: 'Visit Shrine' })).toEqual({ ok: true, status: 200 });
  });

  it('失敗：缺 name', () => {
    expect(validateEntryBody({}).ok).toBe(false);
  });

  it('失敗：name 為 null', () => {
    expect(validateEntryBody({ name: null }).ok).toBe(false);
  });

  it('失敗：name 為空字串', () => {
    expect(validateEntryBody({ name: '' }).ok).toBe(false);
  });

  it('失敗：舊 title 不再視為有效 name', () => {
    expect(validateEntryBody({ title: 'Visit Shrine' }).ok).toBe(false);
  });
});

describe('detectGarbledText', () => {
  it('正常中文 → false', () => {
    expect(detectGarbledText('這是正常的中文')).toBe(false);
  });

  it('空字串 → false', () => {
    expect(detectGarbledText('')).toBe(false);
  });

  it('null/undefined → false', () => {
    expect(detectGarbledText(null as unknown as string)).toBe(false);
    expect(detectGarbledText(undefined as unknown as string)).toBe(false);
  });

  it('含 U+FFFD → true', () => {
    expect(detectGarbledText('hello \uFFFD world')).toBe(true);
  });

  it('連續 Latin Extended → true', () => {
    expect(detectGarbledText('abc\u00C0\u00C1\u00C2def')).toBe(true);
  });

  it('C1 控制字元 → true', () => {
    expect(detectGarbledText('test\x80data')).toBe(true);
  });

  it('日文平假名 → false', () => {
    expect(detectGarbledText('こんにちは')).toBe(false);
  });
});

describe('sanitizeReply', () => {
  const FALLBACK = '已處理您的請求。如有問題請直接聯繫行程主人。';

  it('正常回覆不被過濾', () => {
    expect(sanitizeReply('已新增餐廳推薦：すし三昧')).toBe('已新增餐廳推薦：すし三昧');
  });

  it('超長 reply → 截斷（containment：防旅伴 agent 用 reply 大量外洩單一 trip 資料）', () => {
    const long = 'あ'.repeat(3000);
    const out = sanitizeReply(long);
    expect(out.length).toBeLessThanOrEqual(2001); // 2000 + 省略號
    expect(out.endsWith('…')).toBe(true);
  });

  it('含 API 路徑 → 過濾', () => {
    expect(sanitizeReply('請用 /api/trips 端點')).toBe(FALLBACK);
  });

  it('含 DB table 名 → 過濾', () => {
    expect(sanitizeReply('已寫入 trip_entries 表')).toBe(FALLBACK);
  });

  it('含 SQL → 過濾', () => {
    expect(sanitizeReply('SELECT id FROM trips')).toBe(FALLBACK);
    expect(sanitizeReply('INSERT INTO pois VALUES')).toBe(FALLBACK);
  });

  it('含 CF-Access → 過濾', () => {
    expect(sanitizeReply('使用 CF-Access 認證')).toBe(FALLBACK);
  });

  it('含 Service Token → 過濾', () => {
    expect(sanitizeReply('Service Token 認證')).toBe(FALLBACK);
  });

  it('含 functions/api → 過濾', () => {
    expect(sanitizeReply('程式碼在 functions/api/_middleware.ts')).toBe(FALLBACK);
  });

  it('含 .bind( → 過濾', () => {
    expect(sanitizeReply('db.prepare().bind()')).toBe(FALLBACK);
  });

  it('含 onRequestPost → 過濾', () => {
    expect(sanitizeReply('handler 是 onRequestPost')).toBe(FALLBACK);
  });

  it('audit_log 名稱 → 過濾', () => {
    expect(sanitizeReply('寫入 audit_log')).toBe(FALLBACK);
  });

  it('poi_relations 名稱 → 過濾', () => {
    expect(sanitizeReply('查詢 poi_relations')).toBe(FALLBACK);
  });
});
