# kiro-bed-warmer

One long-lived, pre-warmed `kiro-cli acp` daemon shared by every OpenCode window and subagent, exposed as an
OpenAI-compatible endpoint (`kiro-warm` provider). It removes kiro-cli startup cost from the hot path and turns
silent Kiro stalls into retryable errors so omo can fall back.

It talks to Kiro **only through `kiro-cli acp`** (default v2 engine). It never calls Kiro/CodeWhisperer HTTP APIs,
never reads or copies kiro-cli tokens or its SQLite store, and never spoofs IDE headers.

## What it changes (and what it doesn't)

Measured on this machine (2026-10-21, `claude-haiku-4.5`, `kiro-bed-warmer bench`, medians of 3; the existing
`kiro` provider vs `kiro-warm`, both through real `opencode run`):

| metric | kiro-warm | kiro |
|---|---|---|
| new window: `opencode run` wall time | 8.43 s | 15.77 s |
| new window: user msg → first output | 6.36 s | 13.57 s |
| subagent: user msg → first output | 1.47 s | 5.87 s |
| new message, turns 2–4 (long-lived `opencode serve`) | 1.34 s | 1.78 s |
| new message, last 3 of 50 turns | 1.16 s | 1.51 s |
| tool result → next step output | 1.31 s | 1.33 s |

- **First message per window: ~7 s faster.** No `kiro-cli settings`/`whoami` exec, no spawn/initialize, and a
  spare kiro session is pre-created for the window's directory when the plugin loads.
- **Each Kiro subagent: ~4.4 s faster.** Subagents take a spare session from the warm process instead of spawning
  kiro-cli.
- **Each new message: ≥0.4 s faster, growing with history.** A live session is never `session/load`ed; only the
  new user message is sent. The bench sessions are tiny (one-word turns), so this row understates real sessions,
  where `session/load` grows with history.
- **Per tool step: unchanged** (model-bound), as expected.
- **Stalls are capped**: no ACP output for `KBW_STALL_SECONDS` (default 30) → the step fails with a retryable
  503 that omo's `runtime_fallback` turns into a retry on the fallback model.

It does **not** make the model faster. In real use, bridge overhead was ~3 of 66 minutes.

## Requirements

- macOS, Node ≥ 24 (runs the TypeScript sources directly via Node's type stripping, so there is no build step).
- `kiro-cli` on `PATH`, logged in (`kiro-cli login`).
- `/usr/bin/nc` (ships with macOS). The per-session MCP relay uses `nc -U`; there is a Node relay fallback.
- OpenCode 1.18.x (plugin API v1).

```sh
cd ~/kiro_bed_warmer && npm ci      # local devDependencies only; nothing global
```

## OpenCode configuration

The companion plugin starts the daemon on demand, injects `baseURL` and the bearer token into the provider
options **in memory** (the token is never written into `opencode.json`), adds the window's directory as a header,
and pre-warms a session for it. Add this to `~/.config/opencode/opencode.json` (I have not edited it):

```jsonc
{
  "plugin": [
    // keep your existing entries, e.g. "opencode-kiro@0.4.0"
    "file:///Users/apple/kiro_bed_warmer/plugin/kiro-warm.ts"
  ],
  "provider": {
    "kiro-warm": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kiro (warm daemon)",
      "options": { "baseURL": "http://127.0.0.1:47900/v1" },
      "models": {
        "claude-opus-5.5":   { "name": "Claude Opus 5.5 (warm)",   "tool_call": true, "limit": { "context": 1000000, "output": 32000 } },
        "claude-opus-5":     { "name": "Claude Opus 5 (warm)",     "tool_call": true, "limit": { "context": 1000000, "output": 32000 } },
        "claude-sonnet-5.5": { "name": "Claude Sonnet 5.5 (warm)", "tool_call": true, "limit": { "context": 1000000, "output": 32000 } },
        "claude-sonnet-4.5": { "name": "Claude Sonnet 4.5 (warm)", "tool_call": true, "limit": { "context": 200000,  "output": 32000 } },
        "claude-haiku-4.5":  { "name": "Claude Haiku 4.5 (warm)",  "tool_call": true, "limit": { "context": 200000,  "output": 32000 } },
        "gpt-5.6-sol":       { "name": "GPT 5.6 Sol (warm)",       "tool_call": true, "limit": { "context": 1000000, "output": 32000 } },
        "gpt-5.6-luna":      { "name": "GPT 5.6 Luna (warm)",      "tool_call": true, "limit": { "context": 1000000, "output": 32000 } },
        "auto":              { "name": "Kiro auto (warm)",         "tool_call": true, "limit": { "context": 200000,  "output": 32000 } }
      }
    }
  }
}
```

- `@ai-sdk/openai-compatible` is **bundled inside the opencode 1.18.30 binary** and is not installed from npm, so
  the `npm` field cannot be version-pinned. Pinning means pinning opencode.
- Any model kiro-cli offers can be listed. Run `GET /v1/models` (or `kiro-bed-warmer status`) for the current set:
  `auto claude-opus-5.5 claude-sonnet-5.5 claude-opus-5 claude-sonnet-5 claude-opus-4.8 gpt-5.6-sol gpt-5.6-terra
  gpt-5.6-luna claude-opus-4.7 claude-opus-4.6 claude-sonnet-4.6 claude-opus-4.5 claude-sonnet-4.5 claude-haiku-4.5
  deepseek-3.2 minimax-m2.5 minimax-m2.1 glm-5 qwen3-coder-next`.
- `kiro-warm` coexists with the existing `kiro` provider (`opencode-kiro@0.4.0`, untouched) for A/B use.
- Without the plugin, set `options.apiKey` to the contents of `~/.local/state/kiro-bed-warmer/token` and start the
  daemon yourself (`bin/kiro-bed-warmer start`). Without the cwd header, the daemon reads `Working directory:` from
  opencode's system prompt.

### omo fallback on stalls

Verified with omo 4.19.4 against a fake stalling kiro-cli, in a real `opencode serve`:

- `runtime_fallback` **must be enabled**. With only `model_fallback: true` (your current setting), omo marked a
  pending fallback but its prompt gate skipped it ("latest assistant is still active") and nothing was retried.
- With it enabled, both a 503 before any output and an error after partial text fell back within ~10 ms, and the
  fallback model's answer landed in the same session.
- omo picks the fallback target from the **agent's** `model` + `fallback_models` chain (it logged
  "Derived model from agent config"), so put the model you want to land on right after the `kiro-warm` primary.

Suggested `~/.omo/omo.jsonc` change (not applied):

```jsonc
"runtime_fallback": { "enabled": true, "retry_on_errors": [429, 500, 502, 503, 504], "max_fallback_attempts": 2 },
"agents": {
  "sisyphus": {
    "model": "kiro-warm/claude-opus-5.5",
    "fallback_models": ["anthropic/claude-opus-5-5", "kiro/claude-opus-5.5", "anthropic/claude-opus-5"]
  }
}
```

Unverified: how omo's own `timeout_seconds` (default 30) interacts with `KBW_STALL_SECONDS` in a long real
session. Keep the daemon's stall timeout ≤ omo's timeout so the daemon's 503 arrives first.

## Security

- The HTTP server binds **127.0.0.1 only**. **Every route, including `/health`, requires a bearer token.**
- The token is 32 random bytes, generated on first run at `~/.local/state/kiro-bed-warmer/token` (mode `0600`,
  dir `0700`). Any process running as your user can read it, the same as kiro-cli's own credentials. This is not a
  boundary between local users or processes.
- Each kiro session gets its own MCP bridge on a Unix socket in the `0700` state dir. The daemon auto-approves
  kiro permission requests **only for tools from that bridge** (`@oc/<tool>`) and rejects anything else. The tools
  are opencode's, and opencode executes them under its own permission rules.
- kiro-cli built-in tools are disabled (agent config `tools: []`), and your Kiro MCP config is not loaded
  (`includeMcpJson: false`). That agent config lives in the daemon's private work dir, never in your repos.

## How it works

```
opencode (window / subagent) ──OpenAI chat/completions (SSE, tools)──▶ daemon 127.0.0.1:47900
  plugin: token, x-kbw-cwd, pre-warm                                  ├─ router: opencode session → live kiro session
                                                                      ├─ pool: warm kiro-cli acp + spare session per cwd
                                                                      ├─ bridge: per-session MCP over unix socket (nc -U)
                                                                      └─ turn: tool batching, suspended turns, stall guard
```

- **Session key** is `x-session-affinity` (opencode sends it, plus `x-session-id`, and subagents add
  `x-parent-session-id`). Toolless calls get their own key. Verified against opencode 1.18.30.
- **New user turn**: if the request history is the known history plus our reply plus new user message(s), only the
  new message goes to `session/prompt`.
- **Tool calls**: kiro's MCP calls are batched for 100 ms and streamed as OpenAI `tool_calls` (`finish_reason:
  tool_calls`). The ACP turn stays suspended until the next request brings the `role: tool` results. Parallel calls
  arrive in one step.
- **Divergence** (revert/undo, compaction, fork, unknown session after a daemon restart, crashed kiro-cli): the
  daemon starts a fresh session from the pool and seeds it with a compact transcript, including tool calls and
  results. Steps answered elsewhere (fallback model) are caught up as context. These events are logged as
  `router.diverged`.
- **Fingerprints** tolerate plugin rewrites of earlier user messages (omo injects reminders into them) and
  opencode's pruning of old tool output.
- **System prompt**: sent as `<system_instructions>` on the first prompt. It is re-sent when it really changes,
  after kiro compacts, or above 70 % context. opencode lists skill paths in a different order per process, so the
  change check ignores line order and skill `<location>` lines.
- **Abort**: a client disconnect sends `session/cancel` and fails any pending tool calls. The session stays
  reusable.
- **Crash**: kiro-cli exit marks its sessions dead, the pool respawns and re-warms, and the router rebuilds from
  history on the next request.
- **Auth**: there is no `whoami` on the hot path. An ACP auth error returns HTTP 401 with "run `kiro-cli login`".

### Deliberate deviations from the brief

- **System prompt change → re-deliver, not reset** (`KBW_ON_SYSTEM_CHANGE=redeliver`). Every opencode process
  reorders the skill list, so "reset on change" reset every multi-process session (observed: 3/3 resets). Set
  `KBW_ON_SYSTEM_CHANGE=reset` to get the brief's behavior.
- **MCP bridge is `nc -U` to a daemon Unix socket**, not a Node bridge process. It is per session and isolated
  (verified: two sessions in one process only saw their own tools), supports `tools/list_changed`, and holds a tool
  call for at least 200 s (kiro's HTTP MCP transport dropped calls at about 120 s, so HTTP MCP was not used).
- **Node 24 instead of Bun**: Bun isn't installed here and installing it is a global change. Node runs the `.ts`
  files directly; tests use `node:test`.

## CLI

```sh
bin/kiro-bed-warmer start [--foreground] [--debug] [--warm <cwd>]
bin/kiro-bed-warmer stop | status | token
bin/kiro-bed-warmer bench [--providers kiro,kiro-warm] [--model claude-haiku-4.5] [--runs 3] [--turns 50]
```

Environment variables: `KBW_PORT` (47900), `KBW_STATE_DIR` (`~/.local/state/kiro-bed-warmer`),
`KBW_STALL_SECONDS` (30), `KBW_IDLE_SHUTDOWN_MINUTES` (120), `KBW_SESSION_IDLE_MINUTES` (180),
`KBW_TOOL_TIMEOUT_MINUTES` (45, which matches kiro's `mcp.noInteractiveTimeout`), `KBW_MAX_SESSIONS_PER_PROCESS`
(24), `KBW_SPARE_CWDS` (4), `KBW_TOOL_BATCH_MS` (100), `KBW_ENGINE=v2|v3` (v2), `KBW_ON_SYSTEM_CHANGE`,
`KBW_DEBUG=1` (logs every ACP method with timings).

Logs are JSON lines in `<state>/daemon.log`. `GET /metrics` reports spare hits, deltas, continuations and resets
by reason.

## Known limits

- **Token usage is not reported**, because kiro-cli doesn't expose token counts. opencode shows 0 tokens and $0 for
  `kiro-warm`, and will not auto-compact. kiro compacts its own context. Credits, context %, and turn duration are
  in the final SSE chunk (`kiro` field) and `/metrics`.
- The first message in a directory the plugin hasn't pre-warmed pays one `session/new` on the warm process
  (about 0.3 s).
- kiro-cli keeps its own session files in `~/.kiro/sessions/` for daemon sessions, as it does for the existing
  provider.
- There is no launchd agent: the plugin starts the daemon on demand and it exits after 2 h idle.

## Tests

```sh
npm run check              # tsc + biome + 31 unit tests (fake kiro-cli: diffing, tool mapping, batching, stall, abort, crash, auth)
npm run test:integration   # real kiro-cli, claude-haiku-4.5: context across turns w/o session/load, parallel tool round-trip
```

Tests use `/private/tmp/kbw-*` dirs and remove them, plus only the kiro session files whose cwd is under those
dirs.
