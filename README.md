# 🐹 HamsterMCP

An [MCP](https://modelcontextprotocol.io) server that lets **Claude** (and any MCP
client) launch rug-proof tokens on [HamsterBunker](https://hamsterbunker.com) —
the launchpad on Robinhood Chain — and read live token data.

Just tell Claude:

> launch me a token called Agent Coin, symbol AGENT

and it deploys an immutable 1B-supply token, seeds the whole supply as locked
liquidity, and burns the LP forever. One call, on-chain, rug-proof.

## Tools

| Tool | What | Needs a key |
| --- | --- | --- |
| `launch_token` | Deploy a token (immutable, full supply locked, LP burned) | ✅ |
| `predict_token_address` | Dry-run the deterministic token address | — |
| `get_token` | Live price / mcap / liquidity / graduation for a token | — |
| `discover_tokens` | Discover tokens by trending / new / top / graduating | — |
| `recent_launches` | Recent tokens on the board | — |
| `token_trades` | Recent on-chain buys and sells for a token | — |
| `trade_link` | Ready-to-use buy/sell link routed to the right venue | — |
| `safety_check` | Rug-check a token before trading — is the LP burned and locked? | — |
| `buy_hbnk` | Buy $HBNK, HamsterBunker's own token, in one call | — |

So you can tell Claude things like *"what's trending on HamsterBunker"*, *"is this token safe
to buy"*, *"buy me some HBNK"* — and, with a key, *"launch me
a token"*.

Addresses, bytecode, RPC and the public read key are pulled live from the
HamsterBunker config, so the server stays in sync with the deployment.

## Install

```bash
git clone https://github.com/hamsterbunker/hamster-mcp
cd hamster-mcp
npm install
```

You need Node 18+. To launch (not just read), you need a Robinhood Chain wallet
funded with ~0.0015 ETH for gas.

## Configure

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "hamsterbunker": {
      "command": "node",
      "args": ["/absolute/path/to/hamster-mcp/src/server.mjs"],
      "env": {
        "WALLET_PRIVATE_KEY": "0xYOUR_LAUNCHER_KEY"
      }
    }
  }
}
```

Restart Claude Desktop. Omit `WALLET_PRIVATE_KEY` if you only want the read tools.

### Claude Code

```bash
claude mcp add hamsterbunker -e WALLET_PRIVATE_KEY=0xYOUR_LAUNCHER_KEY -- node /absolute/path/to/hamster-mcp/src/server.mjs
```

## Environment

| Var | Purpose |
| --- | --- |
| `WALLET_PRIVATE_KEY` | Signing key for `launch_token`. Robinhood Chain wallet with gas. **Never** hardcode or paste it into chat — set it only in the MCP client config env. |
| `HAMSTER_CONFIG_URL` | Optional. Override the config source (defaults to the live site). |

## Notes

- `launch_token` is **irreversible**: it deploys an immutable token and burns the
  LP forever. Confirm the name/symbol before launching.
- The `creator` (fee wallet) earns 90% of the 1% trading fee. It does not own or
  control the token — there is no owner.
- Default DEX is Uniswap (deepest liquidity on Robinhood Chain); pass `dex: "sushi"`
  to use SushiSwap.
- The private key stays in the server process. It is never returned by any tool and
  never sent anywhere except to sign the launch transaction.

## License

MIT
