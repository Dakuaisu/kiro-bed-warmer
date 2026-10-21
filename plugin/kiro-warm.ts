import type { Plugin } from "@opencode-ai/plugin";
import { call, ensureDaemon, health } from "../src/client.ts";
import { loadConfig } from "../src/config.ts";
import { errorMessage } from "../src/log.ts";

const PROVIDER_ID = "kiro-warm";
const HEALTH_CACHE_MS = 5000;

/**
 * Companion plugin for the `kiro-warm` provider: starts the daemon on demand, injects baseURL + bearer token
 * into the provider options in memory (never written to opencode.json), tags requests with the window's
 * directory, and pre-warms a kiro session for that directory.
 */
export const KiroWarmPlugin: Plugin = async ({ directory }) => {
  const cfg = loadConfig(process.env);
  let token: string | undefined;
  let checkedAt = 0;

  const ensure = async (): Promise<string> => {
    if (token && Date.now() - checkedAt < HEALTH_CACHE_MS) return token;
    if (token && (await health(cfg, token, 300))) {
      checkedAt = Date.now();
      return token;
    }
    const started = await ensureDaemon(cfg, { warmCwd: directory });
    token = started.token;
    checkedAt = Date.now();
    return token;
  };

  void ensure()
    .then((t) => call(cfg, t, "POST", "/v1/warm", { cwd: directory }))
    .catch((err: unknown) => console.warn(`[kiro-warm] daemon not started: ${errorMessage(err)}`));

  return {
    config: async (config) => {
      const provider = config.provider?.[PROVIDER_ID];
      if (!provider) return;
      const t = await ensure().catch(() => undefined);
      provider.options = {
        ...provider.options,
        baseURL: `http://127.0.0.1:${cfg.port}/v1`,
        ...(t ? { apiKey: t } : {}),
      };
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== PROVIDER_ID) return;
      await ensure().catch((err: unknown) => console.warn(`[kiro-warm] ${errorMessage(err)}`));
      output.headers["x-kbw-cwd"] = directory;
    },
  };
};
