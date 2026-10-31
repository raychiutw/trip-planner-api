-- V1 trip_docs table已 DROP (migration 0021)，移除 V2 後綴
ALTER TABLE trip_docs_v2 RENAME TO trip_docs;
