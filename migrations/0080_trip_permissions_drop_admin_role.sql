-- Migration 0080: 移除全域 admin Phase 3 — trip_permissions.role CHECK 去 'admin'
--
-- per-trip role='admin'（協作者 admin 角色）隨全域 admin 一併移除。
-- ⚠️ prod 實測有 4 個 role='admin' row（歷史遺留，非 code 持續寫入）。admin 角色
-- 降為 'member'（保留讀寫權限，最接近語意），再收緊 CHECK 排除 'admin'。
--
-- trip_permissions 無 children FK（見 0047:75 註解），標準 swap 安全。
-- D1 deploy ↔ migration apply 不 atomic：CHECK 收緊，先 apply 此 migration（含
-- admin→member 降級）再 merge code PR（移除 permissions.ts admin 防守碼）。
-- 見 docs/plans / project_d1_migration_phase_split。

-- 1. admin row → member（必須先做，否則步驟 2 的 INSERT SELECT 違反新 CHECK → 整 txn ABORT）
UPDATE trip_permissions SET role = 'member' WHERE role = 'admin';

-- 2. swap 收緊 CHECK（role IN owner/member/viewer，去 admin）
DROP TABLE IF EXISTS trip_permissions_new;
CREATE TABLE trip_permissions_new (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id TEXT NOT NULL,
  role    TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member', 'viewer')),
  UNIQUE (user_id, trip_id)
);

INSERT INTO trip_permissions_new (id, user_id, trip_id, role)
SELECT id, user_id, trip_id, role FROM trip_permissions;
-- ↑ 任何殘留 role='admin' 會違反新 CHECK → ABORT（E-C1 assertion via CHECK）

DROP TABLE trip_permissions;
ALTER TABLE trip_permissions_new RENAME TO trip_permissions;

-- UNIQUE (user_id, trip_id) auto-creates index covering user_id lookups.
ANALYZE trip_permissions;
