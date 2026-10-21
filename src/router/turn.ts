import { randomBytes } from "node:crypto";
import type { KiroProcess, PromptBlock } from "../acp/process.ts";
import { RpcClosedError } from "../acp/rpc.ts";
import type { Metadata, SessionEvent } from "../acp/schema.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { Bridge, ToolCallRequest, ToolCallResult } from "../mcp/bridge.ts";

export type EmittedCall = { id: string; name: string; args: string };
export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter";
export type TurnError = { kind: "stall" | "auth" | "crash" | "cancelled" | "kiro"; message: string };
export type TurnInfo = { metadata: Metadata | undefined; wallMs: number };

/** Where a turn's output goes; one sink per HTTP response. */
export interface TurnSink {
  text(delta: string): void;
  reasoning(delta: string): void;
  toolCalls(calls: EmittedCall[]): void;
  finish(reason: FinishReason, info: TurnInfo): void;
  fail(err: TurnError): void;
}

type PendingCall = EmittedCall & { resolve: (r: ToolCallResult) => void };
export type TurnTiming = { stallMs: number; toolTimeoutMs: number; batchMs: number };
export type TurnHooks = { onMetadata: (m: Metadata) => void; onCompacted: () => void };
export type TurnDeps = {
  proc: KiroProcess;
  acpId: string;
  bridge: Bridge;
  timing: TurnTiming;
  log: Logger;
  hooks: TurnHooks;
};

const AUTH_PATTERN =
  /not logged in|kiro-cli login|unauthori[sz]ed|expired|invalid (?:token|credentials)|sign[- ]?in/i;

export function classifyError(err: unknown, procAlive: boolean): TurnError {
  const message = errorMessage(err);
  if (AUTH_PATTERN.test(message)) {
    return { kind: "auth", message: `Kiro authentication failed; run \`kiro-cli login\`. (${message})` };
  }
  if (err instanceof RpcClosedError || !procAlive)
    return { kind: "crash", message: `kiro-cli exited: ${message}` };
  return { kind: "kiro", message };
}

function mapStop(stop: string): FinishReason {
  if (stop === "max_tokens") return "length";
  if (stop === "refusal" || stop === "content_filter") return "content_filter";
  return "stop";
}

/** One ACP `session/prompt`, possibly spanning several HTTP requests via suspended tool calls. */
export class Turn {
  state: "running" | "awaiting_tools" | "done" = "running";
  outcome: "completed" | "interrupted" | "failed" = "interrupted";
  readonly done: Promise<void>;
  private sink: TurnSink | undefined;
  private readonly buffered: Array<(s: TurnSink) => void> = [];
  private readonly batch: PendingCall[] = [];
  private readonly awaiting = new Map<string, PendingCall>();
  private batchTimer: NodeJS.Timeout | undefined;
  private stallTimer: NodeJS.Timeout | undefined;
  private toolTimer: NodeJS.Timeout | undefined;
  private metadata: Metadata | undefined;
  private aborted = false;
  private readonly started = Date.now();

  private readonly proc: KiroProcess;
  private readonly acpId: string;
  private readonly timing: TurnTiming;
  private readonly log: Logger;
  private readonly hooks: TurnHooks;

  constructor(d: TurnDeps, blocks: PromptBlock[], sink: TurnSink) {
    this.proc = d.proc;
    this.acpId = d.acpId;
    this.timing = d.timing;
    this.log = d.log;
    this.hooks = d.hooks;
    this.sink = sink;
    d.proc.listen(d.acpId, (ev) => this.onEvent(ev));
    d.bridge.handler = (call) => this.onToolCall(call);
    this.armStall();
    this.done = d.proc.prompt(d.acpId, blocks).then(
      (stop) => this.onStop(stop),
      (err: unknown) => this.onError(err),
    );
  }

  /** Still working for a client. Aborted turns waiting on kiro's cancel ack do not count. */
  get active(): boolean {
    return this.state !== "done" && !this.aborted;
  }

  get pendingToolIds(): string[] | undefined {
    return this.state === "awaiting_tools" ? [...this.awaiting.keys()] : undefined;
  }

  /** Attach the next HTTP response and hand kiro the tool results. */
  resume(sink: TurnSink, results: ReadonlyMap<string, string>): void {
    this.sink = sink;
    this.state = "running";
    clearTimeout(this.toolTimer);
    for (const [id, call] of this.awaiting) {
      const text = results.get(id);
      call.resolve(
        text === undefined
          ? { text: "Error: no tool result received", isError: true }
          : { text, isError: false },
      );
    }
    this.awaiting.clear();
    for (const write of this.buffered.splice(0)) write(sink);
    this.armStall();
    if (this.batch.length > 0) this.scheduleFlush();
  }

  /** Cancel the ACP turn (client gone, stall, or opencode moved on without tool results). */
  abort(
    reason: string,
    err: TurnError = { kind: "cancelled", message: `Kiro turn cancelled (${reason})` },
  ): void {
    if (this.state === "done" || this.aborted) return;
    this.aborted = true;
    this.log.info("turn.abort", { acpId: this.acpId, reason });
    const sink = this.sink;
    this.sink = undefined;
    this.clearTimers();
    this.failCalls(`Tool call aborted (${reason})`);
    this.proc.cancel(this.acpId);
    sink?.fail(err);
  }

  private onEvent(ev: SessionEvent): void {
    if (ev.kind === "metadata") {
      this.metadata = { ...this.metadata, ...ev.meta };
      this.hooks.onMetadata(ev.meta);
    } else if (ev.kind === "compacted") this.hooks.onCompacted();
    else if (ev.kind === "update") {
      const u = ev.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.text)
        this.out((s) => s.text(u.content.text ?? ""));
      if (u.sessionUpdate === "agent_thought_chunk" && u.content.text) {
        this.out((s) => s.reasoning(u.content.text ?? ""));
      }
    }
    this.armStall();
  }

  private out(write: (s: TurnSink) => void): void {
    if (this.aborted) return;
    if (this.sink) write(this.sink);
    else this.buffered.push(write);
  }

  private onToolCall(call: ToolCallRequest): Promise<ToolCallResult> {
    if (this.state === "done" || this.aborted) {
      return Promise.resolve({ text: "Error: turn is no longer active", isError: true });
    }
    return new Promise((resolve) => {
      const pending: PendingCall = {
        id: `call_${randomBytes(9).toString("base64url")}`,
        name: call.name,
        args: JSON.stringify(call.args),
        resolve,
      };
      this.batch.push(pending);
      clearTimeout(this.stallTimer);
      call.signal.addEventListener("abort", () => {
        this.awaiting.delete(pending.id);
        const i = this.batch.indexOf(pending);
        if (i >= 0) this.batch.splice(i, 1);
        resolve({ text: "Error: cancelled by kiro", isError: true });
      });
      if (this.sink) this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (!this.batchTimer) this.batchTimer = setTimeout(() => this.flush(), this.timing.batchMs);
  }

  private flush(): void {
    this.batchTimer = undefined;
    const sink = this.sink;
    if (!sink || this.batch.length === 0) return;
    const calls = this.batch.splice(0);
    for (const c of calls) this.awaiting.set(c.id, c);
    this.state = "awaiting_tools";
    this.sink = undefined;
    sink.toolCalls(calls.map(({ id, name, args }) => ({ id, name, args })));
    sink.finish("tool_calls", this.info());
    this.toolTimer = setTimeout(() => this.abort("tool_timeout"), this.timing.toolTimeoutMs);
  }

  private armStall(): void {
    clearTimeout(this.stallTimer);
    if (this.state !== "running" || this.batch.length > 0 || this.aborted) return;
    this.stallTimer = setTimeout(() => this.onStall(), this.timing.stallMs);
  }

  private onStall(): void {
    const message = `Kiro produced no output for ${this.timing.stallMs / 1000}s (service unavailable, stalled); turn cancelled so the client can retry or fall back`;
    this.log.warn("turn.stall", { acpId: this.acpId, ms: this.timing.stallMs });
    this.abort("stall", { kind: "stall", message });
  }

  private onStop(stop: string): void {
    this.finalize();
    if (this.aborted) return;
    if (stop === "cancelled") {
      this.sink?.fail({ kind: "cancelled", message: "Kiro cancelled the turn" });
      return;
    }
    this.outcome = "completed";
    this.sink?.finish(mapStop(stop), this.info());
  }

  private onError(err: unknown): void {
    this.finalize();
    if (this.aborted) return;
    this.outcome = "failed";
    const e = classifyError(err, this.proc.isAlive);
    this.log.warn("turn.error", { acpId: this.acpId, kind: e.kind, err: e.message });
    this.sink?.fail(e);
  }

  private finalize(): void {
    this.state = "done";
    this.clearTimers();
    this.failCalls("Turn ended");
  }

  private failCalls(reason: string): void {
    for (const c of [...this.batch.splice(0), ...this.awaiting.values()])
      c.resolve({ text: `Error: ${reason}`, isError: true });
    this.awaiting.clear();
  }

  private clearTimers(): void {
    clearTimeout(this.batchTimer);
    clearTimeout(this.stallTimer);
    clearTimeout(this.toolTimer);
    this.batchTimer = undefined;
  }

  private info(): TurnInfo {
    return { metadata: this.metadata, wallMs: Date.now() - this.started };
  }
}
