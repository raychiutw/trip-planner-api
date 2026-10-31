/** Worker 的 bindings 與設定。欄位由舊入口（functions/api/_types.ts）移植，隨各票接上才補齊。 */
export interface Env {
  DB: D1Database;
  /** 逗號分隔的 web origin 白名單（精確比對）。未設 = 拒絕所有帶 Origin 的跨站請求。 */
  ALLOWED_ORIGINS?: string;
  ENVIRONMENT?: 'production' | 'preview' | 'development';
  GOOGLE_MAPS_API_KEY?: string;
}
