# LMA Go runtime enforcement component

Independent from lma-steer; compiled with `npm run build:go-plugin`.

This is a **fixture-ready component, not enabled production Go integration**.
It registers the public SDK `before_tool_call` hook. Explicit bindings use
canonical executor/checker session keys, generations and native goal IDs.
Message-review checkers have **zero tools**, including reads and generic dispatch
wrappers. No prompt-based permission claims. Missing/replaced checker generations
remain denied on the exact key. Unrelated sessions are unchanged.

Managed executors' direct `create_goal` / `update_goal` calls are vetoed. This does
not control external Goal mutations, generic nested dispatch on executor tools,
or establish Goal CAS; these require the host integration described in the
artifact report. Bindings are configuration-supplied in isolated fixtures only;
there is no exposed unauthenticated binding RPC and no dynamic binding handshake.
Production `verifyGoSafety` remains unavailable rather than claiming enforcement
coverage from plugin presence. Do not load this into the business Gateway until
host capability proof and lifecycle integration are complete.
