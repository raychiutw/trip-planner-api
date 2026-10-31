/**
 * D1 Adapter for Panva oidc-provider — V2-P1 (per docs/v2-oauth-server-plan.md)
 *
 * Implements the [Adapter interface](https://github.com/panva/node-oidc-provider/blob/main/lib/models/adapter.js)
 * over Cloudflare D1。Generic single-table key-value store (oauth_models)，
 * complex queries 用 SQLite json_extract() 索引。
 *
 * Lifecycle 模式：
 *   - upsert(id, payload, expiresIn): INSERT OR REPLACE，expires_at = now + ms
 *   - find(id): SELECT，過期 row 視為不存在（lazy delete on read）
 *   - destroy(id): DELETE
 *   - 過期 row cleanup 由 cron job 跑 `DELETE WHERE expires_at < now()`（V2-P6）
 *
 * 不做（留 next sprint）：
 *   - findByUserCode：device flow（V2-P5 排程）
 *   - 加密 payload at rest（敏感 token 已 short-lived，明文 acceptable）
 */


/** Panva oidc-provider 的 AdapterPayload contract（subset，含常用欄位）。 */
export interface AdapterPayload {
  [key: string]: unknown;
  jti?: string;
  iat?: number;
  exp?: number;
  /** 用於 findByUid (Session model) */
  uid?: string;
  /** 用於 revokeByGrantId */
  grantId?: string;
  /** consume() 標記為 used（authorization_code one-shot） */
  consumed?: number;
}

export class D1Adapter {
  constructor(private db: D1Database, private name: string) {
    // name = 'Session' | 'AuthorizationCode' | 'AccessToken' | 'RefreshToken' | ...
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    // v2.33.63 round 14d: 16KB payload size cap — 避免任 caller 把超大 payload
    // 寫入塞 D1 row (free tier ~1MB 上限 quota burn)。OAuth model 正常 payload
    // 含 scopes / grantId / user_id 等小欄位，遠低於 16KB；超出代表 logic bug。
    const serialised = JSON.stringify(payload);
    if (serialised.length > 16 * 1024) {
      throw new Error(`oauth_models payload too large: ${serialised.length}B for ${this.name}/${id}`);
    }
    await this.db
      .prepare(
        'INSERT OR REPLACE INTO oauth_models (name, id, payload, expires_at) VALUES (?, ?, ?, ?)',
      )
      .bind(this.name, id, serialised, Date.now() + expiresIn * 1000)
      .run();
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    return (await this.findWithExpiry(id))?.payload;
  }

  /** 同 find，另回傳到期時間（unix ms）；過期的 row 視為不存在。 */
  async findWithExpiry(id: string): Promise<{ payload: AdapterPayload; expiresAt: number } | undefined> {
    const row = await this.db
      .prepare('SELECT payload, expires_at FROM oauth_models WHERE name = ? AND id = ?')
      .bind(this.name, id)
      .first<{ payload: string; expires_at: number }>();
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined; // lazy delete
    return { payload: JSON.parse(row.payload) as AdapterPayload, expiresAt: row.expires_at };
  }

  /**
   * Device flow lookup — V2-P5 才實作。throw 讓 oidc-provider 把 device flow
   * grant 全 disable（library 在 init 期 detect adapter capability）。
   */
  async findByUserCode(_userCode: string): Promise<AdapterPayload | undefined> {
    throw new Error('D1Adapter: device flow (findByUserCode) not implemented (V2-P5)');
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.db
      .prepare(
        'SELECT payload, expires_at FROM oauth_models WHERE name = ? AND json_extract(payload, ?) = ?',
      )
      .bind(this.name, '$.uid', uid)
      .first<{ payload: string; expires_at: number }>();
    if (!row) return undefined;
    if (row.expires_at < Date.now()) return undefined;
    return JSON.parse(row.payload) as AdapterPayload;
  }

  /**
   * Mark authorization_code / refresh_token as used (one-shot guard against replay)。
   *
   * v2.33.58 round 12 C4: 改 conditional UPDATE with `consumed IS NULL` guard。
   * 返 boolean 表示是否實際 mark (winner) — 平行雙重 POST /token 只有第一個拿到 true。
   * 之前 unconditional UPDATE 兩個 caller 都 success，雙重 grantId 漏接。
   * Caller 必須檢 return value，false 表示已被 consume，要 abort + revokeByGrantId。
   */
  async consume(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE oauth_models SET payload = json_set(payload, ?, ?)
         WHERE name = ? AND id = ? AND json_extract(payload, '$.consumed') IS NULL`,
      )
      .bind('$.consumed', Date.now(), this.name, id)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  /** Store the complete issuance and its source link in one transaction.
   * The consumed source must still exist: refresh reuse may have revoked it.
   * Consumption commits separately and is never undone by issuance rollback.
   */
  async storeIssuedPair(
    sourceId: string,
    payload: AdapterPayload & { grantId: string },
    access: { id: string; expiresIn: number },
    refresh: { id: string; expiresIn: number },
  ): Promise<boolean> {
    const serialized = JSON.stringify(payload);
    if (serialized.length > 16 * 1024) throw new Error('oauth_models payload too large');
    const now = Date.now();
    const statements = [
      ['AccessToken', access] as const,
      ['RefreshToken', refresh] as const,
    ].map(([name, token]) => this.db.prepare(
      `INSERT INTO oauth_models (name, id, payload, expires_at)
       SELECT ?, ?, ?, ? FROM oauth_models
       WHERE name = ? AND id = ? AND expires_at >= ?
         AND json_extract(payload, '$.consumed') IS NOT NULL`,
    ).bind(name, token.id, serialized, now + token.expiresIn * 1000, this.name, sourceId, now));
    statements.push(this.db.prepare(
      `UPDATE oauth_models SET payload = json_set(payload, ?, ?)
       WHERE name = ? AND id = ? AND expires_at >= ?
         AND json_extract(payload, '$.consumed') IS NOT NULL`,
    ).bind('$.grantId', payload.grantId, this.name, sourceId, now));
    const result = await this.db.batch(statements);
    return result.every((item) => (item.meta?.changes ?? 0) === 1);
  }

  async destroy(id: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM oauth_models WHERE name = ? AND id = ?')
      .bind(this.name, id)
      .run();
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // 跨 token model 刪 — grantId 是 access_token / refresh_token 共享 link key。
    // v2.33.58 round 12: 加 name IN allowlist 避免未來新 model（例如 audit log）誤含
    // grantId field 被無辜刪除。
    await this.db
      .prepare(
        `DELETE FROM oauth_models
         WHERE name IN ('AccessToken', 'RefreshToken')
           AND json_extract(payload, ?) = ?`,
      )
      .bind('$.grantId', grantId)
      .run();
  }

  /** Maintenance: 清掉過期 row，cron job 用。回傳清掉幾 row。 */
  static async sweepExpired(db: D1Database): Promise<number> {
    const result = await db
      .prepare('DELETE FROM oauth_models WHERE expires_at < ?')
      .bind(Date.now())
      .run();
    return result.meta?.changes ?? 0;
  }
}
