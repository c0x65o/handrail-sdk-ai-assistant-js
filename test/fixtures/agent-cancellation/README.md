# Durable Stop regression fixture

From the JS SDK root:

```
npm ci --prefix test/fixtures/agent-cancellation --no-audit --no-fund
npm run build
node test/run-agent-stop-postgres.mjs
```

Node 22+, npm and PostgreSQL 15 binaries at `/usr/lib/postgresql/15/bin` are
required. The runner creates and stops its own disposable loopback cluster and
non-superuser database role. It never uses `DATABASE_URL` or a deployed database.
Do not run the test file directly against an application database.

`host.mjs` and `database.mjs` are retained public consumer fixtures from Agent SDK
`f6eb0ef10af89a8ecaea0707610d7709483eaa49`; the host adds one native-effect adapter
injection. The locked fixture installs that full public Git revision. No SDK
implementation is copied or patched. `api.mjs` resolves only public Agent APIs
from that installation. Root test files resolve the candidate AI SDK's built
public exports through package self-reference. This is source qualification,
not proof of installation of the eventual published AI SDK SHA.

The native test follows Mills `nativeDecision('stop')`, `agent-composition.ts`
and `agent-host.ts`: actual canonical browser client, protected gateway, durable
wrapper, native proposal, Agent/Runner, admission, effects and PostgreSQL. It
checks the original job/conversation/turn binding and persisted checkpoint,
including a fresh Node process receiving Stop with no original observer. Model
responses and the external business effect are simulated. Controlled valid
schemas avoid the separately assigned catalog-schema repair; this does not
qualify Mills's complete catalog, deployment, or web/Flutter parity.
