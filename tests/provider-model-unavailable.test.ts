import { describe, expect, it } from "vitest";
import { classifyProviderError, formatProviderError, safeErrorSummary } from "../src/provider-errors.js";
import { FeishuBot } from "../src/feishu-bot.js";

// Exact Go main.go pre-upstream configuredModelDisabled + writeErr contract.
// Model ID is public fixture metadata; no user request text or live call is used.
const sentence = "model 'gemini-3.8-flash' is disabled";
const goBody = { error: { message: sentence, type: "gateway_error", code: 503 } };
const show = (error: unknown, locale: "zh" | "en" = "zh", model = "x/gemini-3.8-flash") => formatProviderError(error, "Gemini", model, locale);

describe("Go disabled-model HTTP503 (the C false-negative regression)", () => {
  it.each([
    new Error(`Agent error: 503 ${sentence}`),
    new Error(`Agent error: 503 ${JSON.stringify(sentence)}`),
    new Error(`Agent error: HTTP 503: ${JSON.stringify(goBody)}`),
    new Error(`RPC error: ${JSON.stringify({ status: 503, error: JSON.stringify(sentence) })}`),
    { status: 503, error: { message: sentence } },
    { response: { status: 503, data: JSON.stringify(goBody) } },
    { response: { status: 503, data: JSON.stringify(sentence) } },
    { response: { status: 503 }, message: sentence },
    { response: { status: 503 }, message: JSON.stringify(sentence) },
    { response: { status: 503, data: { error: { message: JSON.stringify(sentence), type: "gateway_error", code: 503 } } } },
    goBody,
  ])("recognizes the complete known plain/JSON-quoted/nested SDK body with HTTP503", error => {
    expect(classifyProviderError(error)).toMatchObject({ category: "model_unavailable", status: 503 });
    const output = show(error);
    expect(output).toContain("所选模型已暂停或当前没有可用上游");
    expect(output).toContain("HTTP 503");
    expect(output).toContain("x/gemini-3.8-flash");
    expect(output).not.toContain("原因尚未分类");
    expect(output).not.toContain("JSON Schema");
    expect(output).not.toContain("The requested model is not supported");
    // No synthetic provider code or provider-prose/model-ID echo.
    expect(output).not.toContain("code=model_disabled");
    expect(output).not.toContain(sentence);
  });
  it.each(["model_disabled", "model_unavailable"])("accepts closed structured code %s before model-param/tool noise", code => {
    const error = { status: 503, error: { code, param: "model", message: "PRIVATE_PROMPT schema rejected disabled" } };
    expect(classifyProviderError(error)).toMatchObject({ category: "model_unavailable", code, param: "model", status: 503 });
    expect(show(error)).toContain(`code=${code}`);
    expect(show(error) + safeErrorSummary(error)).not.toContain("PRIVATE_");
  });
  it.each(["model_disabled", "model_unavailable"])("recognizes closed type %s with no invented code", type => {
    const error = { status: 503, error: { type, message: "模型已暂停 PRIVATE_PROMPT" } };
    expect(classifyProviderError(error)).toMatchObject({ category: "model_unavailable", type, status: 503 });
    expect(show(error)).toContain(`type=${type}`);
    expect(show(error)).not.toContain("PRIVATE_");
  });
  it("an explicit unavailable type can specialize generic codes but cannot hide concrete quota/context/auth", () => {
    expect(classifyProviderError({ status: 503, error: { code: "invalid_request_error", type: "model_unavailable", param: "model" } }).category).toBe("model_unavailable");
    for (const [code, category] of [["insufficient_quota", "quota"], ["context_length_exceeded", "context"], ["invalid_api_key", "auth"]]) {
      expect(classifyProviderError({ status: 503, error: { code, type: "model_unavailable" } }).category).toBe(category);
    }
  });
  it("does not let wrapper disabled prose replace authoritative nested model_not_supported", () => {
    const error = { response: { status: 400, data: { error: { code: "model_not_supported", param: "model" } } }, message: `503 ${JSON.stringify(sentence)}` };
    expect(classifyProviderError(error).category).toBe("model");
  });
  it.each([401, 403, 429, 500, 502, 504])("the known sentence with HTTP%s is not the observed Go disabled-model contract", status => {
    expect(classifyProviderError({ status, error: { message: sentence } }).category).not.toBe("model_unavailable");
  });
  it.each([
    sentence, new Error(sentence), "disabled", "model is disabled", "模型已暂停", "模型目前不可用",
    new Error(`503 Request rejected. User prompt: ${sentence}`),
    new Error(`503 tool output: ${JSON.stringify(goBody)}`),
    new Error(`503 prefix ${JSON.stringify(sentence)}`),
    new Error(`503 ${sentence} please retry`),
    new Error(`503 ${sentence}\nPRIVATE_PROMPT`),
    new Error(`503 ${JSON.stringify(sentence)}${" ".repeat(16_384)}PRIVATE_PROMPT`),
    new Error(`503 <html><body>${sentence}</body></html>`),
    new Error(`503 <body>${JSON.stringify(goBody)}</body>`),
    new Error('503 Service unavailable'),
    { status: 503, error: { code: "server_error", message: "disabled upstream request" } },
    { status: 503, error: { code: "service_unavailable", message: "PRIVATE_PROMPT" } },
    { status: 503, prompt: sentence, tools: [{ message: sentence }], request: { error: goBody } },
  ])("does not upgrade ambiguous prose, tool/prompt echoes, HTML or arbitrary server503", error => {
    expect(classifyProviderError(error).category).toBe("unknown");
    const output = show(error) + safeErrorSummary(error);
    expect(output).not.toContain("PRIVATE_");
    expect(output).not.toContain(sentence);
    expect(output).not.toContain("<html");
  });
  it.each([
    "https://private.invalid/path", "x/sk-abcdef0123456789", "ghp_abcdef0123456789", "eyJhbGciOiJPRIVATE",
    "abcdef0123456789abcdef0123456789", "api_key", "PRIVATE_MODEL", "secret-model", "a".repeat(129),
  ])("rejects credential/URL-shaped IDs in the closed template: %s", id => {
    const error = new Error(`503 model '${id}' is disabled`);
    expect(classifyProviderError(error).category).toBe("unknown");
    expect(show(error) + safeErrorSummary(error)).not.toContain(id);
    expect(show(error, "en", id)).toContain("Model: unknown");
  });
  it.each([
    ["invalid_argument", "tools"], ["context_length_exceeded", "context"], ["insufficient_quota", "quota"],
    ["invalid_api_key", "auth"], ["ECONNREFUSED", "network"], ["total_timeout", "total_timeout"],
  ])("a disabled sentence does not override stronger %s diagnostic with param=tools", (code, category) => {
    const error = { status: 503, error: { code, param: "tools", message: sentence } };
    expect(classifyProviderError(error).category).toBe(category);
  });
  it("gateway numeric HTTP code and complete sentence are jointly required", () => {
    const error = { error: { type: "gateway_error", code: 503, message: sentence } };
    expect(classifyProviderError(error).category).toBe("model_unavailable");
    expect(classifyProviderError({ error: { ...error.error, code: 500 } }).category).toBe("unknown");
    expect(classifyProviderError({ error: { ...error.error, message: "disabled" } }).category).toBe("unknown");
  });
  it("explicit caller stop remains stopped even with the exact Go error", () => {
    expect(classifyProviderError({ userStop: true, status: 503, error: goBody.error }).category).toBe("cancelled");
  });
  it("unknown nested credentials/tree fields and generic numeric code do not acquire Go authority", () => {
    expect(classifyProviderError({ error: { code: 503, message: sentence }, headers: { Authorization: "PRIVATE_AUTH" }, config: { token: "PRIVATE_TOKEN" } }).category).toBe("unknown");
    expect(show({ error: { code: 503, message: sentence }, headers: { Authorization: "PRIVATE_AUTH" } })).not.toContain("PRIVATE_");
  });
  it("a normal model-name suffix resembling part of a key prefix stays valid", () => {
    const error = new Error("503 model 'task-high' is disabled");
    expect(classifyProviderError(error).category).toBe("model_unavailable");
    expect(show(error, "en", "x/task-high")).toContain("Model: x/task-high");
  });
  it("keeps locale and configured model name without claiming global Gemini withdrawal", () => {
    expect(show(goBody, "en")).toContain("The selected model is paused or currently has no usable upstream");
    expect(show(goBody, "en")).toContain("Model: x/gemini-3.8-flash");
    expect(show(goBody)).not.toMatch(/Google|全球|撤模|已经恢复/);
    const bot: any = Object.create(FeishuBot.prototype);
    bot.config = { name: "Gemini", model: "x/gemini-3.8-flash" }; bot.locale = "zh";
    bot.store = { getChatLocale: (id: string) => id === "en-chat" ? "en" : "zh" };
    expect(bot.formatUserVisibleError(new Error(`Agent error: 503 ${JSON.stringify(sentence)}`), "en-chat")).toContain("selected model is paused");
    expect(bot.formatUserVisibleError(goBody, "zh-chat")).toContain("所选模型已暂停");
  });
});
