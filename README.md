# Lure

**Every coin needs a hook.** Lure is a Solana launchpad for tokens with rules built in: Token-2022 transfer hooks that run games and guards on every transfer, and AI agents that can only act inside an on-chain leash. Tokens trade on Meteora bonding curves.

This repo holds two things:

- **The site**, at the repo root: plain HTML, CSS and JavaScript, with no build step and no dependencies.
- **The on-chain programs**, in [`programs/`](programs/README.md). The leash limits what a token's AI agent can do; the hook checks every transfer of a token.

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
| `index.html` | Landing page: five screens beside the logo, which hangs from the top of the window as a rig. The logo is inline SVG, split into its parts (line, knot, hook, tie, fish) and reused whole with `<use href="#lure-path">`. |
| `tokens.html` | Token board: trending, new, biggest pots, about to graduate, graduated. Demo data. |
| `launch.html` | Launch form: token, hooks and their settings, curve, fees, dev buy, live preview. Preview only. |
| `app.js` | Shared by every page: the fee split (`FEES`), the hook catalog, token cards, rule highlighting. |
| `styles.css` | Base styles. Palette tokens sit at the top (black and `#FD4B00`, taken from the logo). |
| `app.css` | Styles for the board and the launch form. |
| `main.js` | The landing: the rig (springs for the line, the swing and the bait), and the replays of real devnet runs. |
| `tokens.js`, `launch.js` | Scripts of the board and the launch form. |
| `assets/` | Logo (SVG, PNG, transparent PNG), the hook on its own, and icons. |
| `dev-server.mjs` | Tiny static server for local preview. |
| `programs/` | On-chain programs and their tests. Not part of the site. |

The landing shows only things that happened: its buttons replay real devnet transactions and link to them. The board and the launch form are still demos, and say so. The leash and the first hook (a cap per wallet) are live on devnet only.
