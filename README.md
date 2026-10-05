# Lure

**The hook pays you.** Lure is a Solana launchpad where Token-2022 transfer hooks run games, reward holders and pay creators, on Meteora bonding curves.

This repo holds two things:

- **The site**, at the repo root: plain HTML, CSS and JavaScript, with no build step and no dependencies.
- **The on-chain programs**, in [`programs/`](programs/README.md). So far that is the leash, which limits what a token's AI agent can do.

## Run the site locally

```bash
node dev-server.mjs
```

Then open http://localhost:5173.

## Deploy the site

Any static host works. On Vercel or Netlify, import the repo with no build command and the repo root as the output folder.

## Structure

| Path | What it is |
|---|---|
| `index.html` | Landing page. The logo is one inline SVG path, reused everywhere with `<use href="#lure-path">`. |
| `tokens.html` | Token board: trending, new, biggest pots, about to graduate, graduated. Demo data. |
| `launch.html` | Launch form: token, hooks and their settings, curve, fees, dev buy, live preview. Preview only. |
| `app.js` | Shared by every page: the fee split (`FEES`), the hook catalog, token cards, rule highlighting. |
| `styles.css` | Base styles. Palette tokens sit at the top (black and `#FD4B00`, taken from the logo). |
| `app.css` | Styles for the board and the launch form. |
| `main.js`, `tokens.js`, `launch.js` | Page scripts. |
| `assets/` | Logo (SVG, PNG, transparent PNG) and icons. |
| `dev-server.mjs` | Tiny static server for local preview. |
| `programs/` | On-chain programs and their tests. Not part of the site. |

Everything on the page marked "simulated" or "in development" is a demo; no hook is live yet.
