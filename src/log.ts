import { appendFileSync } from "node:fs";

export type Fields = Record<string, unknown>;

export type Logger = {
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  debug(event: string, fields?: Fields): void;
  readonly debugEnabled: boolean;
};

/** JSON-lines logger. Writes to `file` when given, else stderr. */
export function createLogger(file: string | undefined, debugEnabled: boolean): Logger {
  const write = (level: string, event: string, fields: Fields | undefined): void => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`;
    if (file) appendFileSync(file, line, { mode: 0o600 });
    else process.stderr.write(line);
  };
  return {
    debugEnabled,
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    debug: (event, fields) => {
      if (debugEnabled) write("debug", event, fields);
    },
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
