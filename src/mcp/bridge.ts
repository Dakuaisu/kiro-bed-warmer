import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { McpServerSpec } from "../acp/process.ts";
import { errorMessage, type Logger } from "../log.ts";
import { BRIDGE_SERVER_NAME } from "../state.ts";

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
export type ToolCallRequest = { name: string; args: Record<string, unknown>; signal: AbortSignal };
export type ToolCallResult = { text: string; isError: boolean };
export type ToolCallHandler = (call: ToolCallRequest) => Promise<ToolCallResult>;

const Inbound = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
});
const CallParams = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() });
const CancelParams = z.object({ requestId: z.union([z.number(), z.string()]) });

const NC = "/usr/bin/nc";
// Same extension as this file: .ts when run from source, .js from the published dist/ build.
const EXT = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const RELAY = new URL(`./relay${EXT}`, import.meta.url).pathname;

/**
 * Per-kiro-session MCP server. kiro-cli launches a stdio relay (`nc -U <socket>`) and this
 * object answers MCP over the socket, so the tool set can change via tools/list_changed.
 */
export class Bridge {
  readonly id = randomBytes(6).toString("hex");
  readonly socketPath: string;
  private server: Server | undefined;
  private conn: Socket | undefined;
  private tools: McpTool[] = [];
  private toolsKey = "[]";
  private version = 0;
  private listedVersion = 0;
  private readonly listWaiters = new Set<() => void>();
  private readonly inflight = new Map<string, AbortController>();
  handler: ToolCallHandler | undefined;

  private readonly log: Logger;

  constructor(socketDir: string, log: Logger) {
    this.log = log;
    this.socketPath = join(socketDir, `${this.id}.sock`);
  }

  async listen(): Promise<void> {
    if (existsSync(this.socketPath)) rmSync(this.socketPath);
    const server = createServer((sock) => this.accept(sock));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => resolve());
    });
  }

  spec(): McpServerSpec {
    const useNc = process.platform !== "win32" && existsSync(NC);
    return useNc
      ? { name: BRIDGE_SERVER_NAME, command: NC, args: ["-U", this.socketPath], env: [] }
      : { name: BRIDGE_SERVER_NAME, command: process.execPath, args: [RELAY, this.socketPath], env: [] };
  }

  /** Replace the tool set. Resolves once kiro has re-listed (or after `waitMs`). */
  async setTools(tools: McpTool[], waitMs = 3000): Promise<boolean> {
    const key = JSON.stringify(tools);
    if (key === this.toolsKey) return false;
    this.tools = tools;
    this.toolsKey = key;
    this.version++;
    if (!this.conn) return true;
    const target = this.version;
    const listed = new Promise<void>((resolve) => {
      const self = this;
      const timer = setTimeout(() => {
        self.log.warn("bridge.tools_not_relisted", { bridge: self.id, waitMs, tools: tools.length });
        done();
      }, waitMs);
      function done(): void {
        clearTimeout(timer);
        self.listWaiters.delete(check);
        resolve();
      }
      function check(): void {
        if (self.listedVersion >= target) done();
      }
      this.listWaiters.add(check);
    });
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    await listed;
    return true;
  }

  /** Ask kiro to re-list the current tools (no-op until kiro has connected). */
  relist(): void {
    this.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
  }

  close(): void {
    for (const ac of this.inflight.values()) ac.abort();
    this.inflight.clear();
    this.conn?.destroy();
    this.server?.close();
    rmSync(this.socketPath, { force: true });
  }

  private accept(sock: Socket): void {
    this.conn?.destroy();
    this.conn = sock;
    const rl = createInterface({ input: sock });
    rl.on("line", (line) => {
      void this.onLine(line);
    });
    // readline re-emits socket errors (EPIPE/ECONNRESET when nc or kiro-cli exits); unhandled, they kill the daemon.
    rl.on("error", (err) => this.log.debug("bridge.readline_error", { bridge: this.id, err: err.message }));
    sock.on("error", (err) => this.log.debug("bridge.socket_error", { bridge: this.id, err: err.message }));
    sock.on("close", () => {
      if (this.conn === sock) this.conn = undefined;
    });
  }

  private send(msg: object): void {
    const c = this.conn;
    if (c && !c.destroyed && c.writable) c.write(`${JSON.stringify(msg)}\n`);
  }

  private async onLine(line: string): Promise<void> {
    let msg: z.infer<typeof Inbound>;
    try {
      msg = Inbound.parse(JSON.parse(line));
    } catch (err) {
      this.log.warn("bridge.bad_message", { bridge: this.id, err: errorMessage(err) });
      return;
    }
    const { id, method } = msg;
    if (method === "notifications/cancelled") {
      const c = CancelParams.safeParse(msg.params);
      if (c.success) this.inflight.get(String(c.data.requestId))?.abort();
      return;
    }
    if (id === undefined || method === undefined) return;
    const reply = (result: unknown): void => this.send({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize": {
        const pv = z.object({ protocolVersion: z.string() }).safeParse(msg.params);
        reply({
          protocolVersion: pv.success ? pv.data.protocolVersion : "2024-11-05",
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "kiro-bed-warmer", version: "0.1.0" },
        });
        return;
      }
      case "tools/list": {
        const version = this.version;
        reply({ tools: this.tools });
        this.listedVersion = Math.max(this.listedVersion, version);
        for (const w of [...this.listWaiters]) w();
        return;
      }
      case "tools/call":
        reply(await this.call(String(id), msg.params));
        return;
      default:
        reply({});
    }
  }

  private async call(rpcId: string, params: unknown): Promise<unknown> {
    const p = CallParams.safeParse(params);
    if (!p.success) return { content: [{ type: "text", text: "Invalid tools/call params" }], isError: true };
    if (!this.handler) {
      return { content: [{ type: "text", text: "No active turn for this tool call" }], isError: true };
    }
    const ac = new AbortController();
    this.inflight.set(rpcId, ac);
    try {
      const res = await this.handler({ name: p.data.name, args: p.data.arguments ?? {}, signal: ac.signal });
      return { content: [{ type: "text", text: res.text }], isError: res.isError };
    } finally {
      this.inflight.delete(rpcId);
    }
  }
}
