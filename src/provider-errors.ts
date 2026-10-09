import type { Locale } from "./i18n.js";

export type ErrorCategory = "cancelled" | "model" | "model_unavailable" | "model_policy" | "tools" | "context" | "compaction_failed" | "quota" | "rate_limit" | "auth" | "network" | "ttft_timeout" | "total_timeout" | "collector_timeout" | "timeout" | "unknown";
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
  "model_not_supported", "invalid_model", "model_not_found", "unsupported_model", "incompatible_api", "model_disabled", "model_unavailable", "unknown_model",
  "invalid_request_error", "invalid_request", "bad_request", "invalid_argument", "schema_rejected", "schema_validation_error", "validation_error", "malformed_request",
  "context_length_exceeded", "context_window_exceeded", "prompt_too_long", "input_too_long",
  "insufficient_quota", "quota_exceeded", "usage_limit_exceeded", "credits_exhausted", "rate_limit_exceeded", "too_many_requests", "rate_limit_error",
  "authentication_error", "permission_denied", "unauthorized", "forbidden", "invalid_api_key",
  "econnrefused", "econnreset", "enotfound", "eai_again", "etimedout", "und_err_connect_timeout", "cert_has_expired", "unable_to_verify_leaf_signature", "err_tls_cert_altname_invalid",
  "ttft_timeout", "first_token_timeout", "response_header_timeout", "und_err_headers_timeout", "total_timeout", "execution_timeout", "request_deadline_exceeded",
  "server_error", "internal_error", "internal_server_error", "api_error", "service_unavailable", "overloaded_error", "timeout_error", "abort_err",
]);
const TYPES = new Set([...CODES, "error", "request_error", "invalid_argument_error", "permission_error", "not_found_error", "invalid_response_error", "gateway_error"]);
// A known model identifier is classification evidence, not public provider prose.
// Reject URLs and credential-shaped IDs; even a valid captured ID is never echoed.
const isSafeModelId = (value: string): boolean => /^[a-z0-9_./:-]{1,128}$/i.test(value)
  && !value.includes("://") && !/(?:^|[/:._-])(?:sk-|gh[pousr]_|eyJ)|secret|private_|password|credential|api[_-]?key|access[_-]?token/i.test(value)
  && !value.split("/").some(part => /^[a-f0-9]{24,}$/i.test(part) || /^[a-z0-9_+]{48,}$/i.test(part));
const isDisabledModelBody = (value: string): boolean => {
  const id = value.match(/^model '([a-z0-9_./:-]{1,128})' is disabled$/)?.[1];
  return id !== undefined && isSafeModelId(id);
};
const UNKNOWN_MODEL_NOTE = "The selected model is not registered in the current model catalog or is unavailable.";
const isUnknownModelBody = (value: string): boolean => {
  const id = value.match(/^Unknown model: ([a-z0-9][a-z0-9_.-]{0,63}\/([a-z0-9][a-z0-9_./-]{0,127}))$/i)?.[1];
  return id !== undefined && isSafeModelId(id) && id.split("/").every(part => part.length > 0);
};
// Exact observed Core copy, not a substring/context heuristic. No arbitrary
// reason suffix, model ID or provider prose is accepted or shown to the chat.
const CORE_COMPACTION_FAILURE = "⚠️ Context is too large and auto-compaction could not recover this turn. Try again, use /compact, or use /new to start a fresh session.";
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
  type Candidate = Partial<SafeProviderError> & { score: number; disabledModelBody?: boolean; unknownModelBody?: boolean; compactionFailedBody?: boolean };
  const candidates: Candidate[] = [];
  const texts: string[] = [];
  const seen = new Set<object>();
  let nodes = 0;
  let cancelled = false;
  let abortSignal = false;
  function visit(value: unknown, depth = 0, rank = 0, envelopeStatus?: number, rootDiagnostic = true, compactionDiagnostic = true): void {
    if (depth > 8 || ++nodes > 64) return;
    if (typeof value === "string") {
      const text = value.slice(0, MAX_TEXT).trim();
      texts.push(text);
      const unwrapped = text.replace(/^(?:(?:Agent error|RPC error|Error|HTTP(?: error)?)\s*:\s*)+/i, "");
      const statusPrefix = unwrapped.match(/^(?:HTTP\s*)?([45]\d{2})\b\s*:?\s*/i);
      const localStatus = statusPrefix ? httpStatus(statusPrefix[1]) : envelopeStatus;
      if (statusPrefix) candidates.push({ score: rank + depth, status: localStatus });
      if (/<(?:!doctype|html|body)\b/i.test(text)) return;
      const body = statusPrefix ? unwrapped.slice(statusPrefix[0].length) : unwrapped;
      // Only a complete JSON value in an explicit SDK/HTTP envelope. Never
      // search arbitrary prose (which may contain prompt echoes) for JSON or
      // code/type/request_id assignments.
      if (value.length <= MAX_TEXT && /^[{"]/.test(body)) {
        try { const parsed: unknown = JSON.parse(body); if (parsed !== value) visit(parsed, depth + 1, rank, localStatus, rootDiagnostic,
          compactionDiagnostic && typeof parsed === "string" && /^(?:Agent error|RPC error|Error)\s*:/i.test(text)); } catch { /* not JSON */ }
      }
      const plain = body.trim();
      if (rootDiagnostic && compactionDiagnostic && value.length <= MAX_TEXT && plain === CORE_COMPACTION_FAILURE) {
        candidates.push({ score: rank + depth, compactionFailedBody: true });
      }
      // Mark only a complete known sentence, never a "disabled" substring.
      // Classification below additionally requires the enclosing HTTP503 and
      // compatible diagnostic provenance, including sibling response.status.
      // Do not classify a truncated long body as a complete known sentence.
      if (value.length <= MAX_TEXT && isDisabledModelBody(plain)) {
        candidates.push({ score: rank + depth, disabledModelBody: true });
      }
      // A root Core/SDK diagnostic (including complete quoted envelopes), not
      // an arbitrary response-data/details/tool tree or a substring search.
      if (rootDiagnostic && value.length <= MAX_TEXT && isUnknownModelBody(plain)) {
        candidates.push({ score: rank + depth, unknownModelBody: true });
      }
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
      status: httpStatus(obj.status) ?? httpStatus(obj.statusCode) ?? httpStatus(obj.httpStatus)
        // Go writeErr's closed envelope uses a numeric HTTP code, not a string
        // provider code. Accept it only with its known gateway_error type.
        ?? (obj.type === "gateway_error" ? httpStatus(obj.code) : undefined),
      requestId: requestId(obj.request_id) ?? requestId(obj.req_id) ?? requestId(obj.requestId) };
    candidates.push(candidate);
    for (const field of ENVELOPE_FIELDS) {
      // An authoritative response.data.error outranks a sibling wrapper message
      // regardless of iteration order. Keep code/type/param as one envelope.
      const weight = field === "error" ? 100 : field === "response" ? 80 : field === "data" ? 20
        : field === "body" || field === "cause" || field === "details" ? 10 : 0;
      visit(obj[field], depth + 1, rank + weight, candidate.status ?? envelopeStatus,
        rootDiagnostic && ["error", "message", "msg", "errorMessage"].includes(field), compactionDiagnostic);
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
  const disabledBody = candidates.find(c => c.disabledModelBody);
  const neutralCode = /^(?:server_error|internal_error|internal_server_error|api_error|service_unavailable|invalid_request_error|bad_request)$/.test(code);
  const knownDisabledBody = result.status === 503 && disabledBody !== undefined
    && disabledBody.score >= (chosen?.score ?? -Infinity) && (!param || param === "model")
    && (!code || neutralCode)
    && (!type || /^(?:error|request_error|gateway_error|api_error|server_error|invalid_request_error|service_unavailable)$/.test(type));
  const unknownBody = candidates.find(c => c.unknownModelBody);
  const knownUnknownBody = unknownBody !== undefined && unknownBody.score >= (chosen?.score ?? -Infinity)
    && !abortSignal && ![401, 403, 429].includes(result.status ?? 0) && (!param || param === "model")
    && (!code || neutralCode)
    && (!type || /^(?:error|request_error|gateway_error|api_error|server_error|invalid_request_error|service_unavailable)$/.test(type));
  if (cancelled) result.category = "cancelled";
  else if (code === "unknown_model" || ((!code || neutralCode) && type === "unknown_model") || knownUnknownBody) {
    result.category = "model_unavailable";
    // Fixed semantic explanation, not an invented provider code or captured ID.
    result.safeMessage = UNKNOWN_MODEL_NOTE;
  }
  else if (/^(?:model_disabled|model_unavailable)$/.test(code)
    || ((!code || neutralCode) && /^(?:model_disabled|model_unavailable)$/.test(type)) || knownDisabledBody) result.category = "model_unavailable";
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
  else if (candidates.some(c => c.compactionFailedBody && c.score >= (chosen?.score ?? -Infinity))
    && ![401, 403, 429].includes(result.status ?? 0) && (!code || neutralCode) && !param
    && (!type || /^(?:error|request_error|gateway_error|api_error|server_error|invalid_request_error|service_unavailable)$/.test(type))) result.category = "compaction_failed";
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

/** Transparency (user directive 2026-10-09): the visible notice must always
 *  carry the original diagnostic so "unclassified" is still actionable. The
 *  excerpt is extracted from the error's diagnostic envelope fields and
 *  sanitized (no HTML, no URLs, no keys/tokens, capped) — never verbatim
 *  arbitrary provider prose. Kept out of classifyProviderError so the
 *  classification shape stays stable. */
export function rawErrorExcerpt(error: unknown): string | undefined {
  const texts: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 3 || texts.length > 16) return;
    if (typeof value === "string") {
      if (value.length <= MAX_TEXT) texts.push(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const obj = value as Record<string, unknown>;
    for (const field of ENVELOPE_FIELDS) {
      if (obj[field] !== undefined) visit(obj[field], depth + 1);
    }
  };
  visit(error);
  // Safety screen (the curated anti-echo contract keeps applying): prompt
  // echoes, tool outputs, JSON/HTML bodies, PRIVATE-like markers and known
  // compaction-copy fragments are attacker- or prompt-controlled content and
  // are never eligible for the transparency excerpt. Real server diagnostics
  // (status lines, provider error prose) pass through sanitized below.
  const isEcho = (t: string) => /\b(?:user|your)\s+prompt\b|\btool\s+outputs?\b|\btool\s+results?\b|\bdocs\s+quote\b/i.test(t);
  const containsCoreCopyFragment = /context is too large|auto-compaction could not|use \/compact|start a fresh session/i;
  // Credential-shaped or malformed-ID content is never eligible for echo.
  // Applied AFTER URL pre-redaction so URL-bearing diagnostics still show as
  // "[url]" instead of being dropped entirely.
  const credentialish = (t: string) => /api[_-]?key|secret|credential|password|passcode|ghp_[a-z0-9]|eyJ[a-z0-9]|sk-[a-z0-9]|private|\/\/|[{"]/i.test(t);
  const preRedact = (t: string) => t.replace(/\s+/g, " ").replace(/https?:\/\/\S+/gi, "[url]");
  const isUnsafeForEcho = (t: string) =>
    isEcho(t) || credentialish(t) || containsCoreCopyFragment.test(t)
    || /^\s*[{\["]/.test(t) || /<(?:!doctype|html|body)\b/i.test(t);
  const diagnosticTexts = texts.map(preRedact).filter(t => t && !isUnsafeForEcho(t));
  const excerptSource =
    diagnosticTexts.filter(t => /(?:error|fail|exceed|disabled|timeout|filter|quota|unsupported|invalid|refused|terminated|abort|prohibited|denied|limit|not found|unknown)/i.test(t))
      .sort((a, b) => b.length - a.length)[0]
    || [...diagnosticTexts].sort((a, b) => b.length - a.length)[0]
    || "";
  if (!excerptSource) return undefined;
  const sanitized = excerptSource
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\b(?:bearer|authorization)\s+[A-Za-z0-9._-]{8,}/gi, "[auth]")
    .replace(/[A-Za-z0-9+/]{32,}={0,2}/g, "[token]")
    .trim()
    .slice(0, 200);
  return sanitized || undefined;
}

export function safeErrorSummary(error: unknown): string {
  const e = classifyProviderError(error);
  return [e.category, e.safeMessage, e.status && `HTTP ${e.status}`, e.code && `code=${e.code}`,
    e.type && `type=${e.type}`, e.param && `param=${e.param}`, e.requestId && `request_id=${e.requestId}`].filter(Boolean).join(" · ");
}

export function formatProviderError(error: unknown, botName: string, model: string, locale: Locale): string {
  const e = classifyProviderError(error);
  // Transparency for the unclassified gap (user directive 2026-10-09): when
  // no category explains the failure, carry the sanitized original text.
  // Categorized errors keep their curated prose (anti-echo hardening) unless
  // an exact safe message was allowlisted.
  const rawExcerpt = e.category === "unknown" ? rawErrorExcerpt(error) : undefined;
  const en = locale === "en";
  const reasons: Record<ErrorCategory, [string, string]> = {
    cancelled: ["本次运行收到停止或取消信号；不据此认定供应商故障。", "A stop/cancel signal was reported; provider failure is not established."],
    model: ["当前模型不受供应商支持、不可用，或与所用 API 不兼容；供应商支持尚未恢复。", "The current model is unsupported, unavailable or incompatible with this API; provider support has not been restored."],
    model_unavailable: ["所选模型已暂停或当前没有可用上游；这不是工具参数错误。", "The selected model is paused or currently has no usable upstream; this is not a tool-argument error."],
    model_policy: ["当前模型被 OpenClaw 模型策略拒绝（modelPolicy.allow）；没有自动切换模型。", "The current model was rejected by OpenClaw modelPolicy.allow; no automatic model switch occurred."],
    tools: ["供应商明确拒绝了 tools/functions 的参数或 JSON Schema。", "The provider explicitly rejected tools/functions arguments or JSON Schema."],
    context: ["请求超过模型上下文或输入长度限制；这不是供应商额度耗尽。", "The request exceeded the model context/input limit; this is not quota exhaustion."],
    compaction_failed: ["整理/压缩未完成，本轮尚未生成回复；请检查摘要辅助模型或后台状态。", "Context preparation/compaction did not complete and this turn has not produced a reply; check the summarization helper model or background status."],
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
  const registration = e.category === "model_unavailable" && e.safeMessage === UNKNOWN_MODEL_NOTE;
  const reason = registration
    ? (en ? "The selected model is not registered in the current model catalog or is unavailable; this is not a tool-argument error."
      : "所选模型在当前模型目录中未注册或不可用；这不是工具参数错误。")
    : reasons[e.category][en ? 1 : 0];
  const metadata = [e.status && `HTTP ${e.status}`, e.code && `code=${e.code}`, e.type && `type=${e.type}`,
    e.param && `param=${e.param}`, e.requestId && `request_id=${e.requestId}`].filter(Boolean).join(" · ");
  // Names come from bridge configuration, not provider prose. Validate them too.
  const safeName = /^[\p{L}\p{N} _.-]{1,64}$/u.test(botName) ? botName : "Agent";
  const safeModel = isSafeModelId(model) ? model : "unknown";
  const title = e.category === "cancelled" ? (en ? "run cancelled" : "本次运行已取消") : (en ? "did not finish this reply" : "这次没有完成回复");
  return `${e.category === "cancelled" ? "⏹️" : "⚠️"} ${safeName} ${title}${en ? "." : "。"}\n${en ? "Model: " : "模型："}${safeModel}\n${en ? "Reason: " : "原因："}${reason}${e.safeMessage && !registration ? `\n${e.safeMessage}` : ""}${rawExcerpt && rawExcerpt !== e.safeMessage ? `\n${en ? "Raw error (excerpt): " : "原始错误（节选）："}${rawExcerpt}` : ""}${metadata ? `\n${metadata}` : ""}`;
}
