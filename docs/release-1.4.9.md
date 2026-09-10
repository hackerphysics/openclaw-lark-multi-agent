# v1.4.9

Release from main, including the previously local cf5827d reconciliation fix.

- Compact final footer: model · session state · integer-K context used/limit.
- Remove the `status:` prefix and snapshot wording from the footer. Data remains
  a send-time snapshot, not a promise of continuously updated state.
- Ten-minute foreground wait and independent card refresh budget. Continuous
  progress cannot extend recurring card edits indefinitely.
- A running session's wait timeout produces a normal notice, not a false session
  failure. Original background observation/queue ownership remain; no automatic
  abort or request replay. Frozen cards allow only necessary terminal cleanup.
- Keep the real final answer's delivery key free; real results win timeout races.
- Bounded metadata lookup, unknown/stale count handling and plain-text fallback.
- lma-steer 0.1.1 is a compatibility/packaging refresh, not a new injection engine.
  It preserves legacy behavior and accepts but ignores old questionBridge config.
- Regression tests are network-isolated by default, including publish/CI runs.

Not included: unverified steer V2 or ask_user adaptations. Those are preserved
separately in wip/steer-v2-20260910 and must not be packed into this release.
