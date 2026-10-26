-- store_keyset_indexes.sql — FLIP-TIME DDL for the store slice
-- (S-K1 support index + S-W7 idempotency index). This is NOT a
-- function file: it is staged here per the store build brief ("SQL /
-- index DDL is staged as flip-time artifacts in src/lib/supa/sql/")
-- and applied by the coordinator at flip time, never by this build.
-- Both statements are idempotent (`if not exists`).
--
-- (1) Orders page support index: the store_orders_page predicate's
--     shape — (millis(createdAt) DESC, id ASC). At current scale
--     (orders are tens of rows in the reconciled dump) the planner
--     cost is immaterial; the index is staged so the predicate's shape
--     stays cheap as the table grows.
create index if not exists fs_orders_keyset_page_idx
  on fs_orders (
    (floor(extract(epoch from (data->>'createdAt')::timestamptz) * 1000)) desc,
    id asc
  );

-- (2) S-W7 — order-creation idempotency (design §3.5.3): a unique
--     PARTIAL expression index on (buyerUserId, idempotencyKey) makes
--     the tx_store_order_create / tx_store_create_order dedupe lookup
--     race-proof; a unique violation inside those functions is caught
--     and converted to the { created: false } replay response.
--     Partial (key IS NOT NULL): every pre-cutover order carries no
--     idempotencyKey (the field is additive, minted only by keyed
--     clients under primacy), so the index builds clean over the
--     existing table by construction.
create unique index if not exists fs_orders_buyer_idempotency_key_idx
  on fs_orders ((data->>'buyerUserId'), (data->>'idempotencyKey'))
  where data->>'idempotencyKey' is not null;
