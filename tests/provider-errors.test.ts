import { describe, expect, it } from "vitest";
import { classifyProviderError, formatProviderError, rawErrorExcerpt, safeErrorSummary, type ErrorCategory } from "../src/provider-errors.js";
import { FeishuBot } from "../src/feishu-bot.js";
import { SessionWaitPaused, normalizeSessionRuntimeStatus } from "../src/session-status.js";

const modelError = { status: 400, error: { code: "model_not_supported", type: "invalid_request_error", param: "model", message: "The requested model is not supported." }, request_id: "gw-72f76eeee916f7fa" };
const show = (e: unknown, locale: "zh" | "en" = "zh") => formatProviderError(e, "Gemini", "x/gemini-3.8-flash", locale);

describe("structured provider-error classification and safe presentation", () => {
  it.each([
    modelError,
    new Error(`Agent error: 400 ${JSON.stringify(modelError)}`),
    { code: "schema_validation_error", error: JSON.stringify(modelError) },
    new Error(`RPC error: ${JSON.stringify({ message: `HTTP 400: ${JSON.stringify(modelError)}`, code: "schema_rejected" })}`),
    { response: { status: 400, data: { error: JSON.stringify(modelError.error) } } },
  ])("prioritizes concrete model rejection over wrapper schema/rejected labels", error => {
    const e = classifyProviderError(error);
    expect(e).toMatchObject({ category: "model", status: 400, code: "model_not_supported", param: "model" });
    expect(show(error)).toContain("供应商支持尚未恢复");
    expect(show(error)).not.toContain("JSON Schema");
    expect(show(error)).toContain("x/gemini-3.8-flash");
  });
  it("preserves safe provider message, status and request identity without inventing OpenClaw/Go correlation", () => {
    expect(show(modelError)).toContain("The requested model is not supported.");
    expect(show(modelError)).toContain("HTTP 400");
    expect(show(modelError)).toContain("request_id=gw-72f76eeee916f7fa");
    expect(classifyProviderError(modelError)).not.toHaveProperty("runId");
  });
  it.each([
    ["invalid_model", "model"], ["incompatible_api", "model"],
    ["model_not_found", "model"], ["invalid_request_error", "model"],
  ])("classifies %s/param=%s as a model/API error", (code, param) => {
    expect(classifyProviderError({ status: 400, error: { code, param } }).category).toBe("model");
  });
  it.each(["schema rejected", "request rejected", "exceeded allowed length", "invalid timeout parameter", "schema_validation_error"]) ("does not infer tools/quota/timeout from generic text %s", message => {
    expect(classifyProviderError(new Error(message)).category).toBe("unknown");
    expect(show(new Error(message))).toContain("原因尚未分类");
  });
  it.each(["tools", "tools[0].function.parameters", "tools.0.function.name", "functions[1].parameters", "tool_choice"]) ("reports actual invalid tool argument param=%s without echoing names or definitions", param => {
    const error = { status: 400, error: { code: "invalid_argument", param,
      message: "Invalid JSON schema for function 'private_customer_lookup': sk-secret-value. User prompt: PRIVATE_PROMPT",
      tools: [{ function: { name: "private_customer_lookup", parameters: { secret: "PRIVATE_DEFINITION" } } }] } };
    const output = show(error) + safeErrorSummary(error);
    expect(classifyProviderError(error).category).toBe("tools");
    expect(output).toContain(`param=${param}`);
    for (const secret of ["private_customer_lookup", "sk-secret-value", "PRIVATE_PROMPT", "PRIVATE_DEFINITION"]) expect(output).not.toContain(secret);
  });
  it("does not classify a schema keyword without a tools/functions parameter as a tools failure", () => {
    expect(classifyProviderError({ status: 400, error: { code: "schema_rejected", param: "messages", message: "schema" } }).category).toBe("unknown");
  });
  it.each([
    ["insufficient_quota", "quota"], ["quota_exceeded", "quota"], ["rate_limit_exceeded", "rate_limit"],
    ["context_length_exceeded", "context"], ["prompt_too_long", "context"],
  ] as const)("distinguishes 429 %s as %s", (code, category) => {
    expect(classifyProviderError({ status: 429, error: { code } }).category).toBe(category);
  });
  it("a bare 429 does not assert true exhaustion", () => {
    expect(show(new Error('Agent error: 429 {"error":{"message":"PRIVATE_PROMPT"}}'))).toContain("未能确认额度已耗尽");
  });
  it("retains the proven usage-quota case but does not echo arbitrary reset prose", () => {
    expect(classifyProviderError(new Error("You have exceeded the 5-hour usage quota. It will reset at PRIVATE_RESET." )).category).toBe("quota");
    expect(show(new Error("You have exceeded the 5-hour usage quota. It will reset at PRIVATE_RESET."))).not.toContain("PRIVATE_RESET");
  });
  it("retains model policy diagnostics without blaming provider tools or changing models", () => {
    const error = new Error("model not allowed by agents.defaults.modelPolicy.allow");
    expect(classifyProviderError(error).category).toBe("model_policy");
    expect(show(error)).toContain("modelPolicy.allow");
    expect(show(error)).not.toContain("JSON Schema");
  });
  it("recognizes an invalid_api_key error code without echoing actual keys", () => {
    const error = { error: { code: "invalid_api_key", message: "sk-secret-value" } };
    expect(classifyProviderError(error).category).toBe("auth");
    expect(show(error)).toContain("code=invalid_api_key");
    expect(show(error)).not.toContain("sk-secret-value");
  });
  it.each([401, 403])("reports HTTP %s as authentication/access, not schema rejection", status => {
    expect(classifyProviderError({ status, error: { message: "request rejected" } }).category).toBe("auth");
  });
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"]) ("separates %s network/TLS/DNS from provider latency", code => {
    expect(classifyProviderError(Object.assign(new Error("PRIVATE_HOST"), { code })).category).toBe("network");
    expect(show({ code })).not.toContain("PRIVATE_HOST");
  });
  it.each([
    ["TTFT timeout", "ttft_timeout"], ["first token timed out", "ttft_timeout"],
    ["total timeout", "total_timeout"], ["execution deadline exceeded", "total_timeout"],
    ["RPC timeout: chat.send", "collector_timeout"], ["collectReply idle reconcile timeout", "collector_timeout"],
    ["Request timed out", "timeout"],
  ] as [string, ErrorCategory][])("preserves %s boundary as %s", (message, category) => {
    expect(classifyProviderError(new Error(message)).category).toBe(category);
  });
  it.each([
    { name: "AbortError", message: "aborted" }, { code: "ABORT_ERR" },
    { userStop: true, error: modelError }, { stopReason: "user_cancel" },
  ])("cancel/stop outranks provider labels", error => {
    expect(classifyProviderError(error).category).toBe("cancelled");
    expect(show(error)).toContain("不据此认定供应商故障");
    expect(show(error)).not.toContain("这次没有完成回复");
  });
  it.each([
    '<html><body>PRIVATE_PROMPT https://private.invalid/?api_key=PRIVATE_KEY</body></html>',
    'upstream returned https://private.invalid/internal?key=PRIVATE_KEY token=PRIVATE_TOKEN',
    'HTTP 500 upstream https://private.invalid/?code=PRIVATE_CODE&request_id=req_PRIVATE_KEY',
    '<html><body>code=PRIVATE_CODE request_id=req_PRIVATE_KEY</body></html>',
    { status: 500, error: { code: "PRIVATE_CODE", type: "PRIVATE_TYPE" }, request_id: "req_PRIVATE_KEY" },
    { error: JSON.stringify({ status: 500, error: { code: "server_error", type: "api_error", message: 'PRIVATE_PROMPT https://private.invalid/?token=PRIVATE_KEY' } }), config: { headers: { Authorization: "PRIVATE_AUTH" } } },
    { status: 400, error: { code: "sk-secret", param: "PRIVATE_PARAM", message: '{"tools":[{"secret":"PRIVATE_DEFINITION"}]}' } },
  ])("never echoes HTML, private URLs, prompts, tokens or definitions", error => {
    const output = show(error) + safeErrorSummary(error);
    for (const fragment of ["PRIVATE_", "https://", "<html", "sk-secret", "Authorization"]) expect(output).not.toContain(fragment);
  });
  it("never extracts metadata or tool names from arbitrary prompt echo prose", () => {
    const error = new Error("Request rejected. User prompt: code=abcdef0123456789abcdef0123456789 type=customer_lookup request_id=req_customer1234");
    expect(classifyProviderError(error)).toEqual({ category: "unknown" });
    const output = show(error) + safeErrorSummary(error);
    for (const text of ["abcdef0123456789", "customer_lookup", "req_customer1234"]) expect(output).not.toContain(text);
  });
  it("does not accept arbitrary credentials-shaped structured code/type values", () => {
    const error = { status: 500, error: { code: "abcdef0123456789abcdef0123456789", type: "customer_lookup" } };
    expect(classifyProviderError(error)).toEqual({ category: "unknown", status: 500 });
    expect(show(error)).not.toContain("customer_lookup");
  });
  it("a wrapper message cannot replace an authoritative response.data.error envelope", () => {
    const error = { response: { status: 400, data: { error: { code: "model_not_supported", param: "model" } } }, message: '{"code":"schema_rejected","param":"tools"}' };
    expect(classifyProviderError(error)).toMatchObject({ category: "model", status: 400, code: "model_not_supported", param: "model" });
    expect(show(error)).not.toContain("JSON Schema");
  });
  it("classifies a deep tools property path using only its safe structural prefix", () => {
    const error = { status: 400, error: { code: "invalid_argument", param: "tools[0].function.parameters.properties.customer_id", message: "Invalid JSON schema" } };
    expect(classifyProviderError(error)).toMatchObject({ category: "tools", param: "tools[0].function.parameters.properties" });
    expect(show(error) + safeErrorSummary(error)).not.toContain("customer_id");
  });
  it("prompt-echo stop words never override a structured model rejection", () => {
    const error = { status: 400, error: { code: "model_not_supported", param: "model", message: 'Rejected input containing "user stopped"' } };
    expect(classifyProviderError(error).category).toBe("model");
    expect(show(error)).not.toContain("本次运行已取消");
  });
  it("a tools param and HTTP 400 cannot override a concrete context error code", () => {
    const error = { status: 400, error: { code: "context_length_exceeded", param: "tools", message: "The request exceeds the model context window." } };
    expect(classifyProviderError(error).category).toBe("context");
    const withoutParam = { ...error, error: { code: error.error.code, message: error.error.message } };
    expect(classifyProviderError(withoutParam).category).toBe("context");
    expect(show(error)).not.toContain("JSON Schema");
  });
  it.each(["insufficient_quota", "invalid_api_key"])("a tools param does not override concrete %s", code => {
    expect(classifyProviderError({ status: 400, error: { code, type: "invalid_request_error", param: "tools" } }).category).toBe(code === "invalid_api_key" ? "auth" : "quota");
  });
  it("JSON quoted in provider prose cannot synthesize caller stop intent", () => {
    const error = { status: 400, error: { code: "model_not_supported", param: "model", message: '{"userStop":true,"stopReason":"stop","name":"AbortError"}' } };
    expect(classifyProviderError(error).category).toBe("model");
  });
  it("a generic AbortError does not hide a known total-timeout cause", () => {
    expect(classifyProviderError({ name: "AbortError", error: { code: "total_timeout" } }).category).toBe("total_timeout");
  });
  it("bounds recursive/oversize/malformed inputs without leaking arbitrary prose", () => {
    const recursive: any = { status: 500, message: "PRIVATE_TEXT" }; recursive.error = recursive;
    expect(show(recursive)).toContain("HTTP 500");
    expect(show(new Error("PRIVATE_TEXT".repeat(10_000)))).not.toContain("PRIVATE_TEXT");
    expect(show(new Error('400 {"error":"PRIVATE_TEXT"'))).not.toContain("PRIVATE_TEXT");
  });
  it("English style retains model name and concrete code", () => {
    expect(show(modelError, "en")).toContain("Reason: The current model is unsupported");
    expect(show(modelError, "en")).toContain("Model: x/gemini-3.8-flash");
    expect(show(modelError, "en")).toContain("code=model_not_supported");
  });
  it("uses the chat locale while preserving waiting/yield notice semantics unchanged", () => {
    const bot: any = Object.create(FeishuBot.prototype);
    bot.config = { name: "Gemini", model: "x/gemini-3.8-flash" };
    bot.locale = "zh";
    bot.store = { getChatLocale: (id: string) => id === "english-chat" ? "en" : "zh" };
    expect(bot.formatUserVisibleError(modelError, "english-chat")).toContain("The current model is unsupported");
    for (const reason of ["timeout", "yield"] as const) {
      const notice = new SessionWaitPaused(normalizeSessionRuntimeStatus({ session: { status: "running" } }), true, reason);
      expect(bot.formatUserVisibleError(notice, "english-chat")).toBe(notice.message);
    }
  });
});

describe("provider error transparency (raw excerpt, directive 2026-10-09)", () => {
  it("carries a sanitized raw excerpt for unclassified errors", () => {
    const err = new Error("400 unsupported registered MiniMax M3.1 operation");
    expect(classifyProviderError(err).category).toBe("unknown");
    expect(rawErrorExcerpt(err)).toContain("unsupported registered MiniMax M3.1 operation");
    const text = formatProviderError(err, "Minimax", "x/minimax-m3.1-flash", "zh");
    expect(text).toContain("原始错误（节选）");
    expect(text).toContain("unsupported registered MiniMax M3.1 operation");
  });

  it("categorized errors keep curated prose without the raw excerpt", () => {
    const err = new Error("429 You have exceeded the monthly usage quota. It will reset at 2026-10-09 23:59:59 +0800 CST.");
    expect(classifyProviderError(err).category).toBe("quota");
    const text = formatProviderError(err, "Gemini", "phgeek-gw/gemini-3.8-flash", "zh");
    expect(text).toContain("额度已用尽");
    expect(text).toContain("HTTP 429");
    expect(text).not.toContain("原始错误（节选）");
  });

  it("redacts URLs and long tokens in the excerpt", () => {
    const err = new Error("500 upstream failed https://evil.example/path?a=1 " + "A".repeat(64) + "\nline2");
    const excerpt = rawErrorExcerpt(err);
    expect(excerpt).toContain("[url]");
    expect(excerpt).not.toContain("evil.example");
    expect(excerpt).not.toContain("AAAA");
    expect(excerpt!.length).toBeLessThanOrEqual(200);
  });

  it("credential-shaped, echo-marked, JSON/HTML and core-copy texts are never echoed", () => {
    expect(rawErrorExcerpt(new Error("500 upstream failed key sk-AbCdEf123456789012345678 token ghp_ab12cd34"))).toBeUndefined();
    expect(rawErrorExcerpt(new Error("400 bad request for api_key rotation"))).toBeUndefined();
    expect(rawErrorExcerpt(new Error("Request rejected. User prompt: do things"))).toBeUndefined();
    expect(rawErrorExcerpt(new Error('Prefix {"message":"boom"}'))).toBeUndefined();
    expect(rawErrorExcerpt(new Error("<!doctype html><html>err</html>"))).toBeUndefined();
    expect(rawErrorExcerpt(new Error("⚠️ Context is too large and auto-compaction could not recover this turn."))).toBeUndefined();
  });

  it("content-filter rejections surface their raw reason", () => {
    const err = new Error("Provider finish_reason: content_filter: PROHIBITED_CONTENT");
    const text = formatProviderError(err, "Gemini", "phgeek-gw/gemini-3.8-flash", "zh");
    expect(text).toContain("content_filter: PROHIBITED_CONTENT");
  });

  it("the exact disabled-model copy classifies with curated prose (no excerpt needed)", () => {
    const err = new Error("503 model 'gemini-3.8-flash' is disabled");
    expect(classifyProviderError(err).category).toBe("model_unavailable");
    const text = formatProviderError(err, "Gemini", "phgeek-gw/gemini-3.8-flash", "zh");
    expect(text).toContain("所选模型已暂停");
    expect(text).toContain("HTTP 503");
    expect(text).not.toContain("原始错误（节选）");
  });
});
