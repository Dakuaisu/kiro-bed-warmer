type Json = Record<string, unknown>;

/** Models kiro-cli offered when this was written; the daemon's live /v1/models list is merged in. */
const KNOWN_MODELS = [
  "auto",
  "claude-opus-5.5",
  "claude-sonnet-5.5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-opus-4.8",
  "claude-opus-4.7",
  "claude-opus-4.6",
  "claude-sonnet-4.6",
  "claude-opus-4.5",
  "claude-sonnet-4.5",
  "claude-haiku-4.5",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "deepseek-3.2",
  "minimax-m2.5",
  "minimax-m2.1",
  "glm-5",
  "qwen3-coder-next",
];

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function defaultModel(id: string): Json {
  const big = /opus-5|sonnet-5|gpt-5\.6/.test(id);
  // Image input was verified on claude-opus-5.5 and claude-haiku-4.5; other vendors are left text-only.
  const vision = id.startsWith("claude-");
  return {
    name: `${id} (Kiro warm)`,
    tool_call: true,
    limit: { context: big ? 1_000_000 : 200_000, output: 32_000 },
    ...(vision ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}),
  };
}

/**
 * The `kiro-warm` provider block: defaults for every known and live model, overlaid field by field with
 * whatever the user's config already sets, so user entries win but missing fields (e.g. modalities) are
 * filled in.
 */
export function buildProvider(
  existing: unknown,
  liveModels: string[],
  baseURL: string,
  apiKey?: string,
): Json {
  const user = isRecord(existing) ? existing : {};
  const userModels = isRecord(user.models) ? user.models : {};
  const ids = [...new Set([...KNOWN_MODELS, ...liveModels, ...Object.keys(userModels)])];
  const models: Json = {};
  for (const id of ids) {
    const mine = userModels[id];
    const base = defaultModel(id);
    models[id] = isRecord(mine)
      ? {
          ...base,
          ...mine,
          limit: { ...(base.limit as Json), ...(isRecord(mine.limit) ? mine.limit : {}) },
        }
      : base;
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Kiro (warm daemon)",
    ...user,
    options: { ...(isRecord(user.options) ? user.options : {}), baseURL, ...(apiKey ? { apiKey } : {}) },
    models,
  };
}
