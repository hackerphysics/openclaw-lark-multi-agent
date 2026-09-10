# v1.4.10

Published from main. Adds Gateway-confirmed yield foreground handoff on top of
1.4.9's compact context/status footer and ten-minute foreground/card budget.

- Immediately send a normal background-wait notice and freeze recurring card
  edits when a trusted chat-final event has `yielded: true`; no ten-minute wait.
- Keep result observation and final delivery ownership, without treating the
  handoff or its buffered preface as successful completion, failure or NO_REPLY.
- Do not infer handoff from a tool name, spawn receipt or unconfirmed tool result.
- Do not expose sessions_yield's private message/arguments/results in tool cards.
- Prevent yielded/empty-final fallback from stopping the original run; preserve
  explicit stop and late-result handling.
- Keep new-run continuation results on the existing proactive delivery route.
- Reuse trigger-level notice dedupe; an earlier timeout notice is not repeated
  when the same trigger later yields. Real final-answer keys remain available.

Build and 369 offline tests passed during independent review. Release validation
also uses a clean checkout. Live Feishu/reconnect edge cases are not claimed by
these offline tests; see docs/yield-handoff-2026-09-10.md for precise limitations.

Bundled lma-steer remains 0.1.1 (unchanged). This version does not include
experimental steer V2, does not change Gateway SDK imports, and requires no new
plugin update beyond the 1.4.9 bundle. Release publication does not automatically
update or restart an already-installed LMA service.
