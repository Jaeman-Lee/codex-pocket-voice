import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import { CodexAppServerClient } from "./app-server-client.js";
import { PathPolicy } from "./path-policy.js";
import { APP_VERSION } from "./version.js";
import { compactThread, errorResult, summarizeTurn, textResult } from "./result.js";

export interface BridgeDependencies {
  client: CodexAppServerClient;
  paths: PathPolicy;
}

export function createBridgeServer({ client, paths }: BridgeDependencies): McpServer {
  const server = new McpServer({ name: "codex-voice-bridge", version: APP_VERSION });

  server.registerTool(
    "codex_health",
    {
      title: "Check Codex bridge",
      description: "Check whether the local Codex app-server is reachable and show its safety-scoped workspace roots.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () => {
      try {
        const initialized = await client.start();
        return textResult({ ok: true, ...initialized, allowedWorkspaceRoots: paths.roots });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_list_threads",
    {
      title: "List Codex conversations",
      description: "List recent Codex conversations only from the configured workspace roots.",
      inputSchema: {
        limit: z.number().int().min(1).max(50).default(10),
        search: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ limit, search }) => {
      try {
        const response = await client.listThreads(limit, search);
        const data = response.data.filter((thread) => paths.isAllowed(thread.cwd)).map(compactThread);
        return textResult({ threads: data, nextCursor: response.nextCursor });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_get_thread",
    {
      title: "Read a Codex conversation",
      description: "Read one Codex conversation after verifying that its working directory is allowed.",
      inputSchema: { thread_id: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ thread_id }) => {
      try {
        const response = await client.readThread(thread_id, true);
        paths.assertAllowed(response.thread.cwd);
        return textResult(response.thread);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_run",
    {
      title: "Run a Codex development turn",
      description:
        "Start or continue a Codex coding conversation. Codex may edit files only inside an allowed workspace. Elevated approvals are always declined.",
      inputSchema: {
        prompt: z.string().min(1).max(100_000),
        cwd: z.string().optional().describe("Allowed local project directory; defaults to the first configured root"),
        thread_id: z.string().min(1).optional().describe("Existing Codex thread to continue"),
        network_access: z.boolean().default(false).describe("Allow network access inside the workspace sandbox"),
        model: z.string().min(1).optional(),
        effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
        timeout_seconds: z.number().int().min(30).max(3600).default(900),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ prompt, cwd, thread_id, network_access, model, effort, timeout_seconds }) => {
      try {
        let workspace: string;
        if (thread_id) {
          const existing = await client.readThread(thread_id, false);
          paths.assertAllowed(existing.thread.cwd);
          workspace = await paths.resolveWorkspace(cwd ?? existing.thread.cwd);
        } else {
          workspace = await paths.resolveWorkspace(cwd);
        }
        const result = await client.runTurn({
          threadId: thread_id,
          cwd: workspace,
          prompt,
          networkAccess: network_access,
          model,
          effort,
          timeoutMs: timeout_seconds * 1000,
        });
        paths.assertAllowed(result.thread.cwd);
        return textResult(summarizeTurn(result.thread, result.turn));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "codex_interrupt",
    {
      title: "Interrupt a Codex turn",
      description: "Stop a currently running Codex turn in an allowed workspace.",
      inputSchema: { thread_id: z.string().min(1), turn_id: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ thread_id, turn_id }) => {
      try {
        const existing = await client.readThread(thread_id, false);
        paths.assertAllowed(existing.thread.cwd);
        await client.interrupt(thread_id, turn_id);
        return textResult({ interrupted: true, threadId: thread_id, turnId: turn_id });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}
