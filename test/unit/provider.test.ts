import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProvider } from "../../plugin/provider.ts";

const URL = "http://127.0.0.1:47900/v1";
type Model = { name?: string; attachment?: boolean; limit?: { context?: number; output?: number } };
const modelsOf = (p: Record<string, unknown>): Record<string, Model> => p.models as Record<string, Model>;

describe("kiro-warm provider block from the plugin", () => {
  it("creates the whole provider when the config has none", () => {
    const p = buildProvider(undefined, ["brand-new-model"], URL, "tok");
    assert.equal(p.npm, "@ai-sdk/openai-compatible");
    assert.deepEqual(p.options, { baseURL: URL, apiKey: "tok" });
    const m = modelsOf(p);
    assert.equal(m["claude-opus-5.5"]?.limit?.context, 1_000_000);
    assert.equal(m["claude-haiku-4.5"]?.limit?.context, 200_000);
    assert.equal(m["claude-haiku-4.5"]?.attachment, true);
    assert.equal(m["glm-5"]?.attachment, undefined);
    assert.ok(m["brand-new-model"], "models the daemon reports are added");
  });

  it("keeps the user's fields and fills in the missing ones", () => {
    const user = {
      name: "Mine",
      options: { timeout: 5 },
      models: { "claude-opus-5.5": { name: "My Opus", limit: { output: 8000 } } },
    };
    const p = buildProvider(user, [], URL);
    assert.equal(p.name, "Mine");
    assert.deepEqual(p.options, { timeout: 5, baseURL: URL });
    const opus = modelsOf(p)["claude-opus-5.5"];
    assert.equal(opus?.name, "My Opus");
    assert.deepEqual(opus?.limit, { context: 1_000_000, output: 8000 });
    assert.equal(opus?.attachment, true);
  });
});
