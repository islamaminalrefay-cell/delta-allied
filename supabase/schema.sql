-- ============================================================================
-- Delta Allied Sports — tournament registration schema
-- Project: delta-registrations (ref omijppvwphqbuozqxliq)
-- ============================================================================
-- Deliberately standalone. Shares no schema, no data and no credentials with
-- the `delta-tournament` project that backs the tournament app.
--
-- Security model
-- --------------
-- There is NO public write path to these tables. The browser never talks to
-- PostgREST directly; it posts to the `submit-registration` Edge Function,
-- which validates, rate-limits, and inserts using the service_role key that
-- never leaves the server.
--
-- The anon role therefore holds ZERO privileges on these tables — not even
-- INSERT. That is the strongest version of what was asked for: anon cannot
-- read, cannot write, cannot tamper, cannot enumerate.
--
-- RLS is still enabled on both tables as a second layer, so that if anyone
-- ever re-grants anon by hand (or Supabase's default privileges are reapplied
-- by a future migration), rows remain unreachable without an explicit policy.
--
-- service_role (the Edge Function, and the dashboard's table editor) bypasses
-- RLS by design. That is how registrations get written, and how you will view,
-- filter and export them.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Tournaments — the live competition list.
-- A CHECK rather than free text so the table editor's filters and exports stay
-- clean. To add a tournament later, alter this one constraint on each table.
-- ---------------------------------------------------------------------------

create table if not exists public.player_registrations (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),

  full_name           text not null,
  date_of_birth       date not null,
  nationality         text not null,
  academy_affiliation text not null,          -- free text, or 'Independent'
  position            text,                   -- optional
  guardian_name       text not null,
  guardian_phone      text not null,
  email               text not null,
  phone               text not null,
  tournament_category text not null,

  constraint player_tournament_valid check (tournament_category in (
    'DOFA', 'ADOFA', 'UAE GIRLS FOOTBALL', 'AEC', 'AEC RIYADH', 'UAE BASKETBALL'
  )),
  constraint player_full_name_len    check (char_length(full_name)           between 2 and 120),
  constraint player_nationality_len  check (char_length(nationality)         between 2 and 60),
  constraint player_academy_len      check (char_length(academy_affiliation) between 2 and 120),
  constraint player_position_len     check (position is null or char_length(position) <= 40),
  constraint player_guardian_len     check (char_length(guardian_name)       between 2 and 120),
  constraint player_guardian_ph_len  check (char_length(guardian_phone)      between 5 and 32),
  constraint player_phone_len        check (char_length(phone)               between 5 and 32),
  constraint player_email_len        check (char_length(email)               between 5 and 160),
  constraint player_email_format     check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Sanity bounds only. Deliberately static rather than current_date, which is
  -- not immutable and misbehaves on restore.
  constraint player_dob_range        check (date_of_birth > date '1950-01-01'
                                        and date_of_birth < date '2030-01-01')
);

create table if not exists public.academy_registrations (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  academy_name   text not null,
  contact_name   text not null,
  email          text not null,
  phone          text not null,
  team_size      integer not null,
  age_category   text not null,
  city           text not null,
  notes          text,                        -- optional

  constraint academy_tournament_valid check (age_category in (
    'DOFA', 'ADOFA', 'UAE GIRLS FOOTBALL', 'AEC', 'AEC RIYADH', 'UAE BASKETBALL'
  )),
  constraint academy_name_len      check (char_length(academy_name) between 2 and 140),
  constraint academy_contact_len   check (char_length(contact_name) between 2 and 120),
  constraint academy_phone_len     check (char_length(phone)        between 5 and 32),
  constraint academy_city_len      check (char_length(city)         between 2 and 80),
  constraint academy_notes_len     check (notes is null or char_length(notes) <= 2000),
  constraint academy_email_len     check (char_length(email)        between 5 and 160),
  constraint academy_email_format  check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint academy_team_size     check (team_size between 1 and 60)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
create index if not exists player_registrations_created_at_idx
  on public.player_registrations (created_at desc);
create index if not exists academy_registrations_created_at_idx
  on public.academy_registrations (created_at desc);

-- Stops an honest double-click, or a refresh-and-resubmit, creating duplicates.
-- The Edge Function turns the resulting unique violation into a friendly 409.
create unique index if not exists player_registrations_unique_entry
  on public.player_registrations (lower(email), tournament_category);
create unique index if not exists academy_registrations_unique_entry
  on public.academy_registrations (lower(email), age_category);

-- ============================================================================
-- Privileges — anon and authenticated get nothing at all.
-- ============================================================================
-- Supabase's default privileges grant anon ALL on new public tables, so this
-- REVOKE is doing real work. `public` is every role and has to be named
-- explicitly; revoking from anon/authenticated alone would not be enough.
revoke all on table public.player_registrations  from public, anon, authenticated;
revoke all on table public.academy_registrations from public, anon, authenticated;

-- ============================================================================
-- Row level security — second layer
-- ============================================================================
alter table public.player_registrations  enable row level security;
alter table public.academy_registrations enable row level security;

-- No policies are created. Under RLS, anything without a matching policy is
-- refused, so even if the grants above were restored by accident, anon still
-- reaches nothing. service_role bypasses RLS and is unaffected.
drop policy if exists "anon may submit player registrations"  on public.player_registrations;
drop policy if exists "anon may submit academy registrations" on public.academy_registrations;

-- ============================================================================
-- Rate limiting — private schema, invisible to PostgREST
-- ============================================================================
-- Lives outside `public` so the REST API does not expose it at all, regardless
-- of grants. Only the Edge Function (service_role) ever touches it.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists private.submission_throttle (
  id         bigserial primary key,
  ip_hash    text not null,          -- SHA-256 of caller IP + salt; never the raw IP
  created_at timestamptz not null default now()
);
create index if not exists submission_throttle_lookup
  on private.submission_throttle (ip_hash, created_at desc);

revoke all on table private.submission_throttle from public, anon, authenticated;

-- Atomic "may this caller submit?" check. Counts recent attempts for the
-- hashed IP, records this one, and returns false once the limit is hit.
create or replace function private.check_submission_throttle(
  p_ip_hash text,
  p_limit   integer default 5,
  p_window  interval default interval '1 hour'
)
returns boolean
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  recent_count integer;
begin
  -- Opportunistic cleanup; keeps the table from growing without a cron job.
  delete from private.submission_throttle where created_at < now() - interval '24 hours';

  select count(*) into recent_count
    from private.submission_throttle
   where ip_hash = p_ip_hash
     and created_at > now() - p_window;

  if recent_count >= p_limit then
    return false;
  end if;

  insert into private.submission_throttle (ip_hash) values (p_ip_hash);
  return true;
end;
$$;

revoke all on function private.check_submission_throttle(text, integer, interval)
  from public, anon, authenticated;

-- ============================================================================
-- Realtime is explicitly NOT enabled on these tables, so no one can subscribe
-- to a live feed of incoming registrations.
-- ============================================================================

comment on table public.player_registrations  is
  'Individual player tournament sign-ups. Written only by the submit-registration Edge Function.';
comment on table public.academy_registrations is
  'Academy/club squad sign-ups. Written only by the submit-registration Edge Function.';
comment on table private.submission_throttle  is
  'Hashed-IP rate limit ledger for submit-registration. Never exposed via the REST API.';
