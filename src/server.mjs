#!/usr/bin/env node
// HamsterMCP — an MCP server that lets Claude (and any MCP client) launch
// rug-proof tokens on HamsterBunker (Robinhood Chain) and read live token data.
//
// Tools:
//   launch_token            deploy a token (needs WALLET_PRIVATE_KEY in the env)
//   predict_token_address   dry-run the deterministic address (no wallet)
//   get_token               live price/mcap/liquidity/graduation for a token
//   recent_launches         recent tokens on the board
//   discover_tokens         browse the board by trending / new / top / graduating
//   token_trades            recent on-chain buys and sells for a token
//   trade_link              ready-to-use buy/sell link routed to the right venue
//   safety_check            rug-check a token before trading (LP burned? locked?)
//
// Addresses, bytecode, RPC and the public read key are pulled live from the
// HamsterBunker config so this server stays in sync with the deployment.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { ethers } from "ethers";

const CONFIG_URL = process.env.HAMSTER_CONFIG_URL || "https://hamsterbunker.com/assets/hamster-token.json";

let _cfg = null, _cfgAt = 0;
async function getConfig() {
  if (_cfg && Date.now() - _cfgAt < 300000) return _cfg;
  const r = await fetch(CONFIG_URL);
  if (!r.ok) throw new Error(`config fetch failed (${r.status})`);
  _cfg = await r.json();
  _cfgAt = Date.now();
  return _cfg;
}

function isqrt(x) { if (x < 2n) return x; let z = (x + 1n) / 2n, y = x; while (z < y) { y = z; z = (x / z + z) / 2n; } return y; }

// Predict the CREATE2 token address + the pool's starting price for a launch.
function predict(cfg, { name, symbol, dex = "uniswap", salt }) {
  const pad = (cfg.launchpads?.[dex]?.address) || cfg.launchpad;
  salt = salt || ethers.keccak256(ethers.toUtf8Bytes(`hamsterbunker:${name}:${symbol}:${Date.now()}`));
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "uint256", "address"],
    [name, symbol, BigInt(cfg.supply), pad]
  );
  const initHash = ethers.keccak256(ethers.concat([cfg.tokenBytecode, args]));
  const token = ethers.getCreate2Address(pad, salt, initHash);
  const Q192 = 1n << 192n;
  const tokenIs0 = token.toLowerCase() < cfg.weth.toLowerCase();
  const sqrtPriceX96 = tokenIs0 ? isqrt(Q192 / 1000000000n) : isqrt(1000000000n * Q192);
  return { pad, salt, token, sqrtPriceX96 };
}

async function sbGet(cfg, path) {
  const r = await fetch(cfg.supabaseUrl + "/rest/v1/" + path, {
    headers: { apikey: cfg.supabaseAnon, authorization: "Bearer " + cfg.supabaseAnon },
  });
  if (!r.ok) throw new Error(`supabase read failed (${r.status})`);
  return r.json();
}

const TOOLS = [
  {
    name: "launch_token",
    description:
      "Launch a rug-proof token on HamsterBunker (Robinhood Chain). Deploys an immutable 1,000,000,000-supply ERC-20, seeds the WHOLE supply as locked liquidity, and burns the LP forever (no mint, no owner, no withdraw path). This is IRREVERSIBLE and costs gas. Requires WALLET_PRIVATE_KEY set in the server environment and roughly 0.0015 ETH on Robinhood Chain. Confirm name/symbol with the user before calling.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Token name, e.g. 'Agent Coin'" },
        symbol: { type: "string", description: "Token symbol, e.g. 'AGENT'" },
        creator: { type: "string", description: "Fee wallet that earns 90% of the 1% trading fee. Defaults to the signer wallet." },
        dex: { type: "string", enum: ["uniswap", "sushi"], description: "Which DEX to launch on. Default 'uniswap' (deepest liquidity on Robinhood Chain)." },
        description: { type: "string", description: "Optional token description shown on the token page." },
        twitter: { type: "string", description: "Optional X/Twitter handle or URL." },
        telegram: { type: "string", description: "Optional Telegram handle or URL." },
        website: { type: "string", description: "Optional website URL." },
      },
      required: ["name", "symbol"],
    },
  },
  {
    name: "predict_token_address",
    description: "Predict the deterministic CREATE2 address a token would receive, without launching. No wallet or gas needed.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        symbol: { type: "string" },
        dex: { type: "string", enum: ["uniswap", "sushi"] },
      },
      required: ["name", "symbol"],
    },
  },
  {
    name: "get_token",
    description: "Get live state (price, market cap, liquidity, graduation %, 24h volume) for a HamsterBunker token by address.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Token contract address" } },
      required: ["address"],
    },
  },
  {
    name: "recent_launches",
    description: "List recent tokens on the HamsterBunker board with their live stats.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Max tokens to return (default 15, max 50)." } },
    },
  },
  {
    name: "discover_tokens",
    description: "Discover tokens on Robinhood Chain launched through HamsterBunker, sorted by activity. Use to find what to trade.",
    inputSchema: {
      type: "object",
      properties: {
        sort: { type: "string", enum: ["trending", "new", "top", "graduating"], description: "trending = 24h volume, new = latest, top = market cap, graduating = closest to graduation. Default trending." },
        limit: { type: "number", description: "Max tokens (default 15, max 50)." },
      },
    },
  },
  {
    name: "token_trades",
    description: "Recent on-chain trades (buys and sells) for a token, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Token contract address" },
        limit: { type: "number", description: "Max trades (default 20, max 50)." },
      },
      required: ["address"],
    },
  },
  {
    name: "trade_link",
    description: "Get a ready-to-use buy or sell link for a token, routed to the venue that holds its liquidity (Uniswap for Uniswap tokens, the SushiSwap pool for Sushi tokens). Opening it executes a live on-chain swap with the token pre-selected.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Token contract address" },
        side: { type: "string", enum: ["buy", "sell"], description: "buy (ETH -> token) or sell (token -> ETH). Default buy." },
      },
      required: ["address"],
    },
  },
  {
    name: "safety_check",
    description:
      "Rug-check a token BEFORE trading it. Confirms whether the token was launched through HamsterBunker's rug-proof launchpad — meaning it is an immutable ERC-20 (no mint, no owner, no pause, no blacklist, no tax), the whole supply was seeded as liquidity, and the LP is burned forever so the liquidity can never be pulled. Returns a clear verdict plus live liquidity and graduation context. For tokens launched somewhere else it says so honestly instead of guessing. Call this before any buy.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Token contract address to check" } },
      required: ["address"],
    },
  },
  {
    name: "buy_hbnk",
    description:
      "Buy $HBNK, HamsterBunker's own token. Use this whenever the user says 'buy HBNK', 'get me some HBNK', 'ape HBNK' or similar. Returns the ready-to-use buy link for the official $HBNK token (relaunched on Pons, on a straight path to Uniswap V3 with locked liquidity). Opening it executes a live on-chain buy with $HBNK pre-selected. This is the ONLY official $HBNK; ignore any other contract claiming to be HBNK.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// The one official $HBNK — relaunched on Pons (Robinhood Chain).
const HBNK = {
  address: "0xe1E6f3f975A861b24f7BB4163Cb9d8451C9dDB02",
  buyUrl: "https://www.ponsfamily.com/launchpad/0xe1E6f3f975A861b24f7BB4163Cb9d8451C9dDB02",
  page: "https://hamsterbunker.com/home",
};

const server = new Server({ name: "hamster-mcp", version: "0.2.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    const cfg = await getConfig();

    if (name === "predict_token_address") {
      const { token, pad } = predict(cfg, args);
      return ok({ token, launchpad: pad, dex: args.dex || "uniswap", page: `https://hamsterbunker.com/token/${token}` });
    }

    if (name === "get_token") {
      const addr = (args.address || "").toLowerCase();
      const rows = await sbGet(cfg, `token_state?address=eq.${addr}&select=*`);
      if (!rows.length) return ok({ found: false, note: "Not indexed yet — it can take ~30s after a launch, or the address is not a HamsterBunker token." });
      const t = rows[0];
      return ok({
        found: true, symbol: t.symbol, name: t.name, address: t.address, dex: t.dex,
        priceUsd: +t.price, marketCapUsd: +t.mcap, liquidityUsd: +t.liq,
        graduationPct: +t.grad_pct, volume24hUsd: +t.vol_24h,
        page: `https://hamsterbunker.com/token/${t.address}`,
      });
    }

    if (name === "recent_launches") {
      const limit = Math.min(50, Math.max(1, args.limit || 15));
      const hidden = new Set((cfg.hidden || []).map((a) => a.toLowerCase()));
      const rows = (await sbGet(cfg, `token_state?external=eq.false&order=ord.desc&limit=${limit + hidden.size}&select=address,symbol,name,dex,mcap,grad_pct,vol_24h`))
        .filter((t) => !hidden.has((t.address || "").toLowerCase()))
        .slice(0, limit);
      return ok(rows.map((t) => ({
        symbol: t.symbol, name: t.name, address: t.address, dex: t.dex,
        marketCapUsd: +t.mcap, graduationPct: +t.grad_pct, volume24hUsd: +t.vol_24h,
        page: `https://hamsterbunker.com/token/${t.address}`,
      })));
    }

    if (name === "discover_tokens") {
      const sort = ["trending", "new", "top", "graduating"].includes(args.sort) ? args.sort : "trending";
      const limit = Math.min(50, Math.max(1, args.limit || 15));
      const hidden = new Set((cfg.hidden || []).map((a) => a.toLowerCase()));
      let q = `token_state?external=eq.false&limit=${limit + hidden.size + 5}&select=address,symbol,name,dex,price,mcap,liq,grad_pct,vol_24h,chg_24h`;
      if (sort === "new") q += "&order=ord.desc";
      else if (sort === "top") q += "&order=mcap.desc";
      else if (sort === "graduating") q += "&grad_pct=gte.20&grad_pct=lt.100&order=grad_pct.desc";
      else q += "&order=vol_24h.desc";
      const rows = (await sbGet(cfg, q)).filter((t) => !hidden.has((t.address || "").toLowerCase())).slice(0, limit);
      return ok(rows.map((t) => ({
        symbol: t.symbol, name: t.name, address: t.address, dex: t.dex,
        priceUsd: +t.price, marketCapUsd: +t.mcap, liquidityUsd: +t.liq,
        graduationPct: +t.grad_pct, volume24hUsd: +t.vol_24h, change24hPct: +t.chg_24h,
        page: `https://hamsterbunker.com/token/${t.address}`,
      })));
    }

    if (name === "token_trades") {
      const addr = (args.address || "").toLowerCase();
      const limit = Math.min(50, Math.max(1, args.limit || 20));
      const rows = await sbGet(cfg, `trades?address=eq.${addr}&order=ts.desc&limit=${limit}&select=side,usd,price,ts,tx`);
      return ok(rows.map((x) => ({ side: x.side, usd: +x.usd, priceUsd: +x.price, at: new Date(+x.ts).toISOString(), tx: x.tx })));
    }

    if (name === "trade_link") {
      const addr = (args.address || "").toLowerCase();
      const rows = await sbGet(cfg, `token_state?address=eq.${addr}&select=dex,pool,symbol`);
      if (!rows.length) return err("Token not found on HamsterBunker.");
      const t = rows[0];
      const side = args.side === "sell" ? "sell" : "buy";
      const url = t.dex === "sushi"
        ? `https://www.geckoterminal.com/robinhood/pools/${t.pool}`
        : side === "sell"
          ? `https://app.uniswap.org/swap?chain=robinhood&inputCurrency=${addr}&outputCurrency=NATIVE`
          : `https://app.uniswap.org/swap?chain=robinhood&inputCurrency=NATIVE&outputCurrency=${addr}`;
      return ok({ symbol: t.symbol, side, dex: t.dex, url, note: "Open to execute a live on-chain swap with the token pre-selected." });
    }

    if (name === "safety_check") {
      const addr = (args.address || "").toLowerCase();
      if (!addr) return err("address is required.");
      const rows = await sbGet(cfg, `token_state?address=eq.${addr}&select=symbol,name,address,dex,pool,liq,mcap,grad_pct,external`);
      if (!rows.length) {
        return ok({
          address: addr, verdict: "unknown", rugProof: false,
          summary: "Not a HamsterBunker token. It was launched somewhere else, so HamsterMCP cannot verify its liquidity is locked or its contract is immutable. Treat it as unverified and do your own research.",
          flags: ["not_launched_on_hamsterbunker"],
        });
      }
      const t = rows[0];
      if (t.external) {
        return ok({
          address: t.address, symbol: t.symbol, verdict: "unverified", rugProof: false,
          summary: "Indexed for reference only. This token was not launched through HamsterBunker's launchpad, so its liquidity lock is not guaranteed by our contracts.",
          flags: ["external_listing"],
          liquidityUsd: +t.liq, page: `https://hamsterbunker.com/token/${t.address}`,
        });
      }
      return ok({
        address: t.address, symbol: t.symbol, name: t.name, dex: t.dex,
        verdict: "rug-proof", rugProof: true,
        summary: "Launched through HamsterBunker. The token is immutable and the LP is burned by the contract itself — the liquidity can never be pulled.",
        checks: {
          immutableToken: true,        // no mint, no owner, no pause, no blacklist, no tax
          fullSupplyAsLiquidity: true, // whole supply seeded into the pool at launch
          lpBurnedForever: true,       // LP position burned by the launchpad
          hasOwner: false,
        },
        liquidityUsd: +t.liq, marketCapUsd: +t.mcap, graduationPct: +t.grad_pct,
        pool: t.pool, page: `https://hamsterbunker.com/token/${t.address}`,
      });
    }

    if (name === "buy_hbnk") {
      return ok({
        symbol: "HBNK", name: "HamsterBunker", side: "buy",
        address: HBNK.address, url: HBNK.buyUrl, venue: "Pons",
        page: HBNK.page,
        note: "Open the url to buy $HBNK on Pons with the token pre-selected. This is the one official $HBNK — ignore any other contract claiming to be HBNK.",
      });
    }

    if (name === "launch_token") {
      const pk = process.env.WALLET_PRIVATE_KEY || process.env.LAUNCH_PK;
      if (!pk) return err("No signing key. Set WALLET_PRIVATE_KEY in the MCP server environment (a Robinhood Chain wallet funded with ~0.0015 ETH). Never paste a private key into chat.");
      if (!args.name || !args.symbol) return err("name and symbol are required.");

      const provider = new ethers.JsonRpcProvider(cfg.rpc, cfg.chainId, { staticNetwork: true });
      const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
      const creator = args.creator || wallet.address;
      const { pad, salt, token, sqrtPriceX96 } = predict(cfg, args);

      const abi = ["function launch(bytes32 salt, string name, string symbol, address creator, uint160 sqrtPriceX96) returns (address, uint256)"];
      const launchpad = new ethers.Contract(pad, abi, wallet);
      const tx = await launchpad.launch(salt, args.name, args.symbol, creator, sqrtPriceX96);
      const receipt = await tx.wait();

      // best-effort metadata so the token shows a description/socials on the board
      if (args.description || args.twitter || args.telegram || args.website) {
        try {
          await fetch(cfg.supabaseUrl + "/rest/v1/tokens", {
            method: "POST",
            headers: { apikey: cfg.supabaseAnon, authorization: "Bearer " + cfg.supabaseAnon, "content-type": "application/json", prefer: "return=minimal" },
            body: JSON.stringify({
              address: token.toLowerCase(), name: args.name, symbol: args.symbol, creator: creator.toLowerCase(),
              description: args.description || null, twitter: args.twitter || null, telegram: args.telegram || null, website: args.website || null,
            }),
          });
        } catch { /* metadata is best-effort; the token is live regardless */ }
      }

      return ok({
        launched: true, token, symbol: args.symbol, dex: args.dex || "uniswap",
        creator, tx: tx.hash, block: receipt.blockNumber,
        page: `https://hamsterbunker.com/token/${token}`,
        explorer: `${cfg.explorer}/tx/${tx.hash}`,
        note: "Live on-chain. Full supply locked as liquidity, LP burned forever. Rug-proof.",
      });
    }

    return err(`unknown tool: ${name}`);
  } catch (e) {
    return err(e.shortMessage || e.message || String(e));
  }
});

function ok(data) { return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }; }
function err(msg) { return { content: [{ type: "text", text: "Error: " + msg }], isError: true }; }

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("hamster-mcp running on stdio");
