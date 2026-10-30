-- fs_consent_requests_history — mirror table for the Firestore
-- subcollection consent_requests/{id}/history (consents mirror + seam
-- program, 2026-10-30).
--
-- WHY A DEDICATED TABLE: the Supabase adapter's subcollection rule
-- lands subcollection docs in fs_group_<name> (here fs_group_history),
-- a shared namespace that does not exist on the project and would mix
-- consent history with every other collection's `history`
-- subcollection. This dedicated table keeps the consent record's
-- history in its own governance namespace. The seam
-- (src/lib/server/consents-supa.ts) reaches it through the raw
-- service-role client, exactly like the contacts mirror reaches
-- fs_users_private_contact.
--
-- SHAPE: the house mirror shape (id, data jsonb, firebase_uid,
-- parent_path, migrated_at). A history entry's identity is its full
-- path, so the primary key is (parent_path, id) — the same ruling as
-- the fs_group_* tables (create_group_tables.sql): the same history
-- doc id under two different consent requests is two different rows.
-- parent_path is always `consent_requests/<requestId>`.
-- firebase_uid is null for consent history (the migration kit's
-- firebaseUidForPath rule only derives a uid from a `users/` path
-- segment; consent_requests rows carry null, verified live on
-- fs_consent_requests 2026-10-30).
--
-- RLS POSTURE: RLS enabled with ZERO policies — service-role only,
-- identical to fs_consent_requests and fs_users_private_contact
-- (verified live: relrowsecurity=true, pg_policies empty). Consent
-- reads flow only through the gated server paths; no client-readable
-- path exists.
--
-- IDEMPOTENT: safe to re-run. Apply via the Supabase Management API
-- / SQL editor BEFORE running scripts/backfill-consents-mirror.mjs.
-- The coordinator applies this file; it is delivered unapplied.

create table if not exists public.fs_consent_requests_history (
  id text not null,
  firebase_uid text,
  parent_path text not null,
  data jsonb not null default '{}'::jsonb,
  migrated_at timestamp with time zone default timezone('utc'::text, now()) not null,
  primary key (parent_path, id)
);

create index if not exists idx_fs_consent_requests_history_parent
  on public.fs_consent_requests_history(parent_path);

alter table public.fs_consent_requests_history enable row level security;

-- Posture assertion for the table that already exists: enabling RLS
-- is idempotent, and this block does NOT touch any policies (zero
-- policies is the posture — do not add any).
alter table public.fs_consent_requests enable row level security;
