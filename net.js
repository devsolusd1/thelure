/* Which Solana cluster the whole site talks to. Every cluster-specific value lives here and
 * nowhere else: load this file before every other script (it sets window.LURE_NET), or
 * require/import it from Node (it is also the module's export).
 *
 * To switch cluster, change the ONE line marked below. A value left "" is not known yet:
 * pages say "not ready" instead of guessing, and nothing falls back to a public RPC.
 */
(function (root) {
  "use strict";

  /* ======================= THE ONE LINE THAT CHOOSES THE CLUSTER ======================= */
  var DEFAULT = "mainnet"; // "devnet" or "mainnet"
  /* ===================================================================================== */
  // One page view can ask for the other cluster with ?net=devnet, which is how the demos on
  // devnet stay reachable once the site runs on mainnet.
  var asked = root.location && /[?&]net=(devnet|mainnet)(&|$)/.exec(root.location.search || "");
  var CLUSTER = asked ? asked[1] : DEFAULT;

  // 1% per trade, in percent of the trade: what Meteora keeps, then half each of the rest.
  var FEES = { total: 1, creator: 0.4, treasury: 0.4, protocol: 0.2 };

  var CLUSTERS = {
    devnet: {
      cluster: "devnet",
      rpcUrl: "https://api.devnet.solana.com", // public, allows browsers, rate-limited
      explorer: "https://explorer.solana.com",
      explorerSuffix: "?cluster=devnet",
      hookProgram: "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS",
      leashProgram: "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p",
      // Meteora DBC configs, one per curve.
      configs: {
        graduating: "2zJPQ6RG6JGEMHPK8oKS33pPnC6ViZAv3K5u6azsMwDz", // 1 to 20 SOL of market cap, then the hook is removed
        infinite: "6BDwLdwv8hdcvEVVvcxZjCzGFWYEB12BxRbNyWJPXTdG", // never graduates
      },
      fees: FEES,
      // Micro-lamports per compute unit added to every transaction the site builds. 0 = none.
      priorityMicroLamports: 0,
      // Shown when a link names no token or no leash. Optional.
      demo: { mint: "EznRVmRH41iZRe5K3jk9JhLP4rgUqX7VMZsXk8mmWMWt", leash: "6E6i1HrRUeQQ8bkA9VqhNvExzVQxux4ScDN4RB1kjyMY" },
    },

    mainnet: {
      cluster: "mainnet",
      // An RPC URL that carries a provider key and accepts calls from the site. The public
      // api.mainnet-beta.solana.com refuses browsers: never put it here. This key is visible to
      // every visitor by nature: restrict it to the site domain in the provider dashboard.
      rpcUrl: "https://mainnet.helius-rpc.com/?api-key=2ea31dea-8fc1-41e7-bebe-b008a512da0a",
      explorer: "https://explorer.solana.com",
      explorerSuffix: "",
      // Same addresses as devnet: the programs were deployed to mainnet with the same keys.
      hookProgram: "4akkPWLw1imyEhcqAJaHgPPrbDZr6VPaHPifVUV7K5tS",
      leashProgram: "GrojbAndyBXQTo5GxgqXAmDDKjDWkPBPeGniBEQsa89p",
      // Meteora DBC configs, made by programs/examples/make-configs.mjs: a 1% fee, a start at
      // 30 SOL of market cap.
      configs: {
        graduating: "DaVC7DGYA9fPvNy7fFRmMUrh4NFt1pkABBsUZvmxqQY", // graduates at 420 SOL of market cap, then the hook is removed
        infinite: "FUaBd8sb3CBGjDFsws9VFtp1veZFnezoXVv3NHu9XmHi", // never graduates
      },
      fees: FEES,
      // Mainnet blocks are contested: a small tip per compute unit. Change it freely.
      priorityMicroLamports: 20000,
      // Optional: a token and a leash to show when a link names none.
      demo: { mint: "", leash: "" },
    },
  };

  var NET = CLUSTERS[CLUSTER];
  if (!NET) throw new Error('net.js: unknown cluster "' + CLUSTER + '" (use "devnet" or "mainnet")');

  var NAMES = {
    rpcUrl: "an RPC URL",
    hookProgram: "the hook program address",
    leashProgram: "the leash program address",
    "configs.graduating": "the graduating curve's config address",
    "configs.infinite": "the infinite bonding curve's config address",
  };
  var value = function (path) {
    return path.split(".").reduce(function (at, key) { return at && at[key]; }, NET);
  };

  NET.isDevnet = NET.cluster === "devnet";
  // Every required value that is still empty, by its path in this file.
  NET.missing = Object.keys(NAMES).filter(function (path) { return !value(path); });
  NET.ready = NET.missing.length === 0;
  /* "" when everything in `needs` is filled, otherwise one plain sentence saying what is not.
   * `needs` is a list of paths ("rpcUrl", "configs.infinite"; "configs" means both); none = all. */
  NET.notReady = function (needs) {
    var wanted = (needs && needs.length ? needs : Object.keys(NAMES)).reduce(function (all, path) {
      return all.concat(path === "configs" ? ["configs.graduating", "configs.infinite"] : [path]);
    }, []);
    var empty = wanted.filter(function (path) { return NET.missing.indexOf(path) >= 0; });
    if (!empty.length) return "";
    var list = empty.map(function (path) { return NAMES[path]; });
    var words = list.length > 1 ? list.slice(0, -1).join(", ") + " and " + list[list.length - 1] : list[0];
    return "Not ready on " + NET.cluster + ": net.js does not have " + words + " yet.";
  };
  NET.addressUrl = function (address) { return NET.explorer + "/address/" + encodeURIComponent(address) + NET.explorerSuffix; };
  NET.txUrl = function (signature) { return NET.explorer + "/tx/" + encodeURIComponent(signature) + NET.explorerSuffix; };

  root.LURE_NET = NET;
  if (typeof module === "object" && module && module.exports) module.exports = NET;

  /* For a page whose markup is fixed, the script tag itself can say what depends on the cluster:
   *   <script src="net.js" data-devnet-only=".some, .selectors" data-needs="rpcUrl leashProgram" data-status="#where"></script>
   * data-devnet-only: elements hidden unless the cluster is devnet.
   * data-needs + data-status: when a needed value is empty, the status element says so, plainly.
   * It works on the elements above the tag, so the tag goes at the end of the body. */
  var tag = root.document && root.document.currentScript;
  if (tag) {
    var only = tag.getAttribute("data-devnet-only");
    if (only && !NET.isDevnet) {
      Array.prototype.forEach.call(root.document.querySelectorAll(only), function (el) { el.hidden = true; });
    }
    var needs = tag.getAttribute("data-needs");
    var status = tag.getAttribute("data-status") && root.document.querySelector(tag.getAttribute("data-status"));
    var problem = needs ? NET.notReady(needs.split(/\s+/).filter(Boolean)) : "";
    if (problem && status) {
      status.textContent = problem;
      status.classList.add("is-error");
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
