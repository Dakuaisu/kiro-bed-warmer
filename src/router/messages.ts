import { createHash } from "node:crypto";
import { type ChatMessage, type ChatRequest, ImagePart } from "../http/schema.ts";

export type Image = { data: string; mimeType: string };
export type ToolCallRef = { id: string; name: string; args: string };
export type Msg =
  | { role: "user"; text: string; images: Image[]; files: string[] }
  | { role: "assistant"; text: string; toolCalls: ToolCallRef[] }
  | { role: "tool"; toolCallId: string; text: string };

export type Conversation = { system: string; messages: Msg[] };

type Content = ChatMessage["content"];

function partsOf(content: Content): { texts: string[]; images: Image[]; files: string[] } {
  const out = { texts: [] as string[], images: [] as Image[], files: [] as string[] };
  if (typeof content === "string") out.texts.push(content);
  else if (Array.isArray(content)) {
    for (const p of content) {
      const img = ImagePart.safeParse(p);
      if (p.type === "text" && "text" in p && typeof p.text === "string") out.texts.push(p.text);
      else if (img.success) {
        const m = /^data:([^;,]+);base64,(.*)$/s.exec(img.data.image_url.url);
        if (m?.[1] && m[2]) out.images.push({ mimeType: m[1], data: m[2] });
        else out.files.push("[Image URL]");
      } else out.files.push(`[${p.type}]`);
    }
  }
  return out;
}

export function textOf(content: Content): string {
  return partsOf(content).texts.join("\n");
}

/** Normalize OpenAI chat messages into the router's model; system/developer messages are joined. */
export function normalize(req: Pick<ChatRequest, "messages">): Conversation {
  const system: string[] = [];
  const messages: Msg[] = [];
  for (const m of req.messages) {
    switch (m.role) {
      case "system":
      case "developer":
        system.push(textOf(m.content));
        break;
      case "user": {
        const p = partsOf(m.content);
        messages.push({ role: "user", text: p.texts.join("\n"), images: p.images, files: p.files });
        break;
      }
      case "assistant":
        messages.push({
          role: "assistant",
          text: textOf(m.content),
          toolCalls: (m.tool_calls ?? []).map((t) => ({
            id: t.id,
            name: t.function.name,
            args: t.function.arguments,
          })),
        });
        break;
      case "tool":
        messages.push({ role: "tool", toolCallId: m.tool_call_id, text: textOf(m.content) });
        break;
    }
  }
  return { system: system.filter((s) => s.length > 0).join("\n\n"), messages };
}

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/**
 * Stable per-message fingerprint. Plugins rewrite earlier user messages between requests (omo injects
 * reminders), and opencode prunes old tool output, so user messages hash by attachments only, tool results by
 * id, and tool calls by id+name. Revert/compaction/fork still show up as count or assistant/tool mismatches.
 */
export function fingerprint(m: Msg): string {
  switch (m.role) {
    case "user":
      return sha1(JSON.stringify(["u", m.images.map((i) => sha1(i.data))]));
    case "assistant":
      return sha1(JSON.stringify(["a", m.text.trim(), m.toolCalls.map((t) => [t.id, t.name])]));
    case "tool":
      return sha1(JSON.stringify(["t", m.toolCallId]));
  }
}

/**
 * System-prompt fingerprint that ignores line order and skill `<location>` paths: opencode lists the same skills
 * from different synced dirs in varying order across processes, which is not a real instruction change.
 */
export const hashSystem = (system: string): string =>
  sha1(
    [...new Set(system.split("\n").map((l) => l.trim()))]
      .filter((l) => l.length > 0 && !l.startsWith("<location>"))
      .sort()
      .join("\n"),
  );
