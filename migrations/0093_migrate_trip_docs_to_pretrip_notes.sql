-- Migration 0093: 把 trip_docs 的內容搬進 trip_pretrip_notes（trip_docs 退場第 1 步）
--
-- ## Why
--
-- trip_docs / trip_doc_entries 整條已經是死路：行程筆記頁讀的是 trip_pretrip_notes
-- + trip_emergency_contacts（migration 0073），從不讀 trip_docs；checklist / emergency
-- / flights / backup / suggestions 這些 doc 的 UI 入口在 v2.17.17 就整批移除，前端
-- 現在完全不 fetch /docs。但兩張表裡仍躺著 114 筆**真實使用者內容**（2026-03～04
-- 寫的行前清單、雨天備案、行程建議），使用者看不到。
--
-- ## 搬什麼、不搬什麼
--
-- 只搬「新 schema 沒有對應家、且還沒被搬過」的兩種：
--   backup       (43) → section='雨天備案'
--   suggestions  (24) → section='行程建議'
--
-- **不搬 checklist (35)**：唯一有 checklist entries 的 trip 是 HuiYun，而
-- scripts/import-huiyun-trip-notes.ts 早就把它搬進 trip_pretrip_notes 了（7 張卡片
-- 聚合成 8 筆 human/human 列：證件與通訊 / 日本撥打電話 / 金錢與行李 / 租車確認 /
-- 住宿確認 / 行程預訂確認 / 颱風動態追蹤 / 保險住宿地址）。再搬一次會變成同內容
-- 兩種粒度並存。那支 script 的 mapping policy 只涵蓋 checklist + emergency + 住宿，
-- **沒有** backup 與 suggestions —— 那正是本 migration 要補的缺口。
--
-- **不搬** emergency (6) 與 flights (6) —— trip_emergency_contacts 與 trip_flights
-- 已經有一字不差且更結構化的版本（實測 Hui Yun 的「警察 110」「消防・救護 119」
-- 「駐日代表處…」三筆兩邊完全重複），搬了只會製造重複項目。
--
-- ## 為什麼寫成 origin='ai' / managed_by='ai'
--
-- owner 決定（2026-07-29）：搬進去的內容**不要擋住未來的 AI 生成**。
-- 筆記 pipeline 把 managed_by='human' 的列當「已有此主題」→ 同主題 AI 項目會被
-- 略過（就是使用者抱怨的「沒有新項目可加」那個機制）。寫成 ai/ai 就不進 manualRows。
--
-- ⚠️ **代價（owner 已知並選擇）**：ai_source='general-tips' 讓它們落進 replacedRows
-- （`WHERE ai_source=? AND origin='ai' AND managed_by='ai'`），所以**下一次按「一般」
-- AI 生成時這 67 筆會被整批刪掉重建**。想永久保住某一筆，在 App 裡編輯它一次即可
-- —— 編輯會把 managed_by 翻成 'human'，之後就受保護。
--
-- ## 安全性
--
-- 純 INSERT ... SELECT，不改任何既有列、不刪任何東西。重複執行會產生重複資料，
-- 但 D1 migration 只跑一次（d1_migrations 記錄）。DROP 在 0094，刻意分開：
-- 依 repo 的 DROP 部署規則（code 先上線、DROP 後套），先讓 owner 在筆記頁確認
-- 67 筆看得到，才套 0094。

INSERT INTO trip_pretrip_notes
  (trip_id, sort_order, section, title, content, ai_generated, ai_source, origin, managed_by, semantic_key, created_at, updated_at)
SELECT
  d.trip_id,
  -- 接在該 trip 現有筆記之後，維持相對順序
  (SELECT COALESCE(MAX(p.sort_order), -1) FROM trip_pretrip_notes p WHERE p.trip_id = d.trip_id)
    + ROW_NUMBER() OVER (PARTITION BY d.trip_id ORDER BY d.doc_type, e.sort_order, e.id),
  CASE d.doc_type
    WHEN 'backup'      THEN '雨天備案'
    WHEN 'suggestions' THEN '行程建議'
  END,
  e.title,
  e.content,
  1,
  'general-tips',
  'ai',
  'ai',
  -- 顯式 semantic_key，帶來源前綴以便日後追查是哪一批搬進來的
  'legacy-docs:' || d.doc_type || ':' || e.id,
  e.updated_at,
  e.updated_at
FROM trip_doc_entries e
JOIN trip_docs d ON d.id = e.doc_id
WHERE d.doc_type IN ('backup', 'suggestions')
  -- 只搬有內容的（title 空白的是自動建立的空 stub）
  AND TRIM(e.title) <> ''
  -- trip 必須還存在（trip_docs 的 FK 是 CASCADE，理論上不會有孤兒，防禦性條件）
  AND EXISTS (SELECT 1 FROM trips t WHERE t.id = d.trip_id);
