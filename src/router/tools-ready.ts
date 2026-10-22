import type { Logger } from "../log.ts";
import type { McpTool } from "../mcp/bridge.ts";
import type { KiroSession } from "../pool/pool.ts";

export class ToolsNotReadyError extends Error {}

/**
 * Install `tools` on the session's bridge and wait until kiro reports them registered, so the
 * prompt never runs without tools. Nudges kiro to re-list once; throws ToolsNotReadyError if it
 * still hasn't registered them.
 */
export async function installTools(
  s: KiroSession,
  tools: McpTool[],
  waitMs: number,
  log: Logger,
): Promise<void> {
  const { proc, acpId, bridge } = s;
  const reports = proc.toolReports;
  const t0 = Date.now();
  const mark = reports.mark(acpId);
  const changed = await bridge.setTools(tools);
  if (tools.length === 0) return;
  const after = changed ? mark : 0;
  let ok = await reports.wait(acpId, after, waitMs);
  if (!ok) {
    log.warn("router.tools_not_registered", { acpId, tools: tools.length, retrying: true });
    bridge.relist();
    ok = await reports.wait(acpId, after, waitMs);
  }
  if (!ok) {
    log.warn("router.tools_not_registered", { acpId, tools: tools.length, retrying: false });
    throw new ToolsNotReadyError(
      `kiro did not register the ${tools.length} opencode tools within ${2 * waitMs} ms`,
    );
  }
  const count = reports.count(acpId);
  log.debug("router.tools_ready", { acpId, tools: tools.length, kiro: count, ms: Date.now() - t0 });
  if (count !== tools.length)
    log.warn("router.tool_count_mismatch", { acpId, sent: tools.length, kiro: count });
}
