# v1.4.12

Release from main: explicit group mention identity and Chairman-off silence.

- Match managed bot mentions by configured app_id or startup-probed open_id.
  Conflicting known IDs reject the match. Display names, parentheses/suffixes,
  unverified IDs and message-supplied identity replacements are not trusted.
- A group message targeting others, without reliably targeting this bot, cannot
  trigger this bot through Free, Chairman, Discuss, coordinator or single-bot
  fallback. This also applies to local command routing.
- With no Chairman, ordinary unmentioned group messages do not start new model
  work, regardless of bot count, Free mode or stale Discuss state.
- Chairman off atomically clears Chairman and disables Discuss; future discussion
  scheduling stops, without aborting in-flight agents or suppressing old results.
- Preserve reliable self/multiple-target mentions, standalone broadcasts, private
  chats and local management commands used to restore Chairman. When a broadcast
  also names specific targets, explicit target exclusivity takes precedence.
- Rich-post mentions use structured IDs; incomplete/conflicting identities fail
  closed. Bare `/chairman CONFIGURED_NAME` remains a local management argument,
  not evidence that a name-only @ mention identifies a managed bot.

Compatibility: Free answers unmentioned messages only in groups with a Chairman.
Name-only mention delivery is intentionally no longer accepted. See bilingual
README group-routing sections for the complete behavior and migration notes.

Independent review passed build and 621 offline tests. Release preflight uses a
clean checkout. Bundled lma-steer is unchanged at 0.1.1; no plugin/Gateway update
is required. This release does not deploy or restart existing installations.
