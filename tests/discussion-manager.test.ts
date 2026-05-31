import { describe, expect, it, vi } from "vitest";
import { DiscussionManager, type DiscussionParticipant } from "../src/discussion-manager.js";

function participant(name: string, replies: string[], calls: Array<{ name: string; prompt: string }>): DiscussionParticipant {
  return {
    name,
    async runDiscussionTurn(_chatId: string, prompt: string) {
      calls.push({ name, prompt });
      return { botName: name, text: replies.shift() ?? "NO_REPLY", visible: true };
    },
  };
}

describe("DiscussionManager", () => {
  it("runs participants in barrier-style rounds", async () => {
    const manager = new DiscussionManager();
    const calls: Array<{ name: string; prompt: string }> = [];
    const systemMessages: string[] = [];
    const started = manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "m1",
      topic: "讨论主题",
      maxRounds: 2,
      participants: [
        participant("GPT", ["g1", "g2"], calls),
        participant("Claude", ["c1", "NO_REPLY"], calls),
      ],
      sendSystemMessage: async (text) => { systemMessages.push(text); },
    });
    expect(started).toBe(true);
    await vi.waitUntil(() => !manager.isActive("chat1"), { timeout: 1000 });

    expect(calls).toHaveLength(4);
    expect(calls[0].prompt).toContain("当前轮次：1");
    expect(calls[1].prompt).toContain("当前轮次：1");
    expect(calls[0].prompt).not.toContain("g1");
    expect(calls[1].prompt).not.toContain("g1");
    expect(calls[2].prompt).toContain("当前轮次：2");
    expect(calls[2].prompt).toContain("GPT: g1");
    expect(calls[2].prompt).toContain("Claude: c1");
    expect(systemMessages).toContain("💬 第 2/2 轮：Claude 无新增回复");
    expect(systemMessages.at(-1)).toContain("已达到 2 轮");
  });

  it("passes only the previous round into the next discussion prompt", async () => {
    const manager = new DiscussionManager();
    const calls: Array<{ name: string; prompt: string }> = [];
    const started = manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "m1",
      topic: "讨论主题",
      maxRounds: 3,
      participants: [participant("GPT", ["g1", "g2", "g3"], calls)],
    });
    expect(started).toBe(true);
    await vi.waitUntil(() => !manager.isActive("chat1"), { timeout: 1000 });

    expect(calls).toHaveLength(3);
    expect(calls[1].prompt).toContain("当前轮次：2");
    expect(calls[1].prompt).toContain("Round 1:");
    expect(calls[1].prompt).toContain("GPT: g1");
    expect(calls[2].prompt).toContain("当前轮次：3");
    expect(calls[2].prompt).toContain("Round 2:");
    expect(calls[2].prompt).toContain("GPT: g2");
    expect(calls[2].prompt).not.toContain("Round 1:");
    expect(calls[2].prompt).not.toContain("GPT: g1");
  });

  it("deduplicates start by chat and root message", async () => {
    const manager = new DiscussionManager();
    const calls: Array<{ name: string; prompt: string }> = [];
    const p = participant("GPT", ["NO_REPLY"], calls);
    expect(manager.startIfAbsent({ chatId: "chat1", rootMessageId: "m1", topic: "t", maxRounds: 3, participants: [p] })).toBe(true);
    expect(manager.startIfAbsent({ chatId: "chat1", rootMessageId: "m1", topic: "t", maxRounds: 3, participants: [p] })).toBe(false);
    await vi.waitUntil(() => !manager.isActive("chat1"), { timeout: 1000 });
  });

  it("does not retain seen roots forever", async () => {
    const manager = new DiscussionManager();
    const calls: Array<{ name: string; prompt: string }> = [];
    const p = participant("GPT", ["NO_REPLY"], calls);
    expect(manager.startIfAbsent({ chatId: "chat1", rootMessageId: "m1", topic: "t", maxRounds: 3, participants: [p] })).toBe(true);
    expect((manager as any).seenRoots.size).toBe(1);
    (manager as any).pruneSeenRoots(Date.now() + 7 * 60 * 60 * 1000);
    expect((manager as any).seenRoots.size).toBe(0);
    await vi.waitUntil(() => !manager.isActive("chat1"), { timeout: 1000 });
  });

  it("asks chairman for a final summary when participants stop adding new points", async () => {
    const manager = new DiscussionManager();
    const sent: string[] = [];
    const gpt = {
      name: "GPT",
      runDiscussionTurn: vi.fn(async () => ({ botName: "GPT", text: "NO_REPLY", visible: false })),
    };
    const chairman = {
      name: "Claude",
      runDiscussionTurn: vi.fn(async (_chatId: string, prompt: string) => ({ botName: "Claude", text: prompt.includes("本轮必须结束") ? "FINAL_SUMMARY: 总结" : "CHAIRMAN_NOTE: 继续", visible: true })),
    };

    expect(manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "root-chair",
      topic: "讨论主题",
      maxRounds: 3,
      participants: [gpt],
      chairman,
      sendSystemMessage: async (text) => { sent.push(text); },
    })).toBe(true);

    await vi.waitUntil(() => sent.some((text) => text.includes("Chairman Claude 已完成总结")), { timeout: 1000 });
    expect(chairman.runDiscussionTurn).toHaveBeenCalledOnce();
    expect(chairman.runDiscussionTurn.mock.calls[0][1]).toContain("本轮必须结束");
    expect(chairman.runDiscussionTurn.mock.calls[0][1]).toContain("先发表你自己的实质观点");
    expect(chairman.runDiscussionTurn.mock.calls[0][1]).toContain("警惕的问题/薄弱点");
    expect(chairman.runDiscussionTurn.mock.calls[0][1]).toContain("扮演质疑者");
    expect(manager.status("chat1")).toBeNull();
  });

  it("lets chairman request another round before final summary", async () => {
    const manager = new DiscussionManager();
    const sent: string[] = [];
    let participantCalls = 0;
    const gpt = {
      name: "GPT",
      runDiscussionTurn: vi.fn(async () => ({ botName: "GPT", text: participantCalls++ === 0 ? "新观点" : "NO_REPLY", visible: participantCalls === 1 })),
    };
    let chairmanCalls = 0;
    const chairman = {
      name: "Claude",
      runDiscussionTurn: vi.fn(async () => ({ botName: "Claude", text: chairmanCalls++ === 0 ? "CHAIRMAN_NOTE: 再讨论一轮" : "FINAL_SUMMARY: 总结", visible: true })),
    };

    expect(manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "root-chair-2",
      topic: "讨论主题",
      maxRounds: 3,
      participants: [gpt],
      chairman,
      sendSystemMessage: async (text) => { sent.push(text); },
    })).toBe(true);

    await vi.waitUntil(() => sent.some((text) => text.includes("Chairman Claude 已完成总结")), { timeout: 1000 });
    expect(gpt.runDiscussionTurn).toHaveBeenCalledTimes(2);
    expect(chairman.runDiscussionTurn).toHaveBeenCalledTimes(2);
    expect(chairman.runDiscussionTurn.mock.calls[0][1]).toContain("先发表你自己的实质观点");
    expect(manager.status("chat1")).toBeNull();
  });
  it("detects chairman final marker even after a preface", async () => {
    const manager = new DiscussionManager();
    const sent: string[] = [];
    const gpt = {
      name: "GPT",
      runDiscussionTurn: vi.fn(async () => ({ botName: "GPT", text: "普通观点", visible: true })),
    };
    const chairman = {
      name: "Claude",
      runDiscussionTurn: vi.fn(async () => ({ botName: "Claude", text: "我认为可以收尾。\n\nFINAL_SUMMARY:\n最终结论", visible: true })),
    };

    expect(manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "root-chair-preface",
      topic: "讨论主题",
      maxRounds: 10,
      participants: [gpt],
      chairman,
      sendSystemMessage: async (text) => { sent.push(text); },
      onComplete: async (event) => { sent.push(`complete:${event.reason}:${event.chairmanName}`); },
    })).toBe(true);

    await vi.waitUntil(() => sent.some((text) => text.includes("complete:chairman_final:Claude")), { timeout: 1000 });
    expect(gpt.runDiscussionTurn).toHaveBeenCalledTimes(1);
    expect(chairman.runDiscussionTurn).toHaveBeenCalledTimes(1);
    expect(manager.status("chat1")).toBeNull();
  });

  it("uses English prompts and system notices when locale is en", async () => {
    const manager = new DiscussionManager("en");
    const calls: Array<{ name: string; prompt: string }> = [];
    const systemMessages: string[] = [];
    expect(manager.startIfAbsent({
      chatId: "chat1",
      rootMessageId: "root-en",
      topic: "topic",
      maxRounds: 1,
      participants: [participant("GPT", ["NO_REPLY"], calls)],
      sendSystemMessage: async (text) => { systemMessages.push(text); },
    })).toBe(true);
    await vi.waitUntil(() => !manager.isActive("chat1"), { timeout: 1000 });
    expect(calls[0].prompt).toContain("Current round: 1");
    expect(calls[0].prompt).toContain("reply exactly NO_REPLY");
    expect(systemMessages.at(-1)).toContain("Discuss ended");
  });

});
