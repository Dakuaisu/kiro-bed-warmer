import { timingSafeEqual } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import { errorMessage, type Logger } from "../log.ts";
import type { Pool } from "../pool/pool.ts";
import type { Router } from "../router/router.ts";
import { ChatRequest, WarmRequest } from "./schema.ts";
import { CompletionSink } from "./sse.ts";

const MAX_BODY = 64 * 1024 * 1024;

export type HttpDeps = {
  cfg: Config;
  log: Logger;
  token: string;
  pool: Pool;
  router: Router;
  startedAt: number;
  onActivity: () => void;
  onShutdown: () => void;
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

const fail = (res: ServerResponse, status: number, message: string, code: string): void =>
  send(res, status, {
    error: { message, type: status === 401 ? "authentication_error" : "invalid_request_error", code },
  });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = Buffer.from(req.headers.authorization ?? "");
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};

const isDir = (p: string): boolean => p.startsWith("/") && existsSync(p) && statSync(p).isDirectory();

/** cwd for the kiro session: plugin header, else opencode's <env> block, else the daemon work dir. */
export function resolveCwd(headerCwd: string | undefined, system: string, fallback: string): string {
  if (headerCwd && isDir(headerCwd)) return headerCwd;
  const m = /Working directory:\s*(\/[^\n<]*)/.exec(system);
  const fromPrompt = m?.[1]?.trim();
  return fromPrompt && isDir(fromPrompt) ? fromPrompt : fallback;
}

async function chat(d: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readBody(req));
  } catch (err) {
    fail(res, 400, `invalid JSON body: ${errorMessage(err)}`, "invalid_json");
    return;
  }
  const parsed = ChatRequest.safeParse(raw);
  if (!parsed.success) {
    fail(res, 400, `invalid chat request: ${parsed.error.message.slice(0, 500)}`, "invalid_request");
    return;
  }
  const body = parsed.data;
  const sid = header(req, "x-session-affinity") ?? header(req, "x-session-id");
  const toolless = (body.tools ?? []).length === 0;
  const key = sid ? (toolless ? `${sid}:notools` : sid) : undefined;
  const system = body.messages.flatMap((m) =>
    m.role === "system" && typeof m.content === "string" ? [m.content] : [],
  );
  const cwd = resolveCwd(header(req, "x-kbw-cwd"), system.join("\n"), d.cfg.workDir);
  const sink = new CompletionSink(res, body.model, body.stream ?? false);
  const ac = new AbortController();
  res.on("close", () => {
    if (!sink.isEnded) ac.abort();
  });
  d.log.debug("http.chat", {
    key,
    parent: header(req, "x-parent-session-id"),
    model: body.model,
    cwd,
    n: body.messages.length,
  });
  await d.router.handle({ key, cwd, req: body }, sink, ac.signal);
}

async function route(d: HttpDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authorized(req, d.token)) {
    fail(res, 401, "missing or invalid bearer token", "unauthorized");
    return;
  }
  d.onActivity();
  const url = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && url === "/health") {
    send(res, 200, {
      status: "ok",
      pid: process.pid,
      uptimeMs: Date.now() - d.startedAt,
      processes: d.pool.processCount(),
      spares: d.pool.spareCount(),
      sessions: d.router.liveCount(),
      activeTurns: d.router.activeTurns(),
    });
  } else if (req.method === "GET" && url === "/metrics") {
    send(res, 200, { pool: d.pool.stats, router: d.router.stats, memory: process.memoryUsage().rss });
  } else if (req.method === "GET" && url === "/v1/models") {
    const data = d.pool
      .models()
      .map((m) => ({ id: m.modelId, object: "model", owned_by: "kiro", description: m.description }));
    send(res, 200, { object: "list", data });
  } else if (req.method === "POST" && url === "/v1/chat/completions") {
    await chat(d, req, res);
  } else if (req.method === "POST" && url === "/v1/warm") {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      body = undefined;
    }
    const w = WarmRequest.safeParse(body);
    if (!w.success || !isDir(w.data.cwd)) {
      fail(res, 400, "body must be {cwd: <absolute directory>}", "invalid_request");
      return;
    }
    void d.pool.ensureSpare(w.data.cwd);
    send(res, 202, { status: "warming", cwd: w.data.cwd });
  } else if (req.method === "POST" && url === "/v1/shutdown") {
    send(res, 202, { status: "stopping" });
    d.onShutdown();
  } else fail(res, 404, `no route for ${req.method} ${url}`, "not_found");
}

/** Bind 127.0.0.1 only. Every route (including /health) requires the bearer token. */
export function startHttp(d: HttpDeps): Promise<Server> {
  const server = createServer((req, res) => {
    route(d, req, res).catch((err: unknown) => {
      d.log.error("http.unhandled", { err: errorMessage(err) });
      if (!res.headersSent) fail(res, 500, errorMessage(err), "internal");
      else res.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(d.cfg.port, "127.0.0.1", () => resolve(server));
  });
}
