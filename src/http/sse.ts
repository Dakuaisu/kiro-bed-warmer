import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { EmittedCall, FinishReason, TurnError, TurnInfo, TurnSink } from "../router/turn.ts";

export function errorStatus(kind: TurnError["kind"]): number {
  switch (kind) {
    case "auth":
      return 401;
    case "stall":
    case "crash":
      return 503;
    case "cancelled":
    case "kiro":
      return 502;
  }
}

export function errorBody(err: TurnError): string {
  const type = err.kind === "auth" ? "authentication_error" : "server_error";
  return JSON.stringify({ error: { message: err.message, type, code: `kiro_${err.kind}` } });
}

function kiroUsage(info: TurnInfo): Record<string, unknown> {
  const m = info.metadata;
  const credits = m?.meteringUsage?.filter((u) => u.unit === "credit").reduce((a, u) => a + u.value, 0);
  return {
    wall_ms: info.wallMs,
    turn_duration_ms: m?.turnDurationMs ?? null,
    context_usage_percentage: m?.contextUsagePercentage ?? null,
    credits: credits ?? null,
  };
}

/**
 * OpenAI chat.completions writer. Headers are deferred until the first output so that an early failure
 * (stall before the first token, auth, crash) can still be reported with a real HTTP status.
 */
export class CompletionSink implements TurnSink {
  private readonly id = `chatcmpl-${randomBytes(12).toString("hex")}`;
  private readonly created = Math.floor(Date.now() / 1000);
  private started = false;
  private ended = false;
  private toolIndex = 0;
  private text_ = "";
  private reasoning_ = "";
  private readonly calls: EmittedCall[] = [];

  private readonly res: ServerResponse;
  private readonly model: string;
  private readonly stream: boolean;

  constructor(res: ServerResponse, model: string, stream: boolean) {
    this.res = res;
    this.model = model;
    this.stream = stream;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  text(delta: string): void {
    if (!this.stream) this.text_ += delta;
    else this.chunk({ content: delta });
  }

  reasoning(delta: string): void {
    if (!this.stream) this.reasoning_ += delta;
    else this.chunk({ reasoning_content: delta });
  }

  toolCalls(calls: EmittedCall[]): void {
    if (!this.stream) {
      this.calls.push(...calls);
      return;
    }
    this.chunk({
      tool_calls: calls.map((c) => ({
        index: this.toolIndex++,
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args },
      })),
    });
  }

  finish(reason: FinishReason, info: TurnInfo): void {
    if (this.ended) return;
    if (!this.stream) {
      const message = {
        role: "assistant",
        content: this.text_ || null,
        ...(this.reasoning_ ? { reasoning_content: this.reasoning_ } : {}),
        ...(this.calls.length > 0
          ? {
              tool_calls: this.calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: c.args },
              })),
            }
          : {}),
      };
      const body = {
        ...this.base("chat.completion"),
        choices: [{ index: 0, message, finish_reason: reason }],
      };
      this.json(200, JSON.stringify({ ...body, kiro: kiroUsage(info) }));
      return;
    }
    this.chunk({}, reason, { kiro: kiroUsage(info) });
    this.res.end("data: [DONE]\n\n");
    this.ended = true;
  }

  fail(err: TurnError): void {
    if (this.ended) return;
    if (!this.started) {
      this.json(errorStatus(err.kind), errorBody(err));
      return;
    }
    this.res.write(`data: ${errorBody(err)}\n\n`);
    this.res.end();
    this.ended = true;
  }

  private base(object: string): Record<string, unknown> {
    return { id: this.id, object, created: this.created, model: this.model };
  }

  private chunk(delta: Record<string, unknown>, finish: FinishReason | null = null, extra = {}): void {
    if (this.ended) return;
    if (!this.started) {
      this.started = true;
      this.res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      this.write({ role: "assistant", content: "" }, null, {});
    }
    this.write(delta, finish, extra);
  }

  private write(
    delta: Record<string, unknown>,
    finish: FinishReason | null,
    extra: Record<string, unknown>,
  ): void {
    const payload = {
      ...this.base("chat.completion.chunk"),
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    this.res.write(`data: ${JSON.stringify({ ...payload, ...extra })}\n\n`);
  }

  private json(status: number, body: string): void {
    this.ended = true;
    if (this.res.headersSent) {
      this.res.end();
      return;
    }
    this.res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    this.res.end(body);
  }
}
