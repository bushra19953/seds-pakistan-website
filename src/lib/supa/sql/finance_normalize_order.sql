-- finance_normalize_order.sql — SQL port of normalizeOrder()
-- (src/lib/finance/order-canonical.ts), restricted to the fields the
-- money-approval create validation and decide apply handlers consume.
-- Plain helper, no writes. Parity notes (from the TS original):
--   totalPkr: totalPkr > total > amount > sum of item subtotals > 0
--     (a non-number value counts as absent; item subtotals that are
--     not numbers count as 0). The TS result is NEVER null: the chain
--     bottoms out at 0. dataQuality is not ported (unused by writes).
--   status: legacy map pending->pending_verification,
--     pending_payment->pending_verification, paid->verified,
--     printed->processing; anything else passes through ('' if absent).
--   paymentStatus: stored value if a non-empty string; else 'completed'
--     when the raw status was 'paid' or the mapped status is
--     'verified'; else 'pending'.
--   isDeleted: raw isDeleted = true, or mapped status 'soft_deleted'.
--   buyerUserId: buyerUserId if a non-empty string, else userId, else ''.
--   receiptUrl / receiptDriveId: canonical key if a non-empty string,
--     else the legacy proof key, else null.


-- A jsonb value as a number, or NULL when it is not a JSON number
-- (the TS asNumber(): typeof number && Number.isFinite).
create or replace function finance_jsonb_number(p_value jsonb) returns numeric
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_value) = 'number' then (p_value #>> '{}')::numeric
  end;
$$;

-- deriveFyLabel() port (src/lib/finance/ledger.ts): FY runs 1 July to
-- 30 June; the label names the FY by its start year (fy2026-27).
create or replace function finance_derive_fy_label(p_iso_date text) returns text
language sql
immutable
as $$
  select 'fy' || v_start_year || '-' || lpad(((v_start_year + 1) % 100)::text, 2, '0')
    from (
      select case
        when extract(month from p_iso_date::date) >= 7
          then extract(year from p_iso_date::date)::int
        else extract(year from p_iso_date::date)::int - 1
      end as v_start_year
    ) s;
$$;

-- ledgerCategoryForModule() port (order-canonical.ts).
create or replace function finance_ledger_category(p_module text) returns text
language sql
immutable
as $$
  select case p_module
    when 'donation' then 'donations'
    when 'chapter-registration' then 'chapter_fees'
    when 'Events' then 'event_income'
    when 'Certificates' then 'store_sales'
    when 'store' then 'store_sales'
    else 'other_income'
  end;
$$;

create or replace function finance_normalize_order(p_data jsonb) returns jsonb
language plpgsql
immutable
as $$
declare
  v_raw_status text := coalesce(p_data ->> 'status', '');
  v_mapped_status text;
  v_items jsonb := case
    when jsonb_typeof(p_data -> 'items') = 'array' then p_data -> 'items'
    else '[]'::jsonb
  end;
  v_total numeric;
  v_payment_status text;
begin
  v_mapped_status := case v_raw_status
    when 'pending' then 'pending_verification'
    when 'pending_payment' then 'pending_verification'
    when 'paid' then 'verified'
    when 'printed' then 'processing'
    else v_raw_status
  end;

  v_total := finance_jsonb_number(p_data -> 'totalPkr');
  if v_total is null then v_total := finance_jsonb_number(p_data -> 'total'); end if;
  if v_total is null then v_total := finance_jsonb_number(p_data -> 'amount'); end if;
  if v_total is null then
    if jsonb_array_length(v_items) > 0 then
      select coalesce(sum(coalesce(finance_jsonb_number(item -> 'subtotal'), 0)), 0)
        into v_total
        from jsonb_array_elements(v_items) as item;
    else
      v_total := 0;
    end if;
  end if;

  if coalesce(p_data ->> 'paymentStatus', '') <> '' then
    v_payment_status := p_data ->> 'paymentStatus';
  elsif v_raw_status = 'paid' or v_mapped_status = 'verified' then
    v_payment_status := 'completed';
  else
    v_payment_status := 'pending';
  end if;

  return jsonb_build_object(
    'totalPkr', v_total,
    'status', v_mapped_status,
    'paymentStatus', v_payment_status,
    'buyerUserId', coalesce(
      nullif(p_data ->> 'buyerUserId', ''),
      case when jsonb_typeof(p_data -> 'userId') = 'string' then p_data ->> 'userId' end,
      ''
    ),
    'buyer', coalesce(p_data -> 'buyer', 'null'::jsonb),
    'items', v_items,
    'receiptUrl', coalesce(
      nullif(p_data ->> 'receiptUrl', ''),
      case when jsonb_typeof(p_data -> 'proofOfPaymentUrl') = 'string' then p_data ->> 'proofOfPaymentUrl' end
    ),
    'receiptDriveId', coalesce(
      nullif(p_data ->> 'receiptDriveId', ''),
      case when jsonb_typeof(p_data -> 'proofOfPaymentDriveFileId') = 'string' then p_data ->> 'proofOfPaymentDriveFileId' end
    ),
    'originatingModule', case
      when jsonb_typeof(p_data -> 'originatingModule') = 'string' then p_data ->> 'originatingModule'
    end,
    'isDeleted', coalesce(p_data -> 'isDeleted', 'false'::jsonb) = 'true'::jsonb
      or v_mapped_status = 'soft_deleted'
  );
end;
$$;
