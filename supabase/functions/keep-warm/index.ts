// ============================================================================
// keep-warm — Delta Allied Sports
// ============================================================================
// Supabase pauses free-plan projects after ~7 days of low activity, and paused
// projects do not wake on their own. That is not a theoretical risk here: it
// already happened once and took tournament registration down silently for
// twelve days, with visitors seeing an error and no notification reaching us.
//
// This function makes one trivial database query so the project registers as
// in use. It is called on a schedule by .github/workflows/keep-warm.yml.
//
// Why an external scheduler rather than pg_cron: Supabase's pausing docs talk
// about "user database activity" and list external API calls as the remedy.
// pg_cron runs inside the database and is not documented as counting. If it
// does not count, a pg_cron keep-warm would look installed and silently fail —
// the exact failure mode this exists to prevent.
//
// It reads no tables and touches no personal data. See public.keep_warm().
//
// Deployed to BOTH Supabase projects, identically:
//   - delta-registrations (omijppvwphqbuozqxliq) — this website's registrations
//   - delta-tournament    (ejcokxagxtyjymdiepjr) — the tournament app's backend
// Both were found paused on 27 Sep 2026. The workflow pings each as a separate
// matrix job with fail-fast disabled, so one being down cannot stop the other
// from being kept alive.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async () => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await admin.rpc("keep_warm");

  if (error) {
    // Surface failures loudly: the scheduled job checks the status code, so a
    // non-200 turns into a visible red run in GitHub Actions rather than a
    // silent no-op.
    console.error("keep-warm failed", error);
    return new Response(
      JSON.stringify({ ok: false, error: error.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, db_time: data }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
