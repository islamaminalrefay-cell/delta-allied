# supabase/tournament-app

Functions in this folder belong to the **`delta-tournament`** Supabase project
(ref `ejcokxagxtyjymdiepjr`) — the backend for the tournament app.

Everything in `supabase/` *outside* this folder belongs to a different project:
**`delta-registrations`** (ref `omijppvwphqbuozqxliq`), which backs this
website's tournament sign-up form. The two projects deliberately share no
schema, no data and no credentials.

They are kept apart in this repo because deploying a function to the wrong
project is an easy and damaging mistake: `delete-account` reads `people`,
`tournaments` and `digital_ids`, none of which exist in `delta-registrations`.

## Deploying

```
supabase functions deploy delete-account --project-ref ejcokxagxtyjymdiepjr
```

## Why the tournament app's code is not here

Only the server-side pieces are. The app itself lives in its own repository;
this folder holds the Edge Functions because they are deployed infrastructure
rather than app code, and because `delete-account` is paired with
`delete-account.html` on this site, which is the public deletion-request URL
Google Play requires in the Data safety form.
