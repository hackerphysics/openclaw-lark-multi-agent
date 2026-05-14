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
});
