# SolveSum ➕

A number-swapping puzzle. Every row has a target on the left and every column a
target on top. Swap neighbouring tiles until a line adds up to its target. Solved
lines score, refill with new numbers and get a new target. Make every swap count.

Live at **[solvesum.tryonlinux.com](https://solvesum.tryonlinux.com)**.

A web rewrite of the original React Native / Expo app (`../solvesum`). No build step,
no dependencies, no framework: static files served by a Cloudflare Worker.

## Playing

| | |
|---|---|
| **Swap** | Tap a tile, then a neighbour (or swipe toward it). Costs 1 swap. |
| **Solve** | A line whose sum equals its target. Worth 10 points. |
| **Combo** | Solve *k* lines with one swap (chains included) for 10 × *k* × *k*. |
| **Hint** | −2 swaps. Plans a full route to a solved line (the best single swap, else the fewest straight slides) and lights it up one pair at a time. Any other swap cancels it. Free if no line can be solved. |
| **Shuffle** | Deals a fresh board. Free, 3 per round. |
| **Swaps** | `10 + 6n` per round (40 on the 5×5 daily). The round ends at zero. |

### Games

- **Daily**: a 5×5 board seeded from the local date, the same for everyone. The first
  finish is the one saved to stats; replays are marked as such.
- **Random**: a board from 2×2 to 10×10 with a shareable code like `K3F9QZ-6`
  (`/?g=K3F9QZ-6`).

Games in progress, settings, stats (daily streaks, best by size, recent rounds) live
in `localStorage` under `solvesum:v1:`. Nothing leaves the browser.

## Changes from the app

- The help text said the game ends when your swaps run out, but the app never had a
  swap limit. This version has one.
- Targets used to be random `1..n²` and often couldn't be reached. Now each target
  is built by pulling 1–4 tiles into the line from lines one or two away, so it can
  always be reached from the board it was dealt with.
- Added: combos and chains, hints, swipe to swap, keyboard play,
  and animations (the original win shake is still there). Also added a daily puzzle,
  shareable game codes, stats, a result card you can share, dark mode and optional
  sound.
- Kept from the app: grid sizes 2–10, tile values `−n²..n²`, green/red tile tint by
  magnitude (toggle in Settings), 3 shuffles, and swaps limited to direct neighbours.

## Layout

```
public/
  index.html          markup, dialogs, meta/OG tags, JSON-LD
  404.html            "doesn't add up" page
  game.js             rules, seeded RNG, hints, rendering, persistence
  style.css           theming (light/dark), board, dialogs
  _headers            CSP and security headers, cache policy
  robots.txt, sitemap.xml, site.webmanifest
  favicon.svg         source icon; apple-touch-icon and icon-192/512 are rendered from it
  og-image.svg/.png   social card source and the 1200×630 PNG that ships
wrangler.jsonc        Cloudflare Worker static-asset config
```

The CSP is `'self'` only, with no `unsafe-inline`. There are no inline scripts,
styles or `style="..."` attributes; dynamic styling goes through
`el.style.setProperty`.

To re-render the PNGs after editing an SVG:

```sh
printf '<body style="margin:0">' > /tmp/og.html && cat public/og-image.svg >> /tmp/og.html
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu \
  --screenshot=public/og-image.png --window-size=1200,630 --hide-scrollbars file:///tmp/og.html
```

## Running it

```sh
npx wrangler dev          # or: python3 -m http.server -d public 8765
```

Opening `public/index.html` directly also works.

## Deploying

```sh
npx wrangler deploy
```

The `routes` entry binds `solvesum.tryonlinux.com` as a custom domain, which requires
`tryonlinux.com` to be an active zone on the same Cloudflare account.

Changing `reachableTarget`, `deal` or the RNG changes every daily board. If you do,
bump `PREFIX` in `game.js` so saved games don't resume onto a different board.
