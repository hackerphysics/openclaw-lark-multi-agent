# LMA Go independent runtime enforcement

Build with `npm run build:go-plugin`. Enable plugin id `lma-go` through the host's
supported plugin installation/configuration workflow (operator-owned).

The real before_tool_call hook denies **all** tools for explicitly bound dedicated
Checkers. Exact canonical keys/generations are persisted under the host state dir;
missing/replaced Checker generations remain denied on the bound key. Executor
native Goal tools and unrelated sessions are not restricted.

Public operator RPCs:
- `lma.go.capabilities` (operator.read): independent policy/task query capability;
  explicitly no atomic snapshot and no native Goal authority.
- `lma.go.bind` (operator.admin): persistent idempotent dynamic Checker binding;
  identity conflicts reject. Called before the first Checker admission.
- `lma.go.snapshot` (operator.read): canonical-key task views, explicit query
  boundaries; the production client separately checks session generation, public
  input/recovery/live-run state and LMA's durable queue/delivery ledger.

No static bindings or nativeGoalId are required. The bridge's independent SQLite
Go state owns objective, criteria, revision and completion. No Host changes needed.
See ../../docs/go-integration-boundaries.md for limits and activation procedure.
