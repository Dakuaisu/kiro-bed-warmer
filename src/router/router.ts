import type { Metadata } from "../acp/schema.ts";
import type { Config } from "../config.ts";
import type { ChatRequest } from "../http/schema.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { McpTool } from "../mcp/bridge.ts";
import type { KiroSession, Pool } from "../pool/pool.ts";
import { firstDiff, systemDiff, tracked } from "./diag.ts";
import { fingerprint, hashSystem, type Msg, normalize } from "./messages.ts";
import { type Plan, planRequest, type SessionView } from "./plan.ts";
import { catchUpPrompt, deltaPrompt, seedPrompt } from "./prompt.ts";
import { classifyError, Turn, type TurnSink } from "./turn.ts";

const INSTRUCTION_HIGH_WATER_PCT = 70;

type Live = {
  key: string;
  s: KiroSession;
  model: string | undefined;
  effort: string | undefined;
  history: string[];
  messages: Msg[];
  system: string;
  systemHash: string | undefined;
  needInstructions: boolean;
  lastOutcome: SessionView["lastOutcome"];
  contextPct: number;
  turn: Turn | undefined;
  lastUsed: number;
};

export type ChatInput = { key: string | undefined; cwd: string; req: ChatRequest };

export const toMcpTools = (req: ChatRequest): McpTool[] =>
  (req.tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    inputSchema: t.function.parameters ?? { type: "object", properties: {} },
  }));

/** Routes opencode sessions to live kiro sessions; never uses session/load while a session is live. */
export class Router {
  private readonly live = new Map<string, Live>();
  private readonly locks = new Map<string, Promise<void>>();
  private ephemeral = 0;
  readonly stats = {
    requests: 0,
    continuations: 0,
    deltas: 0,
    catchUps: 0,
    resets: {} as Record<string, number>,
  };

  private readonly cfg: Config;
  private readonly pool: Pool;
  private readonly log: Logger;

  constructor(cfg: Config, pool: Pool, log: Logger) {
    this.cfg = cfg;
    this.pool = pool;
    this.log = log;
  }

  activeTurns(): number {
    return [...this.live.values()].filter((l) => l.turn && l.turn.state !== "done").length;
  }

  liveCount(): number {
    return this.live.size;
  }

  /** Serve one chat request; resolves when its HTTP response is complete. */
  async handle(input: ChatInput, sinkIn: TurnSink, signal: AbortSignal): Promise<void> {
    this.stats.requests++;
    const key = input.key ?? `ephemeral:${++this.ephemeral}`;
    const prev = this.locks.get(key) ?? Promise.resolve();
    const { sink, done } = tracked(sinkIn);
    const run = prev.then(() => this.serve(key, input, sink, signal, done));
    const lock = run.then(
      () => done,
      () => undefined,
    );
    this.locks.set(key, lock);
    try {
      await run;
    } catch (err) {
      this.log.warn("router.request_failed", { key, err: errorMessage(err) });
      sink.fail(classifyError(err, true));
    }
    await done;
    if (this.locks.get(key) === lock) this.locks.delete(key);
    if (!input.key) this.drop(key);
  }

  private async serve(
    key: string,
    input: ChatInput,
    sink: TurnSink,
    signal: AbortSignal,
    done: Promise<void>,
  ) {
    const conv = normalize(input.req);
    const fps = conv.messages.map(fingerprint);
    const sysHash = hashSystem(conv.system);
    let live = this.live.get(key);
    if (live && !live.s.proc.isAlive) {
      this.log.warn("router.session_lost", { key, reason: "kiro-cli process exited" });
      this.drop(key);
      live = undefined;
    }
    if (live?.turn && live.turn.state === "running") {
      live.turn.abort("superseded");
      await live.turn.done;
    }
    const plan0 = planRequest(live && this.view(live), conv.messages, fps, sysHash, this.cfg.onSystemChange);
    let plan: Plan = plan0;
    if (plan0.kind === "abort_tools" && live?.turn) {
      live.turn.abort("opencode continued without the pending tool results");
      await live.turn.done;
      live.lastOutcome = "interrupted";
      plan = planRequest(this.view(live), conv.messages, fps, sysHash, this.cfg.onSystemChange);
    }
    if (plan.kind === "continue_tools" && live?.turn) {
      this.stats.continuations++;
      live.history = fps;
      live.messages = conv.messages;
      live.lastUsed = Date.now();
      this.watchAbort(live.turn, signal, done);
      live.turn.resume(sink, plan.results);
      return;
    }
    let blocks: ReturnType<typeof seedPrompt>;
    if (plan.kind === "delta" || plan.kind === "catch_up") {
      if (!live) throw new Error("internal: delta without live session");
      const redeliver =
        live.needInstructions ||
        (live.systemHash !== sysHash && this.cfg.onSystemChange === "redeliver") ||
        live.contextPct >= INSTRUCTION_HIGH_WATER_PCT;
      const system = redeliver && conv.system ? conv.system : undefined;
      blocks =
        plan.kind === "delta" ? deltaPrompt(system, plan.messages) : catchUpPrompt(system, plan.messages);
      if (plan.kind === "delta") this.stats.deltas++;
      else this.stats.catchUps++;
    } else {
      const reason = plan.kind === "reset" ? plan.reason : "unknown_session";
      const hasHistory = conv.messages.some((m) => m.role !== "user");
      if (live) this.drop(key);
      this.stats.resets[reason] = (this.stats.resets[reason] ?? 0) + 1;
      if (reason !== "unknown_session" || hasHistory) {
        this.log.info("router.diverged", {
          key,
          reason,
          messages: conv.messages.length,
          ...firstDiff(live, fps, conv.messages),
          ...systemDiff(live, conv.system),
        });
      }
      live = await this.create(key, input.cwd);
      blocks = seedPrompt(conv.system, conv.messages);
    }
    await this.configure(live, input.req);
    live.history = fps;
    live.messages = conv.messages;
    live.system = conv.system;
    live.systemHash = sysHash;
    live.needInstructions = false;
    live.lastUsed = Date.now();
    live.lastOutcome = "interrupted";
    const target = live;
    const timing = {
      stallMs: this.cfg.stallMs,
      toolTimeoutMs: this.cfg.toolTimeoutMs,
      batchMs: this.cfg.toolBatchMs,
    };
    const hooks = {
      onMetadata: (m: Metadata) => {
        if (m.contextUsagePercentage !== undefined) target.contextPct = m.contextUsagePercentage;
      },
      onCompacted: () => {
        target.needInstructions = true;
      },
    };
    const { proc, acpId, bridge } = live.s;
    const turn = new Turn({ proc, acpId, bridge, timing, log: this.log, hooks }, blocks, sink);
    live.turn = turn;
    void turn.done.then(() => {
      target.lastOutcome = turn.outcome;
      target.lastUsed = Date.now();
    });
    this.watchAbort(turn, signal, done);
  }

  private watchAbort(turn: Turn, signal: AbortSignal, done: Promise<void>): void {
    const onAbort = (): void => {
      if (turn.state === "running") turn.abort("client_disconnected");
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void done.then(() => signal.removeEventListener("abort", onAbort));
  }

  private view(l: Live): SessionView {
    return {
      history: l.history,
      systemHash: l.systemHash,
      lastOutcome: l.lastOutcome,
      pendingToolIds: l.turn?.pendingToolIds,
    };
  }

  private async create(key: string, cwd: string): Promise<Live> {
    const s = await this.pool.take(cwd);
    const live: Live = {
      key,
      s,
      model: undefined,
      effort: undefined,
      history: [],
      messages: [],
      system: "",
      systemHash: undefined,
      needInstructions: true,
      lastOutcome: "none",
      contextPct: 0,
      turn: undefined,
      lastUsed: Date.now(),
    };
    this.live.set(key, live);
    return live;
  }

  private async configure(live: Live, req: ChatRequest): Promise<void> {
    const { proc, acpId, bridge } = live.s;
    const tasks: Promise<unknown>[] = [bridge.setTools(toMcpTools(req))];
    if (live.model !== req.model) {
      tasks.push(proc.setModel(acpId, req.model).then(() => (live.model = req.model)));
    }
    const effort = req.reasoning_effort;
    if (effort && live.effort !== effort) {
      tasks.push(
        proc
          .setEffort(acpId, effort)
          .then(() => (live.effort = effort))
          .catch((err: unknown) => this.log.warn("router.effort_failed", { effort, err: errorMessage(err) })),
      );
    }
    await Promise.all(tasks);
  }

  drop(key: string): void {
    const l = this.live.get(key);
    if (!l) return;
    this.live.delete(key);
    l.turn?.abort("session dropped");
    this.pool.release(l.s);
  }

  /** Evict idle sessions; called periodically. */
  sweep(now = Date.now()): void {
    for (const [key, l] of this.live) {
      const idle = !l.turn || l.turn.state === "done";
      if (idle && now - l.lastUsed > this.cfg.sessionIdleMs) this.drop(key);
    }
  }
}
