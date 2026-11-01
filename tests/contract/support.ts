/**
 * 契約測試的嚴格檢查：實際回應必須符合 schema，**而且不能多出 schema 沒宣告的欄位**（含巢狀物件、陣列元素、union 分支）。
 * 一般的 zod parse 會悄悄丟掉多餘欄位，文件漏寫欄位就看不出來；這裡把所有物件遞迴改成 strict 再驗證。
 */
import { z } from '@hono/zod-openapi';

type Z = z.ZodTypeAny;

/** 把 schema 內所有物件遞迴改成 strict（遇到不認得的型別原樣回傳）。 */
export function strictify(schema: Z): Z {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape as Record<string, Z>).map(([k, v]) => [k, strictify(v)]));
    return z.strictObject(shape);
  }
  if (schema instanceof z.ZodArray) return z.array(strictify(schema.element as Z));
  if (schema instanceof z.ZodOptional) return strictify(schema.unwrap() as Z).optional();
  if (schema instanceof z.ZodNullable) return strictify(schema.unwrap() as Z).nullable();
  if (schema instanceof z.ZodDefault) return strictify(schema.unwrap() as Z);
  if (schema instanceof z.ZodUnion) return z.union((schema.options as Z[]).map(strictify) as [Z, Z, ...Z[]]);
  if (schema instanceof z.ZodRecord) return schema;
  return schema;
}

/** 回傳所有不符合的描述（空陣列＝符合）；路徑以 a.b[0].c 表示。 */
export function contractIssues(schema: Z, value: unknown): string[] {
  const r = strictify(schema).safeParse(value);
  if (r.success) return [];
  return r.error.issues.map((i) => {
    const path = i.path.map((p, n) => (typeof p === 'number' ? `[${p}]` : `${n ? '.' : ''}${String(p)}`)).join('') || '(root)';
    const extra = i.code === 'unrecognized_keys' ? `（未宣告的欄位：${(i as { keys: string[] }).keys.join(', ')}）` : '';
    return `${path}：${i.message}${extra}`;
  });
}

export function expectContract(schema: Z, value: unknown): void {
  const issues = contractIssues(schema, value);
  if (issues.length) throw new Error(`回應不符合文件的 schema：\n  - ${issues.join('\n  - ')}`);
}
