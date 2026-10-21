// Read-only helper over opencode's SQLite DB for tests/bench: messages and parts of a session.
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");

const MessageData = z
  .object({
    role: z.string(),
    providerID: z.string().optional(),
    modelID: z.string().optional(),
    finish: z.string().optional(),
    time: z.object({ created: z.number(), completed: z.number().optional() }).passthrough(),
    error: z.object({ name: z.string() }).passthrough().optional(),
  })
  .passthrough();

const PartData = z
  .object({
    type: z.string(),
    tool: z.string().optional(),
    text: z.string().optional(),
    state: z
      .object({
        status: z.string().optional(),
        time: z.object({ start: z.number(), end: z.number().optional() }).partial().optional(),
      })
      .passthrough()
      .optional(),
    time: z.object({ start: z.number(), end: z.number().optional() }).partial().optional(),
  })
  .passthrough();

const Row = z.object({ id: z.string(), data: z.string(), time_created: z.number() });
const SessionRow = z.object({ id: z.string(), parent_id: z.string().nullable() });

export type DbMessage = z.infer<typeof MessageData> & { id: string; parts: Array<z.infer<typeof PartData>> };

export function readSession(sessionId: string): DbMessage[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const msgs = z
      .array(Row)
      .parse(
        db
          .prepare("select id, data, time_created from message where session_id = ? order by time_created")
          .all(sessionId),
      );
    return msgs.map((m) => {
      const parts = z
        .array(Row)
        .parse(
          db
            .prepare("select id, data, time_created from part where message_id = ? order by time_created")
            .all(m.id),
        )
        .map((p) => PartData.parse(JSON.parse(p.data)));
      return { ...MessageData.parse(JSON.parse(m.data)), id: m.id, parts };
    });
  } finally {
    db.close();
  }
}

const IdRow = z.object({ id: z.string() });

/** Newest top-level session opencode created in `directory` since `sinceMs`. */
export function latestSession(directory: string, sinceMs: number): string | undefined {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const row = db
      .prepare(
        "select id from session where directory = ? and parent_id is null and time_created >= ? order by time_created desc limit 1",
      )
      .get(directory, sinceMs);
    const parsed = IdRow.safeParse(row);
    return parsed.success ? parsed.data.id : undefined;
  } finally {
    db.close();
  }
}

export function childSessions(parentId: string): string[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return z
      .array(SessionRow)
      .parse(db.prepare("select id, parent_id from session where parent_id = ?").all(parentId))
      .map((r) => r.id);
  } finally {
    db.close();
  }
}
