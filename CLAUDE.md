# CLAUDE.md

## Project
Delta Allied Sports — a cinematic marketing site for a Dubai-based sports
management/consulting company. Static HTML/CSS/JS, no build step, no
framework. The main page is a single long `index.html`; a few small service
detail pages live under `services/`.

## Structure
- `index.html` — the whole main page: markup, CSS, and JS all inline
- `services/` — four service detail pages (`youth-football.html`,
  `tournament-ops.html`, `digital-gaming.html`, `media-sponsorship.html`),
  linked from the service cards on the main page
- `vendor/` — self-hosted libraries (`gsap.min.js`, `ScrollTrigger.min.js`,
  `three.min.js`, `GLTFLoader.js`)
- `video/` — hero background video (`hero-scroll.mp4`) + `poster.jpg`
- `models/` — GLB models: `ball.glb` (closing scene) and `football.glb`,
  `basketball.glb`, `camera.glb`, `trophy.glb` (performance-section waypoints)
- `audio/` — one background track per theme (`dark-theme.mp3`,
  `light-theme.mp3`)
- `images/` — logo/favicon, service card photos, partner logos
- `vercel.json` — security response headers only (no build config)

## Stack
- No build tools, no npm, no bundler
- GSAP + ScrollTrigger for scroll-driven animations — **self-hosted in
  `vendor/`, not CDN**. Keep it that way; don't swap back to CDN script tags
- Three.js r128 + GLTFLoader, also self-hosted in `vendor/`, for the pinned
  performance/tunnel section and the closing wave/particle scene
- Uses `data-theme="light"` on `<html>` for the light/dark toggle — CSS
  custom properties in `:root` and `[data-theme="light"]` drive both palettes.
  An inline script in `<head>` applies the saved theme before first paint;
  don't move it or the page will flash
- Contact form posts to a live Formspree endpoint (see `FORMSPREE_ENDPOINT`
  in `index.html`) — no backend of our own

## Page sections (top to bottom)
Entrance gate (canvas, click-to-enter, remembered per session via
`sessionStorage`, also unlocks video/audio autoplay) → nav with theme + sound
toggles → scroll-scrubbed hero video → pinned Three.js "Performance Engine"
with four stages → services cards → sectors + hand-authored SVG GCC map →
partners marquee → Three.js athlete finale → footer.

## Conventions
- Keep the main page in one `index.html` — do not split its CSS/JS into
  separate files unless explicitly asked. The `services/` pages are the one
  intentional exception to the single-file rule
- GLB models are in use (see `models/`), loaded through the vendored
  GLTFLoader. They need explicit per-model light rigs and orientation fixes —
  we've had trouble here before, so when adding or swapping one, check it in
  both themes before finishing
- Three.js r128 defaults to linear output; GLB models are authored for sRGB.
  The renderer's output encoding is set deliberately — don't change it
- Every scroll-driven Three.js section must: (1) lazy-load via
  IntersectionObserver, (2) pause its render loop when scrolled off-screen,
  (3) have a lighter/disabled path for mobile and `prefers-reduced-motion`
- Brand accent color is red (`--color-electric`) in both themes — never
  changes between light/dark
- When editing 3D scene code, check for dangling variable references before
  finishing — removing an object (e.g. particles, lights) without removing
  every reference to it in the animate loop will throw a runtime error and
  silently break the whole scene

## Commands
No build/test commands. Preview with a local server — opening `index.html`
straight off the filesystem does not work any more, because `file://` blocks
the GLB fetches and the 3D scenes come up empty:
```
python3 -m http.server 8000
```

## Deployment
GitHub → Vercel auto-deploy is already connected. Pushing to `main` deploys
automatically. No manual Vercel steps needed once committed.

## Avoid
- Don't reintroduce a single-file base64-embedded version as the default —
  the folder structure (separate video/models/audio/vendor files) is the
  production version; base64-embedding everything is only for one-off
  "download and double-click" shares, not for git/deployment
