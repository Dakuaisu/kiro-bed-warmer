import type { PromptBlock } from "../acp/process.ts";
import type { Msg } from "./messages.ts";

const MAX_TOOL_ARGS = 400;
const MAX_TOOL_RESULT = 2000;
const MAX_TRANSCRIPT = 300_000;

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}… [${s.length - n} chars cut]` : s;

function line(m: Msg, toolNames: Map<string, string>): string {
  switch (m.role) {
    case "user":
      return `User: ${[m.text, ...m.files, ...m.images.map((i) => `[Image: ${i.mimeType}]`)].filter(Boolean).join("\n")}`;
    case "assistant": {
      const calls = m.toolCalls.map((t) => {
        toolNames.set(t.id, t.name);
        return `[Tool call ${t.name} ${clip(t.args, MAX_TOOL_ARGS)}]`;
      });
      return `Assistant: ${[m.text, ...calls].filter(Boolean).join("\n")}`;
    }
    case "tool":
      return `[Tool result ${toolNames.get(m.toolCallId) ?? m.toolCallId}: ${clip(m.text, MAX_TOOL_RESULT)}]`;
  }
}

/** Compact text transcript; keeps the most recent part when over budget. */
export function transcript(messages: Msg[]): string {
  const names = new Map<string, string>();
  const text = messages.map((m) => line(m, names)).join("\n\n");
  return text.length > MAX_TRANSCRIPT ? `[earlier history omitted]\n…${text.slice(-MAX_TRANSCRIPT)}` : text;
}

/** Restate the open request so a resumed session keeps working on the task instead of re-greeting. */
function continueInstruction(history: Msg[]): string {
  const lastUser = history.findLast((m) => m.role === "user");
  const ask = lastUser?.role === "user" ? clip(lastUser.text, 4000) : "";
  return ask
    ? `Continue working on the latest user request, using the tool results above. The request was:\n\n${ask}`
    : "Continue from where the conversation above left off.";
}

const instructions = (system: string): string => `<system_instructions>\n${system}\n</system_instructions>`;

function userBlocks(prefix: string[], users: Msg[]): PromptBlock[] {
  const texts = [...prefix];
  const images: PromptBlock[] = [];
  for (const u of users) {
    if (u.role !== "user") continue;
    texts.push([u.text, ...u.files].filter(Boolean).join("\n"));
    for (const img of u.images) images.push({ type: "image", data: img.data, mimeType: img.mimeType });
  }
  return [{ type: "text", text: texts.filter(Boolean).join("\n\n") }, ...images];
}

/** First prompt of a fresh kiro session. With prior history, replays it as a transcript. */
export function seedPrompt(system: string, messages: Msg[]): PromptBlock[] {
  const head = system ? [instructions(system)] : [];
  let lastUser = messages.length;
  while (lastUser > 0 && messages[lastUser - 1]?.role === "user") lastUser--;
  const history = messages.slice(0, lastUser);
  const trailing = messages.slice(lastUser);
  if (history.length === 0) return userBlocks(head, trailing);
  const ctx = `<context>\n${transcript(history)}\n</context>`;
  if (trailing.length === 0) return userBlocks([...head, ctx, continueInstruction(history)], []);
  return userBlocks([...head, ctx, "Resume and act on the following message."], trailing);
}

/** New user turn on a live session. */
export function deltaPrompt(system: string | undefined, users: Msg[]): PromptBlock[] {
  return userBlocks(system ? [instructions(system)] : [], users);
}

/** Same request again after a cancelled turn: the user message is already in kiro's history. */
export function retryPrompt(system: string | undefined): PromptBlock[] {
  return userBlocks(system ? [instructions(system)] : [], []).map((b) =>
    b.type === "text"
      ? {
          type: "text",
          text: [b.text, "Your previous reply was interrupted. Answer my last message now."]
            .filter(Boolean)
            .join("\n\n"),
        }
      : b,
  );
}

/** Live session, but some messages happened elsewhere (other model, interrupted turn). */
export function catchUpPrompt(system: string | undefined, messages: Msg[]): PromptBlock[] {
  let lastUser = messages.length;
  while (lastUser > 0 && messages[lastUser - 1]?.role === "user") lastUser--;
  const foreign = messages.slice(0, lastUser);
  const trailing = messages.slice(lastUser);
  const parts = system ? [instructions(system)] : [];
  if (foreign.length > 0) {
    parts.push(
      "<context>\nThese conversation steps happened outside this session (for example answered by another " +
        `model after an interruption). Treat them as part of the conversation:\n\n${transcript(foreign)}\n</context>`,
    );
  }
  if (trailing.length === 0) parts.push(continueInstruction(messages));
  return userBlocks(parts, trailing);
}
