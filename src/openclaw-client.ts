import { OpenClawConfig } from "./config.js";
import { ChatMessage } from "./message-store.js";

interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CompletionResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export class OpenClawClient {
  private baseUrl: string;
  private token: string;

  constructor(config: OpenClawConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.token = config.token;
  }

  /**
   * Send the full conversation context to OpenClaw and get a response.
   *
   * @param botName   Name of the responding bot (for system prompt context)
   * @param model     Model override
   * @param sessionKey  Stable session key for this bot+chat
   * @param history   Full chat history (all participants)
   * @param systemPrompt  Bot-specific system prompt
   */
  async chat(params: {
    botName: string;
    sessionKey: string;
    model: string;
    history: ChatMessage[];
    systemPrompt?: string;
  }): Promise<string> {
    const messages: CompletionMessage[] = [];

    // System prompt: include bot identity + context about multi-bot setup
    const sysParts: string[] = [];
    if (params.systemPrompt) sysParts.push(params.systemPrompt);
    sysParts.push(
      `You are "${params.botName}" in a group chat. ` +
      `Other AI participants may also be present. ` +
      `Messages from humans are marked as [human], messages from other AIs are marked with their name like [GPT], [Claude], etc. ` +
      `Respond naturally as ${params.botName}. Keep responses concise for chat.`
    );
    messages.push({ role: "system", content: sysParts.join("\n\n") });

    // Convert chat history to OpenAI messages format
    for (const msg of params.history) {
      if (msg.senderType === "human") {
        messages.push({
          role: "user",
          content: `[${msg.senderName}]: ${msg.content}`,
        });
      } else if (msg.senderName === params.botName) {
        // This bot's own previous messages → assistant role
        messages.push({
          role: "assistant",
          content: msg.content,
        });
      } else {
        // Other bots' messages → user role with label
        messages.push({
          role: "user",
          content: `[${msg.senderName}]: ${msg.content}`,
        });
      }
    }

    const resp = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
        "x-openclaw-model": params.model,
        "x-openclaw-session-key": params.sessionKey,
      },
      body: JSON.stringify({
        model: "openclaw/default",
        messages,
      }),
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenClaw API error ${resp.status}: ${body}`);
    }

    const data = (await resp.json()) as CompletionResponse;
    return data.choices?.[0]?.message?.content || "(empty response)";
  }
}
