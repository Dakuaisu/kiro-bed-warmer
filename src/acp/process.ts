import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Config } from "../config.ts";
import { errorMessage, type Logger } from "../log.ts";
import { AGENT_NAME, BRIDGE_SERVER_NAME } from "../state.ts";
import { RpcPeer } from "./rpc.ts";
import {
  CommandResult,
  CompactionStatus,
  InitializeResult,
  MetadataNotification,
  type ModelInfo,
  NewSessionResult,
  PermissionRequest,
  PromptResult,
  type SessionEvent,
  SessionScoped,
  SessionUpdate,
  SessionUpdateNotification,
} from "./schema.ts";

export type McpServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
};
export type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type Listener = (ev: SessionEvent) => void;

const INIT_TIMEOUT_MS = 60_000;
const NEW_SESSION_TIMEOUT_MS = 60_000;
const CONTROL_TIMEOUT_MS = 15_000;
let processCounter = 0;

/** One long-lived `kiro-cli acp` child. Many sessions share it. */
export class KiroProcess {
  readonly id = `p${++processCounter}`;
  private child: ChildProcessWithoutNullStreams | undefined;
  private peer: RpcPeer | undefined;
  private readonly listeners = new Map<string, Listener>();
  private stderrTail = "";
  private alive = false;
  /** initialize succeeded; a process that dies before this never served sessions. */
  started = false;
  createdSessions = 0;
  /** Slots claimed by in-flight session/new calls (see Pool.reserve). */
  reserved = 0;
  liveSessions = new Set<string>();
  models: ModelInfo[] = [];
  readonly onExit = new Set<(proc: KiroProcess) => void>();

  private readonly cfg: Config;
  private readonly log: Logger;

  constructor(cfg: Config, log: Logger) {
    this.cfg = cfg;
    this.log = log;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  async start(): Promise<void> {
    const args = ["acp", "--agent", AGENT_NAME];
    if (this.cfg.engine === "v3") args.push("--agent-engine", "v3");
    const t0 = Date.now();
    const child = spawn(this.cfg.kiroBin, args, { cwd: this.cfg.workDir, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.alive = true;
    child.stderr.on("data", (c: Buffer) => {
      this.stderrTail = (this.stderrTail + c.toString()).slice(-4096);
    });
    const peer = new RpcPeer(child.stdout, child.stdin, {
      onRequest: (method, params) => this.onServerRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onProtocolError: (line, err) =>
        this.log.warn("acp.bad_message", { proc: this.id, line, err: errorMessage(err) }),
      onTrace: (dir, method, ms) => this.log.debug("acp.rpc", { proc: this.id, dir, method, ms }),
    });
    this.peer = peer;
    child.stdin.on("error", (err) => this.log.warn("acp.stdin_error", { proc: this.id, err: err.message }));
    child.on("error", (err) => this.handleExit(`spawn error: ${err.message}`));
    child.on("exit", (code, signal) => this.handleExit(`exit code=${code} signal=${signal}`));
    const init = InitializeResult.parse(
      await peer.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "kiro-bed-warmer", version: "0.1.0" },
        },
        INIT_TIMEOUT_MS,
      ),
    );
    this.started = true;
    this.log.info("acp.started", {
      proc: this.id,
      pid: child.pid,
      ms: Date.now() - t0,
      kiro: init.agentInfo.version,
    });
  }

  async newSession(cwd: string, mcpServers: McpServerSpec[]): Promise<string> {
    const t0 = Date.now();
    const res = NewSessionResult.parse(
      await this.rpc().request("session/new", { cwd, mcpServers }, NEW_SESSION_TIMEOUT_MS),
    );
    this.createdSessions++;
    this.liveSessions.add(res.sessionId);
    if (res.models) this.models = res.models.availableModels;
    this.log.debug("acp.session_new", { proc: this.id, sessionId: res.sessionId, cwd, ms: Date.now() - t0 });
    return res.sessionId;
  }

  async setModel(sessionId: string, modelId: string): Promise<void> {
    await this.rpc().request("session/set_model", { sessionId, modelId }, CONTROL_TIMEOUT_MS);
  }

  async setEffort(sessionId: string, level: string): Promise<boolean> {
    const res = CommandResult.parse(
      await this.rpc().request(
        "_kiro.dev/commands/execute",
        { sessionId, command: { command: "effort", args: { value: level } } },
        CONTROL_TIMEOUT_MS,
      ),
    );
    return res.success;
  }

  async prompt(sessionId: string, prompt: PromptBlock[]): Promise<string> {
    return PromptResult.parse(await this.rpc().request("session/prompt", { sessionId, prompt })).stopReason;
  }

  cancel(sessionId: string): void {
    this.peer?.notify("session/cancel", { sessionId });
  }

  listen(sessionId: string, fn: Listener): void {
    this.listeners.set(sessionId, fn);
  }

  /** Forget a session (kiro-cli has no close; memory is reclaimed when the process is recycled). */
  drop(sessionId: string): void {
    this.listeners.delete(sessionId);
    this.liveSessions.delete(sessionId);
  }

  stderr(): string {
    return this.stderrTail.trim();
  }

  async stop(): Promise<number> {
    const child = this.child;
    if (!child || !this.alive) return 0;
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const term = setTimeout(() => child.kill("SIGTERM"), 5000);
      const kill = setTimeout(() => child.kill("SIGKILL"), 8000);
      child.once("exit", () => {
        clearTimeout(term);
        clearTimeout(kill);
        resolve();
      });
      child.stdin.end();
    });
    return Date.now() - t0;
  }

  private rpc(): RpcPeer {
    if (!this.peer || !this.alive) throw new Error(`kiro-cli process ${this.id} is not running`);
    return this.peer;
  }

  private handleExit(reason: string): void {
    if (!this.alive) return;
    this.alive = false;
    this.peer?.close(new Error(`kiro-cli ${reason}${this.stderrTail ? `; stderr: ${this.stderr()}` : ""}`));
    this.log.warn("acp.exited", { proc: this.id, reason, sessions: this.liveSessions.size });
    for (const fn of this.onExit) fn(this);
  }

  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") return null;
    const req = PermissionRequest.parse(params);
    // Only our opencode bridge tools are auto-approved; opencode applies its own permission rules when it runs them.
    const title = req.toolCall?.title ?? "";
    const ours = title.includes(`@${BRIDGE_SERVER_NAME}/`);
    const wanted = ours ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];
    const option =
      req.options.find((o) => wanted.includes(o.optionId)) ?? req.options.find((o) => o.kind === wanted[0]);
    if (!ours) this.log.warn("acp.permission_rejected", { proc: this.id, sessionId: req.sessionId, title });
    if (!option) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: option.optionId } };
  }

  private onNotification(method: string, params: unknown): void {
    if (method === "session/update" || method === "_kiro.dev/session/update") {
      const n = SessionUpdateNotification.safeParse(params);
      if (!n.success) return;
      const parsed = SessionUpdate.safeParse(n.data.update);
      if (parsed.success) {
        const u = parsed.data;
        this.emit(n.data.sessionId, { kind: "update", update: u });
        if (u.sessionUpdate === "session_info_update" && u._meta?.kiro?.kind === "summarization_completed") {
          this.emit(n.data.sessionId, { kind: "compacted" });
        }
      } else this.emit(n.data.sessionId, { kind: "other", method: n.data.update.sessionUpdate });
      return;
    }
    if (method === "_kiro.dev/metadata") {
      const m = MetadataNotification.safeParse(params);
      if (m.success) this.emit(m.data.sessionId, { kind: "metadata", meta: m.data });
      return;
    }
    if (method === "_kiro.dev/compaction/status" || method === "_kiro.dev/clear/status") {
      const c = CompactionStatus.safeParse(params);
      const status = c.success ? c.data.status : undefined;
      const type = typeof status === "string" ? status : status?.type;
      // Progress notices count as activity so a long compaction is not cancelled as a stall.
      if (c.success && c.data.sessionId) {
        this.emit(c.data.sessionId, type === "completed" ? { kind: "compacted" } : { kind: "other", method });
      }
      return;
    }
    const other = SessionScoped.safeParse(params);
    if (other.success) this.emit(other.data.sessionId, { kind: "other", method });
  }

  private emit(sessionId: string, ev: SessionEvent): void {
    this.listeners.get(sessionId)?.(ev);
  }
}
