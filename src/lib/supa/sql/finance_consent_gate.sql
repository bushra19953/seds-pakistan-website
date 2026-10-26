-- finance_consent_gate.sql — SQL ports of the finance consent view and
-- the related-party gate:
--   getConsentView / isDecidedApprovedConsent
--     (src/lib/finance/adapters.ts)
--   assertLedgerConsent's check (src/lib/finance/money-approval.ts)
--   evaluateRelatedPartyGate (src/lib/finance/related-party-gate.ts)
-- Plain helpers, no writes. Consent rows are read from
-- fs_consent_requests (governance-owned surface; freshness depends on
-- the governance mirror, the same caveat the read migration recorded).

-- The ConsentView for one consent_requests id: { exists, status,
-- decision, decisionDate, amountPkr }. decisionDate is the ISO date
-- (YYYY-MM-DD) derived from decisionDate, else decidedAtSort — the TS
-- timestampToIsoDate takes the first 10 chars of the ISO form.

-- An instant stored as an ISO string / dumped timestamp shape, as a
-- YYYY-MM-DD date (the TS timestampToIsoDate arms: string -> slice,
-- Date -> ISO slice, {seconds} -> instant -> ISO slice; ISO strings in
-- jsonb are the storage ruling, the {seconds} arm covers legacy rows).
create or replace function finance_iso_date(p_value jsonb) returns text
language sql
immutable
as $$
  select case
    when jsonb_typeof(p_value) = 'string' then left(p_value #>> '{}', 10)
    when jsonb_typeof(p_value) = 'object' and jsonb_typeof(p_value -> 'seconds') = 'number'
      then to_char(to_timestamp((p_value ->> 'seconds')::double precision) at time zone 'UTC', 'YYYY-MM-DD')
  end;
$$;

-- isDecidedApprovedConsent(view, minAmountPkr): consent_given and
-- conditional_consent count as approved; when a minimum is given AND
-- the consent carries an amount, the amount must cover it; a consent
-- with no amount is not amount-scoped and passes.
create or replace function finance_consent_approved(
  p_view jsonb,
  p_min_amount numeric default null
) returns boolean
language sql
immutable
as $$
  select coalesce(p_view -> 'exists', 'false'::jsonb) = 'true'::jsonb
    and (p_view ->> 'decision') in ('consent_given', 'conditional_consent')
    and (
      p_min_amount is null
      or (p_view -> 'amountPkr') is null
      or jsonb_typeof(p_view -> 'amountPkr') = 'null'
      or finance_jsonb_number(p_view -> 'amountPkr') >= p_min_amount
    );
$$;

-- assertLedgerConsent's decision: returns the CONSENT_REQUIRED message
-- when the entry may NOT post, or NULL when it may. An entry that is
-- neither unbudgeted nor over threshold needs no consent.
create or replace function finance_ledger_consent_blocker(p_entry jsonb) returns text
language plpgsql
stable
as $$
declare
  v_unbudgeted boolean := coalesce(p_entry -> 'unbudgeted', 'false'::jsonb) = 'true'::jsonb;
  v_over boolean := coalesce(p_entry -> 'overThreshold', 'false'::jsonb) = 'true'::jsonb;
  v_view jsonb;
  v_min numeric;
begin
  if not v_unbudgeted and not v_over then return null; end if;
  v_view := finance_consent_view(
    case when jsonb_typeof(p_entry -> 'consentId') = 'string' then p_entry ->> 'consentId' else '' end
  );
  v_min := case when v_over then finance_jsonb_number(p_entry -> 'amountPkr') end;
  if finance_consent_approved(v_view, v_min) then return null; end if;
  return 'Entry is unbudgeted or over the PKR 250,000 threshold and requires a decided Founder Consent before posting (hooks H1/H2)';
end;
$$;

-- evaluateRelatedPartyGate(record, consentView) port. Returns
-- { canActivate, missing: [..in TS order..], founderConsentDate,
--   triggerValuePkr }. The caller formats the TS failure message:
-- 'Related-party gate not satisfied: ' || missing joined by '; '.
create or replace function finance_related_party_gate(
  p_record jsonb,
  p_consent_view jsonb
) returns jsonb
language plpgsql
immutable
as $$
declare
  v_pledged numeric := coalesce(finance_jsonb_number(p_record #> '{financials,pledgedAmount}'), 0);
  v_contract numeric := coalesce(finance_jsonb_number(p_record #> '{relatedParty,contractSumPkr}'), 0);
  v_trigger numeric := greatest(v_pledged, v_contract);
  v_rp jsonb := case when jsonb_typeof(p_record -> 'relatedParty') = 'object' then p_record -> 'relatedParty' end;
  v_missing jsonb := '[]'::jsonb;
  v_founder_date text := null;
  v_d jsonb;
  v_b jsonb;
  v_quotes int;
begin
  if coalesce(p_record -> 'isRelatedParty', 'false'::jsonb) <> 'true'::jsonb then
    return jsonb_build_object('canActivate', true, 'missing', '[]'::jsonb, 'founderConsentDate', null, 'triggerValuePkr', v_trigger);
  end if;

  -- Disclosure (RP-04).
  v_d := case when jsonb_typeof(v_rp -> 'disclosure') = 'object' then v_rp -> 'disclosure' end;
  if v_d is null then
    v_missing := v_missing || jsonb_build_array('Written disclosure record (RP-04) is not recorded');
  else
    if coalesce(v_d ->> 'disclosedTo', '') <> 'national_general_secretary' then
      v_missing := v_missing || jsonb_build_array('Disclosure must be made to the National General Secretary');
    end if;
    if coalesce(trim(v_d ->> 'disclosureDate'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Disclosure date is missing');
    end if;
    if coalesce(trim(v_d ->> 'natureSummary'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Disclosure: nature of the interest is missing');
    end if;
    if coalesce(trim(v_d ->> 'extentSummary'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Disclosure: extent of the interest is missing');
    end if;
    if coalesce(trim(v_d ->> 'valueSummary'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Disclosure: commercial value summary is missing');
    end if;
  end if;

  if coalesce(trim(v_rp ->> 'agreementRef'), '') = '' then
    v_missing := v_missing || jsonb_build_array('Agreement reference (Exhibit A) is missing');
  end if;

  -- Benchmarking (RP-05) above PKR 100,000.
  if v_trigger > 100000 then
    v_b := case when jsonb_typeof(v_rp -> 'benchmarking') = 'object' then v_rp -> 'benchmarking' end;
    if v_b is null then
      v_missing := v_missing || jsonb_build_array('Benchmarking record is required above PKR 100,000 (RP-05)');
    elsif v_b ->> 'method' = 'two_quotes' then
      select count(*) into v_quotes
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_b -> 'quoteDriveIds') = 'array' then v_b -> 'quoteDriveIds' else '[]'::jsonb end
        ) as q
       where trim(q) <> '';
      if v_quotes < 2 then
        v_missing := v_missing || jsonb_build_array('Benchmarking requires at least two independent quotes');
      end if;
    elsif v_b ->> 'method' = 'written_justification' then
      if coalesce(trim(v_b ->> 'justification'), '') = '' or length(trim(v_b ->> 'justification')) < 50 then
        v_missing := v_missing || jsonb_build_array('Benchmarking written justification must be at least 50 characters');
      end if;
    else
      v_missing := v_missing || jsonb_build_array('Benchmarking method is not set');
    end if;
    if v_b is null or coalesce(trim(v_b ->> 'boardReviewedAt'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Board review date for the benchmarking comparison is missing');
    end if;
    if coalesce(trim(v_rp ->> 'boardApprovalDate'), '') = '' then
      v_missing := v_missing || jsonb_build_array('Board approval date is missing');
    end if;
  end if;

  -- Founder Consent (RP-07).
  if coalesce(trim(v_rp ->> 'consentRequestId'), '') = '' then
    v_missing := v_missing || jsonb_build_array('Founder Consent record is not linked');
  elsif p_consent_view is null
    or coalesce(p_consent_view -> 'exists', 'false'::jsonb) <> 'true'::jsonb
    or (p_consent_view ->> 'decision') not in ('consent_given', 'conditional_consent')
  then
    v_missing := v_missing || jsonb_build_array('Linked Founder Consent is not decided-approved');
  else
    v_founder_date := p_consent_view ->> 'decisionDate';
  end if;

  return jsonb_build_object(
    'canActivate', jsonb_array_length(v_missing) = 0,
    'missing', v_missing,
    'founderConsentDate', v_founder_date,
    'triggerValuePkr', v_trigger
  );
end;
$$;

create or replace function finance_consent_view(p_consent_id text) returns jsonb
language plpgsql
stable
as $$
declare
  v_data jsonb;
begin
  if p_consent_id is null or p_consent_id = '' then
    return jsonb_build_object('exists', false, 'status', null, 'decision', null, 'decisionDate', null, 'amountPkr', null);
  end if;
  select data into v_data from fs_consent_requests where id = p_consent_id;
  if not found then
    return jsonb_build_object('exists', false, 'status', null, 'decision', null, 'decisionDate', null, 'amountPkr', null);
  end if;
  return jsonb_build_object(
    'exists', true,
    'status', case when jsonb_typeof(v_data -> 'status') = 'string' then v_data ->> 'status' end,
    'decision', case when jsonb_typeof(v_data -> 'decision') = 'string' then v_data ->> 'decision' end,
    'decisionDate', coalesce(
      finance_iso_date(v_data -> 'decisionDate'),
      finance_iso_date(v_data -> 'decidedAtSort')
    ),
    'amountPkr', finance_jsonb_number(v_data -> 'amountPkr')
  );
end;
$$;
