-- fs_vendor_shop_tables.sql: landing tables for the six vendor shop
-- pilot collections (PLAN-ga Section 5.4): vendors, commission_ledger,
-- vendor_payouts, store_waitlist, group_buys, store_credits.
--
-- Apply once through the Supabase SQL editor or the migration route
-- the coordinator names. GA code does not run this file. Until it is
-- applied, mirror writes return false and log, and nothing else in GA
-- is affected.
--
-- SHAPE: the house landing shape (id, firebase_uid, parent_path,
-- data jsonb, migrated_at), matching create_tables.sql and the
-- consents precedent in scripts/fs_consent_requests_history.sql. The
-- Supabase adapter derives each table name from the Firestore
-- collection name (tableForCollection), so no GA code writes a table
-- name for these collections.
--
-- RLS POSTURE: RLS enabled with ZERO policies for every table : 
-- service-role only, the supabase-postgres-best-practices rule for
-- server-only tables. The service role bypasses RLS; no client-readable
-- path exists for these admin-tier records.
--
-- IDEMPOTENT: if not exists throughout, safe to re-run.

create table if not exists public.fs_vendors (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_vendors_uid on public.fs_vendors(firebase_uid);
alter table public.fs_vendors enable row level security;

create table if not exists public.fs_commission_ledger (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_commission_ledger_uid on public.fs_commission_ledger(firebase_uid);
alter table public.fs_commission_ledger enable row level security;

create table if not exists public.fs_vendor_payouts (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_vendor_payouts_uid on public.fs_vendor_payouts(firebase_uid);
alter table public.fs_vendor_payouts enable row level security;

create table if not exists public.fs_store_waitlist (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_store_waitlist_uid on public.fs_store_waitlist(firebase_uid);
alter table public.fs_store_waitlist enable row level security;

create table if not exists public.fs_group_buys (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_group_buys_uid on public.fs_group_buys(firebase_uid);
alter table public.fs_group_buys enable row level security;

create table if not exists public.fs_store_credits (
  id text primary key,
  firebase_uid text,
  parent_path text,
  data jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
create index if not exists idx_fs_store_credits_uid on public.fs_store_credits(firebase_uid);
alter table public.fs_store_credits enable row level security;
