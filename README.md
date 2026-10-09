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
| `tokens.html` | Token board: every token launched under the two Lure configs, read from the chain. |
| `token.html` | One token: its game live, buy and sell with a wallet, pay the winner, its rules. |
| `launch.html` | Launch form: builds and sends a real launch (token, the three live rules, an agent on a leash, the curve, a first buy). |
| `agent.html` | The leash page: what a token's agent may do, simulated attempts to break it, what it did. |
| `net.js` | The one file that says which cluster the site talks to, with its RPC, program and config addresses. `?net=devnet` on a page asks for devnet for that view. |
| `vendor/lure-chain.js` | The chain layer the pages use, built from `tools/chain` (`npm run build` there). |
| `app.js` | Shared by every page: the fee split (`FEES`), the hook catalog, token cards, rule highlighting. |
| `styles.css` | Base styles. Palette tokens sit at the top (black and `#FD4B00`, taken from the logo). |
| `app.css` | Styles for the board and the launch form. |
| `main.js` | The landing: the rig (springs for the line, the swing and the bait), and the replays of real devnet runs. |
| `tokens.js`, `launch.js` | Scripts of the board and the launch form. |
| `assets/` | Logo (SVG, PNG, transparent PNG), the hook on its own, and icons. |
| `dev-server.mjs` | Tiny static server for local preview. |
| `programs/` | On-chain programs and their tests. Not part of the site. |

The site runs on mainnet. The landing shows only things that happened: its buttons replay real devnet transactions and link to them. The programs are not audited and still upgradeable.
