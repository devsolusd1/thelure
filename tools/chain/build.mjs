// Bundles src/index.mjs and everything it needs (Meteora's SDK, web3.js, spl-token) into ONE
// file the site loads with a script tag: ../../vendor/lure-chain.js, which sets window.LureChain
// and is also a CommonJS module (require / import it from Node to test the very file that ships).
//
//   npm install && npm run build
//
// net.js is NOT bundled: the page loads it first, so the cluster can change without a rebuild.

import { build } from "esbuild";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const out = here("../../vendor/lure-chain.js");

await build({
  entryPoints: [here("./src/index.mjs")],
  outfile: out,
  bundle: true,
  format: "iife",
  globalName: "LureChain",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  inject: [here("./src/buffer-shim.mjs")],
  define: { "process.env.NODE_ENV": '"production"', "process.env.ANCHOR_BROWSER": '"true"', global: "globalThis" },
  banner: {
    js: "/* Lure chain layer. BUILT FILE, do not edit: the source is tools/chain/src, rebuilt with `npm run build` in tools/chain. */",
  },
  footer: { js: 'if (typeof module === "object" && module && module.exports) module.exports = LureChain;' },
  plugins: [{
    name: "net-is-loaded-by-the-page",
    setup(b) {
      b.onResolve({ filter: /net\.js$/ }, (args) => (args.importer.endsWith("core.mjs") ? { path: args.path, namespace: "page-loads-it" } : null));
      b.onLoad({ filter: /.*/, namespace: "page-loads-it" }, () => ({ contents: "", loader: "js" }));
    },
  }],
  logLevel: "warning",
});

console.log(`vendor/lure-chain.js  ${(statSync(out).size / 1024).toFixed(0)} KB`);
