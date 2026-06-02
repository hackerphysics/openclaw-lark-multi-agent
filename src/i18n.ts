export type Locale = "zh" | "en";

export function normalizeLocale(value?: string | null): Locale {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized.startsWith("en")) return "en";
  return "zh";
}

export function isLocale(value: string): value is Locale {
  return value === "zh" || value === "en";
}

const dict = {
  zh: {
    bridgePolicy: [
      "[LMA bridge policy]",
      "你正在 OpenClaw Lark Multi-Agent bridge 会话中。",
      "不要调用 message、sessions_send、feishu_im_user_message 或任何主动向飞书/外部聊天发送消息的工具。",
      "直接在当前回复中作答；LMA bridge 会负责把最终回复投递回原始飞书会话。",
      "如果你是某个群的 Chairman：Chairman 的主持、调停、质疑和总结职责只在 /discuss 模式中生效。非 /discuss 模式下，即使你是 Chairman，也只按普通 @all/free/定向参与者身份给出自己的观点，不要总结、主持、调停、质疑或收束其他 bot 的回复。",
    ].join("\n"),
    discussParticipantPrompt: (p: { topic: string; round: number; previous: string }) => [
      "这是一个多智能体结构化讨论。",
      "",
      "话题：",
      p.topic,
      "",
      `当前轮次：${p.round}`,
      "",
      "已完成的轮次：",
      p.previous,
      "",
      "本轮其他 bot 的回复你暂时看不到，请基于同一份上下文独立给出观点。",
      "",
      "要求：",
      "1. 不要重复前几轮已经说过的观点。",
      "2. 只补充新的、有价值的信息。",
      "3. 如果没有新东西，回复 NO_REPLY。",
      "4. 简洁作答。",
    ].join("\n"),
    chairmanPrompt: (p: { topic: string; round: number; maxRounds: number; replies: string; mustFinish: boolean }) => [
      "这是一个多智能体结构化讨论。你是本群的 Chairman / 主席。",
      "",
      "话题：",
      p.topic,
      "",
      `当前轮次：${p.round}/${p.maxRounds}`,
      "",
      "本轮发言：",
      p.replies || "（本轮没有普通参与者发言）",
      "",
      "你的职责：",
      "1. 先发表你自己的实质观点和判断，不要只做中立转述。",
      "2. 识别大家已经达成的共识。",
      "3. 扮演质疑者：主动检查薄弱证据、跳跃结论、未验证假设、遗漏风险和可能错误。",
      "4. 识别还没解决的关键分歧。",
      "5. 如果观点冲突，要调停并指出下一轮应聚焦的问题。",
      "6. 如果已经足够清楚，或者本轮必须结束，请做最终总结。",
      "",
      p.mustFinish
        ? "本轮必须结束。请以 `FINAL_SUMMARY:` 开头，先给出你的个人判断，再指出你认为仍需警惕的问题/薄弱点，最后给出最终总结、共识、分歧和下一步建议。"
        : "如果应继续讨论，请以 `CHAIRMAN_NOTE:` 开头，先给出你的个人判断，再提出必要质疑（薄弱证据、跳跃结论、未验证假设、遗漏风险），最后简要调停并提出下一轮聚焦问题；如果已经可以结束，请以 `FINAL_SUMMARY:` 开头，先给出你的个人判断和必要质疑，再做最终总结。",
      "",
      "请简洁、有主持感，但必须包含你自己的观点；在需要时要敢于质疑，不要只做中立转述，也不要只重复普通参与者的长篇内容。",
    ].join("\n"),
    labels: {
      noPreviousRounds: "（暂无，当前是第一轮）",
      noRegularReplies: "（本轮没有普通参与者发言）",
      noNewReply: "无新增回复",
      error: "出错",
      discussionRoundNotice: (round: number, max: number, parts: string) => `💬 第 ${round}/${max} 轮：${parts}`,
      round: "轮",
      discussEndedChairman: (name: string) => `💬 Discuss 已结束：Chairman ${name} 已完成总结。`,
      discussEndedNoNew: (round: number) => `💬 Discuss 已结束：第 ${round} 轮没有新的有效补充。`,
      discussMaxRounds: (max: number) => `💬 Discuss 已完成：已达到 ${max} 轮。`,
    },
  },
  en: {
    bridgePolicy: [
      "[LMA bridge policy]",
      "You are in an OpenClaw Lark Multi-Agent bridge session.",
      "Do not call message, sessions_send, feishu_im_user_message, or any proactive external-chat sending tool.",
      "Reply directly in the current assistant response; the LMA bridge will deliver the final reply back to the original Feishu chat.",
      "If you are the Chairman of a group: your chairman duties (moderating, challenging, summarizing, or concluding other bots' replies) apply only inside /discuss mode. Outside /discuss mode, even if you are the Chairman, answer only as a normal @all/free/direct participant with your own view; do not summarize, moderate, challenge, or conclude other bots' replies.",
    ].join("\n"),
    discussParticipantPrompt: (p: { topic: string; round: number; previous: string }) => [
      "This is a structured multi-agent discussion.",
      "",
      "Topic:",
      p.topic,
      "",
      `Current round: ${p.round}`,
      "",
      "Completed rounds:",
      p.previous,
      "",
      "You cannot see other bots' replies in this round yet. Give an independent view based on the same context.",
      "",
      "Rules:",
      "1. Do not repeat points already made in previous rounds.",
      "2. Only add new, useful information.",
      "3. If you have nothing new, reply exactly NO_REPLY.",
      "4. Be concise.",
    ].join("\n"),
    chairmanPrompt: (p: { topic: string; round: number; maxRounds: number; replies: string; mustFinish: boolean }) => [
      "This is a structured multi-agent discussion. You are the Chairman of this group.",
      "",
      "Topic:",
      p.topic,
      "",
      `Current round: ${p.round}/${p.maxRounds}`,
      "",
      "This round's replies:",
      p.replies || "(No regular participant replies in this round)",
      "",
      "Your responsibilities:",
      "1. First state your own substantive view and judgment; do not merely summarize neutrally.",
      "2. Identify the consensus already reached.",
      "3. Act as a challenger: inspect weak evidence, logical jumps, unverified assumptions, missed risks, and possible mistakes.",
      "4. Identify unresolved key disagreements.",
      "5. If views conflict, mediate and specify what the next round should focus on.",
      "6. If the discussion is sufficiently clear, or this round must finish, provide a final summary.",
      "",
      p.mustFinish
        ? "This round must finish. Start with `FINAL_SUMMARY:`. First give your own judgment, then point out remaining caveats/weak spots, then provide the final summary, consensus, disagreements, and next steps."
        : "If the discussion should continue, start with `CHAIRMAN_NOTE:`. First give your own judgment, then raise necessary challenges (weak evidence, logical jumps, unverified assumptions, missed risks), then mediate briefly and propose the next focus. If it can end now, start with `FINAL_SUMMARY:`, give your own judgment and necessary challenges first, then provide the final summary.",
      "",
      "Be concise and chair-like, but include your own view. Challenge when needed; do not merely restate participants' long answers.",
    ].join("\n"),
    labels: {
      noPreviousRounds: "(None yet; this is the first round)",
      noRegularReplies: "(No regular participant replies in this round)",
      noNewReply: "no new reply",
      error: "error",
      discussionRoundNotice: (round: number, max: number, parts: string) => `💬 Round ${round}/${max}: ${parts}`,
      round: "round",
      discussEndedChairman: (name: string) => `💬 Discuss ended: Chairman ${name} completed the final summary.`,
      discussEndedNoNew: (round: number) => `💬 Discuss ended: round ${round} had no new useful additions.`,
      discussMaxRounds: (max: number) => `💬 Discuss completed: reached ${max} rounds.`,
    },
  },
} as const;

export type I18n = typeof dict[Locale];

export function getI18n(locale?: string | null): I18n {
  return dict[normalizeLocale(locale)];
}
