#!/usr/bin/env node
// Fake `kiro-cli acp` for tests. Prompt text controls behaviour:
//   contains "PARTIAL"   -> one text chunk, then silence until session/cancel
//   contains "STALL"     -> never answers until session/cancel
//   contains "AUTHFAIL"  -> JSON-RPC error like a logged-out kiro-cli
//   contains "SLOWSTART" -> waits FAKE_SLOW_MS before the first chunk
//   contains "CALLTOOLS:a,b" -> calls those MCP tools in parallel via the session's MCP server, echoes results
//   otherwise            -> streams "fake: <last line>" and ends the turn
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const out = (m: Json): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
};
const sessions = new Map<string, { mcp?: ReturnType<typeof spawn>; cancel?: () => void }>();
let n = 0;

let callSeq = 0;
function mcpCall(sid: string, name: string): Promise<string> {
  const mcp = sessions.get(sid)?.mcp;
  if (!mcp?.stdin || !mcp.stdout) return Promise.resolve("no mcp");
  const id = `call-${++callSeq}`;
  return new Promise((resolve) => {
    const rl = createInterface({ input: mcp.stdout as NodeJS.ReadableStream });
    rl.on("line", (l) => {
      const m = JSON.parse(l) as Json;
      if (m.id === id) {
        rl.close();
        const content = ((m.result as Json)?.content as Json[]) ?? [];
        resolve(content.map((c) => String(c.text ?? "")).join(""));
      }
    });
    mcp.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { name } } })}\n`,
    );
  });
}

function update(sessionId: string, u: Json): void {
  out({ method: "session/update", params: { sessionId, update: u } });
}

async function prompt(id: unknown, p: Json): Promise<void> {
  const sid = String(p.sessionId);
  const blocks = (p.prompt as Json[]) ?? [];
  const text = blocks.map((b) => String(b.text ?? "")).join("\n");
  const last = text.trim().split("\n").at(-1) ?? "";
  const s = sessions.get(sid) ?? {};
  sessions.set(sid, s);
  const cancelled = new Promise<void>((r) => {
    s.cancel = r;
  });
  if (text.includes("AUTHFAIL")) {
    return out({
      id,
      error: { code: -32603, message: "Not logged in. Run kiro-cli login to authenticate." },
    });
  }
  if (text.includes("PARTIAL")) {
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial answer..." },
    });
    await cancelled;
    return out({ id, result: { stopReason: "cancelled" } });
  }
  if (text.includes("STALL")) {
    await cancelled;
    return out({ id, result: { stopReason: "cancelled" } });
  }
  if (text.includes("SLOWSTART"))
    await new Promise((r) => setTimeout(r, Number(process.env.FAKE_SLOW_MS ?? 2000)));
  const tools = /CALLTOOLS:([\w,]+)/.exec(text)?.[1]?.split(",");
  if (tools) {
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "calling " } });
    const results = await Promise.all(tools.map((t) => mcpCall(sid, t)));
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `tools said ${results.join("|")}` },
    });
    return out({ id, result: { stopReason: "end_turn" } });
  }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `fake: ${last}` } });
  out({
    method: "_kiro.dev/metadata",
    params: { sessionId: sid, contextUsagePercentage: 1.5, turnDurationMs: 5 },
  });
  out({ id, result: { stopReason: "end_turn" } });
}

function newSession(id: unknown, p: Json): void {
  const sid = `fake-${process.pid}-${++n}`;
  const servers = (p.mcpServers as Json[]) ?? [];
  const spec = servers[0];
  const s: { mcp?: ReturnType<typeof spawn> } = {};
  if (spec) {
    const mcp = spawn(String(spec.command), (spec.args as string[]) ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    s.mcp = mcp;
    mcp.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
    );
    createInterface({ input: mcp.stdout as NodeJS.ReadableStream }).on("line", (l) => {
      if ((JSON.parse(l) as Json).method === "notifications/tools/list_changed") {
        mcp.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: `list-${++callSeq}`, method: "tools/list", params: {} })}\n`,
        );
      }
    });
  }
  sessions.set(sid, s);
  out({
    id,
    result: {
      sessionId: sid,
      models: { currentModelId: "auto", availableModels: [{ modelId: "fake-model", name: "fake-model" }] },
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as Json;
  const p = (m.params as Json) ?? {};
  switch (m.method) {
    case "initialize":
      return out({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "0" } } });
    case "session/new":
      return newSession(m.id, p);
    case "session/set_model":
      return out({ id: m.id, result: {} });
    case "_kiro.dev/commands/execute":
      return out({ id: m.id, result: { success: true } });
    case "session/prompt":
      return void prompt(m.id, p);
    case "session/cancel":
      return sessions.get(String(p.sessionId))?.cancel?.();
    default:
      if (m.id !== undefined) out({ id: m.id, result: null });
  }
});
process.stdin.on("end", () => {
  for (const s of sessions.values()) s.mcp?.kill();
  process.exit(0);
});
