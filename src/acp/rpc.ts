import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

const RpcId = z.union([z.number(), z.string()]);
const RpcError = z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() });
const RpcMessage = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: RpcId.optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: RpcError.optional(),
});
type RpcId = z.infer<typeof RpcId>;

export class RpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(method: string, err: z.infer<typeof RpcError>) {
    super(`${method}: ${err.message} (code ${err.code})`);
    this.code = err.code;
    this.data = err.data;
  }
}

export class RpcClosedError extends Error {}

type Pending = {
  method: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | undefined;
};

export type RpcHandlers = {
  /** Server→client request. Return the result; throw to answer with an error. */
  onRequest: (method: string, params: unknown) => Promise<unknown>;
  onNotification: (method: string, params: unknown) => void;
  onProtocolError: (line: string, err: unknown) => void;
  onTrace?: (dir: "out" | "in", method: string, ms?: number) => void;
};

/** Newline-delimited JSON-RPC 2.0 peer over a pair of streams. */
export class RpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, Pending>();
  private closed = false;
  private readonly out: Writable;
  private readonly handlers: RpcHandlers;

  constructor(input: Readable, out: Writable, handlers: RpcHandlers) {
    this.out = out;
    this.handlers = handlers;
    const rl = createInterface({ input });
    rl.on("line", (line) => this.onLine(line));
    rl.on("close", () => this.close(new RpcClosedError("stream closed")));
    rl.on("error", (err) => this.close(new RpcClosedError(`stream error: ${err.message}`)));
  }

  request(method: string, params: unknown, timeoutMs = 0): Promise<unknown> {
    if (this.closed) return Promise.reject(new RpcClosedError(`peer closed before ${method}`));
    const id = this.nextId++;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, {
        method,
        timer,
        reject,
        resolve: (v) => {
          this.handlers.onTrace?.("in", method, Date.now() - started);
          resolve(v);
        },
      });
      this.handlers.onTrace?.("out", method);
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.handlers.onTrace?.("out", method);
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(reason);
    }
    this.pending.clear();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private write(msg: object): void {
    this.out.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: z.infer<typeof RpcMessage>;
    try {
      msg = RpcMessage.parse(JSON.parse(trimmed));
    } catch (err) {
      this.handlers.onProtocolError(trimmed.slice(0, 200), err);
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answer(msg.id, msg.method, msg.params);
    } else if (msg.method !== undefined) {
      this.handlers.onNotification(msg.method, msg.params);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcRemoteError(p.method, msg.error));
      else p.resolve(msg.result);
    }
  }

  private async answer(id: RpcId, method: string, params: unknown): Promise<unknown> {
    try {
      const result = await this.handlers.onRequest(method, params);
      this.write({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.write({ jsonrpc: "2.0", id, error: { code: -32603, message } });
    }
    return undefined;
  }
}
