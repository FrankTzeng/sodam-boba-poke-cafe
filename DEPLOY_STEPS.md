# Deploy the Sodam server version — steps for the parent agent / Frank

Goal: a lasting public URL like `https://sodam-boba-poke-cafe.onrender.com`
that anyone can open in a normal browser, no Muse account, no geo-block.

## What is already done

- The full deploy package is built and tested locally in
  `~/workspace/sodam-server-deploy/`:
  - `server.js` — Node stdlib only (no npm install), serves the site + API
  - `public/index.html` — the approved preview, patched to talk to the server
  - `menu.json` — **80 items, the FIXED Toast menu** (Vanilla Latte Over Ice
    added, Blended Vanilla Latte removed, Coke Zero, Iced Strawberry/Mango
    Matcha, Lavender out of stock)
  - `assets/cans/` — the 3 real can photos (Sprite / Coke / Coke Zero)
  - `tablet-check/` — iPad-size screenshots from the verification run
  - `render.yaml` — Render Blueprint, **free** web service, $0
  - `package.json`, `build.py`, `README.md`, `.gitignore`
  - Local git repo, commits `ae808eb` (v1) + v2 (fixed menu, server fixes,
    tablet checks), no remote yet
- Verified locally (2026-11-14 evening): **API tests 16/16 pass** and
  **tablet checks 28/28 pass** (see README "Verified"). A browser-style
  order (dollar floats, exactly as the page sends) places as S-1001;
  Lavender order rejected; tampered price rejected; staff board requires
  sign-in, shows the order, moves to Preparing; regulars sign-in + favourite
  sync. Full browser order flow verified at 1024×768 landscape and
  768×1024 portrait: no horizontal overflow, all 80 cards, all 76 photos
  load, Lavender OUT OF STOCK, map iframe present. Test data wiped — the
  demo starts with zero orders.
- **Not yet verified on the real public URL** — after deploy, load the URL as
  a stranger would and check: SODAM header + hero render, a menu photo loads,
  place a test pickup order, confirm it appears on the Staff Board, confirm
  the board still asks for sign-in first. Frank should also tap the link
  himself on his iPad before showing the owner (that is his plan).

## What still needs Frank (do NOT do this for him)

Render needs code from a GitHub repo, and both GitHub and Render need a
free account sign-in. No account was created in Frank's name.

1. **GitHub (free account, Frank's own)** — create a repo, e.g.
   `sodam-boba-poke-cafe`, and push this folder to it:
   ```bash
   cd ~/workspace/sodam-server-deploy
   git remote add origin https://github.com/<his-username>/sodam-boba-poke-cafe.git
   git push -u origin main
   ```
   (If the local branch is `master`, push that instead — check `git branch`.)
2. **Render (free account, Frank's own)** — sign in at render.com, then
   **New → Web Service → Build and deploy from a Git repository**, pick the
   repo above. Render reads `render.yaml` in the repo: free plan, build
   command `python3 build.py`, start command `node server.js`. The
   `STAFF_PASSWORD` env var is already set in `render.yaml` to the test
   password `sodam-staff-2026` — the owner picks a real one before going live.
3. Wait for the first deploy (a few minutes), then open the
   `https://<name>.onrender.com` URL Render shows and run the stranger checks
   above. The first load after the service sleeps takes ~30–60s — that is
   normal on the free tier.

## Cost

- **$0 to start** (Render free tier, 750 instance-hours/month, sleeps after
  15 min idle). No card is required for the free tier.
- Do NOT upgrade to Starter ($7/mo) and do NOT buy a domain without Frank's
  explicit approval. A domain later points at this same URL with two CNAME
  records (apex + www) in the registrar's DNS — that step is separate.

## If Render is not an option

- Railway needs a $5/mo minimum (Hobby) — not free. Fly.io is pay-as-you-go
  from ~$2/mo with no free tier for new accounts. Render free is the right
  pick for the demo.
- The Netlify Drop route (already in progress in a separate browser task)
  only hosts the static preview — it cannot run this server version.
