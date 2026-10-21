import { call, ensureDaemon, health } from "../client.ts";
import { loadConfig } from "../config.ts";
import { runDaemon } from "../daemon.ts";
import { errorMessage } from "../log.ts";
import { ensureToken, readLockPid, statePaths } from "../state.ts";

const USAGE = `kiro-bed-warmer <command>

  start [--foreground] [--debug] [--warm <cwd>]   start the daemon (detached unless --foreground)
  stop                                             graceful stop
  status                                           health + metrics
  token                                            print the bearer token file path
  bench [--providers kiro,kiro-warm] [--model M] [--runs N]   run the latency benchmark

Env: KBW_PORT, KBW_STATE_DIR, KBW_STALL_SECONDS, KBW_IDLE_SHUTDOWN_MINUTES, KBW_ENGINE=v2|v3, KBW_DEBUG=1, ...`;

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [cmd = "help", ...args] = argv;
  const debug = flag(args, "--debug");
  const cfg = loadConfig(process.env, debug ? { debug } : {});
  switch (cmd) {
    case "start": {
      const warm = option(args, "--warm");
      if (flag(args, "--foreground")) {
        await runDaemon(cfg, { logToStderr: process.stderr.isTTY === true, warmCwds: warm ? [warm] : [] });
        return process.exitCode === 3 ? 3 : 0;
      }
      const { health: h } = await ensureDaemon(cfg, { debug, ...(warm ? { warmCwd: warm } : {}) });
      process.stdout.write(`kiro-bed-warmer running: pid ${h.pid}, port ${cfg.port}\n`);
      return 0;
    }
    case "stop": {
      const token = ensureToken(cfg);
      const pid = readLockPid(cfg);
      if (!pid) {
        process.stdout.write("not running\n");
        return 0;
      }
      await call(cfg, token, "POST", "/v1/shutdown").catch(() => process.kill(pid, "SIGTERM"));
      const deadline = Date.now() + 20_000;
      while (readLockPid(cfg) !== undefined && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      const stopped = readLockPid(cfg) === undefined;
      process.stdout.write(stopped ? "stopped\n" : `still running (pid ${pid})\n`);
      return stopped ? 0 : 1;
    }
    case "status": {
      const token = ensureToken(cfg);
      const h = await health(cfg, token);
      if (!h) {
        process.stdout.write("not running\n");
        return 1;
      }
      const metrics = await (await call(cfg, token, "GET", "/metrics")).json();
      process.stdout.write(`${JSON.stringify({ health: h, metrics }, null, 2)}\n`);
      return 0;
    }
    case "token":
      ensureToken(cfg);
      process.stdout.write(`${statePaths(cfg).tokenFile}\n`);
      return 0;
    case "bench": {
      const { runBench } = await import("./bench.ts");
      return runBench(cfg, args);
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      return cmd === "help" || cmd === "--help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`kiro-bed-warmer: ${errorMessage(err)}\n`);
    process.exit(1);
  },
);
