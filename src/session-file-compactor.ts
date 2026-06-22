import { existsSync, copyFileSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export type ToolTrimResult = {
  ok: boolean;
  reason?: string;
  /** Bytes before / after, and line counts, for reporting. */
  bytesBefore?: number;
  bytesAfter?: number;
  linesBefore?: number;
  linesAfter?: number;
  removedToolResults?: number;
  strippedToolCalls?: number;
  removedEmptyAssistants?: number;
  keptRecentToolCalls?: number;
  backupPath?: string;
};

/**
 * Resolve the on-disk OpenClaw transcript file for a session.
 *
 * Session key looks like `agent:<agentId>:<label>` (e.g.
 * `agent:main:lma-claude-oc_xxx`). The transcript lives at
 * `<openclawHome>/agents/<agentId>/sessions/<sessionId>.jsonl`.
 */
export function resolveSessionFilePath(sessionKey: string, sessionId: string, openclawHome?: string): string | null {
  if (!sessionId) return null;
  const home = openclawHome
    || process.env.OPENCLAW_HOME
    || process.env.OPENCLAW_CONFIG_DIR
    || join(homedir(), ".openclaw");
  // agentId is the second segment of agent:<agentId>:<label>; default to "main".
  const parts = sessionKey.split(":");
  const agentId = parts.length >= 3 && parts[0] === "agent" ? parts[1] : "main";
  const file = join(home, "agents", agentId, "sessions", `${sessionId}.jsonl`);
  return existsSync(file) ? file : null;
}

/**
 * "Tool-trim" compaction: rewrite a session transcript in place, removing the
 * tool-call noise while keeping the conversation intact:
 *   - drop every toolResult message entirely;
 *   - strip the `toolCall` parts from assistant messages but KEEP their text
 *     (the model's "thinking out loud while acting"); if an assistant message
 *     had only tool calls and no text, drop the whole line;
 *   - fix `stopReason: "toolUse"` -> "stop" on messages that no longer have a
 *     tool call, so the loader is not confused.
 *
 * This does NOT call any model, so it works no matter how large the session is
 * (unlike OpenClaw's LLM-summary compaction, which itself fails to fit an
 * oversized session into the model). A backup is always written first.
 *
 * Typical reduction is ~70-90% for tool-heavy sessions.
 */
export function toolTrimCompactFile(filePath: string, keepRecentToolCalls: number = 3): ToolTrimResult {
  if (!existsSync(filePath)) return { ok: false, reason: "transcript file not found" };
  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  const bytesBefore = Buffer.byteLength(original, "utf8");

  // First pass: collect every toolCall id in order, so we can keep the most
  // recent N of them (and their matching toolResults) intact. Recent tool calls
  // are often still relevant to what the agent is doing next.
  const toolCallIds: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d?.type !== "message") continue;
    const msg = d.message;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p && typeof p === "object" && p.type === "toolCall" && p.id) toolCallIds.push(String(p.id));
      }
    }
  }
  const keepN = Math.max(0, Math.floor(keepRecentToolCalls));
  const keepIds = new Set(keepN > 0 ? toolCallIds.slice(-keepN) : []);

  const out: string[] = [];
  let removedToolResults = 0;
  let strippedToolCalls = 0;
  let removedEmptyAssistants = 0;
  let keptRecentToolCalls = 0;
  let linesBefore = 0;

  for (const line of lines) {
    if (line.trim() === "") { continue; } // drop blank lines; we re-join with \n
    linesBefore++;
    let d: any;
    try { d = JSON.parse(line); } catch { out.push(line); continue; }
    if (d?.type !== "message") { out.push(line); continue; }
    const msg = d.message;
    const role = msg?.role;

    if (role === "toolResult") {
      // Keep the toolResult only if its toolCall is in the recent keep-set.
      if (msg?.toolCallId && keepIds.has(String(msg.toolCallId))) { out.push(line); continue; }
      removedToolResults++; continue;
    }

    if (role === "assistant" && Array.isArray(msg?.content)) {
      const content = msg.content as any[];
      const hasToolCall = content.some((p) => p && typeof p === "object" && p.type === "toolCall");
      if (hasToolCall) {
        // Keep toolCalls that are in the recent keep-set; strip the rest.
        const kept = content.filter((p) => {
          if (!p || typeof p !== "object") return false;
          if (p.type !== "toolCall") return true;
          return p.id && keepIds.has(String(p.id));
        });
        const keptToolCall = kept.some((p) => p.type === "toolCall");
        const hasText = kept.some((p) => p.type === "text" && typeof p.text === "string" && p.text.trim() !== "");
        if (!keptToolCall && !hasText) { removedEmptyAssistants++; continue; }
        if (keptToolCall) {
          keptRecentToolCalls++;
          // stopReason stays toolUse since a toolCall remains.
          if (kept.length !== content.length) msg.content = kept;
          out.push(JSON.stringify(d));
          continue;
        }
        // All toolCalls stripped: keep text only, fix stopReason.
        msg.content = kept;
        if (msg.stopReason === "toolUse") msg.stopReason = "stop";
        strippedToolCalls++;
        out.push(JSON.stringify(d));
        continue;
      }
    }
    out.push(line);
  }

  // Safety: verify every output line is valid JSON before committing.
  for (const l of out) {
    try { JSON.parse(l); } catch { return { ok: false, reason: "produced invalid JSON; aborted" }; }
  }

  if (removedToolResults === 0 && strippedToolCalls === 0 && removedEmptyAssistants === 0) {
    return { ok: true, reason: "no tool content to trim", bytesBefore, bytesAfter: bytesBefore, linesBefore, linesAfter: out.length, keptRecentToolCalls };
  }

  // Always back up first.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-tooltrim-${stamp}`;
  copyFileSync(filePath, backupPath);

  // Atomic write: temp file + rename.
  const body = out.join("\n") + "\n";
  const tmp = `${filePath}.tmp-tooltrim`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, filePath);

  return {
    ok: true,
    bytesBefore,
    bytesAfter: Buffer.byteLength(body, "utf8"),
    linesBefore,
    linesAfter: out.length,
    removedToolResults,
    strippedToolCalls,
    removedEmptyAssistants,
    keptRecentToolCalls,
    backupPath,
  };
}
