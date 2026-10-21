import type { Msg } from "./messages.ts";
import type { TurnSink } from "./turn.ts";

/** The parts of a live session the divergence diagnostics need. */
export type Known = { history: readonly string[]; messages: readonly Msg[]; system: string };

const brief = (m: Msg | undefined): string =>
  m === undefined
    ? "-"
    : `${m.role}:${JSON.stringify(m.role === "tool" ? m.toolCallId : m.text).slice(0, 160)}`;

/** Where a live session's known history stops matching the request (for divergence logs). */
export function firstDiff(
  live: Known | undefined,
  fps: readonly string[],
  msgs: Msg[],
): Record<string, unknown> {
  if (!live) return {};
  const i = live.history.findIndex((h, k) => fps[k] !== h);
  if (i < 0) return { knownLen: live.history.length };
  return { at: i, knownLen: live.history.length, was: brief(live.messages[i]), now: brief(msgs[i]) };
}

export function systemDiff(live: Known | undefined, now: string): Record<string, unknown> {
  if (!live || live.system === now) return {};
  let i = 0;
  while (i < now.length && now[i] === live.system[i]) i++;
  return { systemAt: i, systemWas: live.system.slice(i, i + 160), systemNow: now.slice(i, i + 160) };
}

/** Resolve `done` when the wrapped sink completes (finish or fail). */
export function tracked(sink: TurnSink): { sink: TurnSink; done: Promise<void> } {
  let resolve: () => void = () => undefined;
  const done = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    done,
    sink: {
      text: (d) => sink.text(d),
      reasoning: (d) => sink.reasoning(d),
      toolCalls: (c) => sink.toolCalls(c),
      finish: (r, i) => {
        sink.finish(r, i);
        resolve();
      },
      fail: (e) => {
        sink.fail(e);
        resolve();
      },
    },
  };
}
