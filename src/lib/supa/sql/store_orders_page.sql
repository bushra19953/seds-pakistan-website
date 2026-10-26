-- store_orders_page.sql — S-K1: the orders list page fetcher (READ rpc,
-- not a tx_* function: it writes nothing). Spec:
-- ~/workspace/supabase-migration/cutover-sections/store-design.md §1.7.
--
-- This file is an APPLY artifact: authoring it applies nothing. The
-- coordinator applies it at the store-orders-api flip, together with
-- store_keyset_indexes.sql. `create or replace` — re-applying is a
-- no-op.
--
-- THE TOTAL ORDER (design §1.2, the whole keyset rests on it):
--   ORDER BY createdAt DESC, id ASC
-- expressed over the key (millis(createdAt), id). The predicate is the
-- design's strict "after" verbatim:
--   millis(r) < p_cursor_millis
--   OR (millis(r) = p_cursor_millis AND r.id > p_cursor_id)
-- A bare value bound (millis < bound alone) is the defect this retires:
-- it dropped every unserved tie sibling sharing the cursor timestamp.
--
-- millis(r): the cast is safe for every row the dump or the adapter
-- wrote (both store ISO-8601 timestamp strings in data->>'createdAt').
-- Rows whose createdAt text does not look like an ISO instant are
-- outside the keyset universe (Firestore orderBy likewise excludes
-- docs missing the ordered field; both order-create paths always
-- stamp createdAt) — the regex guard keeps a stray non-ISO value from
-- raising a cast error that would fail the whole list.
--
-- The caller asks for p_limit = limit+1 (the route's hasMore window);
-- the route's in-code soft-delete post-filter is unchanged and applies
-- AFTER this fetch, exactly where Firestore startAfter applied.

create or replace function store_orders_page(
  p_status text default null,
  p_cursor_millis bigint default null,
  p_cursor_id text default null,
  p_limit int default 21
) returns table (id text, data jsonb)
language sql
stable
as $$
  with keyed as (
    select
      r.id,
      r.data,
      case
        when r.data->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}'
          then floor(extract(epoch from (r.data->>'createdAt')::timestamptz) * 1000)::bigint
        else null
      end as millis
    from fs_orders r
    where (p_status is null or r.data->>'status' = p_status)
  )
  select k.id, k.data
    from keyed k
   where k.millis is not null
     and (
       p_cursor_millis is null
       or k.millis < p_cursor_millis
       or (k.millis = p_cursor_millis and k.id > p_cursor_id)
     )
   order by k.millis desc, k.id asc
   limit p_limit;
$$;
