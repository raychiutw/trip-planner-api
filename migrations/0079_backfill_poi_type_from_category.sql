-- Migration 0079: backfill pois.type from Google primaryType (pois.category)
--
-- ## Background
--
-- 加入行程的各路徑過去從不送 poi_type，後端 entries.ts fallback 'attraction'，
-- 導致幾乎所有新增 POI 都被存成 type='attraction'，即使它其實是餐廳 / 飯店 /
-- 車站等。going-forward 已由前端 mapGooglePrimaryTypeToPoiType + forward poi_type
-- 修正；本 migration 一次性回填既有資料：把 type='attraction' 但 category（Google
-- primaryType）對應到其它 whitelist 類別的 POI 重新分類。
--
-- ## Collision safety（重要）
--
-- pois 有 `UNIQUE INDEX idx_pois_name_type ON pois(name, type)`（migration 0018）。
-- 直接 `UPDATE ... SET type=X` 若已存在同 name + 目標 type 的 row 會違反 unique
-- 約束 → 整個 migration abort。因此每句 UPDATE 都：
--   1. `NOT EXISTS (... q.name=p.name AND q.type=<target>)` — 跳過會撞既有目標 row 的。
--   2. `SELECT MIN(p.id) ... GROUP BY p.name` — 同 name 多筆只升級最小 id 那筆，
--      避免同一句內把兩筆 attraction 都改成同 (name,target) 造成自我碰撞。
-- 撞到的 row 維持 attraction（資料不遺失、不 abort），可日後人工處理。
--
-- ## Precedence
--
-- 依 mapGooglePrimaryTypeToPoiType 的關鍵字優先序執行（hotel > parking > transport
-- > activity > restaurant > shopping）。每句只動 type 仍為 'attraction' 的 row，
-- 故先升級的不會被後面的句子再改 → 與前端 mapper 同序。
--
-- ## Idempotent / deploy
--
-- 只 UPDATE 不改 schema：重跑為 no-op（升級後的 row 不再是 attraction）。無 DROP/
-- ADD COLUMN，故不涉 deploy migration race 的 DROP 順序問題；無對應 rollback（資料
-- 無法精確還原舊 type，going-forward 才是精準路徑）。

-- 1) lodging → hotel
UPDATE pois SET type = 'hotel'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND (
      LOWER(p.category) LIKE '%hotel%' OR LOWER(p.category) LIKE '%lodging%'
      OR LOWER(p.category) LIKE '%hostel%' OR LOWER(p.category) LIKE '%motel%'
      OR LOWER(p.category) LIKE '%guest_house%' OR LOWER(p.category) LIKE '%resort%'
      -- NOTE: legacy Nominatim tokens (tourism/amenity/leisure) are deliberately NOT
      -- matched here. Google `primaryType` never emits them, but old manual rows do
      -- (ambiguously) — e.g. an aquarium stored as category='tourism' would wrongly
      -- become 'hotel'. The going-forward mapper keeps them only for test back-compat.
      -- 'inn' as a whole snake_case token (ESCAPE '\' → literal '_'; bare '_' is a LIKE wildcard).
      OR LOWER(p.category) = 'inn' OR LOWER(p.category) LIKE 'inn\_%' ESCAPE '\'
      OR LOWER(p.category) LIKE '%\_inn' ESCAPE '\' OR LOWER(p.category) LIKE '%\_inn\_%' ESCAPE '\'
    )
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'hotel')
  GROUP BY p.name
);

-- 2) parking → parking
UPDATE pois SET type = 'parking'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND LOWER(p.category) LIKE '%parking%'
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'parking')
  GROUP BY p.name
);

-- 3) transit / airport → transport
UPDATE pois SET type = 'transport'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND (
      LOWER(p.category) LIKE '%station%' OR LOWER(p.category) LIKE '%airport%'
      OR LOWER(p.category) LIKE '%transit%' OR LOWER(p.category) LIKE '%terminal%'
      OR LOWER(p.category) LIKE '%subway%' OR LOWER(p.category) LIKE '%railway%'
      OR LOWER(p.category) LIKE '%taxi_stand%' OR LOWER(p.category) LIKE '%bus_stop%'
      OR LOWER(p.category) LIKE '%transport%'
    )
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'transport')
  GROUP BY p.name
);

-- 4) leisure venues → activity
UPDATE pois SET type = 'activity'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND (
      LOWER(p.category) LIKE '%amusement%' OR LOWER(p.category) LIKE '%theme_park%'
      OR LOWER(p.category) LIKE '%water_park%' OR LOWER(p.category) LIKE '%zoo%'
      OR LOWER(p.category) LIKE '%aquarium%' OR LOWER(p.category) LIKE '%gym%'
      OR LOWER(p.category) LIKE '%fitness%'
      -- 'spa' as a whole token only — '%spa%' would misfile 'spanish_restaurant' as activity.
      OR LOWER(p.category) = 'spa' OR LOWER(p.category) LIKE 'spa\_%' ESCAPE '\'
      OR LOWER(p.category) LIKE '%\_spa' ESCAPE '\' OR LOWER(p.category) LIKE '%\_spa\_%' ESCAPE '\'
      OR LOWER(p.category) LIKE '%night_club%' OR LOWER(p.category) LIKE '%nightclub%'
      OR LOWER(p.category) LIKE '%cinema%' OR LOWER(p.category) LIKE '%movie%'
      OR LOWER(p.category) LIKE '%theater%' OR LOWER(p.category) LIKE '%theatre%'
      OR LOWER(p.category) LIKE '%stadium%' OR LOWER(p.category) LIKE '%arena%'
      OR LOWER(p.category) LIKE '%bowling%' OR LOWER(p.category) LIKE '%karaoke%'
      OR LOWER(p.category) LIKE '%activity%'
    )
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'activity')
  GROUP BY p.name
);

-- 5) food & drink → restaurant
UPDATE pois SET type = 'restaurant'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND (
      LOWER(p.category) LIKE '%restaurant%' OR LOWER(p.category) LIKE '%cafe%'
      OR LOWER(p.category) LIKE '%coffee%' OR LOWER(p.category) LIKE '%bakery%'
      OR LOWER(p.category) LIKE '%food%' OR LOWER(p.category) LIKE '%pub%'
      OR LOWER(p.category) LIKE '%bistro%' OR LOWER(p.category) LIKE '%diner%'
      OR LOWER(p.category) LIKE '%eatery%' OR LOWER(p.category) LIKE '%izakaya%'
      OR LOWER(p.category) LIKE '%brunch%'
      -- prepared-food *_shop must beat the shopping bucket's '%shop%' (parity with the JS mapper).
      OR LOWER(p.category) LIKE '%ice_cream%' OR LOWER(p.category) LIKE '%dessert%'
      OR LOWER(p.category) LIKE '%donut%' OR LOWER(p.category) LIKE '%doughnut%'
      OR LOWER(p.category) LIKE '%bagel%' OR LOWER(p.category) LIKE '%juice%'
      OR LOWER(p.category) LIKE '%acai%' OR LOWER(p.category) LIKE '%tea_house%'
      -- 'bar' as a whole token only — '%bar%' would misfile 'barber_shop' as restaurant.
      OR LOWER(p.category) = 'bar' OR LOWER(p.category) LIKE 'bar\_%' ESCAPE '\'
      OR LOWER(p.category) LIKE '%\_bar' ESCAPE '\' OR LOWER(p.category) LIKE '%\_bar\_%' ESCAPE '\'
    )
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'restaurant')
  GROUP BY p.name
);

-- 6) retail → shopping
UPDATE pois SET type = 'shopping'
WHERE id IN (
  SELECT MIN(p.id) FROM pois p
  WHERE p.type = 'attraction'
    AND (
      LOWER(p.category) LIKE '%shop%' OR LOWER(p.category) LIKE '%store%'
      OR LOWER(p.category) LIKE '%mall%' OR LOWER(p.category) LIKE '%market%'
      OR LOWER(p.category) LIKE '%supermarket%' OR LOWER(p.category) LIKE '%retail%'
      OR LOWER(p.category) LIKE '%boutique%' OR LOWER(p.category) LIKE '%grocery%'
    )
    AND NOT EXISTS (SELECT 1 FROM pois q WHERE q.name = p.name AND q.type = 'shopping')
  GROUP BY p.name
);

ANALYZE pois;
