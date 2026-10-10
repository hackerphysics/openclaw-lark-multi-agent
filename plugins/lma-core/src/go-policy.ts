/** Message-review checker: no tools at all. Exact host identity, never prefixes. */
export type Binding = { checkerSessionKey: string; checkerSessionId: string; executorSessionKey: string; executorSessionId: string; goalId?: string };
export function checkTool(bindings: readonly Binding[], event: { toolName: string; params: Record<string, unknown> }, ctx: { sessionKey?: string; sessionId?: string }) {
  for (const b of bindings) {
    // Deny also on changed/missing generation: an old checker must not become unrestricted.
    if (ctx.sessionKey === b.checkerSessionKey || ctx.sessionId === b.checkerSessionId)
      return { block: true, blockReason: "LMA Go message-review Checker cannot invoke tools" };

  }
}
export function parseBindings(value: unknown): Binding[] {
  if (!Array.isArray(value)) throw new Error("bindings must be an array");
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid binding");
    for (const k of ["checkerSessionKey", "checkerSessionId", "executorSessionKey", "executorSessionId"])
      if (typeof item[k] !== "string" || !(item as any)[k].trim()) throw new Error(`missing ${k}`);
    if (!item.checkerSessionKey.startsWith("agent:") || !item.executorSessionKey.startsWith("agent:")) throw new Error("canonical session keys required");
    if (item.checkerSessionKey === item.executorSessionKey || item.checkerSessionId === item.executorSessionId || seen.has(item.checkerSessionKey)) throw new Error("ambiguous binding");
    seen.add(item.checkerSessionKey);
    return { ...item };
  });
}
