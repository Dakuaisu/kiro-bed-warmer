# Build "kiro-bed-warmer": a warm kiro-cli daemon + OpenCode provider

You are building a new project in `/Users/apple/kiro_bed_warmer` (currently empty). Goal: make Kiro models in OpenCode fast to *start* and resilient to Kiro backend stalls, by replacing the per-process, per-subagent kiro-cli spawning of the current `opencode-kiro` / `kiro-acp-ai-provider` stack with one long-lived, shared, pre-warmed kiro-cli daemon.

Read this whole brief before writing code. Everything below was measured on this machine on 2026-10-21 unless marked UNVERIFIED.

---

## 1. Environment (as of today)

- macOS, zsh. Remember zsh does NOT word-split unquoted `$VAR` — use arrays or `${=VAR}` in scripts.
- OpenCode **1.18.30** (plugin API v1). Do not target OpenCode v2 APIs.
- Global config: `~/.config/opencode/opencode.json` (+ `opencode.jsonc`), `~/.config/opencode/tui.json`. **Do not edit these without asking the user**; produce a config snippet for them instead.
- Current Kiro setup (keep it working, untouched):
  - Plugin `opencode-kiro@0.4.0` (pinned on purpose; 0.5.x targets OpenCode v2).
  - Provider id `kiro`, `npm: "kiro-acp-ai-provider"` (resolves to **3.3.2**; the plugin bundles 3.0.0), options include `agent`, `trustAllTools: true`, `mcpTimeout: 45` (**minutes**).
  - Models: `kiro/claude-opus-5.5` (user's main), `claude-sonnet-4.5`, `claude-haiku-4.5`, `auto`, `gpt-5.6-luna`, `gpt-5.6-sol`, `deepseek-3.2`, `qwen3-coder-next`, `glm-5`, `minimax-m2.5`, … (~20). All verified to do real tool calls today.
- Reference sources (MIT, read them, reuse ideas/code where useful):
  - `~/.cache/opencode/packages/kiro-acp-ai-provider/node_modules/kiro-acp-ai-provider/` (3.3.2: `dist/index.js` ~134 KB with `ACPClient` + `KiroACPLanguageModel`, `mcp-bridge.mjs`, `ipc.cjs`, README).
  - `~/.cache/opencode/packages/opencode-kiro@0.4.0/node_modules/opencode-kiro/` (auth loader, model hook).
- `kiro-cli` 2.32, logged in via **IAM Identity Center** (company seat, "Ethara"). Sign-in region ap-south-1, Kiro profile us-east-1. kiro-cli owns its auth in its own SQLite store.
- oh-my-openagent ("omo") plugin is installed. It has a `runtime_fallback` hook (`retry_on_errors` 429/500/502/503/504, `timeout_seconds` default 30, disabled by default); the user's config has `model_fallback: true`. Kiro stalls currently never trigger it because kiro-cli retries silently.

## 2. Hard constraints

1. **Only talk to Kiro through `kiro-cli acp`** (the sanctioned client). Never call Kiro/CodeWhisperer HTTP APIs directly, never read, copy, refresh, or write kiro-cli's tokens or its SQLite DB, never spoof IDE headers. (Reason: third-party direct clients were flagged by a Kiro team member as possibly triggering security flags; this is a company seat.)
2. Use kiro-cli's **default (v2) ACP engine**. `--agent-engine v3` measured slower today (8–13 s init, slower prompts, 5.6 s exit). Keep a flag to benchmark v3 later, default off.
3. New provider id (e.g. `kiro-warm`) so it coexists with the existing `kiro` provider for A/B comparison. Do not uninstall or modify `opencode-kiro`.
4. Daemon binds **127.0.0.1 only** and requires a bearer token (random, generated on first run, stored `0600` in the daemon's state dir). Flag this in the README.
5. Pin all dependency versions exactly.
6. No `as any`, `@ts-ignore`, empty catches. Strict TS. Files ≤ ~250 LOC. Parse-don't-validate at boundaries (Zod).
7. Clean up anything tests create: temp dirs, `.kiro/agents/*` files written into test cwds, and kiro-cli session files under `~/.kiro/sessions/` whose cwd points at your test dirs (only those — the user has real sessions there).

## 3. Why the current bridge is slow (measured)

Steady state is fine; startup and reloads are not.

| Cost | Where | Measured |
|---|---|---|
| `kiro-cli settings mcp.noInteractiveTimeout 45` exec before every spawn | `ensureMcpTimeoutSetting` | ~4 s, every opencode process, even though it's already set |
| `verifyAuth`: `execFileSync kiro-cli --version` + `whoami` | auth loader / `notifyIfTokenExpired` | ~3.4 s **blocking** |
| spawn + ACP `initialize` | per process | 1.9–5.4 s |
| first `session/new` in a process | | 1.8–4.7 s |
| new kiro-cli **per subagent** (`subClients`) and for toolless calls | | pays all of the above again (5–10 s) |
| `session/load` on **every new user message**, even if the session is live in the same process | `startFreshPrompt → acquireSession → loadPersistedSession` | 0.4 s on a 1-turn session; grows with history. Real sessions: first-token on new messages 12.1 s median → 17 s after ~120 steps (max 27 s) vs 10.2 s on Anthropic |
| agent config rewrite `.kiro/agents/default-<hash>.json` in cwd + new `mcp-bridge.mjs` node process per session | `createSessionWithToolsPath` | part of session/new cost; also litters user repos |
| `setMode` + `waitForToolsReady` (up to 5 s) | `ensureSessionMode` | |
| kiro-cli exit | shutdown | 1.1–2.8 s each (STOP_TIMEOUT 10 s) |

What is already good (keep this behavior):
- Tool hand-off kiro-cli → MCP bridge → IPC → opencode tool-call part: **~120 ms**, 100 ms of which is a deliberate debounce to batch parallel calls. 3 parallel `read` calls arrived in one step.
- Resume after tool result: model-bound (~2.5 s on haiku bench, 5.3 s median on real opus sessions). kiro-cli reuses its HTTPS connections (5 TCP conns stay ESTABLISHED across prompts) — no per-step handshake.
- Warm kiro-cli (v2), measured raw over ACP JSON-RPC:
  - later `session/new` in a warm process: **0.39–0.45 s**; with one stdio MCP server: 0.93–1.29 s
  - `session/set_model`: ~50 ms
  - warm prompt "reply PONG" (haiku): 1.0–1.3 s
  - `session/new` **honors per-session `mcpServers`** (a `noop` tool from a per-session stdio server became visible). **UNVERIFIED: whether that tool is isolated from other sessions in the same process — test this first (see §6).**
- Stalls: 31/244 real steps had a stall; 8–12 min of 66 min model time. kiro-cli silently retries; the provider only emits a "Kiro: no output…" reasoning notice every 10 s.

Expectation to communicate in the README: this removes ~8–14 s before the first message per window, ~5–10 s per Kiro subagent, ≥0.4 s (growing) per message in long sessions, and caps stalls via fallback. It does **not** speed up the model; bridge overhead was ~3 of 66 min in real use.

## 4. Architecture to build

```
opencode (any window, main agent or subagent)
  └─ provider kiro-warm  (@ai-sdk/openai-compatible, baseURL http://127.0.0.1:<port>/v1)
        │  OpenAI chat/completions, stream=true, tools, session header
        ▼
kiro-bed-warmer daemon (single per user, launchd-friendly, auto-started)
  ├─ HTTP server: /v1/chat/completions, /v1/models, /health, /metrics
  ├─ Session router: opencode session id → live kiro session (never session/load while live)
  ├─ Warm pool: ≥1 kiro-cli acp process, each with 1 spare pre-created session
  ├─ Tool relay: per-session MCP stdio bridge → daemon IPC → OpenAI tool_calls
  └─ Stall guard: silence > N s → abort step, return retryable 503
```

### 4.1 Daemon
- One process per user; lockfile + port file in state dir (e.g. `~/.local/state/kiro-bed-warmer/`). Client side auto-starts it if not running (detached), waits on `/health`.
- Spawn `kiro-cli acp` once at daemon start (not per request). Do **not** run `kiro-cli settings …` or `whoami` on the hot path; check auth lazily (on ACP auth error, return a clear 401-style error telling the user to run `kiro-cli login`).
- Warm pool: keep one spare pre-created session per process ready (so the first message costs ~0 setup). Refill in background after handing one out. Decide sessions-per-process limit after testing; spawn extra processes only when concurrency or isolation demands it.
- Handle kiro-cli crash/exit: mark its sessions dead, respawn, and let the router rebuild (see 4.3).
- Graceful shutdown on idle timeout (configurable, default e.g. 2 h) and SIGTERM.

### 4.2 Request mapping (OpenAI ⇄ ACP)
- **Session key**: find which header opencode sends for session affinity / parent session (the current provider uses session-affinity and `x-parent-session-id`). **UNVERIFIED for `@ai-sdk/openai-compatible`** — first thing to do is log incoming headers from a real opencode request. If no stable header arrives, use opencode's `chat.headers` plugin hook (write a tiny companion opencode plugin) to inject one.
- **Model/effort**: map `model` → `session/set_model` (only when changed). Mirror the existing provider's effort/variant handling.
- **System prompt**: kiro-cli has no system role; the current provider wraps it into the prompt as `<system_instructions>`. Reuse that approach. Hash it; if the system prompt for a live session changes, treat as divergence.
- **New user turn**: if the incoming history = known history + new user message → send only the new message via `session/prompt` on the live session.
- **Tool continuation**: when kiro-cli calls an MCP tool, stream it out as OpenAI `tool_calls` (keep the 100 ms batching window), end the HTTP response with `finish_reason: "tool_calls"`, and keep the ACP turn suspended. The next request carrying `role: "tool"` results for those ids → resolve the pending MCP calls; stream the continuation.
- **Divergence** (compaction, revert/undo, fork, edited message, unknown session after daemon restart): start a fresh kiro session from the warm pool and seed it with a compact text transcript of the history (look at how the current provider handles non-affinity history), then continue. Log it.
- **Reasoning**: stream kiro thought chunks as `reasoning_content` deltas (check what `@ai-sdk/openai-compatible` at the pinned version accepts). Never inject stall notices as reasoning — that would fool omo's inactivity timer.
- **Usage**: report whatever kiro-cli gives (turn duration, credits). Don't fabricate token counts.
- **Abort**: client disconnect → `session/cancel`, resolve any pending tool calls with an error, keep the session reusable.

### 4.3 Tools per session
- Pass tools per session via `mcpServers` in `session/new` (a stdio MCP bridge like `mcp-bridge.mjs`, pointed at the daemon over a local socket/port with the session id). No agent-config file writes into user repos.
- Tools change between requests (different agents): support `tools/list_changed` on the bridge rather than recreating the session.
- If the isolation test (§6 step 1) fails, fall back to one kiro-cli process per *tool-set* (still pooled and warm), never per request.
- `trustAllTools` equivalent: auto-approve kiro-cli permission requests for bridge tools only; opencode's own permission rules still apply because opencode executes the tools. Do not enable kiro-cli built-in tools or the user's Kiro MCP config.
- Tool-call timeout: honor a configurable timeout (current setup is 45 min).

### 4.4 Stall → fallback
- If no ACP output for `stallSeconds` (default 30, configurable), cancel the turn and respond with HTTP 503 + a JSON error body. The goal is that omo `runtime_fallback` / `model_fallback` retries that step on the agent's fallback model (Anthropic). **Verify** with omo enabled what actually triggers its fallback (status code vs error shape) and document the omo config snippet the user needs. Don't change the user's omo config yourself.
- Mid-tool-call (waiting on opencode to execute a tool) is NOT a stall.

## 5. Tech choices
- TypeScript, strict. Use the user's standard stack: Bun + Biome + tsc, Zod for parsing every HTTP body and ACP message. If Bun's child-process/stdio is a problem for kiro-cli, use Node 22 — justify it.
- Small modules: `acp/` (JSON-RPC client), `pool/`, `router/`, `mcp-bridge/`, `http/` (OpenAI surface), `stall/`, `cli/` (start/stop/status/bench).
- Structured logs (JSON lines) to the state dir; `--debug` logs every ACP method with timings.
- Ship a `bench` command that reproduces the measurements in §3 against both `kiro` and `kiro-warm`.

## 6. Order of work
1. **Spike, before the design hardens** (throwaway scripts in `/private/tmp`, clean up after):
   a. One kiro-cli process, two sessions, each with its own stdio MCP server exposing different tools. Ask each session to list its tools. Confirm isolation.
   b. Confirm a session stays usable across many prompts without `session/load`.
   c. Log the headers a real opencode 1.18.30 request sends to an `@ai-sdk/openai-compatible` baseURL.
   Report the results to the user before continuing if (a) or (c) fails.
2. ACP client + warm pool + `/health`.
3. OpenAI streaming surface, text only, new-turn path.
4. Tool relay + suspended turns + parallel tool batching.
5. Divergence handling + crash recovery.
6. Stall guard + omo fallback verification.
7. README with the opencode.json provider snippet (`kiro-warm`, `npm: "@ai-sdk/openai-compatible"` pinned, `baseURL`, `apiKey` = daemon token, model list), security note, and benchmark results.

## 7. Definition of done
- `bun test` (or chosen runner) green: unit tests for message diffing/divergence, tool-call mapping, stall guard; integration test against real kiro-cli using `claude-haiku-4.5` (cheap).
- Real use through opencode, not just tests: in a scratch dir, `opencode run -m kiro-warm/claude-haiku-4.5` with (1) a plain reply, (2) a prompt that must read 3 files in parallel and return a random UUID from them (verify tool parts in the opencode DB, `~/.local/share/opencode/` SQLite), (3) a second message in the same session (no `session/load` in debug log), (4) a subagent call, (5) a simulated stall (fake slow MCP/ACP stub) producing a 503 and, with omo fallback enabled in a test config, a retry on another model.
- Bench table: first-message latency per new window, per-subagent overhead, new-message overhead at 1 and ~50 turns, per-tool-step overhead — `kiro` vs `kiro-warm`. Expect: first message saves ~8–14 s, subagents ~5–10 s, per-step unchanged.
- No `.kiro/agents` files written into project dirs; no leftover test sessions in `~/.kiro/sessions/`; daemon stops cleanly.
- Ask before: editing `~/.config/opencode/*`, installing anything globally, adding a launchd agent.
