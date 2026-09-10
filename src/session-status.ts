export type SessionRuntimeStatus = {
  status: string;
  running: boolean;
  checkedAt: number;
  contextUsedTokens?: number;
  contextLimitTokens?: number;
};
export const isWaitTimeout = (text: string): boolean => /\btimeout\b|timed\s*out|超时/i.test(text) && !/invalid|validation|schema|malformed|permission denied|forbidden|unauthorized|authentication failed|quota|rate limit|无效参数|参数错误|校验失败/i.test(text);

export function normalizeSessionRuntimeStatus(value: any): SessionRuntimeStatus {
  const session = value?.session || value?.sessionInfo;
  const raw = typeof session?.status === "string" ? session.status.trim().toLowerCase() : "unknown";
  const status = /^[a-z][a-z0-9 _|,-]{0,63}$/.test(raw) ? raw : "unknown";
  const running = session?.hasActiveRun === true || status.split(/[|,]/).some((part: string) => part.trim() === "running");
  // Same context counters as /status, not cumulative input/output billing.
  // A missing/stale count must not be presented as an empty context.
  const used = session?.totalTokens;
  const limit = session?.contextTokens;
  const contextUsedTokens = session?.totalTokensFresh !== false && typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : undefined;
  const contextLimitTokens = typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  return { status: running ? "running" : status, running, checkedAt: Date.now(),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
  };
}

/** Compact presentation only; never replaces the actual status/model values. */
export function formatSessionFooter(snapshot: SessionRuntimeStatus): string {
  const { contextUsedTokens: used, contextLimitTokens: limit } = snapshot;
  if (used === undefined && limit === undefined) return snapshot.status;
  const usedK = used === undefined ? "?" : Math.round(used / 1000);
  const limitK = limit === undefined ? "?" : Math.max(1, Math.round(limit / 1000));
  return `${snapshot.status} · ${usedK}K/${limitK}K`;
}

/** Local observation has ended, NOT an assertion that execution failed. */
export class SessionWaitPaused extends Error {
  constructor(readonly snapshot: SessionRuntimeStatus, reportedTimeout = false) {
    super(reportedTimeout
      ? "⏳ 本轮返回了超时，LMA 已暂停本次等待，但不据此认定整个会话已经结束。会话状态见下方；你可以继续等待后续结果。"
      : "⏳ 本次等待时间已到，LMA 暂停本轮等待，先返回会话状态供你判断。\n没有因此停止运行或自动重发本次请求；你可以继续等待后续结果。");
    this.name = "SessionWaitPaused";
  }
}
