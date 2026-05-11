---
status: active
importance: essential
category: lessons
tags: [lessons, regressions, debugging, operations]
last_reviewed: 2026-05-11
---

# Lessons Learned

This directory records bugs, regressions, debugging lessons, and operational rules learned from maintaining `openclaw-lark-multi-agent`.

The goal is not blame. The goal is to make the same class of mistake harder to repeat.

## Index

| Date | Title | Area | Severity |
| --- | --- | --- | --- |
| 2026-05-11 | [Queued message marked DONE before processing](2026-05-11-queued-message-done-regression.md) | queue / sync / reactions | high |
| 2026-05-11 | [Cron jobs must not share live LMA chat sessions](2026-05-11-cron-must-not-share-lma-session.md) | cron / sessions / concurrency | high |

## Template

Use this structure for future lessons:

```markdown
# <Short title>

## Summary

One paragraph describing what went wrong.

## Impact

What user-visible behavior happened?

## Root Cause

What invariant was broken?

## Fix

What changed in code/tests/deploy?

## Prevention

What tests, comments, review checklist items, or design changes prevent recurrence?

## Related Files

- `src/...`
- `tests/...`
```
