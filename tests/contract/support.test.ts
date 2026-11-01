/** 契約測試的嚴格檢查工具本身的測試：schema 漏寫欄位（回應多出未宣告的欄位）必須讓測試失敗。 */
import { describe, it, expect } from 'vitest';
import { z } from '@hono/zod-openapi';
import { contractIssues, expectContract } from './support';

const Item = z.object({ id: z.number(), name: z.string(), note: z.string().nullable().optional() });
const Schema = z.object({ ok: z.boolean(), items: z.array(Item), meta: z.object({ total: z.number() }).optional(), kind: z.union([z.object({ a: z.number() }), z.object({ b: z.string() })]) });
const valid = { ok: true, items: [{ id: 1, name: 'x' }], kind: { a: 1 } };

describe('contractIssues', () => {
  it('符合 schema → 沒有問題', () => {
    expect(contractIssues(Schema, valid)).toEqual([]);
    expect(contractIssues(Schema, { ...valid, meta: { total: 3 }, items: [{ id: 1, name: 'x', note: null }, { id: 2, name: 'y', note: 'n' }] })).toEqual([]);
    expect(contractIssues(Schema, { ...valid, kind: { b: 's' } })).toEqual([]);
  });
  it('最上層多出未宣告的欄位 → 有問題', () => {
    expect(contractIssues(Schema, { ...valid, extra: 1 }).join()).toMatch(/extra/);
  });
  it('巢狀物件多出欄位 → 有問題', () => {
    expect(contractIssues(Schema, { ...valid, meta: { total: 1, hidden: true } }).join()).toMatch(/hidden/);
  });
  it('陣列元素多出欄位 → 有問題', () => {
    expect(contractIssues(Schema, { ...valid, items: [{ id: 1, name: 'x', leaked: 'secret' }] }).join()).toMatch(/leaked/);
  });
  it('union 的分支多出欄位 → 有問題', () => {
    expect(contractIssues(Schema, { ...valid, kind: { a: 1, zzz: 2 } }).length).toBeGreaterThan(0);
  });
  it('可為 null 的物件裡多出欄位 → 有問題；null 本身可以', () => {
    const N = z.object({ owner: z.object({ id: z.number() }).nullable() });
    expect(contractIssues(N, { owner: null })).toEqual([]);
    expect(contractIssues(N, { owner: { id: 1 } })).toEqual([]);
    expect(contractIssues(N, { owner: { id: 1, email: 'leak@example.com' } }).join()).toMatch(/email/);
  });
  it('缺必填欄位、型別不對 → 有問題', () => {
    expect(contractIssues(Schema, { ok: true, items: [] }).length).toBeGreaterThan(0);
    expect(contractIssues(Schema, { ...valid, ok: 'yes' }).length).toBeGreaterThan(0);
    expect(contractIssues(Schema, { ...valid, items: [{ id: '1', name: 'x' }] }).length).toBeGreaterThan(0);
  });
  it('null 不可用在非 nullable 欄位', () => {
    expect(contractIssues(Schema, { ...valid, items: [{ id: null, name: 'x' }] }).length).toBeGreaterThan(0);
  });
});

describe('expectContract', () => {
  it('符合時不丟錯；不符合時丟出含欄位路徑的錯誤', () => {
    expect(() => expectContract(Schema, valid)).not.toThrow();
    expect(() => expectContract(Schema, { ...valid, extra: 1 })).toThrow(/extra/);
  });
});
