/**
 * 基準測試（自舊 repo tests/api 搬來）的資料庫：每次 createTestDb() 開一個全新的記憶體 SQLite，
 * 套用全部 migrations；介面與舊的 Miniflare 版相同，所以舊測試只需改 import。
 */
import { createD1 } from '../support/d1';

const opened: Array<() => void> = [];

export async function createTestDb(): Promise<D1Database> {
  const { db, close } = createD1();
  opened.push(close);
  return db;
}

/** 舊名稱保留（測試的 afterAll 會呼叫）；關閉本檔建立過的所有資料庫。 */
export async function disposeMiniflare(): Promise<void> {
  while (opened.length) { try { opened.pop()!(); } catch { /* 已關閉 */ } }
}
