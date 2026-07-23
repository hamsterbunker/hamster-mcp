// Smoke test: spawn the server over stdio and exercise the tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["src/server.mjs"], env: { ...process.env } });
const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map(t => t.name).join(", "));

const text = (r) => r.content?.[0]?.text ?? "";

console.log("\n[predict_token_address]");
console.log(text(await client.callTool({ name: "predict_token_address", arguments: { name: "Agent Coin", symbol: "AGENT" } })));

console.log("\n[recent_launches limit 3]");
console.log(text(await client.callTool({ name: "recent_launches", arguments: { limit: 3 } })));

console.log("\n[get_token HBNK]");
console.log(text(await client.callTool({ name: "get_token", arguments: { address: "0xd936dbdc5ad5bded2db0fed446ff07960d538026" } })));

console.log("\n[launch_token without key -> should error safely]");
const r = await client.callTool({ name: "launch_token", arguments: { name: "X", symbol: "X" } });
console.log("isError:", r.isError, "|", text(r));

await client.close();
process.exit(0);
