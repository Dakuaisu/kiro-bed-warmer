import type { Msg } from "./messages.ts";

/** What the router knows about a live kiro session, in terms of the opencode history. */
export type SessionView = {
  /** Fingerprints of the opencode messages kiro already knows. */
  history: readonly string[];
  systemHash: string | undefined;
  /** Whether kiro produced the latest assistant output itself (vs. interrupted / answered elsewhere). */
  lastOutcome: "none" | "completed" | "interrupted";
  /** Tool-call ids handed to opencode and still awaited, when a turn is suspended. */
  pendingToolIds: readonly string[] | undefined;
};

export type Plan =
  | { kind: "continue_tools"; results: ReadonlyMap<string, string> }
  | { kind: "abort_tools" }
  | { kind: "delta"; messages: Msg[] }
  | { kind: "catch_up"; messages: Msg[] }
  | { kind: "reset"; reason: string };

export function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  if (prefix.length > full.length) return false;
  return prefix.every((h, i) => full[i] === h);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Tool continuation: suffix is exactly [assistant(pending tool_calls), tool results for all of them]. */
function matchContinuation(
  suffix: Msg[],
  pending: readonly string[],
): ReadonlyMap<string, string> | undefined {
  const [head, ...rest] = suffix;
  if (head?.role !== "assistant") return undefined;
  if (
    !sameSet(
      head.toolCalls.map((t) => t.id),
      pending,
    )
  )
    return undefined;
  const results = new Map<string, string>();
  for (const m of rest) {
    if (m.role !== "tool" || !pending.includes(m.toolCallId)) return undefined;
    results.set(m.toolCallId, m.text);
  }
  return results.size === pending.length ? results : undefined;
}

/**
 * Decide how an incoming request maps onto a live kiro session. Pure; unit-tested.
 * `fps` are fingerprints of `messages` (same order).
 */
export function planRequest(
  view: SessionView | undefined,
  messages: Msg[],
  fps: readonly string[],
  systemHash: string,
  onSystemChange: "reset" | "redeliver",
): Plan {
  if (!view) return { kind: "reset", reason: "unknown_session" };
  if (!isPrefix(view.history, fps)) {
    return view.pendingToolIds ? { kind: "abort_tools" } : { kind: "reset", reason: "history_mismatch" };
  }
  const suffix = messages.slice(view.history.length);
  if (view.pendingToolIds) {
    const results = matchContinuation(suffix, view.pendingToolIds);
    return results ? { kind: "continue_tools", results } : { kind: "abort_tools" };
  }
  if (view.systemHash !== undefined && view.systemHash !== systemHash && onSystemChange === "reset") {
    return { kind: "reset", reason: "system_changed" };
  }
  if (suffix.length === 0) {
    // Same history again (client retry after an error): repeat the last user message, else nudge.
    const last = messages.at(-1);
    return last?.role === "user" ? { kind: "delta", messages: [last] } : { kind: "catch_up", messages: [] };
  }
  const ours = view.lastOutcome === "completed" && suffix[0]?.role === "assistant";
  const rest = ours ? suffix.slice(1) : suffix;
  if (rest.length > 0 && rest.every((m) => m.role === "user")) return { kind: "delta", messages: rest };
  return { kind: "catch_up", messages: rest };
}
