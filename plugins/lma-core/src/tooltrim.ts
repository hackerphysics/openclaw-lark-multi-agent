/**
 * lma-core :: toolTrim compaction (Phase 2)
 * ------------------------------------------
 * User spec (2026-10-10):
 *   - keep the most recent 10 tool calls visible (with results)
 *   - everything older: keep text, drop tool payload
 *   - manual trigger only (/compact tooltrim); auto-compaction keeps the
 *     built-in LLM summarizer
 *   - no per-tool whitelist
 *
 * Implementation: a registered CompactionProvider whose summarize() does NOT
 * call an LLM — it filters/serializes the batch into structured text. The
 * gateway handles all storage mechanics (checkpoints, successor transcript).
 *
 * Orchestration: the `lma.core.compact.tooltrim` gateway method performs the
 * provider config toggle -> sessions.compact -> restore dance so the bridge
 * calls exactly one method.
 */

const TOOLTRIM_PROVIDER_ID = "lma-tooltrim";
const CONFIG_PATH = "agents.defaults.compaction.provider";
/** Truncation for a KEPT tool result body (they can be enormous). */
const KEPT_RESULT_MAX = 2000;
/** Truncation for a kept text message (rarely needed; texts are small). */
const TEXT_MAX = 8000;

type ToolTrimParts = {
  toolName: string;
};

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[截断，原 ${text.length} 字符]`;
}

/** Extract visible text from an unknown message content shape. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n");
}

/** Collect tool-call descriptors (name + id) in order of appearance. */
function toolCallsOf(content: unknown): ToolTrimParts[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: any) => p && typeof p === "object" && (p.type === "toolCall" || p.type === "tool_use"))
    .map((p: any) => ({ toolName: String(p.name ?? p.toolName ?? "tool") }));
}

function isToolResultMessage(msg: any): boolean {
  if (msg?.role === "toolResult" || msg?.role === "tool") return true;
  return Array.isArray(msg?.content) && msg.content.some((p: any) => p?.type === "toolResult" || p?.type === "tool_result");
}

function toolResultText(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (!Array.isArray(msg?.content)) return "";
  return msg.content
    .filter((p: any) => p && (p.type === "toolResult" || p.type === "tool_result"))
    .map((p: any) => typeof p.content === "string" ? p.content : messageText(p.content ?? p))
    .join("\n");
}

export function toolTrimProvider() {
  return {
    id: TOOLTRIM_PROVIDER_ID,
    label: "LMA ToolTrim (keep text; keep only the 10 most recent tool calls)",
    async summarize(params: { messages: unknown[]; signal?: AbortSignal; previousSummary?: string }): Promise<string> {
      const messages = Array.isArray(params.messages) ? params.messages : [];
      // Pass 1: count tool calls to decide which ones are in the "last 10" set.
      // Tool calls appear as parts on assistant messages; their results as
      // standalone toolResult messages right after. We count tool-call
      // occurrences from the END.
      let totalToolCalls = 0;
      for (const m of messages as any[]) {
        totalToolCalls += toolCallsOf(m?.content).length;
      }
      const firstKeptIndex = Math.max(1, totalToolCalls - 10 + 1); // 1-based ordinal of first kept call
      let ordinal = 0;
      const lines: string[] = [];
      if (params.previousSummary) {
        lines.push("【先前压缩摘要】");
        lines.push(clamp(params.previousSummary, TEXT_MAX));
        lines.push("");
      }
      lines.push("【ToolTrim 压缩记录】以下为历史对话的结构化保留：文本消息完整保留；工具调用仅保留最近 10 条（含结果），更早的工具调用仅保留名称标记。");
      lines.push("");
      for (const m of messages as any[]) {
        const role = String(m?.role ?? "");
        const content = m?.content;
        if (isToolResultMessage(m)) {
          ordinal += 1;
          if (ordinal >= firstKeptIndex) {
            lines.push(`[工具结果 #${ordinal}] ${clamp(toolResultText(m), KEPT_RESULT_MAX)}`);
          } else {
            lines.push(`[工具结果 #${ordinal} 已过滤]`);
          }
          continue;
        }
        const calls = toolCallsOf(content);
        const text = messageText(content).trim();
        if (calls.length > 0) {
          for (const c of calls) {
            ordinal += 1;
            lines.push(ordinal >= firstKeptIndex
              ? `[工具调用 #${ordinal} 保留] ${c.toolName}`
              : `[工具调用 #${ordinal} 已过滤] ${c.toolName}`);
          }
          if (text) lines.push(`${role === "assistant" ? "助手" : role || "消息"}: ${clamp(text, TEXT_MAX)}`);
          continue;
        }
        if (text) {
          const who = role === "user" ? "用户" : role === "assistant" ? "助手" : role || "消息";
          lines.push(`${who}: ${clamp(text, TEXT_MAX)}`);
        }
      }
      return lines.join("\n");
    },
  };
}

/**
 * Orchestration note: plugins cannot call gateway RPCs (trusted-only), so
 * the BRIDGE performs the validated toggle dance (config.set {raw, baseHash}
 * -> sessions.compact -> restore). This method only reports provider status.
 */
export function registerToolTrim(api: any): void {
  api.registerCompactionProvider(toolTrimProvider());

  api.registerGatewayMethod("lma.core.compact.tooltrim", ({ respond }: any) => {
    respond(true, {
      provider: TOOLTRIM_PROVIDER_ID,
      registered: true,
      orchestration: "bridge",
      usage: "LMA bridge /compact tooltrim performs: config.set(provider) -> sessions.compact -> config restore",
      keepRecentToolCalls: 10,
    });
  }, { scope: "operator.read" });
}
