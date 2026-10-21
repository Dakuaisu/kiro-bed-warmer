import {
  type BenchOptions,
  cleanupScratch,
  median,
  ocRun,
  ocServe,
  scratchProject,
  subagentFirstOutput,
  toolResumeGaps,
  userToFirstOutput,
} from "../bench/harness.ts";
import { removeKiroSessionsUnder } from "../bench/kiro-sessions.ts";
import { ensureDaemon } from "../client.ts";
import type { Config } from "../config.ts";
import { errorMessage } from "../log.ts";

function parse(args: string[], cfg: Config): BenchOptions {
  const get = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    providers: (get("--providers") ?? "kiro,kiro-warm").split(","),
    model: get("--model") ?? "claude-haiku-4.5",
    runs: Number(get("--runs") ?? 3),
    turns: Number(get("--turns") ?? 50),
    port: Number(get("--serve-port") ?? cfg.port + 300),
  };
}

type Row = { metric: string; values: Record<string, number | undefined> };
const fmt = (ms: number | undefined): string => (ms === undefined ? "n/a" : `${(ms / 1000).toFixed(2)} s`);

async function benchProvider(p: string, dir: string, o: BenchOptions, cfg: Config, log: (s: string) => void) {
  const m = `${p}/${o.model}`;
  const res: Record<string, number | undefined> = {};
  const wall: number[] = [];
  const first: number[] = [];
  for (let i = 0; i < o.runs; i++) {
    const r = await ocRun(dir, cfg, ["-m", m, "Reply with exactly: PONG"]);
    wall.push(r.wallMs);
    first.push(...userToFirstOutput(r.sessionId).slice(0, 1));
    log(`  ${p} new window #${i + 1}: wall ${fmt(r.wallMs)}, first output ${fmt(first.at(-1))}`);
  }
  res.windowWall = median(wall);
  res.windowFirst = median(first);

  const sub = await ocRun(dir, cfg, [
    "-m",
    m,
    `Call the task tool exactly once with subagent_type "bench-sub-${p}", run_in_background false, load_skills [], description "pong", prompt "Reply with exactly: SUB". Then reply with exactly: DONE`,
  ]);
  res.subagentFirst = subagentFirstOutput(sub.sessionId);
  log(`  ${p} subagent first output: ${fmt(res.subagentFirst)}`);

  const chain = await ocRun(dir, cfg, [
    "-m",
    m,
    "Read step1.txt with the read tool and follow its instructions until you find a file containing DONE-; reply with that token only. One read per step.",
  ]);
  res.toolResume = median(toolResumeGaps(chain.sessionId));
  log(`  ${p} tool resume gap (median): ${fmt(res.toolResume)}`);

  const serve = await ocServe(dir, cfg, o.port);
  try {
    const s = await ocRun(dir, cfg, ["--attach", serve.url, "-m", m, "Reply with exactly: T1"]);
    for (let t = 2; t <= o.turns; t++) {
      await ocRun(dir, cfg, ["--attach", serve.url, "-s", s.sessionId, "-m", m, `Reply with exactly: T${t}`]);
    }
    const lat = userToFirstOutput(s.sessionId);
    res.turn2 = median(lat.slice(1, 4));
    res.turnN = median(lat.slice(-3));
    log(`  ${p} message latency: turns 2-4 ${fmt(res.turn2)}, last 3 of ${lat.length} ${fmt(res.turnN)}`);
  } catch (err) {
    log(`  ${p} multi-turn phase failed: ${errorMessage(err)}`);
  } finally {
    serve.stop();
  }
  return res;
}

export async function runBench(cfg: Config, args: string[]): Promise<number> {
  const o = parse(args, cfg);
  const log = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  if (o.providers.includes("kiro-warm")) await ensureDaemon(cfg);
  const dir = scratchProject(o, cfg);
  log(`bench in ${dir} (model ${o.model}, ${o.runs} runs, ${o.turns} turns)`);
  const results: Record<string, Record<string, number | undefined>> = {};
  try {
    for (const p of o.providers) {
      log(`provider ${p}`);
      results[p] = await benchProvider(p, dir, o, cfg, log).catch((err: unknown) => {
        log(`  ${p} failed: ${errorMessage(err)}`);
        return {};
      });
    }
  } finally {
    cleanupScratch(dir);
    log(`removed ${removeKiroSessionsUnder([dir])} kiro session(s) under ${dir}`);
  }
  const rows: Row[] = [
    ["new window: opencode run wall time", "windowWall"],
    ["new window: user msg -> first output", "windowFirst"],
    ["subagent: user msg -> first output", "subagentFirst"],
    ["new message, turns 2-4", "turn2"],
    [`new message, last 3 of ${o.turns} turns`, "turnN"],
    ["tool result -> next step output", "toolResume"],
  ].map(([metric, key]) => ({
    metric: metric ?? "",
    values: Object.fromEntries(o.providers.map((p) => [p, results[p]?.[key ?? ""]])),
  }));
  log(`\n| metric | ${o.providers.join(" | ")} |\n|---|${o.providers.map(() => "---").join("|")}|`);
  for (const r of rows) log(`| ${r.metric} | ${o.providers.map((p) => fmt(r.values[p])).join(" | ")} |`);
  return 0;
}
