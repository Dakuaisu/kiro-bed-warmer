/**
 * How many bridge tools kiro has registered per session, from `_kiro.dev/commands/available`.
 * A bridge answering tools/list is not enough: kiro registers the tools a moment later, and a
 * prompt sent in between runs with no tools.
 */
export class ToolReports {
  private readonly latest = new Map<string, { seq: number; count: number }>();
  private readonly waiters = new Set<() => void>();
  private seq = 0;

  record(sessionId: string, count: number): void {
    this.latest.set(sessionId, { seq: ++this.seq, count });
    for (const w of [...this.waiters]) w();
  }

  /** Sequence number of the session's latest report (0 if none); pass to `wait` as `after`. */
  mark(sessionId: string): number {
    return this.latest.get(sessionId)?.seq ?? 0;
  }

  count(sessionId: string): number | undefined {
    return this.latest.get(sessionId)?.count;
  }

  forget(sessionId: string): void {
    this.latest.delete(sessionId);
  }

  /** Resolve true once a report newer than `after` shows at least one bridge tool; false after `ms`. */
  wait(sessionId: string, after: number, ms: number): Promise<boolean> {
    const ok = (): boolean => {
      const r = this.latest.get(sessionId);
      return r !== undefined && r.seq > after && r.count > 0;
    };
    if (ok()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const finish = (v: boolean): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(v);
      };
      const check = (): void => {
        if (ok()) finish(true);
      };
      const timer = setTimeout(() => finish(false), ms);
      this.waiters.add(check);
    });
  }
}
