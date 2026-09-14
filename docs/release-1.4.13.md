# v1.4.13

Report only errors supported by exact terminal evidence on the bridge's proactive
Gateway/assistant error path. Preserve normal collector and result delivery.

- Keep structured run/task error provenance instead of turning every aborted
  announcement into an ordinary assistant answer.
- Hold notices while the exact task/delivery is continuing; suppress stale
  attempts only with related confirmed task return or exact-run result evidence.
- Distinguish failed child execution from blocked completion delivery. Do not
  infer whole-task success/failure from session running/killed or unrelated work.
- Use stable terminal keys, durable bounded reconciliation and startup recovery.
  Unknowns are parked after bounded checks; verified continuing tasks retain
  low-frequency observation for at most the existing 24-hour horizon.
- Recheck every error-notice send attempt, use one text operation without fallback
  bypass, require a platform message ID, and preserve actual sender retry budget.
- Retain exact successful-final provenance through identical-text deduplication;
  explicit stop cannot hide a later unrelated run's failure.
- Fence stale record snapshots and recover a last-check crash once durably.
- Do not replay historic messages/model requests or directly resend raw child text.

Independent review found and reproduced issues in the initial candidate; this
release includes the repairs and regression tests. Build and 693 offline tests
passed before clean release validation. Live Feishu acceptance/ambiguous network
exactly-once behavior is not claimed by offline tests.

Bundled lma-steer remains 0.1.1; no Gateway/plugin update is needed. Upgrading from
1.4.11 also includes 1.4.12's verified-ID mentions and Chairman-off silence.
