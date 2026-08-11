import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("plugin stdio command exposes tools and reaches the real app-server", async (t) => {
  const transport = new StdioClientTransport({
    command: process.env.SHELL ?? "sh",
    args: ["./scripts/start-mcp.sh"],
    cwd: repoRoot,
    env: Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  });
  const client = new Client({ name: "bridge-integration-test", version: "0.1.0" });
  t.after(() => client.close());

  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map((tool) => tool.name).sort(),
    ["codex_get_thread", "codex_health", "codex_interrupt", "codex_list_threads", "codex_run"],
  );

  const health = await client.callTool({ name: "codex_health", arguments: {} });
  assert.equal(health.isError, undefined);
  assert.match(JSON.stringify(health.content), /allowedWorkspaceRoots/);
});
