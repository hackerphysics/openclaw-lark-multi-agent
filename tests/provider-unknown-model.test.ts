import { describe, expect, it } from "vitest";
import { classifyProviderError, formatProviderError, safeErrorSummary } from "../src/provider-errors.js";
import { FeishuBot } from "../src/feishu-bot.js";
const sentence = "Unknown model: x/gemini-3.8-flash";
const show = (error: unknown, locale: "zh" | "en" = "zh", model = "x/gemini-3.8-flash") => formatProviderError(error, "Gemini", model, locale);

describe("r4b exact root Core/SDK unknown-custom-model regression", () => {
  it.each([
    new Error(sentence), sentence,
    new Error(`Agent error: ${sentence}`),
    new Error(`RPC error: ${JSON.stringify(sentence)}`),
    { message: sentence },
    { error: { message: sentence } },
    new Error(`Agent error: ${JSON.stringify({ error: { message: sentence } })}`),
  ])("recognizes only the complete qualified root diagnostic without inventing provider code/status", error => {
    const result = classifyProviderError(error);
    expect(result.category).toBe("model_unavailable");
    expect(result).not.toHaveProperty("code"); expect(result).not.toHaveProperty("status");
    const output = show(error);
    expect(output).toContain("所选模型在当前模型目录中未注册或不可用");
    expect(output).toContain("x/gemini-3.8-flash");
    expect(output).not.toContain("原因尚未分类"); expect(output).not.toContain("JSON Schema");
    expect(output).not.toContain(sentence); expect(output).not.toContain("code=unknown_model");
    expect(output).not.toMatch(/Google|全球|供应商支持尚未恢复/);
  });
  it.each([
    { code: "unknown_model", param: "model" },
    { type: "unknown_model" },
    { status: 404, error: { code: "unknown_model", param: "model", message: "PRIVATE_PROMPT" } },
    { response: { status: 400, data: { error: { code: "unknown_model", type: "invalid_request_error" } } } },
    { error: { code: "invalid_request_error", type: "unknown_model" } },
  ])("accepts closed typed/nested unknown_model evidence and does not echo its arbitrary prose", error => {
    expect(classifyProviderError(error).category).toBe("model_unavailable");
    expect(show(error) + safeErrorSummary(error)).not.toContain("PRIVATE_");
    expect(show(error)).toContain("未注册或不可用");
  });
  it.each([
    "unknown", "Unknown model", "Unknown model: gemini-3.8-flash", "Unknown model: x/",
    `Request rejected. User prompt: ${sentence}`, `tool output: ${sentence}`, `${sentence}\nPRIVATE_PROMPT`,
    `Prefix ${JSON.stringify({ message: sentence })}`, `<html><body>${sentence}</body></html>`,
    `${JSON.stringify(sentence)}${" ".repeat(16_384)}PRIVATE_PROMPT`,
    { prompt: sentence, tools: [{ message: sentence }], request: { error: { message: sentence } } },
    { details: { error: { message: sentence } } },
    { response: { status: 503, data: { message: sentence } } },
  ])("does not upgrade ambiguous prose, HTML, JSON substrings, truncation or arbitrary data/tool trees", error => {
    expect(classifyProviderError(error).category).toBe("unknown");
    expect(show(error) + safeErrorSummary(error)).not.toContain("PRIVATE_");
    // Transparency directive (2026-10-09): unclassified plain server prose MAY
    // now echo via the sanitized 原始错误 excerpt; PRIVATE/credential/echo/
    // JSON/HTML screens above still block everything dangerous.
  });
  it.each([
    "x/https://private.invalid/key", "x/sk-abc…6789", "x/ghp_ab…6789", "x/eyJhbGciOiJPRIVATE", "x/api_key", "x/secret-id",
    "x/abcdef0123456789abcdef0123456789", "x/" + "a".repeat(64), "x//gemini", "PRIVATE_PROVIDER/gemini",
  ])("rejects URL/credential-shaped IDs and never echoes escaped secrets: %s", id => {
    const error = new Error(`Unknown model: ${id}`);
    expect(classifyProviderError(error).category).toBe("unknown");
    expect(show(error) + safeErrorSummary(error)).not.toContain(id);
  });
  it("preserves a legitimate long hyphenated model name instead of masking it as an opaque credential", () => {
    const id = "x/gpt-oss-120b-low-adaptive-public-core-20260910-pinned";
    expect(classifyProviderError(new Error(`Unknown model: ${id}`)).category).toBe("model_unavailable");
    expect(show(new Error(`Unknown model: ${id}`), "en", id)).toContain(`Model: ${id}`);
  });
  it("JSON-unescaped credential-shaped IDs stay rejected and unsafe configured IDs are masked", () => {
    const error = new Error('Agent error: "Unknown model: x/\\u0073k-PRIVATE_KEY"');
    expect(classifyProviderError(error).category).toBe("unknown");
    expect(show(error) + safeErrorSummary(error)).not.toContain("PRIVATE_");
    expect(show(new Error(sentence), "en", "x/abcdef0123456789abcdef0123456789")).toContain("Model: unknown");
  });
  it.each([
    ["invalid_argument", "tools", "tools"], ["context_length_exceeded", "tools", "context"],
    ["insufficient_quota", "tools", "quota"], ["invalid_api_key", "tools", "auth"],
    ["ECONNREFUSED", "tools", "network"], ["total_timeout", "tools", "total_timeout"],
  ])("the root template cannot override stronger %s/%s metadata", (code, param, category) => {
    expect(classifyProviderError({ code, param, message: sentence }).category).toBe(category);
    expect(classifyProviderError({ code, param, type: "unknown_model", message: "noise" }).category).toBe(category);
  });
  it.each([[401, "auth"], [403, "auth"], [429, "rate_limit"]])("HTTP%s remains authoritative for an untyped template", (status, category) => {
    expect(classifyProviderError({ status, message: sentence }).category).toBe(category);
  });
  it("real stop/AbortError, collector and model-policy diagnoses stay unchanged", () => {
    expect(classifyProviderError({ userStop: true, error: { code: "unknown_model" } }).category).toBe("cancelled");
    expect(classifyProviderError({ name: "AbortError", message: sentence }).category).toBe("cancelled");
    expect(classifyProviderError({ message: "RPC timeout: chat.send", cause: new Error(sentence) }).category).toBe("collector_timeout");
    expect(classifyProviderError({ message: "model not allowed by agents.defaults.modelPolicy.allow", cause: new Error(sentence) }).category).toBe("model_policy");
  });
  it("the father's three frozen counter shapes now classify unavailable/unavailable/unknown", () => {
    expect(classifyProviderError(new Error(sentence)).category).toBe("model_unavailable");
    expect(classifyProviderError(new Error("503 model 'gemini-3.8-flash' is disabled")).category).toBe("model_unavailable");
    expect(classifyProviderError({ status: 503, error: { code: "server_error", message: "Service unavailable" } }).category).toBe("unknown");
  });
  it("keeps configured model and zh/en locale with fixed registration-specific wording", () => {
    const bot: any = Object.create(FeishuBot.prototype);
    bot.config = { name: "Gemini", model: "x/gemini-3.8-flash" }; bot.locale = "zh";
    bot.store = { getChatLocale: (id: string) => id === "en-chat" ? "en" : "zh" };
    expect(bot.formatUserVisibleError(new Error(sentence), "en-chat")).toContain("not registered in the current model catalog");
    expect(bot.formatUserVisibleError(new Error(sentence), "en-chat")).toContain("Model: x/gemini-3.8-flash");
    expect(bot.formatUserVisibleError(new Error(sentence), "zh-chat")).toContain("未注册或不可用");
  });
});
