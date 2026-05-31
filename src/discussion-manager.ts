import { randomUUID } from "crypto";
import { getI18n, type Locale } from "./i18n.js";

export type ReplyResult = {
  botName: string;
  text: string;
  visible: boolean;
  error?: string;
};

export type DiscussionCompleteReason = "chairman_final" | "all_no_reply" | "max_rounds";

export type DiscussionCompleteEvent = {
  chatId: string;
  reason: DiscussionCompleteReason;
  chairmanName?: string;
};

type DiscussionSession = {
  id: string;
  chatId: string;
  rootMessageId: string;
  topic: string;
  participants: string[];
  chairmanName?: string;
  locale: Locale;
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
  runDiscussionTurn(chatId: string, prompt: string, meta?: { round: number; maxRounds: number }): Promise<ReplyResult>;
};

export class DiscussionManager {
  private sessions = new Map<string, DiscussionSession>();
  private seenRoots = new Map<string, number>();
  private readonly seenRootTtlMs = 6 * 60 * 60 * 1000;

  constructor(private defaultLocale: Locale = "zh") {}

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
    chairman?: DiscussionParticipant;
    sendSystemMessage?: (text: string) => Promise<void>;
    onComplete?: (event: DiscussionCompleteEvent) => Promise<void>;
    locale?: Locale;
  }): boolean {
    this.pruneSeenRoots();
    const key = `${params.chatId}:${params.rootMessageId}`;
    if (this.seenRoots.has(key)) return false;
    this.seenRoots.set(key, Date.now());

    if (this.isActive(params.chatId)) this.stop(params.chatId);

    const chairman = params.chairman;
    const participants = params.participants
      .filter((p) => p.name !== chairman?.name)
      .filter((p, index, arr) => arr.findIndex((x) => x.name === p.name) === index);
    if (participants.length === 0 && !chairman) {
      this.seenRoots.delete(key);
      return false;
    }

    const session: DiscussionSession = {
      id: randomUUID(),
      chatId: params.chatId,
      rootMessageId: params.rootMessageId,
      topic: params.topic,
      participants: [...participants.map((p) => p.name), ...(chairman ? [chairman.name] : [])],
      chairmanName: chairman?.name,
      locale: params.locale || this.defaultLocale,
      currentRound: 1,
      maxRounds: params.maxRounds,
      completedRounds: [],
      status: "running",
    };
    this.sessions.set(params.chatId, session);

    void this.runLoop(session.id, participants, chairman, params.sendSystemMessage, params.onComplete).catch((err) => {
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

  private async runLoop(sessionId: string, participants: DiscussionParticipant[], chairman?: DiscussionParticipant, sendSystemMessage?: (text: string) => Promise<void>, onComplete?: (event: DiscussionCompleteEvent) => Promise<void>): Promise<void> {
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
            return await participant.runDiscussionTurn(session.chatId, prompt, { round: session.currentRound, maxRounds: session.maxRounds });
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

      const noReplyNames = participants
        .map((participant) => participant.name)
        .filter((name) => {
          const text = (replies[name] || "").trim();
          return !text || text.toUpperCase() === "NO_REPLY";
        });
      const errorNames = participants
        .map((participant) => participant.name)
        .filter((name) => (replies[name] || "").trim().startsWith("[ERROR]"));
      const allNoReply = participants.length > 0 && participants.every((participant) => {
        const text = (replies[participant.name] || "").trim();
        return !text || text.toUpperCase() === "NO_REPLY" || text.startsWith("[ERROR]");
      });
      if (sendSystemMessage && !allNoReply && (noReplyNames.length > 0 || errorNames.length > 0)) {
        const parts: string[] = [];
        const t = getI18n(current.locale).labels;
        if (noReplyNames.length > 0) parts.push(`${noReplyNames.join("、")} ${t.noNewReply}`);
        if (errorNames.length > 0) parts.push(`${errorNames.join("、")} ${t.error}`);
        await sendSystemMessage(t.discussionRoundNotice(current.currentRound, current.maxRounds, parts.join(current.locale === "zh" ? "；" : "; "))).catch(() => {});
      }

      const mustFinish = allNoReply || current.currentRound >= current.maxRounds;
      if (chairman) {
        const chairmanPrompt = this.buildChairmanPrompt(current, replies, mustFinish);
        const chairResult = await chairman.runDiscussionTurn(current.chatId, chairmanPrompt, { round: current.currentRound, maxRounds: current.maxRounds });
        const chairText = (chairResult.text || "").trim();
        replies[chairman.name] = chairText;
        const latest = current.completedRounds[current.completedRounds.length - 1];
        if (latest) latest.replies[chairman.name] = chairText;
        const wantsFinal = this.hasFinalSummaryMarker(chairText);
        if (mustFinish || wantsFinal) {
          current.status = "completed";
          this.sessions.delete(current.chatId);
          if (onComplete) await onComplete({ chatId: current.chatId, reason: "chairman_final", chairmanName: chairman.name }).catch(() => {});
          else if (sendSystemMessage) await sendSystemMessage(getI18n(current.locale).labels.discussEndedChairman(chairman.name)).catch(() => {});
          return;
        }
      } else if (allNoReply) {
        current.status = "completed";
        this.sessions.delete(current.chatId);
        if (onComplete) await onComplete({ chatId: current.chatId, reason: "all_no_reply" }).catch(() => {});
        if (sendSystemMessage) await sendSystemMessage(getI18n(current.locale).labels.discussEndedNoNew(current.currentRound)).catch(() => {});
        return;
      } else if (current.currentRound >= current.maxRounds) {
        current.status = "completed";
        this.sessions.delete(current.chatId);
        if (onComplete) await onComplete({ chatId: current.chatId, reason: "max_rounds" }).catch(() => {});
        if (sendSystemMessage) await sendSystemMessage(getI18n(current.locale).labels.discussMaxRounds(current.maxRounds)).catch(() => {});
        return;
      }

      current.currentRound += 1;
    }
  }



  private hasFinalSummaryMarker(text: string): boolean {
    return /(^|\n)\s*FINAL_SUMMARY\s*[:：]/i.test(text) || /(^|\n)\s*最终总结\s*[:：]/.test(text);
  }

  private buildChairmanPrompt(session: DiscussionSession, replies: Record<string, string>, mustFinish: boolean): string {
    const t = getI18n(session.locale);
    const lines = Object.entries(replies).map(([bot, text]) => `- ${bot}: ${text || "NO_REPLY"}`);
    return t.chairmanPrompt({
      topic: session.topic,
      round: session.currentRound,
      maxRounds: session.maxRounds,
      replies: lines.length ? lines.join("\n") : t.labels.noRegularReplies,
      mustFinish,
    });
  }

  private buildPrompt(session: DiscussionSession): string {
    const t = getI18n(session.locale);
    const previous = session.completedRounds.length === 0
      ? t.labels.noPreviousRounds
      : (() => {
          const round = session.completedRounds[session.completedRounds.length - 1];
          const lines = Object.entries(round.replies).map(([bot, text]) => `- ${bot}: ${text || "NO_REPLY"}`);
          return `Round ${round.round}:\n${lines.join("\n")}`;
        })();
    return t.discussParticipantPrompt({
      topic: session.topic,
      round: session.currentRound,
      previous,
    });
  }
}

export const discussionManager = new DiscussionManager();
