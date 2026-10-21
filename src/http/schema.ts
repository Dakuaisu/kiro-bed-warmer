import { z } from "zod";

const TextPart = z.object({ type: z.literal("text"), text: z.string() }).passthrough();
export const ImagePart = z
  .object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }).passthrough() })
  .passthrough();
const OtherPart = z.object({ type: z.string() }).passthrough();
const Part = z.union([TextPart, ImagePart, OtherPart]);
const Content = z.union([z.string(), z.array(Part), z.null()]).optional();

const ToolCall = z
  .object({
    id: z.string(),
    type: z.literal("function").optional(),
    function: z.object({ name: z.string(), arguments: z.string().default("") }),
  })
  .passthrough();

export const ChatMessage = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: Content }).passthrough(),
  z.object({ role: z.literal("developer"), content: Content }).passthrough(),
  z.object({ role: z.literal("user"), content: Content }).passthrough(),
  z
    .object({ role: z.literal("assistant"), content: Content, tool_calls: z.array(ToolCall).optional() })
    .passthrough(),
  z.object({ role: z.literal("tool"), tool_call_id: z.string(), content: Content }).passthrough(),
]);
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ToolDef = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type ToolDef = z.infer<typeof ToolDef>;

export const ChatRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(ChatMessage).min(1),
    tools: z.array(ToolDef).optional(),
    stream: z.boolean().optional(),
    reasoning_effort: z.string().optional(),
  })
  .passthrough();
export type ChatRequest = z.infer<typeof ChatRequest>;

export const WarmRequest = z.object({ cwd: z.string().startsWith("/") });
