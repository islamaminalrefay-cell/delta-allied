// ============================================================================
// delete-account — Delta Allied Sports tournament app
// ============================================================================
// PROJECT: delta-tournament (ejcokxagxtyjymdiepjr).
// NOT delta-registrations. The two Supabase projects share no schema, data or
// credentials, and this function reads tables that only exist in the tournament
// app's project. See ../../README.md before deploying.
//
// Why this exists
// ---------------
// Apple (App Store Review Guideline 5.1.1(v)) requires that an app supporting
// account creation lets the user START deletion inside the app, and that this
// deletes the account record and its personal data — temporarily disabling an
// account is explicitly not enough. Google Play requires the same in-app path
// plus a public web page where deletion can be requested without reinstalling
// (that page is delete-account.html on the marketing site).
//
// Neither is satisfiable from the client: removing a row from auth.users needs
// the service_role key, which must never ship inside an app. So this function
// is the only deletion path, and it authenticates the CALLER'S OWN token — it
// can only ever delete the account that asked.
//
// The trap this avoids
// -------------------
// people.user_id is ON DELETE SET NULL. Deleting the auth user on its own
// therefore removes the login and LEAVES the person record fully intact —
// full_name, date_of_birth, phone, email, photo_url — merely unlinked. It
// looks deleted in the Auth tab while the data is still there. Any correct
// deletion has to clear the person record itself, and that is what this does.
//
// What is deleted
// ---------------
//   auth.users row ............. the login itself
//   people identity fields ..... name, date of birth, phone, email, photo_url
//   player-photos objects ...... every file under <person_id>/ in the bucket
//   push_tokens ................ device tokens; personal, no record value
//   notifications .............. the log of messages sent to this person
//   digital_ids ................ accreditation credentials + QR tokens,
//                                which CASCADE onto qr_scans, removing the
//                                record of which venues/matches they attended
//
// What is retained, and why
// -------------------------
// The people ROW survives, anonymised, because deleting it would take the
// competition record with it: match_events (goals, cards), matches.referee_id
// and matches.result_confirmed_by are all ON DELETE SET NULL, and team_members
// and staff_assignments are ON DELETE CASCADE. A finished tournament's results
// must stay correct and complete. So roster membership, officiating records and
// match events remain, attached to a person row that no longer identifies
// anyone. Both stores permit this where it is disclosed in the privacy policy;
// privacy.html section 6 states it explicitly.
//
// Tournament ownership
// --------------------
// tournaments.organizer_id is NOT NULL, so an owner cannot simply be removed:
// the foreign key would refuse the delete outright. Ownership is never moved
// silently. If the caller owns any tournament, the first call returns 409 with
// the list of tournaments that need transferring, and deletion only proceeds
// once the caller names a successor in transfer_to_organizer_id.
//
// The successor must already have an app account (people.user_id is not null),
// because app.is_tournament_admin() resolves admin rights through
// app.current_person_id(), which maps auth.uid() -> people.user_id. Handing a
// tournament to a person with no account would leave it with no one able to
// administer it.
//
// Request
// -------
//   POST /functions/v1/delete-account
//   apikey:        <publishable key>
//   Authorization: Bearer <the user's own access token>
//   body (optional): { "transfer_to_organizer_id": "<uuid>" }
//
// Order of operations is deliberate: every destructive step runs BEFORE the
// auth user is removed. If a step fails, the account still exists and the user
// can retry. Removing the login first would set people.user_id to NULL and
// leave the identity data unreachable from the caller's token — the exact
// orphaned state described above.
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// The edge runtime populates SUPABASE_ANON_KEY with the sb_publishable_ value
// on newer projects and the legacy JWT on older ones. Accept either, and fall
// back to the explicitly-named variable.
const PUBLIC_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

const ALLOWED_ORIGINS = [
  "https://deltagroup-me.com",
  "https://www.deltagroup-me.com",
  "https://delta-allied.vercel.app",
  "http://localhost:8899",
];

// Replaces the real name on the retained person row. Deliberately not an empty
// string: full_name is NOT NULL, and a historical squad list still has to
// render something for the entry.
const ANONYMISED_NAME = "Deleted participant";

// Private bucket. Objects are stored as <person_id>/<filename> — the path
// convention that app.path_owner() depends on.
const PHOTO_BUCKET = "player-photos";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cors(origin: string | null): Record<string, string> {
  // Native apps send no Origin at all; CORS is a browser-side concern, so the
  // fallback simply has to be one of ours rather than a wildcard.
  const allowed = origin && ALLOWED_ORIGINS.includes(origin)
    ? origin
    : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

// Validates the caller's access token against the Auth API and returns their
// user id. A direct fetch keeps this unambiguous: the token in the header is
// the only thing that decides whose account gets deleted.
async function authenticate(token: string): Promise<string | null> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: PUBLIC_KEY },
  });
  if (!res.ok) return null;
  const user = await res.json().catch(() => null);
  return user && typeof user.id === "string" ? user.id : null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405, origin);
  }

  // ---- 1. Authenticate the caller ----------------------------------------
  const header = req.headers.get("Authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";

  if (!token) {
    return json({
      error: "authentication_required",
      message: "You must be signed in to delete your account.",
    }, 401, origin);
  }
  // The publishable key is a valid apikey but identifies nobody. Without this
  // check the failure downstream would be confusing rather than explicit.
  if (token === PUBLIC_KEY) {
    return json({
      error: "user_token_required",
      message:
        "Send the signed-in user's access token in the Authorization header, not the app's public key.",
    }, 401, origin);
  }

  const userId = await authenticate(token);
  if (!userId) {
    return json({
      error: "invalid_session",
      message: "Your session is no longer valid. Sign in again and retry.",
    }, 401, origin);
  }

  // ---- 2. Read the request ------------------------------------------------
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {}; // no body is fine; transfer_to_organizer_id is optional
  }
  const transferToRaw = body.transfer_to_organizer_id;
  const transferTo = typeof transferToRaw === "string" && transferToRaw.trim()
    ? transferToRaw.trim()
    : null;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ---- 3. Resolve the caller's person record -----------------------------
  const { data: person, error: personErr } = await admin
    .from("people")
    .select("id, full_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (personErr) {
    console.error("delete-account: person lookup failed", personErr);
    return json({ error: "lookup_failed", message: personErr.message }, 500, origin);
  }

  // Signed up but never linked to a person record (the email matched nothing
  // an organiser had entered). The login IS the whole account, so remove it.
  if (!person) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) {
      console.error("delete-account: auth delete failed (no person row)", error);
      return json({ error: "deletion_failed", message: error.message }, 500, origin);
    }
    return json({
      ok: true,
      deleted: { login: true, person_record: false },
      message: "Your account has been deleted.",
    }, 200, origin);
  }

  // ---- 4. Tournament ownership must be transferred explicitly ------------
  const { data: owned, error: ownedErr } = await admin
    .from("tournaments")
    .select("id, name, sport, status, start_date")
    .eq("organizer_id", person.id)
    .order("start_date", { ascending: true });

  if (ownedErr) {
    console.error("delete-account: tournament lookup failed", ownedErr);
    return json({ error: "lookup_failed", message: ownedErr.message }, 500, origin);
  }

  if (owned && owned.length > 0) {
    if (!transferTo) {
      const n = owned.length;
      return json({
        error: "tournament_ownership_transfer_required",
        message:
          `Your account is the organizer of ${n} tournament${n === 1 ? "" : "s"}. ` +
          `Every tournament must have an organizer, so ownership has to be ` +
          `transferred to a named person before your account can be deleted. ` +
          `Retry with "transfer_to_organizer_id" set to the person taking over.`,
        tournaments_requiring_transfer: owned,
      }, 409, origin);
    }

    if (!UUID_RE.test(transferTo)) {
      return json({
        error: "invalid_transfer_target",
        message: "transfer_to_organizer_id must be a person id (UUID).",
      }, 400, origin);
    }
    if (transferTo === person.id) {
      return json({
        error: "invalid_transfer_target",
        message:
          "You cannot transfer your tournaments to yourself. Name another person.",
      }, 400, origin);
    }

    const { data: target, error: targetErr } = await admin
      .from("people")
      .select("id, full_name, user_id")
      .eq("id", transferTo)
      .maybeSingle();

    if (targetErr) {
      console.error("delete-account: transfer target lookup failed", targetErr);
      return json({ error: "lookup_failed", message: targetErr.message }, 500, origin);
    }
    if (!target) {
      return json({
        error: "transfer_target_not_found",
        message: "No person exists with that id.",
        tournaments_requiring_transfer: owned,
      }, 400, origin);
    }
    // Admin rights resolve through people.user_id, so a person with no account
    // could not administer what they were given.
    if (!target.user_id) {
      return json({
        error: "transfer_target_has_no_account",
        message:
          `${target.full_name} does not have an app account yet, so they could ` +
          `not administer these tournaments. Ask them to sign in once, then retry.`,
        tournaments_requiring_transfer: owned,
      }, 400, origin);
    }

    const { error: xferErr } = await admin
      .from("tournaments")
      .update({ organizer_id: target.id })
      .eq("organizer_id", person.id);

    if (xferErr) {
      console.error("delete-account: ownership transfer failed", xferErr);
      return json({ error: "transfer_failed", message: xferErr.message }, 500, origin);
    }
    console.log(
      `delete-account: transferred ${owned.length} tournament(s) from ${person.id} to ${target.id}`,
    );
  }

  // ---- 5. Remove the profile photo from storage --------------------------
  // No foreign key reaches object storage, so nothing else would ever delete
  // this. A child's photograph surviving a deletion is the worst outcome here,
  // so a failure to confirm removal aborts before any data is touched.
  let photosRemoved = 0;
  const { data: files, error: listErr } = await admin
    .storage
    .from(PHOTO_BUCKET)
    .list(person.id, { limit: 100 });

  if (listErr) {
    console.error("delete-account: photo listing failed", listErr);
    return json({
      error: "photo_cleanup_failed",
      message:
        "Could not confirm removal of your profile photo, so nothing was deleted. Please try again.",
    }, 500, origin);
  }
  if (files && files.length > 0) {
    const paths = files.map((f) => `${person.id}/${f.name}`);
    const { error: rmErr } = await admin.storage.from(PHOTO_BUCKET).remove(paths);
    if (rmErr) {
      console.error("delete-account: photo removal failed", rmErr);
      return json({
        error: "photo_cleanup_failed",
        message:
          "Could not remove your profile photo, so nothing was deleted. Please try again.",
      }, 500, origin);
    }
    photosRemoved = paths.length;
  }

  // ---- 6. Delete the purely personal records -----------------------------
  // These CASCADE from people, but the person row is being kept, so they have
  // to go explicitly. digital_ids cascades onto qr_scans, which is what
  // removes the record of which venues and matches the person attended.
  const purge: Array<[string, string]> = [
    ["push_tokens", "person_id"],
    ["notifications", "person_id"],
    ["digital_ids", "person_id"],
  ];
  for (const [table, column] of purge) {
    const { error } = await admin.from(table).delete().eq(column, person.id);
    if (error) {
      console.error(`delete-account: purge of ${table} failed`, error);
      return json({
        error: "deletion_failed",
        message: `Could not delete your ${table} records. Nothing further was changed; please try again.`,
      }, 500, origin);
    }
  }

  // ---- 7. Strip identity from the retained person row --------------------
  // people_email_lower_idx is a partial unique index (WHERE email IS NOT NULL),
  // so clearing the address is safe and repeatable.
  const { error: anonErr } = await admin
    .from("people")
    .update({
      full_name: ANONYMISED_NAME,
      date_of_birth: null,
      phone: null,
      email: null,
      photo_url: null,
    })
    .eq("id", person.id);

  if (anonErr) {
    console.error("delete-account: anonymisation failed", anonErr);
    return json({
      error: "deletion_failed",
      message:
        "Could not remove your personal details. Your account is unchanged; please try again.",
    }, 500, origin);
  }

  // ---- 8. Finally, remove the login --------------------------------------
  const { error: authErr } = await admin.auth.admin.deleteUser(userId);
  if (authErr) {
    // The personal data is already gone. Say so rather than implying the
    // request failed cleanly, and leave a loud log line to follow up on.
    console.error("delete-account: PARTIAL — data cleared, login remains", {
      userId,
      personId: person.id,
      error: authErr.message,
    });
    return json({
      error: "partial_deletion",
      message:
        "Your personal details have been deleted, but the login record could not be removed. Contact us and we will finish it.",
    }, 500, origin);
  }

  console.log(`delete-account: completed for person ${person.id}`);

  return json({
    ok: true,
    deleted: {
      login: true,
      person_record: true,
      identity_fields: ["full_name", "date_of_birth", "phone", "email", "photo_url"],
      photos_removed: photosRemoved,
      push_tokens: true,
      notifications: true,
      digital_ids_and_scan_history: true,
    },
    retained_anonymised: {
      match_events: "goals, cards and other match events, with no name attached",
      match_officiating: "matches you refereed or confirmed results for",
      team_membership: "historical squad entries",
      reason:
        "A completed competition's results must stay accurate. These records no longer identify you.",
    },
    message: "Your account and personal details have been deleted.",
  }, 200, origin);
});
