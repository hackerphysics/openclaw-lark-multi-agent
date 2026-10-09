import { describe, expect, it } from "vitest";
import { classifyProviderError, formatProviderError, safeErrorSummary } from "../src/provider-errors.js";
const coreCopy = "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.";
const show = (error: unknown, locale: "zh" | "en" = "zh") => formatProviderError(error, "Gemini", "x/gemini-3.8-flash", locale);

describe("exact observed Core compaction failure, not broad context/tool/provider refusal", () => {
  it.each([
    coreCopy, new Error(coreCopy), new Error(`Agent error: ${coreCopy}`),
    new Error(`Agent error: ${JSON.stringify(coreCopy)}`), new Error(`RPC error: ${JSON.stringify(coreCopy)}`),
    { errorMessage: coreCopy }, { error: { message: coreCopy } },
  ])("recognizes the complete known copy in a root/native error chain or explicit quoted SDK string", error => {
    expect(classifyProviderError(error)).toEqual({ category: "compaction_failed" });
    expect(safeErrorSummary(error)).toBe("compaction_failed");
    const output = show(error);
    expect(output).toContain("整理/压缩未完成"); expect(output).toContain("摘要辅助模型或后台状态");
    expect(output).toContain("x/gemini-3.8-flash");
    expect(output).not.toMatch(/原因尚未分类|额度已用尽|JSON Schema|HTTP|gpt-5\.6|已恢复|Google/);
    expect(output).not.toContain(coreCopy);
  });
  it.each([
    "Context is too large", "auto-compaction could not recover this turn", `${coreCopy} PRIVATE_PROMPT`,
    `User prompt: ${coreCopy}`, `Tool result: ${coreCopy}`, `Docs quote: ${JSON.stringify(coreCopy)}`,
    `<html><body>${coreCopy}</body></html>`, `prefix ${JSON.stringify({ error: { message: coreCopy } })}`,
    JSON.stringify({ error: { message: coreCopy } }), JSON.stringify(coreCopy),
    new Error(`Agent error: ${JSON.stringify({ message: coreCopy })}`),
    `${coreCopy}${" ".repeat(16_384)}PRIVATE_PROMPT`,
    { tools: [{ errorMessage: coreCopy }], prompt: coreCopy, config: { token: "PRIVATE_TOKEN" } },
    { response: { data: { message: coreCopy } } }, { details: { errorMessage: coreCopy } },
    { message: "PRIVATE_PROMPT", cause: new Error(coreCopy) },
    coreCopy.replace("recover", "recover PRIVATE_KEY"),
    coreCopy.replace("Try again", "See https://private.invalid/?api_key=PRIVATE_KEY"),
  ])("does not promote prose/HTML/fake JSON/truncation/payload trees to a compaction failure", error => {
    expect(classifyProviderError(error).category).not.toBe("compaction_failed");
    const output = show(error) + safeErrorSummary(error);
    expect(output).not.toContain("PRIVATE_"); expect(output).not.toContain("https://");
    expect(output).not.toContain(coreCopy);
  });
  it.each([
    ["model_not_supported", "model"], ["model_disabled", "model_unavailable"], ["unknown_model", "model_unavailable"],
    ["context_length_exceeded", "context"], ["insufficient_quota", "quota"], ["rate_limit_exceeded", "rate_limit"],
    ["invalid_api_key", "auth"], ["ECONNREFUSED", "network"], ["total_timeout", "total_timeout"],
  ])("preserves stronger %s evidence before the exact message", (code, category) => {
    expect(classifyProviderError({ code, message: coreCopy }).category).toBe(category);
  });
  it("preserves real tools/stop/AbortError and HTTP authentication diagnoses", () => {
    expect(classifyProviderError({ status: 400, error: { code: "invalid_argument", param: "tools", message: coreCopy } }).category).toBe("tools");
    expect(classifyProviderError({ userStop: true, message: coreCopy }).category).toBe("cancelled");
    expect(classifyProviderError({ name: "AbortError", message: coreCopy }).category).toBe("cancelled");
    expect(classifyProviderError({ status: 403, message: coreCopy }).category).toBe("auth");
    expect(classifyProviderError({ status: 429, message: coreCopy }).category).toBe("rate_limit");
  });
  it("a wrapper compaction copy does not replace deeper concrete provider metadata", () => {
    const error = { response: { status: 400, data: { error: { code: "model_not_supported", param: "model" } } }, message: coreCopy };
    expect(classifyProviderError(error).category).toBe("model");
  });
  it("keeps existing collector/model-policy boundaries and internal content_filter unknown", () => {
    expect(classifyProviderError(new Error("RPC timeout: chat.send")).category).toBe("collector_timeout");
    expect(classifyProviderError(new Error("model not allowed by agents.defaults.modelPolicy.allow")).category).toBe("model_policy");
    expect(classifyProviderError(new Error("Provider finish_reason: content_filter: PROHIBITED_CONTENT")).category).toBe("unknown");
  });
  it("English wording explains preparation failure without inventing helper identity or provider cause", () => {
    const output = show(new Error(`Agent error: ${coreCopy}`), "en");
    expect(output).toContain("Context preparation/compaction did not complete");
    expect(output).toContain("check the summarization helper model or background status");
    expect(output).toContain("Model: x/gemini-3.8-flash");
    expect(output).not.toMatch(/quota|JSON Schema|gpt-5\.6|not supported|restored/);
  });
});
