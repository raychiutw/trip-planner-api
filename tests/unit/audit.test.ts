/**
 * 純函式測試 — _audit.ts computeDiff
 */
import { describe, it, expect } from 'vitest';
import { computeDiff } from '../../src/lib/audit';

describe('computeDiff', () => {
  it('偵測變更的欄位', () => {
    const diff = JSON.parse(computeDiff(
      { title: 'old', description: 'same' },
      { title: 'new', description: 'same' },
    ));
    expect(diff.title).toEqual({ old: 'old', new: 'new' });
    expect(diff.description).toBeUndefined();
  });

  it('空 diff — 無變更', () => {
    expect(computeDiff({ a: 1 }, { a: 1 })).toBe('{}');
  });

  it('null → 有值', () => {
    const diff = JSON.parse(computeDiff({ note: null }, { note: 'hello' }));
    expect(diff.note).toEqual({ old: null, new: 'hello' });
  });

  it('物件值序列化比較', () => {
    const diff = JSON.parse(computeDiff(
      { data: { a: 1 } },
      { data: { a: 1 } },
    ));
    expect(Object.keys(diff)).toHaveLength(0);
  });

  it('物件值不同', () => {
    const diff = JSON.parse(computeDiff(
      { data: { a: 1 } },
      { data: { a: 2 } },
    ));
    expect(diff.data.old).toEqual({ a: 1 });
    expect(diff.data.new).toEqual({ a: 2 });
  });

  it('只比較 newFields 的 key', () => {
    const diff = JSON.parse(computeDiff(
      { a: 1, b: 2, c: 3 },
      { b: 99 },
    ));
    expect(Object.keys(diff)).toEqual(['b']);
  });
});
