import { OpenClawConfig } from "./config.js";

interface ChatMessage {
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
   * Send a message to OpenClaw and get a response.
   * Each bot+chat combination gets a unique session key for conversation continuity.
   */
  async chat(params: {
    sessionKey: string;
    model: string;
    message: string;
    systemPrompt?: string;
  }): Promise<string> {
    const messages: ChatMessage[] = [];

    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.message });

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
