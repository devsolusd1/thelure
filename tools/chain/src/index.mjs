/* The chain layer of the Lure site.
 *
 * Browser:  <script src="net.js"></script><script src="vendor/lure-chain.js"></script>  ->  window.LureChain
 * Node:     import * as LureChain from "./tools/chain/src/index.mjs"   (loads ../../net.js itself)
 * Rebuild:  cd tools/chain && npm install && npm run build              (writes vendor/lure-chain.js)
 *
 * Nothing here knows which cluster it is on: the RPC URL, the two program addresses, the two
 * curve configs, the fee split and the explorer links all come from net.js (LURE_NET). A call
 * that needs a value net.js leaves empty throws LureError("not-ready") with a plain sentence.
 * Amounts go in and out in SOL and in whole tokens (numbers, or decimal strings for exactness);
 * the "…Raw" fields are the same amounts in lamports or base units, as strings.
 *
 * ============================== THE SURFACE ==============================
 *
 * READING (each answer is kept a few seconds: call as often as you like)
 *   readToken(mint, { maxAge = 4000 }?)  -> Token       one RPC call
 *   listTokens({ maxAge = 10000 }?)      -> Token[]     every token under the two Lure configs, newest first
 *   readWallet(owner, mint, { maxAge = 3000 }?) -> { address, sol, tokens, tokensRaw, tokenAccount, hasTokenAccount }
 *   metadataFromUri(uri)                 -> { description, image }   from a data: URI, no network
 *   programStatus("hook" | "leash")      -> { address, upgradeable (null = unknown), authority }   read once
 *
 *   Token = {
 *     mint, name, symbol, decimals, uri, description, image, supply,
 *     pool, config, curve: "infinite" | "graduating", creator, createdSlot,
 *     price (SOL per token), marketCap (SOL), solInCurve (SOL), supplyLeft (0..1 of supply still in the curve),
 *     progress (0..1 towards graduation, null on infinite), graduation ({ sol, marketCap } or null),
 *     graduated, hooked (the mint still names the Lure hook),
 *     rules: null | {
 *       address, version, curveOk, transfers,
 *       cap:        null | { tokens, share, fromLeash },
 *       blockLimit: null | { tokens, share, guardSlots, forever, up, opened, slotsLeft, boughtThisBlock },
 *       game:       null | { pot (SOL), phase: "guard" | "waiting" | "running" | "over", deadline (unix s, 0 = none),
 *                            endsIn (s), round, lastBuyer, lastWinner, lastPrize (SOL), totalPaid (SOL),
 *                            minBuy (tokens), clock (s a buy puts on it), clockFromLeash, clockRange ({ min, max } | null) },
 *     },
 *     leash (address | null), agent (address | null),
 *     slot, chainTime (unix s), readAt (ms), clockSkew (s: chain time minus this device's),
 *   }
 *   In listTokens, numbers that live in a leash (a clock or a cap the agent sets) are null.
 *
 * QUOTE
 *   quote({ mint, side: "buy" | "sell", amount, slippageBps = 100, owner? }) -> Quote
 *     amount: SOL to pay for a buy, tokens to sell for a sell.
 *   Quote = { side, mint, symbol, amountIn, out, minOut, fee (SOL), feePct, price, priceAfter, partial, slippageBps,
 *             amountInRaw, outRaw, minOutRaw, feeRaw,
 *             checks: [{ id: "balance" | "cap" | "block" | "game" | "sell", by: "wallet" | "hook", ok, text, code?, plays? }],
 *             refusal (the first check that fails, or null) }
 *
 * BUILDING (unsigned, fee payer and recent blockhash set; nothing is sent)
 *   buildBuy({ mint, owner, sol, slippageBps = 100 })      -> Built   (+ quote)
 *   buildSell({ mint, owner, tokens, slippageBps = 100 })  -> Built   (+ quote)
 *   buildSettle({ mint, payer })                           -> Built   (+ winner, pot, round)
 *   buildLaunch({
 *     creator, name, symbol, description?, image?, uri?,   // uri overrides the data: URI built from the rest
 *     curve: "infinite" | "graduating",
 *     rules: { maxWalletPct?, blockLimitPct?, guardSlots?,           // percent of supply; 0 or absent = off
 *              game?: { minBuyPct, timerSeconds } },                 // timerSeconds is ignored when an agent sets the clock
 *     agent?: { key, clock: { value, min, max, step, cooldown },    // seconds; the leash's dial 0 is the game clock
 *               maxPerSpend, maxPerDay, budget, feeMoney (SOL), locked?, destinations? },
 *     firstBuy?: { sol, slippageBps = 100 },
 *   }) -> Built   (+ mint, pool, rules, list, leash, config, curve, uri, agent, firstBuy, spends)
 *       transactions, in order: "Leash and rules" | "Rules", "Token, curve and first buy" | "Token and curve"
 *       (+ "First buy" when it does not fit beside the pool), "Agent's budget". The new mint's signature is already on.
 *   planRules({ rules, agent })  -> the numbers init takes; throws LureError("bad-launch") where the hook would say BadConfig
 *   metadataUri({ name, symbol, description, image }, maxBytes = 200) -> "data:application/json,…"
 *
 *   Built = { kind, feePayer, blockhash, lastValidBlockHeight, builtAt, tx (the first), transactions: [{ label, tx, signers }] }
 *
 * SENDING
 *   simulate(builtOrTx, { all = false }?) -> { label, ok, refusal, units, logs, payerAfter, slot, bytes }  (a list with all)
 *   send(builtOrTx, wallet, { onStep }?)  -> { signatures, signature, slot }
 *     simulates, asks the wallet to sign (once, for all), sends each through the connection of net.js and
 *     waits for it to confirm. onStep({ index, count, label, phase, signature }).
 *     Throws LureError: "refused" (.refusal, .signatures landed so far), "rejected", "expired", "wallet", "network", "rate".
 *   explain(err, logs) -> Refusal = { by: "hook" | "leash" | "curve" | "wallet" | "network" | "other", program, code, name, text }
 *   refusalText(refusal) -> "The hook refused it: … (OverMaxPerWallet, 6000)"
 *
 * WALLETS (Phantom, Solflare, Backpack, as injected)
 *   wallets.list()            -> [{ id, name, installed, url }]
 *   wallets.connect(id?, { silent }?) -> Wallet      remembers the choice for the session
 *   wallets.disconnect()
 *   wallets.restore()         -> Wallet | null       the session's wallet, without a prompt
 *   wallets.current()         -> Wallet | null       { id, name, address, signTransaction, signAllTransactions }
 *   wallets.on(listener)      -> stop()              listener(wallet | null) on every change
 *   wallets.button(element)   the nav strip's control, on <span class="tk-wallet"><button data-wallet>…</button></span>
 *
 * THE REST
 *   net()                     the block of net.js in use         connection()   the site's web3.js Connection
 *   rulesAddress(mint), listAddress(mint), leashAddress(mint, creator) -> [PublicKey, bump]
 *   poolAuthority(), isAddress(text), forget(prefix?), clockWords(seconds), LureError, HOOK_ERRORS, LEASH_ERRORS
 * ========================================================================= */

export { connection, forget, isAddress, leashAddress, listAddress, LureError, net, poolAuthority, rulesAddress } from "./core.mjs";
export { listTokens, metadataFromUri, programStatus, readToken, readWallet } from "./read.mjs";
export { buildBuy, buildSell, buildSettle, clockWords, quote } from "./trade.mjs";
export { buildLaunch, metadataUri, planRules } from "./launch.mjs";
export { explain, HOOK_ERRORS, LEASH_ERRORS, refusalText, send, simulate } from "./send.mjs";
export * as wallets from "./wallets.mjs";
