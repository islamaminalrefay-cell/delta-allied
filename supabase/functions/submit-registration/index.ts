// ============================================================================
// submit-registration — Delta Allied Sports
// ============================================================================
// The ONLY write path into player_registrations / academy_registrations.
//
// The browser never talks to PostgREST directly: the anon role has zero
// privileges on those tables (see supabase/schema.sql). This function holds
// the service_role key, which never leaves the server, and is the sole thing
// allowed to insert.
//
// Order of checks, cheapest first:
//   1. CORS / method
//   2. anon apikey present          — turns away drive-by scanners
//   3. honeypot                     — free, catches naive bots
//   4. shape + field validation     — before we touch the database
//   5. Turnstile (if configured)    — real bot check
//   6. per-IP rate limit            — one DB round trip
//   7. insert
// ============================================================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TOURNAMENTS = [
  "DOFA",
  "ADOFA",
  "UAE GIRLS FOOTBALL",
  "AEC",
  "AEC RIYADH",
  "UAE BASKETBALL",
] as const;

const ALLOWED_ORIGINS = [
  "https://deltagroup-me.com",
  "https://www.deltagroup-me.com",
  "https://delta-allied.vercel.app",
  "http://localhost:8899",
];

// How many submissions one IP may make per window.
const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 60;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function cors(origin: string | null): Record<string, string> {
  // Echo the origin only when it is one of ours; otherwise fall back to the
  // production domain so a stray origin never gets a permissive header.
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

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function lenOk(v: string, min: number, max: number) {
  return v.length >= min && v.length <= max;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Validation — mirrors the CHECK constraints so bad input is rejected with a
// useful message instead of bouncing off Postgres as an opaque 400.
// ---------------------------------------------------------------------------
function validatePlayer(d: Record<string, unknown>): { row?: Record<string, unknown>; error?: string } {
  const full_name = str(d.full_name);
  const date_of_birth = str(d.date_of_birth);
  const nationality = str(d.nationality);
  const academy_affiliation = str(d.academy_affiliation);
  const position = str(d.position);
  const guardian_name = str(d.guardian_name);
  const guardian_phone = str(d.guardian_phone);
  const email = str(d.email);
  const phone = str(d.phone);
  const tournament_category = str(d.tournament_category);

  if (!full_name || !lenOk(full_name, 2, 120)) return { error: "Please enter the player's full name." };
  if (!date_of_birth) return { error: "Please enter a date of birth." };
  const dob = new Date(date_of_birth);
  if (Number.isNaN(dob.getTime())) return { error: "That date of birth isn't a valid date." };
  if (dob < new Date("1950-01-02") || dob > new Date("2029-12-31")) {
    return { error: "That date of birth is outside the range we accept." };
  }
  if (!nationality || !lenOk(nationality, 2, 60)) return { error: "Please enter a nationality." };
  if (!academy_affiliation || !lenOk(academy_affiliation, 2, 120)) {
    return { error: "Please enter an academy or club, or type Independent." };
  }
  if (position && position.length > 40) return { error: "That position is too long." };
  if (!guardian_name || !lenOk(guardian_name, 2, 120)) return { error: "Please enter a parent or guardian name." };
  if (!guardian_phone || !lenOk(guardian_phone, 5, 32)) return { error: "Please enter a parent or guardian phone number." };
  if (!email || !lenOk(email, 5, 160) || !EMAIL_RE.test(email)) return { error: "Please enter a valid email address." };
  if (!phone || !lenOk(phone, 5, 32)) return { error: "Please enter a phone number." };
  if (!tournament_category || !TOURNAMENTS.includes(tournament_category as typeof TOURNAMENTS[number])) {
    return { error: "Please choose a tournament from the list." };
  }

  return {
    row: {
      full_name, date_of_birth, nationality, academy_affiliation, position,
      guardian_name, guardian_phone, email, phone, tournament_category,
    },
  };
}

function validateAcademy(d: Record<string, unknown>): { row?: Record<string, unknown>; error?: string } {
  const academy_name = str(d.academy_name);
  const contact_name = str(d.contact_name);
  const email = str(d.email);
  const phone = str(d.phone);
  const age_category = str(d.age_category);
  const city = str(d.city);
  const notes = str(d.notes);
  const team_size = Number(d.team_size);

  if (!academy_name || !lenOk(academy_name, 2, 140)) return { error: "Please enter the academy or club name." };
  if (!contact_name || !lenOk(contact_name, 2, 120)) return { error: "Please enter a contact person." };
  if (!email || !lenOk(email, 5, 160) || !EMAIL_RE.test(email)) return { error: "Please enter a valid email address." };
  if (!phone || !lenOk(phone, 5, 32)) return { error: "Please enter a phone number." };
  if (!Number.isInteger(team_size) || team_size < 1 || team_size > 60) {
    return { error: "Number of players must be a whole number between 1 and 60." };
  }
  if (!age_category || !TOURNAMENTS.includes(age_category as typeof TOURNAMENTS[number])) {
    return { error: "Please choose a tournament from the list." };
  }
  if (!city || !lenOk(city, 2, 80)) return { error: "Please enter a city." };
  if (notes && notes.length > 2000) return { error: "That note is too long — please keep it under 2000 characters." };

  return { row: { academy_name, contact_name, email, phone, team_size, age_category, city, notes } };
}

// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);

  // The anon key is printed in the page source, so this is a speed bump rather
  // than authentication — it turns away bare scanners that send no headers at
  // all. The real defences are validation, the per-IP rate limit, the honeypot
  // and (once configured) Turnstile.
  //
  // Key formats differ between projects: some expose the legacy anon JWT, some
  // the newer sb_publishable_ key, and the env var names vary with them. So we
  // accept any key the platform tells us about, and fall back to simply
  // requiring that *a* key was presented. Pinning one exact value would make
  // the form break the next time Supabase rotates key formats.
  const presented = req.headers.get("apikey") ??
    (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const accepted = [
    Deno.env.get("SUPABASE_ANON_KEY"),
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY"),
  ].filter((k): k is string => Boolean(k));

  if (!presented) return json({ error: "Unauthorized." }, 401, origin);
  if (accepted.length > 0 && !accepted.includes(presented)) {
    return json({ error: "Unauthorized." }, 401, origin);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Malformed request." }, 400, origin);
  }

  // Honeypot: a real person never fills a field they cannot see. Answer with a
  // plain success so the bot gets no signal that it was caught.
  if (str(payload.company)) {
    return json({ ok: true }, 200, origin);
  }

  const type = str(payload.type);
  if (type !== "player" && type !== "academy") {
    return json({ error: "Unknown registration type." }, 400, origin);
  }

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const { row, error: validationError } = type === "player"
    ? validatePlayer(data)
    : validateAcademy(data);
  if (validationError || !row) return json({ error: validationError }, 400, origin);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  // --- Turnstile, only if a secret has been configured -----------------------
  // Set TURNSTILE_SECRET in the function's env to switch this on; until then
  // the rate limit and honeypot carry the load.
  const turnstileSecret = Deno.env.get("TURNSTILE_SECRET");
  if (turnstileSecret) {
    const token = str(payload.turnstileToken);
    if (!token) return json({ error: "Please complete the verification challenge." }, 400, origin);
    try {
      const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: turnstileSecret, response: token }),
      });
      const result = await verify.json();
      if (!result.success) {
        return json({ error: "Verification failed — please try again." }, 403, origin);
      }
    } catch {
      return json({ error: "Couldn't complete verification — please try again." }, 503, origin);
    }
  }

  // --- Per-IP rate limit -----------------------------------------------------
  // The raw IP is never stored; only a salted hash goes in the ledger.
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0].trim() || "unknown";
  const salt = Deno.env.get("IP_HASH_SALT") ?? "delta-allied-registration";
  const ipHash = await sha256Hex(`${salt}:${ip}`);

  const { data: allowed, error: throttleError } = await admin.rpc("check_submission_throttle", {
    p_ip_hash: ipHash,
    p_limit: RATE_LIMIT,
    p_window_minutes: RATE_WINDOW_MINUTES,
  });

  if (throttleError) {
    console.error("throttle check failed", throttleError);
    return json({ error: "Couldn't process your registration right now." }, 503, origin);
  }
  if (allowed === false) {
    return json(
      { error: "You've submitted several registrations recently. Please try again later, or contact us directly." },
      429,
      origin,
    );
  }

  // --- Insert ----------------------------------------------------------------
  const table = type === "player" ? "player_registrations" : "academy_registrations";
  const { error: insertError } = await admin.from(table).insert(row);

  if (insertError) {
    if (insertError.code === "23505") {
      return json(
        { error: "That email is already registered for this tournament. Contact us if you think that's a mistake." },
        409,
        origin,
      );
    }
    if (insertError.code === "23514") {
      return json({ error: "Some of those details didn't pass our checks. Please review and try again." }, 400, origin);
    }
    console.error("insert failed", insertError);
    return json({ error: "Couldn't save your registration. Please try again shortly." }, 500, origin);
  }

  return json({ ok: true }, 200, origin);
});
