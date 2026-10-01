import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Timers must never auto-fire during tests: cycles are driven manually.
process.env.OPENCLAW_LARK_MULTI_AGENT_GO_CHECK_DELAY_MS = "3600000";
import { MessageStore } from "../src/message-store.js";
import { GoController, parseGoVerdict } from "../src/go-controller.js";

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(botName = "GPT") {
  const dir = mkdtempSync(join(tmpdir(), "olma-go-"));
  const store = new MessageStore(join(dir, "messages.db"));
  const checkerReplies: string[] = [];
  const sent: any[] = [];
  const notifications: string[] = [];
  const repliesToUser: Array<[string, string]> = [];
  const sessions = new Map<string, any>();
  let running = false;
  const client = {
    sessions, sent, checkerReplies,
    set running(v: boolean) { running = v; },
    get running() { return running; },
    async getSessionInfo(key: string) { return { session: sessions.get(key) || null }; },
    async getSessionRuntimeStatus(_key: string) { return { running }; },
    async createSession(p: any) { sessions.set(p.key, { sessionId: `sid-${p.key}`, model: p.model }); return { ok: true }; },
    async chatSendWithContext(p: any) { sent.push(p); return checkerReplies.shift() ?? "OK"; },
    queueReply(r: string) { checkerReplies.push(r); },
  };
  const c = new GoController({
    botName, fallbackModel: "prov/base", store, client: client as any,
    executorSessionKeyFor: (chatId: string) => `lma-${botName.toLowerCase()}-${chatId}`,
    notify: async (chatId, text) => { notifications.push(`${chatId}::${text}`); },
    reply: async (messageId, text) => { repliesToUser.push([messageId, text]); },
  });
  return {
    dir, store, client, c, sent, notifications, repliesToUser,
    cleanup: () => { c.dispose(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function primeExecutor(h: Harness, chatId = "chat1") {
  h.client.sessions.set(`lma-gpt-${chatId}`, { sessionId: "exec-sid-1", model: "glm-5.3", modelProvider: "phgeek-gw" });
}

async function startGo(h: Harness, goal = "完成测试目标", chatId = "chat1") {
  primeExecutor(h, chatId);
  h.client.queueReply("OK");
  await h.c.handleGoCommand(chatId, "msg1", goal);
  return h.store.getActiveGoJob("GPT", chatId)!;
}

async function cycleWithEvidence(h: Harness, jobId: number, n: number, checkerReply: string, chatId = "chat1") {
  h.store.insertGoEvent(jobId, `src-${n}`, "assistant_reply", `第 ${n} 条结果证据：测试通过`);
  h.client.queueReply(checkerReply);
  await (h.c as any).runCheckCycle(chatId);
  return h.store.getGoJobById(jobId)!;
}

describe("parseGoVerdict", () => {
  it("accepts the three valid verdict shapes", () => {
    expect(parseGoVerdict('{"action":"WAIT","summary":"证据不足"}')).toMatchObject({ action: "WAIT" });
    expect(parseGoVerdict('前缀噪音 {"action":"CONTINUE","summary":"缺测试","missing":["单测"]} 后缀')).toMatchObject({ action: "CONTINUE", missing: ["单测"] });
    expect(parseGoVerdict('{"action":"COMPLETE","summary":"达标","evidence_refs":["E1","E2"]}')).toMatchObject({ action: "COMPLETE", evidenceRefs: ["E1", "E2"] });
  });
  it("rejects malformed or non-conforming output", () => {
    expect("error" in parseGoVerdict("没有任何 JSON")).toBe(true);
    expect("error" in parseGoVerdict('{"action":"WAIT","summary":"x"')).toBe(true); // unclosed
    expect("error" in parseGoVerdict('{"action":"RUN","summary":"x"}')).toBe(true); // bad action
    expect("error" in parseGoVerdict('{"action":"CONTINUE","summary":"x"}')).toBe(true); // missing empty
    expect("error" in parseGoVerdict('{"action":"COMPLETE","summary":"x"}')).toBe(true); // no refs
    expect("error" in parseGoVerdict('{"action":"WAIT"}')).toBe(true); // no summary
  });
});

describe("GoController commands", () => {
  it("starts supervision with a dedicated checker session and resolved model", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      expect(job).toBeTruthy();
      expect(job.goal).toBe("完成测试目标");
      expect(job.checkerModel).toBe("phgeek-gw/glm-5.3");
      expect(job.checkerSessionKey).toBe("lma-go-gpt-chat1");
      expect(h.client.sessions.has("lma-go-gpt-chat1")).toBe(true);
      const initMsg = h.sent.find((p) => p.sessionKey === "lma-go-gpt-chat1");
      expect(initMsg.currentMessage).toContain("Go Checker");
      expect(h.repliesToUser[0][1]).toContain("已启动");
    } finally { h.cleanup(); }
  });

  it("refuses to silently overwrite an active Go", async () => {
    const h = makeHarness();
    try {
      await startGo(h);
      await h.c.handleGoCommand("chat1", "msg2", "另一个目标");
      expect(h.repliesToUser[1][1]).toContain("已有活动 Go");
      expect(h.store.listActiveGoJobs("GPT")).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("model pref applies to new Go only", async () => {
    const h = makeHarness();
    try {
      await h.c.handleGoCommand("chat1", "m", "model prov/mini");
      const job = await startGo(h);
      expect(job.checkerModel).toBe("prov/mini");
    } finally { h.cleanup(); }
  });

  it("stop ends supervision and clears the footer marker", async () => {
    const h = makeHarness();
    try {
      await startGo(h);
      expect(h.c.footerMarker("chat1")).toContain("Go待核验");
      await h.c.handleGoCommand("chat1", "m", "stop");
      expect(h.store.getActiveGoJob("GPT", "chat1")).toBeNull();
      expect(h.c.footerMarker("chat1")).toBeNull();
    } finally { h.cleanup(); }
  });

  it("pause and resume transition states with markers", async () => {
    const h = makeHarness();
    try {
      await startGo(h);
      await h.c.handleGoCommand("chat1", "m", "pause");
      expect(h.c.footerMarker("chat1")).toContain("Go已暂停");
      await h.c.handleGoCommand("chat1", "m", "resume");
      expect(h.c.footerMarker("chat1")).toContain("Go待核验");
    } finally { h.cleanup(); }
  });
});

describe("GoController busy gates", () => {
  it("defers the check while the executor session is running", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const sentBefore = h.sent.length;
      h.client.running = true;
      await cycleWithEvidence(h, job.id, 1, '{"action":"COMPLETE","summary":"ok","evidence_refs":["E1"]}');
      expect(h.sent.length).toBe(sentBefore); // no checker call
      expect(h.store.getGoJobById(job.id)!.state).toBe("WAITING_WORK");
    } finally { h.cleanup(); }
  });

  it("defers the check while human messages are pending", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const rowId = h.store.insert({ chatId: "chat1", messageId: "human-1", senderType: "human", senderName: "u", content: "新指令", timestamp: Date.now(), triggerKind: "normal" });
      h.store.markPendingTrigger("GPT", "chat1", rowId);
      const sentBefore = h.sent.length;
      await cycleWithEvidence(h, job.id, 1, '{"action":"COMPLETE","summary":"ok","evidence_refs":["E1"]}');
      expect(h.sent.length).toBe(sentBefore);
      expect(h.store.getGoJobById(job.id)!.state).toBe("WAITING_WORK");
    } finally { h.cleanup(); }
  });
});

describe("GoController verdicts", () => {
  it("WAIT advances watermark, stays silent, pauses after the streak limit", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      for (let i = 1; i <= 4; i++) {
        const j = await cycleWithEvidence(h, job.id, i, '{"action":"WAIT","summary":"还在等结果"}');
        expect(j.state).toBe("WAITING_WORK");
        expect(j.waitStreak).toBe(i);
        expect(h.notifications).toHaveLength(0);
      }
      const j5 = await cycleWithEvidence(h, job.id, 5, '{"action":"WAIT","summary":"还在等结果"}');
      expect(j5.state).toBe("PAUSED");
      expect(h.notifications[0]).toContain("已暂停");
    } finally { h.cleanup(); }
  });

  it("CONTINUE forwards a marked follow-up to the executor and notifies Feishu once", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const j = await cycleWithEvidence(h, job.id, 1, '{"action":"CONTINUE","summary":"缺单测","missing":["缺少单测"],"message":"请补单测"}');
      expect(j.state).toBe("WAITING_WORK");
      expect(j.continueCount).toBe(1);
      const followUp = h.sent.find((p) => p.sessionKey === "lma-gpt-chat1" && p.currentMessage.includes("Go Checker 跟进"));
      expect(followUp).toBeTruthy();
      expect(followUp.currentMessage).toContain("缺少单测");
      expect(h.notifications[0]).toContain("核验未通过");
    } finally { h.cleanup(); }
  });

  it("pauses after 3 consecutive CONTINUEs with unchanged missing items", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const reply = '{"action":"CONTINUE","summary":"同样缺项","missing":["缺少单测"]}';
      let j = await cycleWithEvidence(h, job.id, 1, reply);
      expect(j.state).toBe("WAITING_WORK");
      j = await cycleWithEvidence(h, job.id, 2, reply);
      expect(j.state).toBe("WAITING_WORK");
      j = await cycleWithEvidence(h, job.id, 3, reply);
      expect(j.state).toBe("PAUSED");
      expect(j.pauseReason).toContain("缺项无实质变化");
    } finally { h.cleanup(); }
  });

  it("pauses when the auto-follow-up budget is exhausted", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      for (let i = 1; i <= 10; i++) {
        const j = await cycleWithEvidence(h, job.id, i, `{"action":"CONTINUE","summary":"缺项${i}","missing":["缺少项${i}"]}`);
        expect(j.state).toBe("WAITING_WORK");
      }
      const j11 = await cycleWithEvidence(h, job.id, 11, '{"action":"CONTINUE","summary":"又缺","missing":["缺少项X"]}');
      expect(j11.state).toBe("PAUSED");
      expect(j11.pauseReason).toContain("上限");
    } finally { h.cleanup(); }
  });

  it("COMPLETE with valid refs ends supervision; executor receives no completion backflow", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const j = await cycleWithEvidence(h, job.id, 1, '{"action":"COMPLETE","summary":"全部达标","evidence_refs":["E1"]}');
      expect(j.state).toBe("COMPLETED");
      expect(h.notifications[0]).toContain("验收通过");
      expect(h.sent.some((p) => p.sessionKey === "lma-gpt-chat1" && p.currentMessage.includes("完成"))).toBe(false);
    } finally { h.cleanup(); }
  });

  it("COMPLETE with fabricated refs is rejected and pauses", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const j = await cycleWithEvidence(h, job.id, 1, '{"action":"COMPLETE","summary":"编造","evidence_refs":["E99"]}');
      expect(j.state).toBe("PAUSED");
      expect(j.pauseReason).toContain("不存在的证据");
    } finally { h.cleanup(); }
  });

  it("recovers from one invalid checker reply via a controlled correction, then pauses on repeat", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      // First round: invalid then corrected — BOTH queued up front (the correction
      // request consumes the second reply).
      h.store.insertGoEvent(job.id, "src-1", "assistant_reply", "第 1 条结果证据：测试通过");
      h.client.queueReply("我觉得还没完成");
      h.client.queueReply('{"action":"WAIT","summary":"修正后等待"}');
      await (h.c as any).runCheckCycle("chat1");
      let j = h.store.getGoJobById(job.id)!;
      expect(j.lastVerdict).toBe("WAIT");
      expect(j.state).toBe("WAITING_WORK");
      // Second round: invalid twice -> pause.
      h.store.insertGoEvent(job.id, "src-2", "assistant_reply", "第 2 条结果证据");
      h.client.queueReply("还是不输出 JSON");
      h.client.queueReply("仍然不是 JSON");
      await (h.c as any).runCheckCycle("chat1");
      j = h.store.getGoJobById(job.id)!;
      expect(j.state).toBe("PAUSED");
      expect(j.pauseReason).toContain("格式错误");
    } finally { h.cleanup(); }
  });
});

describe("GoController isolation and recovery", () => {
  it("keeps two bots' Go jobs in the same chat independent", async () => {
    const h1 = makeHarness("GPT");
    const h2 = makeHarness("GLM");
    try {
      await startGo(h1, "目标A", "chat1");
      // GLM executor session under GLM's own harness.
      h2.client.sessions.set("lma-glm-chat1", { sessionId: "exec-sid-2", model: "glm-5.3" });
      h2.client.queueReply("OK");
      await h2.c.handleGoCommand("chat1", "m", "目标B");
      const j1 = h1.store.getActiveGoJob("GPT", "chat1")!;
      const j2 = h2.store.getActiveGoJob("GLM", "chat1")!;
      expect(j1.goal).toBe("目标A");
      expect(j2.goal).toBe("目标B");
    } finally { h1.cleanup(); h2.cleanup(); }
  });

  it("pauses supervision when the executor session is reset", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      await h.c.onExecutorSessionChanged("chat1", "执行会话被 /reset");
      expect(h.store.getGoJobById(job.id)!.state).toBe("PAUSED");
      expect(h.notifications[0]).toContain("已自动暂停");
    } finally { h.cleanup(); }
  });

  it("startup recovery pauses on executor generation mismatch and settles transient states", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      h.client.sessions.set("lma-gpt-chat1", { sessionId: "exec-sid-CHANGED", model: "glm-5.3" });
      await h.c.recoverOnStartup();
      expect(h.store.getGoJobById(job.id)!.state).toBe("PAUSED");
      expect(h.notifications[0]).toContain("已自动暂停");
    } finally { h.cleanup(); }

    const h2 = makeHarness();
    try {
      const job = await startGo(h2);
      // Simulate a crash mid-check: transient CHECKING state with fresh evidence.
      h2.store.updateGoJobCas(job.id, job.revision, { state: "CHECKING" });
      h2.store.insertGoEvent(job.id, "post-crash", "assistant_reply", "崩溃后到达的结果");
      await h2.c.recoverOnStartup();
      const j = h2.store.getGoJobById(job.id)!;
      expect(j.state).toBe("WAITING_WORK");
    } finally { h2.cleanup(); }
  });
});

describe("Go store primitives", () => {
  it("dedupes evidence by source key and claims actions exactly once", async () => {
    const h = makeHarness();
    try {
      const job = await startGo(h);
      const s1 = h.store.insertGoEvent(job.id, "dup-key", "assistant_reply", "A");
      const s2 = h.store.insertGoEvent(job.id, "dup-key", "assistant_reply", "A");
      expect(s1).toBeGreaterThan(0);
      expect(s2).toBe(-1);
      expect(h.store.claimGoAction(job.id, "go:1:check:x:continue", "continue", "{}")).toBe(true);
      expect(h.store.claimGoAction(job.id, "go:1:check:x:continue", "continue", "{}")).toBe(false);
    } finally { h.cleanup(); }
  });
});
