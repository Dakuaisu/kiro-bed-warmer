import type { Plugin } from "@opencode-ai/plugin";
import { z } from "zod";
import { call, ensureDaemon, health } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";
import { errorMessage } from "../src/log.ts";
import { buildProvider } from "./provider.ts";

const PROVIDER_ID = "kiro-warm";
const HEALTH_CACHE_MS = 5000;
const START_FAILURE_BACKOFF_MS = 30_000;
const ModelList = z.object({ data: z.array(z.object({ id: z.string() })) });

async function liveModels(cfg: ReturnType<typeof loadConfig>, token: string): Promise<string[]> {
  try {
    const res = await call(cfg, token, "GET", "/v1/models");
    const parsed = ModelList.safeParse(await res.json());
    return parsed.success ? parsed.data.data.map((m) => m.id) : [];
  } catch {
    return [];
  }
}

/**
 * Companion plugin for the `kiro-warm` provider: starts the daemon on demand, registers the provider (or
 * completes the user's own block) with baseURL + bearer token in memory (never written to opencode.json),
 * tags requests with the window's directory, and pre-warms a kiro session for that directory.
 */
export const KiroWarmPlugin: Plugin = async ({ directory }) => {
  const cfg = loadConfig(process.env);
  let token: string | undefined;
  let checkedAt = 0;
  let failure: { at: number; err: unknown } | undefined;

  const ensure = async (): Promise<string> => {
    if (token && Date.now() - checkedAt < HEALTH_CACHE_MS) return token;
    if (token && (await health(cfg, token, 300))) {
      checkedAt = Date.now();
      return token;
    }
    // Don't make every request wait on a start that just failed (e.g. port taken).
    if (failure && Date.now() - failure.at < START_FAILURE_BACKOFF_MS) throw failure.err;
    try {
      const started = await ensureDaemon(cfg, { warmCwd: directory });
      token = started.token;
      checkedAt = Date.now();
      failure = undefined;
      return token;
    } catch (err) {
      failure = { at: Date.now(), err };
      throw err;
    }
  };

  void ensure()
    .then((t) => call(cfg, t, "POST", "/v1/warm", { cwd: directory }))
    .catch((err: unknown) => console.warn(`[kiro-warm] daemon not started: ${errorMessage(err)}`));

  return {
    config: async (config) => {
      const t = await ensure().catch(() => undefined);
      const live = t ? await liveModels(cfg, t) : [];
      config.provider ??= {};
      config.provider[PROVIDER_ID] = buildProvider(
        config.provider[PROVIDER_ID],
        live,
        `http://127.0.0.1:${cfg.port}/v1`,
        t,
      );
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return;
      const t = await ensure().catch((err: unknown) => {
        console.warn(`[kiro-warm] ${errorMessage(err)}`);
        return undefined;
      });
      output.headers["x-kbw-cwd"] = directory;
      // Lets the daemon turn kiro's context % into token counts opencode measures against this limit.
      output.headers["x-kbw-context-limit"] = String(input.model.limit.context);
      // The config hook may have run while the daemon was down; send the token on every request.
      if (t) output.headers.Authorization = `Bearer ${t}`;
    },
  };
};
