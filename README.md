# Lure

**The hook pays you.** Landing page for Lure, a Solana launchpad where Token-2022 transfer hooks run games, reward holders and pay creators, on Meteora bonding curves.

Plain HTML, CSS and JavaScript. No build step, no dependencies.

## Run locally

```bash
node dev-server.mjs
```

Then open http://localhost:5173.

## Deploy

Any static host works. On Vercel or Netlify, import the repo with no build command and the repo root as the output folder.

## Structure

| Path | What it is |
|---|---|
| `index.html` | Page markup. The logo is one inline SVG path, reused everywhere with `<use href="#lure-path">`. |
| `styles.css` | Styles. Palette tokens sit at the top (black and `#FD4B00`, taken from the logo). |
| `main.js` | Hero animation, simulated event ticker, hook catalog, Last Buyer Wins demo, rule-builder examples. |
| `assets/` | Logo (SVG, PNG, transparent PNG) and icons. |
| `dev-server.mjs` | Tiny static server for local preview. |

Everything on the page marked "simulated" or "in development" is a demo; no hook is live yet.
