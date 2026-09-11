# v1.4.11

Correct foreground waiting to mean **ten consecutive minutes without effective
task activity**, not ten minutes of total task runtime.

- Remove the independent absolute foreground and live-card refresh deadlines.
- Fresh, owned assistant text and tool start/completion restart the idle window.
- Card ticks, status checks, usage-only and duplicate/unrelated events do not
  count as new task progress.
- Fence in-flight status checks so newer progress cannot be followed by a stale
  pause decision. Card preparation/admission time is not charged as task silence.
- A write at elapsed 9:35 cannot freeze the card at 9:59/10:00; with no further
  activity the idle window expires at approximately 19:35.
- Preserve confirmed yield's immediate notice/freeze, private-context protection,
  background result delivery, explicit stop and no automatic abort/replay.
- Once paused, retain the existing no-automatic-thaw policy. A genuinely silent
  single tool may pause foreground presentation without stopping its execution.

431 offline tests and build passed in independent review. See
`docs/foreground-idle-2026-09-11.md` for the exact event and test boundaries.
Bundled lma-steer stays 0.1.1; no plugin or Gateway change is required.
