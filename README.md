# Sodam Boba & Poke Cafe — server version, deployable replica

A standalone copy of the Sodam site with a real shared backend, ready to put on
a free public host so Frank can show the owner a plain browser link (no Muse,
no geo-block).

## What it is

- **Frontend** — `public/index.html`, built by `build.py` from the approved
  static preview (`~/workspace/your_files/sodam-boba-poke-cafe/sodam-boba-poke-cafe.html`):
  the designed hero (signature poke bowl, mango boba, onigirazu, triangle
  onigiri), Real Reactions carousel, Signature Highlights, the full **80-item
  fixed menu** (see below) with Toast photos and prices, Visit / Hours with
  an embedded Google Map, pay-at-pickup ordering, Regulars sign-in +
  favourites, Staff Board. All 76 menu photos are inlined as data URIs
  (73 Toast photos + 3 real can photos), so the page is a single ~16 MB file
  with no external assets.
- **Backend** — `server.js` (Node stdlib only, no npm dependencies): serves the
  page and a small JSON API. Orders placed on any phone appear live on the
  Staff Board on every device. Prices are set on the server — the page's
  prices are never trusted (a tampered price is rejected with 400).
- **Menu data** — `menu.json`, **80 items from the FIXED server version**
  (2026-11-14 evening): Vanilla Latte Over Ice $5.45 added, Blended Vanilla
  Latte removed, cans are Sprite / Coke / **Coke Zero** $1.99 each,
  signatures are **Iced Strawberry Matcha / Iced Mango Matcha**, Lavender
  Milk Tea Over Ice out of stock, 10 individual rice balls, no duplicate
  rows or flavour pickers. `build.py` regenerates the page's menu from this
  file, so the page and the server can never drift apart.

## The fixed menu vs the old preview menu

- 80 items (was 71): the collapsed duplicate rows are separate items again
  (7 extra rice balls, Taro/Horchata/Cookies & Cream Blended, Yuzu/Lemon
  Honey Ades, Vanilla Latte, Lavender, Coke, Coke Zero, Iced Strawberry /
  Iced Mango Matcha, Iced Jasmine Green Tea, Loaded nachos).
- **Can photos (indices 73–75)** — Toast publishes no photos for the cans,
  so these three are real product photos found by image search and verified
  by eye (green Sprite can, red Coke can, black Coke Zero can, all on white):
  Sprite is a Toast-hosted photo from another restaurant's Toast menu;
  Coke and Coke Zero are clean product shots from other restaurants' menus.
  Source files in `assets/cans/` (720×720 JPEG on white). The 4 drinks Toast
  has no photo for (Iced Jasmine Green Tea, Strawberry Slush, Mango Smoothie,
  Cookies & Cream Blended) show "Photo coming soon", matching the fixed
  version.
- Lavender Milk Tea Over Ice is **out of stock**: the card shows an
  OUT OF STOCK badge with a disabled button, the item sheet's Add button is
  disabled, and the server rejects an order containing it with 400.
- Visit has an embedded Google Map (address + red pin + Directions), like
  Toast's. The map iframe is present and correctly sized; its tiles could
  not be seen rendering in this VM (the VM's proxy blocks the browser's
  connection to Google Maps) — it should render on a normal connection, and
  Frank should confirm it on his iPad.

## What changed vs the preview

- Orders go to `POST /api/orders`; the server assigns the order number
  (S-1001, S-1002…) and recomputes the total from its own menu.
- Staff Board fetches `GET /api/staff/orders` (Bearer token, 12-hour session)
  and polls every 10 seconds; a new order triggers the banner + chime.
  Status moves go to `POST /api/staff/orders/:id/status`.
- Staff sign-in is checked on the server (`POST /api/staff/login`).
  **The preview's client-side password hash was removed from the page.**
- Regulars sign-in loads favourites + past orders from the server, and
  starring an item syncs to the server, so they follow the phone number to
  any device. Guest checkout is untouched.
- Menu / signature photos use `object-fit: contain` — whole photo, same-size
  frame, never cropped (Frank's v5 fix).
- The "saved on this device only" copy was corrected to match the server.
- **Two server bugs found by browser-level testing and fixed (2026-11-14):**
  1. The page sends `unitPrice` as a dollar float (14.99); the server only
     accepted cents (1499), so every real browser order failed with
     "Price mismatch". The server now accepts both.
  2. The server returned line prices in cents, so the Staff Board rendered
     "$1499.00" for a $14.99 bowl. The API now returns line prices in
     dollars (the order total stays `totalCents`).

## Still pay at pickup only

No online payment, no Stripe, no Toast links. Stripe later plugs into this
same backend (owner opens their own Stripe account, ~2.9% + 30¢/order).

## Test password

Staff Board test password: **`sodam-staff-2026`** — the same one Frank was
given for the Muse server version. The owner must pick a real one before
going live (set the `STAFF_PASSWORD` env var on the host; never put the real
password in this repo). The old preview test password (`sodam123`) does NOT
work here, and its hash is not in this code.

## Verified (2026-11-14, local)

- **API tests, 16/16 pass** (`/tmp/test_api.py`): menu returns 80 items; a
  browser-style order (Vanilla Latte $5.45 + Coke Zero $1.99, sent as dollar
  floats exactly as the page sends them) places as S-1001 for $7.44;
  Lavender order rejected (out of stock); tampered price rejected; staff
  board 401 without token / 401 with wrong password / 200 with the test
  password, order moves to Preparing; regulars sign-in returns the past
  order and a favourite syncs.
- **Tablet checks, 28/28 pass** (`/tmp/tablet_check.py`, headless Chromium):
  iPad landscape 1024×768 and portrait 768×1024 — no horizontal overflow,
  SODAM header + hero render, all 80 menu cards, all 76 photos load after
  scrolling, Iced Strawberry/Mango Matcha signatures, Lavender OUT OF STOCK
  with disabled button, map iframe present and sized. A full browser order
  flow (card tap → item sheet → Add to Order → View order bar → checkout
  form → Place Pickup Order → confirmation ORDER S-1001, $14.99 due at
  pickup) and staff sign-in with the order appearing on the board at $14.99
  were verified in the browser. Screenshots in `tablet-check/`.
- Test data was wiped after every run — the demo starts with zero orders.

## Run it locally

```bash
python3 build.py   # rebuild public/index.html from the preview (if the preview changed)
node server.js     # listens on $PORT (default 3000)
```

## Deploy (free)

See [DEPLOY_STEPS.md](DEPLOY_STEPS.md). Short version: push this folder to a
GitHub repo, connect it to Render with the included `render.yaml` (free web
service, $0), and Render gives a lasting `*.onrender.com` URL. Frank must do
the GitHub / Render sign-in himself — no account was created for him.

## Limits to know before going live

- **Render free tier sleeps after 15 minutes idle** — the first load after a
  sleep takes ~30–60 seconds. Fine for a demo; for a live cafe it wants the
  $7/mo Starter plan (Frank's call, not done).
- **Orders live in `data/db.json` on the server's disk, which is ephemeral on
  the free tier** — a redeploy or host restart wipes the order list. Fine for
  the demo; real live use needs a small hosted database.
- Staff sign-in is one shared password for the whole team, no per-person
  accounts, no SMS ready alerts, no loyalty points — none of that is built.
- Sign-in is name + phone, unverified (anyone can type a phone number).
