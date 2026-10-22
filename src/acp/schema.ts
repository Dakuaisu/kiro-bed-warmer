import { z } from "zod";

export const InitializeResult = z.object({
  protocolVersion: z.number(),
  agentInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
});

export const ModelInfo = z.object({
  modelId: z.string(),
  name: z.string(),
  description: z.string().optional(),
});
export type ModelInfo = z.infer<typeof ModelInfo>;

export const NewSessionResult = z.object({
  sessionId: z.string(),
  models: z.object({ currentModelId: z.string(), availableModels: z.array(ModelInfo) }).optional(),
});

export const PromptResult = z.object({ stopReason: z.string() });

export const CommandResult = z.object({ success: z.boolean(), message: z.string().optional() });

const ContentText = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

export const SessionUpdate = z.discriminatedUnion("sessionUpdate", [
  z.object({ sessionUpdate: z.literal("agent_message_chunk"), content: ContentText }),
  z.object({ sessionUpdate: z.literal("agent_thought_chunk"), content: ContentText }),
  z.object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string(),
    title: z.string().optional(),
    _meta: z
      .object({ kiro: z.object({ toolName: z.string().optional() }).passthrough().optional() })
      .optional(),
  }),
  z.object({ sessionUpdate: z.literal("tool_call_chunk"), toolCallId: z.string().optional() }).passthrough(),
  z.object({ sessionUpdate: z.literal("tool_call_update"), toolCallId: z.string().optional() }).passthrough(),
  z
    .object({
      sessionUpdate: z.literal("session_info_update"),
      _meta: z
        .object({ kiro: z.object({ kind: z.string().optional() }).passthrough().optional() })
        .optional(),
    })
    .passthrough(),
]);
export type SessionUpdate = z.infer<typeof SessionUpdate>;

export const SessionScoped = z.object({ sessionId: z.string() }).passthrough();

export const SessionUpdateNotification = z.object({
  sessionId: z.string(),
  update: z.object({ sessionUpdate: z.string() }).passthrough(),
});

const Metering = z.object({ value: z.number(), unit: z.string() }).passthrough();
export const MetadataNotification = z.object({
  sessionId: z.string(),
  contextUsagePercentage: z.number().optional(),
  meteringUsage: z.array(Metering).optional(),
  turnDurationMs: z.number().optional(),
  reasoning: z
    .object({ support: z.string().optional(), effortLevels: z.array(z.string()).optional() })
    .passthrough()
    .optional(),
});
export type Metadata = z.infer<typeof MetadataNotification>;

export const CompactionStatus = z
  .object({
    sessionId: z.string().optional(),
    status: z.union([z.string(), z.object({ type: z.string() }).passthrough()]).optional(),
  })
  .passthrough();

/** kiro's view of a session's tools; sent after session/new and after every MCP re-list. */
export const CommandsAvailable = z
  .object({
    sessionId: z.string(),
    mcpServers: z
      .array(z.object({ name: z.string(), toolCount: z.number().optional() }).passthrough())
      .optional(),
    tools: z.array(z.object({ source: z.string().optional() }).passthrough()).optional(),
  })
  .passthrough();

export const PermissionRequest = z.object({
  sessionId: z.string(),
  toolCall: z
    .object({ toolCallId: z.string().optional(), title: z.string().optional() })
    .passthrough()
    .optional(),
  options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).passthrough()),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

/** Events a session listener receives (a parsed subset of kiro's notifications). */
export type SessionEvent =
  | { kind: "update"; update: SessionUpdate }
  | { kind: "metadata"; meta: Metadata }
  | { kind: "compacted" }
  | { kind: "other"; method: string };
