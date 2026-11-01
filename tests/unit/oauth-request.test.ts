/** 共用的 OAuth 請求處理：限大小讀 body、解析 JSON 物件、解析 allowed_scopes。 */
import { describe, it, expect } from 'vitest';
import { MAX_BODY_BYTES, parseAllowedScopes, readBodyText, readJsonObject } from '../../src/lib/oauth-request';

const req = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request('http://localhost/x', { method: 'POST', body, headers, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } as RequestInit);

describe('readBodyText', () => {
  it('一般 body 原樣讀出（含多位元組字元）', async () => {
    expect(await readBodyText(req('{"a":"中文"}'))).toBe('{"a":"中文"}');
  });
  it('沒有 body → 空字串', async () => {
    expect(await readBodyText(new Request('http://localhost/x', { method: 'POST' }))).toBe('');
  });
  it('剛好等於上限可以，多一個位元組就拒絕', async () => {
    expect(await readBodyText(req('a'.repeat(MAX_BODY_BYTES)))).toHaveLength(MAX_BODY_BYTES);
    expect(await readBodyText(req('a'.repeat(MAX_BODY_BYTES + 1)))).toBeNull();
  });
  it('以位元組計，不是字元數', async () => {
    expect(await readBodyText(req('中'.repeat(6000)))).toBeNull(); // 6000 字元 = 18000 位元組
  });
  it('宣告的 content-length 超過上限 → 不讀 body 直接拒絕', async () => {
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); c.close(); } });
    const r = req(stream, { 'content-length': String(MAX_BODY_BYTES + 1) });
    expect(await readBodyText(r)).toBeNull();
    expect(r.body!.locked).toBe(false); // 連 reader 都沒取，根本沒讀
  });
  it('串流超過上限就中止，不會讀到底', async () => {
    let pulled = 0;
    const stream = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1024)); if (pulled > 5000) c.close(); } });
    expect(await readBodyText(req(stream))).toBeNull();
    expect(pulled).toBeLessThan(40);
  });
});

describe('readJsonObject', () => {
  it('物件 → 解析', async () => { expect(await readJsonObject(req('{"a":1}'))).toEqual({ a: 1 }); });
  it.each(['[1,2]', 'null', '42', '"str"', 'true', '{oops', ''])('%s → null', async (body) => {
    expect(await readJsonObject(req(body))).toBeNull();
  });
  it('太大 → null', async () => {
    expect(await readJsonObject(req(JSON.stringify({ x: 'a'.repeat(MAX_BODY_BYTES) })))).toBeNull();
  });
});

describe('parseAllowedScopes', () => {
  it('字串陣列 → 原樣', () => { expect(parseAllowedScopes('["openid","profile"]')).toEqual(['openid', 'profile']); });
  it('混入非字串的項目 → 濾掉（不能讓數字、物件、null 變成「允許」）', () => {
    expect(parseAllowedScopes('["openid",1,null,{"a":1},["x"],true]')).toEqual(['openid']);
  });
  it.each(['not json', '{"a":1}', '"openid"', '42', 'null', ''])('壞掉或非陣列（%s）→ 空白名單（拒絕）', (raw) => {
    expect(parseAllowedScopes(raw)).toEqual([]);
  });
  it('null／undefined → 空白名單', () => {
    expect(parseAllowedScopes(null)).toEqual([]);
    expect(parseAllowedScopes(undefined)).toEqual([]);
  });
});
