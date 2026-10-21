import { KiroProcess } from "../acp/process.ts";
import type { ModelInfo } from "../acp/schema.ts";
import type { Config } from "../config.ts";
import { errorMessage, type Logger } from "../log.ts";
import { Bridge } from "../mcp/bridge.ts";

/** A created kiro session with its private MCP bridge, not yet bound to an opencode session. */
export type KiroSession = { proc: KiroProcess; acpId: string; bridge: Bridge; cwd: string };

/** Warm pool: long-lived kiro-cli processes plus one pre-created spare session per recently used cwd. */
export class Pool {
  private readonly procs: KiroProcess[] = [];
  private starting: Promise<KiroProcess> | undefined;
  private readonly spares = new Map<string, KiroSession>();
  private readonly refilling = new Map<string, Promise<void>>();
  private readonly recentCwds: string[] = [];
  private closed = false;
  stats = { spareHits: 0, spareMisses: 0, processStarts: 0, processExits: 0 };

  private readonly cfg: Config;
  private readonly log: Logger;

  constructor(cfg: Config, log: Logger) {
    this.cfg = cfg;
    this.log = log;
  }

  /** Start the first process and a spare session in the daemon's neutral cwd. */
  async warmUp(cwds: string[]): Promise<void> {
    await this.process();
    await Promise.all(cwds.map((cwd) => this.ensureSpare(cwd)));
  }

  models(): ModelInfo[] {
    return this.procs.find((p) => p.models.length > 0)?.models ?? [];
  }

  processCount(): number {
    return this.procs.length;
  }

  spareCount(): number {
    return this.spares.size;
  }

  /** Hand out a ready session for `cwd` (spare if available) and refill in the background. */
  async take(cwd: string): Promise<KiroSession> {
    this.touchCwd(cwd);
    const spare = this.spares.get(cwd);
    if (spare?.proc.isAlive) {
      this.spares.delete(cwd);
      this.stats.spareHits++;
      void this.ensureSpare(cwd);
      return spare;
    }
    this.stats.spareMisses++;
    const session = await this.create(cwd);
    void this.ensureSpare(cwd);
    return session;
  }

  /** Ensure one spare exists for `cwd` (used for pre-warming a new window). */
  ensureSpare(cwd: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.touchCwd(cwd);
    const existing = this.spares.get(cwd);
    if (existing?.proc.isAlive) return Promise.resolve();
    const inflight = this.refilling.get(cwd);
    if (inflight) return inflight;
    const job = this.create(cwd)
      .then((s) => {
        if (this.closed || !this.recentCwds.includes(cwd)) return this.release(s);
        this.spares.set(cwd, s);
      })
      .catch((err: unknown) => this.log.warn("pool.spare_failed", { cwd, err: errorMessage(err) }))
      .finally(() => this.refilling.delete(cwd));
    this.refilling.set(cwd, job);
    return job;
  }

  /** Forget a session that will not be used again. */
  release(s: KiroSession): void {
    s.proc.drop(s.acpId);
    s.bridge.close();
    this.recycleIdle();
  }

  async close(): Promise<number[]> {
    this.closed = true;
    for (const s of this.spares.values()) s.bridge.close();
    this.spares.clear();
    return Promise.all(this.procs.map((p) => p.stop()));
  }

  private touchCwd(cwd: string): void {
    const i = this.recentCwds.indexOf(cwd);
    if (i >= 0) this.recentCwds.splice(i, 1);
    this.recentCwds.unshift(cwd);
    for (const old of this.recentCwds.splice(this.cfg.spareCwds)) {
      const s = this.spares.get(old);
      if (s) {
        this.spares.delete(old);
        this.release(s);
      }
    }
  }

  private async create(cwd: string): Promise<KiroSession> {
    const proc = await this.process();
    const bridge = new Bridge(this.cfg.socketDir, this.log);
    await bridge.listen();
    try {
      const acpId = await proc.newSession(cwd, [bridge.spec()]);
      return { proc, acpId, bridge, cwd };
    } catch (err) {
      bridge.close();
      throw err;
    }
  }

  /** Least-loaded live process with capacity, spawning one when none has room. */
  private async process(): Promise<KiroProcess> {
    const usable = this.procs
      .filter(
        (p) =>
          p.isAlive &&
          p.liveSessions.size < this.cfg.maxSessionsPerProcess &&
          p.createdSessions < this.cfg.maxCreatedPerProcess,
      )
      .sort((a, b) => a.liveSessions.size - b.liveSessions.size);
    const best = usable[0];
    if (best) return best;
    if (this.starting) return this.starting;
    this.starting = this.spawn().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async spawn(): Promise<KiroProcess> {
    const proc = new KiroProcess(this.cfg, this.log);
    proc.onExit.add((p) => this.onExit(p));
    this.procs.push(proc);
    this.stats.processStarts++;
    try {
      await proc.start();
    } catch (err) {
      // onExit may already have removed it; splice(-1) would drop an unrelated healthy process.
      const i = this.procs.indexOf(proc);
      if (i >= 0) this.procs.splice(i, 1);
      void proc.stop();
      throw err;
    }
    return proc;
  }

  private onExit(proc: KiroProcess): void {
    this.stats.processExits++;
    const i = this.procs.indexOf(proc);
    if (i >= 0) this.procs.splice(i, 1);
    for (const [cwd, s] of this.spares) {
      if (s.proc === proc) {
        this.spares.delete(cwd);
        s.bridge.close();
      }
    }
    // Start failures are reported to the caller by spawn(); re-warming here would retry a broken kiro-cli.
    if (this.closed || !proc.started) return;
    // Respawn in the background and re-warm recent cwds so the next request is still fast.
    for (const cwd of this.recentCwds) void this.ensureSpare(cwd);
  }

  /** Stop processes that hit their creation budget once their last session is gone. */
  private recycleIdle(): void {
    for (const p of [...this.procs]) {
      const spareHere = [...this.spares.values()].some((s) => s.proc === p);
      if (p.createdSessions >= this.cfg.maxCreatedPerProcess && p.liveSessions.size === 0 && !spareHere) {
        this.procs.splice(this.procs.indexOf(p), 1);
        void p.stop().then((ms) => this.log.info("pool.recycled", { proc: p.id, stopMs: ms }));
      }
    }
  }
}
