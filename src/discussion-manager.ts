import { randomUUID } from "crypto";

export type ReplyResult = {
  botName: string;
  text: string;
  visible: boolean;
  error?: string;
};

type DiscussionSession = {
  id: string;
  chatId: string;
  rootMessageId: string;
  topic: string;
  participants: string[];
  currentRound: number;
  maxRounds: number;
  completedRounds: Array<{
    round: number;
    replies: Record<string, string>;
  }>;
  status: "running" | "stopped" | "completed";
};

export type DiscussionParticipant = {
  name: string;
  runDiscussionTurn(chatId: string, prompt: string): Promise<ReplyResult>;
};

export class DiscussionManager {
  private sessions = new Map<string, DiscussionSession>();
  private seenRoots = new Map<string, number>();
  private readonly seenRootTtlMs = 6 * 60 * 60 * 1000;

  isActive(chatId: string): boolean {
    return this.sessions.get(chatId)?.status === "running";
  }

  stop(chatId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    session.status = "stopped";
    this.sessions.delete(chatId);
    return true;
  }

  status(chatId: string): DiscussionSession | null {
    const session = this.sessions.get(chatId);
    return session ? { ...session, completedRounds: [...session.completedRounds] } : null;
  }

  startIfAbsent(params: {
    chatId: string;
    rootMessageId: string;
    topic: string;
    maxRounds: number;
    participants: DiscussionParticipant[];
    sendSystemMessage?: (text: string) => Promise<void>;
  }): boolean {
    this.pruneSeenRoots();
    const key = `${params.chatId}:${params.rootMessageId}`;
    if (this.seenRoots.has(key)) return false;
    this.seenRoots.set(key, Date.now());

    if (this.isActive(params.chatId)) this.stop(params.chatId);

    const participants = params.participants.filter((p, index, arr) => arr.findIndex((x) => x.name === p.name) === index);
    if (participants.length === 0) {
      this.seenRoots.delete(key);
      return false;
    }

    const session: DiscussionSession = {
      id: randomUUID(),
      chatId: params.chatId,
      rootMessageId: params.rootMessageId,
      topic: params.topic,
      participants: participants.map((p) => p.name),
      currentRound: 1,
      maxRounds: params.maxRounds,
      completedRounds: [],
      status: "running",
    };
    this.sessions.set(params.chatId, session);

    void this.runLoop(session.id, participants, params.sendSystemMessage).catch((err) => {
      console.warn(`[Discussion] loop failed for ${params.chatId}:`, err instanceof Error ? err.message : String(err));
      const current = this.sessions.get(params.chatId);
      if (current?.id === session.id) this.sessions.delete(params.chatId);
    });
    return true;
  }

  private pruneSeenRoots(now = Date.now()): void {
    for (const [key, ts] of this.seenRoots) {
      if (now - ts > this.seenRootTtlMs) this.seenRoots.delete(key);
    }
  }

  private async runLoop(sessionId: string, participants: DiscussionParticipant[], sendSystemMessage?: (text: string) => Promise<void>): Promise<void> {
    while (true) {
      const session = Array.from(this.sessions.values()).find((s) => s.id === sessionId);
      if (!session || session.status !== "running") return;
      if (session.currentRound > session.maxRounds) {
        session.status = "completed";
        this.sessions.delete(session.chatId);
        return;
      }

      const prompt = this.buildPrompt(session);
      const results = await Promise.allSettled(
        participants.map(async (participant) => {
          try {
            return await participant.runDiscussionTurn(session.chatId, prompt);
          } catch (err) {
            return {
              botName: participant.name,
              text: "",
              visible: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies ReplyResult;
          }
        })
      );

      const current = this.sessions.get(session.chatId);
      if (!current || current.id !== sessionId || current.status !== "running") return;

      const replies: Record<string, string> = {};
      for (const result of results) {
        const value = result.status === "fulfilled" ? result.value : undefined;
        if (!value) continue;
        replies[value.botName] = value.error ? `[ERROR] ${value.error}` : value.text.trim();
      }
      current.completedRounds.push({ round: current.currentRound, replies });

      const allNoReply = participants.every((participant) => {
        const text = (replies[participant.name] || "").trim();
        return !text || text.toUpperCase() === "NO_REPLY" || text.startsWith("[ERROR]");
      });
      if (allNoReply) {
        current.status = "completed";
        this.sessions.delete(current.chatId);
        if (sendSystemMessage) await sendSystemMessage(`💬 Discuss 已结束：第 ${current.currentRound} 轮没有新的有效补充。`).catch(() => {});
        return;
      }

      if (current.currentRound >= current.maxRounds) {
        current.status = "completed";
        this.sessions.delete(current.chatId);
        if (sendSystemMessage) await sendSystemMessage(`💬 Discuss 已完成：已达到 ${current.maxRounds} 轮。`).catch(() => {});
        return;
      }

      current.currentRound += 1;
    }
  }

  private buildPrompt(session: DiscussionSession): string {
    const previous = session.completedRounds.length === 0
      ? "（暂无，当前是第一轮）"
      : session.completedRounds.map((round) => {
          const lines = Object.entries(round.replies).map(([bot, text]) => `- ${bot}: ${text || "NO_REPLY"}`);
          return `Round ${round.round}:\n${lines.join("\n")}`;
        }).join("\n\n");

    return [
      "这是一个多智能体结构化讨论。",
      "",
      "话题：",
      session.topic,
      "",
      `当前轮次：${session.currentRound}`,
      "",
      "已完成的轮次：",
      previous,
      "",
      "本轮其他 bot 的回复你暂时看不到，请基于同一份上下文独立给出观点。",
      "",
      "要求：",
      "1. 不要重复前几轮已经说过的观点。",
      "2. 只补充新的、有价值的信息。",
      "3. 如果没有新东西，回复 NO_REPLY。",
      "4. 简洁作答。",
    ].join("\n");
  }
}

export const discussionManager = new DiscussionManager();
