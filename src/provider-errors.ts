import type { Locale } from "./i18n.js";

export type ErrorCategory = "cancelled" | "model" | "model_policy" | "tools" | "context" | "quota" | "rate_limit" | "auth" | "network" | "ttft_timeout" | "total_timeout" | "collector_timeout" | "timeout" | "unknown";
export interface SafeProviderError {
  category: ErrorCategory;
  status?: number;
  code?: string;
  type?: string;
  param?: string;
  requestId?: string;
  safeMessage?: string;
}

// Never serialize unknown error objects. Only traverse error-envelope fields;
// request/config/headers/prompt/tool definitions are deliberately not visited.
const ENVELOPE_FIELDS = ["response", "data", "body", "error", "cause", "message", "msg", "errorMessage", "details"] as const;
const MAX_TEXT = 16_384;
const CODES = new Set([
  "model_not_supported", "invalid_model", "model_not_found", "unsupported_model", "incompatible_api",
  "invalid_request_error", "invalid_request", "bad_request", "invalid_argument", "schema_rejected", "schema_validation_error", "validation_error", "malformed_request",
  "context_length_exceeded", "context_window_exceeded", "prompt_too_long", "input_too_long",
  "insufficient_quota", "quota_exceeded", "usage_limit_exceeded", "credits_exhausted", "rate_limit_exceeded", "too_many_requests", "rate_limit_error",
  "authentication_error", "permission_denied", "unauthorized", "forbidden", "invalid_api_key",
  "econnrefused", "econnreset", "enotfound", "eai_again", "etimedout", "und_err_connect_timeout", "cert_has_expired", "unable_to_verify_leaf_signature", "err_tls_cert_altname_invalid",
  "ttft_timeout", "first_token_timeout", "response_header_timeout", "und_err_headers_timeout", "total_timeout", "execution_timeout", "request_deadline_exceeded",
  "server_error", "internal_error", "internal_server_error", "api_error", "service_unavailable", "overloaded_error", "timeout_error", "abort_err",
]);
const TYPES = new Set([...CODES, "error", "request_error", "invalid_argument_error", "permission_error", "not_found_error", "invalid_response_error"]);
const diagnostic = (value: unknown, values: Set<string>): string | undefined => typeof value === "string"
  && values.has(value.toLowerCase()) ? value : undefined;
/** Classify by a validated root; expose only known structural path segments.
 * Arbitrary property/tool/function names never become public metadata. */
const parameter = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 256
    || !/^(?:model|api|api_version|endpoint|messages|input|max_tokens|max_completion_tokens|context|tools|functions|tool_choice)(?:\[\d{1,4}\]|\.[a-z0-9_-]+)*$/i.test(value)) return;
  const parts = value.match(/^[a-z_]+|\[\d+\]|\.[a-z0-9_-]+/gi)!;
  let safe = parts[0];
  for (const part of parts.slice(1)) {
    if (!/^(?:\[\d{1,4}\]|\.(?:\d{1,4}|function|parameters|name|type|properties|required|items))$/i.test(part)) break;
    safe += part;
  }
  return safe;
};
const requestId = (value: unknown): string | undefined => typeof value === "string"
  && /^(?:gw-[a-f0-9]{8,64}|req[_-][a-z0-9_-]{4,80}|[a-f0-9]{8}-[a-f0-9-]{27,40}|[a-f0-9]{16,64})$/i.test(value)
  && !/private_|secret|token|password|credential|api[_-]?key/i.test(value) ? value : undefined;
const httpStatus = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 400 && n <= 599 ? n : undefined;
};
// Exact, known diagnostic sentences only. Arbitrary provider prose can echo
// user input, credentials or tool schemas; metadata survives when prose cannot.
const SAFE_MESSAGES = [
  "The requested model is not supported.", "The requested model is not supported",
  "Invalid model", "Model not found", "Invalid argument", "invalid argument",
  "model not allowed by agents.defaults.modelPolicy.allow",
  "authentication rejected", "tool execution failed", "Request timed out", "Request timeout",
  "Gateway disconnected", "Gateway disconnected during run", "Not connected and reconnect failed",
  "execution budget exhausted", "Authentication failed", "Forbidden", "Unauthorized",
];

/** Bounded parsing of SDK strings (e.g. Agent error: 400 {"error":...})
 * and nested JSON errors. Deeper structured provider fields beat wrapper fields.
 * Message text is used for classification, never returned verbatim. */
export function classifyProviderError(error: unknown): SafeProviderError {
  type Candidate = Partial<SafeProviderError> & { score: number };
  const candidates: Candidate[] = [];
  const texts: string[] = [];
  const seen = new Set<object>();
  let nodes = 0;
  let cancelled = false;
  let abortSignal = false;
  function visit(value: unknown, depth = 0, rank = 0): void {
    if (depth > 8 || ++nodes > 64) return;
    if (typeof value === "string") {
      const text = value.slice(0, MAX_TEXT).trim();
      texts.push(text);
      const unwrapped = text.replace(/^(?:(?:Agent error|RPC error|Error|HTTP(?: error)?)\s*:\s*)+/i, "");
      const statusPrefix = unwrapped.match(/^(?:HTTP\s*)?([45]\d{2})\b\s*:?\s*/i);
      if (statusPrefix) candidates.push({ score: rank + depth, status: httpStatus(statusPrefix[1]) });
      if (/<(?:!doctype|html|body)\b/i.test(text)) return;
      const body = statusPrefix ? unwrapped.slice(statusPrefix[0].length) : unwrapped;
      // Only a complete JSON value in an explicit SDK/HTTP envelope. Never
      // search arbitrary prose (which may contain prompt echoes) for JSON or
      // code/type/request_id assignments.
      if (/^[{"]/.test(body)) {
        try { const parsed: unknown = JSON.parse(body); if (parsed !== value) visit(parsed, depth + 1, rank); } catch { /* not JSON */ }
      }
      const plain = body.trim();
      if (SAFE_MESSAGES.some(message => message.toLowerCase() === plain.toLowerCase())) {
        candidates.push({ score: rank + depth, safeMessage: plain });
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const obj = value as Record<string, unknown>;
    // Control intent is supplied by the caller's typed error, never by JSON
    // quoted inside provider prose. A message echo must not synthesize a stop.
    if (depth === 0) {
      if (obj.userStop === true || ["user", "user_stop", "user_cancel", "stop"].includes(String(obj.stopReason))) cancelled = true;
      if (obj.name === "AbortError" || obj.code === "ABORT_ERR") abortSignal = true;
    }
    const candidate: Candidate = { score: rank + depth,
      code: diagnostic(obj.code, CODES), type: diagnostic(obj.type, TYPES), param: parameter(obj.param),
      status: httpStatus(obj.status) ?? httpStatus(obj.statusCode) ?? httpStatus(obj.httpStatus),
      requestId: requestId(obj.request_id) ?? requestId(obj.req_id) ?? requestId(obj.requestId) };
    candidates.push(candidate);
    for (const field of ENVELOPE_FIELDS) {
      // An authoritative response.data.error outranks a sibling wrapper message
      // regardless of iteration order. Keep code/type/param as one envelope.
      const weight = field === "error" ? 100 : field === "response" ? 80 : field === "data" ? 20
        : field === "body" || field === "cause" || field === "details" ? 10 : 0;
      visit(obj[field], depth + 1, rank + weight);
    }
  }
  visit(error);
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates.find(c => c.code || c.type || c.param);
  const result: SafeProviderError = { category: "unknown",
    ...(chosen?.code ? { code: chosen.code } : {}), ...(chosen?.type ? { type: chosen.type } : {}),
    ...(chosen?.param ? { param: chosen.param } : {}),
  };
  for (const field of ["status", "requestId", "safeMessage"] as const) {
    const candidate = candidates.find(c => c[field] !== undefined);
    if (candidate) Object.assign(result, { [field]: candidate[field] });
  }
  // Exclude HTML and credential/payload text from heuristic classification.
  const text = texts.filter(t => !/<(?:!doctype|html|body)\b/i.test(t))
    .join(" ").replace(/https?:\/\/\S+/gi, "[url]").toLowerCase();
  const code = (result.code || "").toLowerCase();
  const type = (result.type || "").toLowerCase();
  const param = (result.param || "").toLowerCase();
  const tags = `${code} ${type}`;
  if (cancelled) result.category = "cancelled";
  else if (/\b(?:model_not_supported|invalid_model|model_not_found|unsupported_model|incompatible_api)\b/.test(tags) || param === "model") result.category = "model";
  else if (/^(?:tools|functions|tool_choice)(?:\b|[.\[])/.test(param)
    && (/^(?:invalid_argument|invalid_request_error|invalid_request|bad_request|schema_rejected|schema_validation_error|validation_error|malformed_request|invalid_argument_error)$/.test(code)
      || (!code && (/^(?:invalid_argument|invalid_request_error|validation_error|schema_validation_error|invalid_argument_error)$/.test(type)
        || /json schema|invalid (?:argument|schema)|tool payload/.test(text))))) result.category = "tools";
  else if (/\b(?:context_length_exceeded|context_window_exceeded|prompt_too_long|input_too_long)\b/.test(tags)) result.category = "context";
  else if (/\b(?:insufficient_quota|quota_exceeded|usage_limit_exceeded|credits_exhausted)\b/.test(tags)) result.category = "quota";
  else if (/\b(?:rate_limit_exceeded|too_many_requests|rate_limit_error)\b/.test(tags)) result.category = "rate_limit";
  else if (result.status === 401 || result.status === 403 || /\b(?:authentication_error|permission_denied|unauthorized|forbidden|invalid_api_key)\b/.test(tags)) result.category = "auth";
  else if (/\b(?:econnrefused|econnreset|enotfound|eai_again|etimedout|und_err_connect_timeout|cert_has_expired|unable_to_verify_leaf_signature|err_tls[a-z_]*)\b/.test(tags)) result.category = "network";
  else if (/\b(?:ttft_timeout|first_token_timeout|response_header_timeout|und_err_headers_timeout)\b/.test(tags)) result.category = "ttft_timeout";
  else if (/\b(?:total_timeout|execution_timeout|request_deadline_exceeded)\b/.test(tags)) result.category = "total_timeout";
  else if (abortSignal || code === "abort_err") result.category = "cancelled";
  // Fallback prose is classification evidence only. It cannot overwrite the
  // concrete structural category above and is never serialized to audiences.
  else if (/model not allowed by agents\.defaults\.modelpolicy\.allow/.test(text)) result.category = "model_policy";
  else if (/\b(?:invalid model|model (?:is )?not (?:supported|found)|requested model is not supported|incompatible api)\b/.test(text)) result.category = "model";
  else if (/\b(?:maximum context length|context window exceeded|prompt too (?:large|long))\b/.test(text)) result.category = "context";
  else if (/\b(?:quota (?:exceeded|exhausted)|(?:exceeded|exhausted).{0,40}(?:usage quota|usage limit)|insufficient (?:quota|credits)|credits exhausted)\b/.test(text)) result.category = "quota";
  else if (result.status === 429 || /\brate limit(?:ed| exceeded)?\b/.test(text)) result.category = "rate_limit";
  else if (/\b(?:authentication (?:failed|rejected)|permission denied|unauthorized|forbidden)\b/.test(text)) result.category = "auth";
  else if (/\b(?:dns (?:lookup|resolution) failed|tls (?:handshake|certificate)|ssl certificate|connection (?:refused|reset)|gateway disconnected|not connected and reconnect failed)\b/.test(text)) result.category = "network";
  else if (/\b(?:ttft|first[- ]token|response[- ]header).{0,24}(?:timeout|timed out)\b/.test(text)) result.category = "ttft_timeout";
  else if (/\b(?:total|execution|overall).{0,24}(?:timeout|timed out|deadline exceeded)\b/.test(text)) result.category = "total_timeout";
  else if (/\b(?:rpc timeout|collector timeout|collectreply.*timeout|status lookup timeout)\b/.test(text)
    || /等待 agent 运行结果超时/.test(text)) result.category = "collector_timeout";
  else if (!result.status && !/invalid|validation|schema|malformed/.test(tags + " " + text) && /\b(?:timeout|timed out|etimedout)\b|超时/.test(text)) result.category = "timeout";
  return result;
}

export function safeErrorSummary(error: unknown): string {
  const e = classifyProviderError(error);
  return [e.category, e.safeMessage, e.status && `HTTP ${e.status}`, e.code && `code=${e.code}`,
    e.type && `type=${e.type}`, e.param && `param=${e.param}`, e.requestId && `request_id=${e.requestId}`].filter(Boolean).join(" · ");
}

export function formatProviderError(error: unknown, botName: string, model: string, locale: Locale): string {
  const e = classifyProviderError(error);
  const en = locale === "en";
  const reasons: Record<ErrorCategory, [string, string]> = {
    cancelled: ["本次运行收到停止或取消信号；不据此认定供应商故障。", "A stop/cancel signal was reported; provider failure is not established."],
    model: ["当前模型不受供应商支持、不可用，或与所用 API 不兼容；供应商支持尚未恢复。", "The current model is unsupported, unavailable or incompatible with this API; provider support has not been restored."],
    model_policy: ["当前模型被 OpenClaw 模型策略拒绝（modelPolicy.allow）；没有自动切换模型。", "The current model was rejected by OpenClaw modelPolicy.allow; no automatic model switch occurred."],
    tools: ["供应商明确拒绝了 tools/functions 的参数或 JSON Schema。", "The provider explicitly rejected tools/functions arguments or JSON Schema."],
    context: ["请求超过模型上下文或输入长度限制；这不是供应商额度耗尽。", "The request exceeded the model context/input limit; this is not quota exhaustion."],
    quota: ["模型/供应商额度已用尽。", "The model/provider quota is exhausted."],
    rate_limit: ["供应商返回限流或额度限制（429）；未能确认额度已耗尽。", "The provider reported a rate/quota limit (429); quota exhaustion is not confirmed."],
    auth: ["供应商认证失败或当前账号无权访问。", "Provider authentication failed or the current account lacks access."],
    network: ["连接、DNS 或 TLS 失败；不是已确认的模型响应超时。", "Connection, DNS or TLS failed; this is not a confirmed model response timeout."],
    ttft_timeout: ["等待首个 token/响应头超时。", "Waiting for the first token/response headers timed out."],
    total_timeout: ["请求或运行的总时限已到。", "The request/run total deadline was reached."],
    collector_timeout: ["等待或 RPC 查询超时；不能据此认定供应商故障或底层运行已停止。", "A collector/RPC wait timed out; this does not establish provider failure or stopped execution."],
    timeout: ["收到超时错误，但未能确认是网络、首 token、总时限还是等待层。", "A timeout was reported; its network, first-token, total or collector boundary is unconfirmed."],
    unknown: ["请求未完成，原因尚未分类；不据此认定工具参数错误。", "The request did not complete and the cause is unclassified; a tool-argument failure is not established."],
  };
  const metadata = [e.status && `HTTP ${e.status}`, e.code && `code=${e.code}`, e.type && `type=${e.type}`,
    e.param && `param=${e.param}`, e.requestId && `request_id=${e.requestId}`].filter(Boolean).join(" · ");
  // Names come from bridge configuration, not provider prose. Validate them too.
  const safeName = /^[\p{L}\p{N} _.-]{1,64}$/u.test(botName) ? botName : "Agent";
  const safeModel = /^[a-z0-9_./:-]{1,128}$/i.test(model) && !model.includes("://") ? model : "unknown";
  const title = e.category === "cancelled" ? (en ? "run cancelled" : "本次运行已取消") : (en ? "did not finish this reply" : "这次没有完成回复");
  return `${e.category === "cancelled" ? "⏹️" : "⚠️"} ${safeName} ${title}${en ? "." : "。"}\n${en ? "Model: " : "模型："}${safeModel}\n${en ? "Reason: " : "原因："}${reasons[e.category][en ? 1 : 0]}${e.safeMessage ? `\n${e.safeMessage}` : ""}${metadata ? `\n${metadata}` : ""}`;
}
