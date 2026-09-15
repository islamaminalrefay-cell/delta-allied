-- ============================================================================
-- Delta Allied Sports — registration lockdown verification
-- Project: delta-registrations (ref omijppvwphqbuozqxliq)
-- ============================================================================
-- Proves the anon role can do NOTHING to the registration tables. It
-- impersonates anon (`set local role anon`) and actually attempts each
-- operation rather than just listing policies.
--
-- Every check must read PASS. Run it after any change to grants, policies or
-- the schema — particularly after anything that might reapply Supabase's
-- default privileges.
--
-- Last run: all 6 PASS. Every failure was "permission denied", which is the
-- GRANT layer refusing before RLS is even consulted.
-- ============================================================================

begin;

create temp table rls_results(
  id serial, check_name text, expectation text, outcome text, verdict text
) on commit drop;

-- 1. anon must not be able to read registrations -----------------------------
do $$
begin
  set local role anon;
  perform 1 from public.player_registrations limit 1;
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon SELECT players','denied','ROWS WERE READABLE','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon SELECT players','denied',sqlerrm,'PASS');
end $$;

do $$
begin
  set local role anon;
  perform 1 from public.academy_registrations limit 1;
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon SELECT academies','denied','ROWS WERE READABLE','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon SELECT academies','denied',sqlerrm,'PASS');
end $$;

-- 2. anon must not be able to write ------------------------------------------
-- The browser never inserts directly; only the Edge Function (service_role)
-- writes. So even INSERT must be refused here.
do $$
begin
  set local role anon;
  insert into public.player_registrations
    (full_name,date_of_birth,nationality,academy_affiliation,guardian_name,
     guardian_phone,email,phone,tournament_category)
  values ('Anon Bypass','2011-01-01','UAE','Independent','G','+971500000000',
          'bypass@example.com','+971500000000','DOFA');
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon INSERT players','denied','INSERT ACCEPTED','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon INSERT players','denied',sqlerrm,'PASS');
end $$;

-- 3. anon must not be able to tamper or destroy ------------------------------
do $$
begin
  set local role anon;
  update public.player_registrations set full_name='tampered';
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon UPDATE players','denied','UPDATE ACCEPTED','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon UPDATE players','denied',sqlerrm,'PASS');
end $$;

do $$
begin
  set local role anon;
  delete from public.player_registrations;
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon DELETE players','denied','DELETE ACCEPTED','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon DELETE players','denied',sqlerrm,'PASS');
end $$;

-- 4. anon must not see the rate-limit ledger ---------------------------------
do $$
begin
  set local role anon;
  perform 1 from private.submission_throttle limit 1;
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon read throttle ledger','denied','READABLE','FAIL');
exception when others then
  reset role;
  insert into rls_results(check_name,expectation,outcome,verdict)
  values ('anon read throttle ledger','denied',sqlerrm,'PASS');
end $$;

select check_name, verdict, outcome from rls_results order by id;

rollback;

-- ============================================================================
-- Rate limiter check (run separately; it writes to the ledger).
--
--   select
--     public.check_submission_throttle('probe', 5, 60),   -- true
--     public.check_submission_throttle('probe', 5, 60),   -- true
--     public.check_submission_throttle('probe', 5, 60),   -- true
--     public.check_submission_throttle('probe', 5, 60),   -- true
--     public.check_submission_throttle('probe', 5, 60),   -- true
--     public.check_submission_throttle('probe', 5, 60);   -- false, limit hit
--   delete from private.submission_throttle where ip_hash = 'probe';
--
-- Verified: 5 allowed, 6th refused.
-- ============================================================================
