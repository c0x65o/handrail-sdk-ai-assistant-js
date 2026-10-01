# Durable Stop regression fixture

From the JS SDK root:

```
npm ci --prefix test/fixtures/agent-cancellation --allow-git=all --no-audit --no-fund
npm run build
node test/run-agent-stop-postgres.mjs
```

Node 22.23.1+, npm 12.0.2 and PostgreSQL 15 binaries at `/usr/lib/postgresql/15/bin` are
required. The runner creates and stops its own disposable loopback cluster and
non-superuser database role. It never uses `DATABASE_URL` or a deployed database.
Do not run the test file directly against an application database.

`host.mjs` and `database.mjs` are retained public consumer fixtures from Agent SDK
`f6eb0ef10af89a8ecaea0707610d7709483eaa49`; the host adds one native-effect adapter
injection. The locked fixture now installs Agent 0.1.7 at public HTTPS commit
`4b10d0156e4337fbcba95fe91520ec41aaf6eb58` and AI 0.2.63 at
`79c1d5644845630b74d347874acb13b27ca7c873`, with the scoped Agent AI override. No SDK
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
qualify Mills's complete catalog or deployment.

## Canonical projection regression

After the normal fixture install and root build:

```
cd test/fixtures/agent-cancellation/dart
dart pub get
cd ../../../..
HANDRAIL_PROJECTION_TEST=1 HANDRAIL_PROJECTION_DART=/absolute/path/to/dart node test/run-agent-stop-postgres.mjs
```

The Dart manifest/lock install the public Flutter client at the assigned full
SHA, with its normal Git subdirectory. Use a writable task-local `PUB_CACHE` if
the shared Flutter SDK cache is read-only. The fixture invokes public JS and
Dart clients in fresh processes over a real loopback HTTP gateway. This is
protocol/client qualification, not rendered native application QA.

`HANDRAIL_STOP_BASELINE=1 HANDRAIL_PROJECTION_TEST=1 node
test/run-agent-stop-postgres.mjs` selects the installed public AI 0.2.63 gateway
and intentionally fails the ordinary cancelled-history assertion. The candidate
uses the SDK's built public exports through package self-reference; it is not an
installation of the future published repair.

The cases cover native approval, disconnect/reconstruction, simulated quota
failure followed by acknowledged Stop, projection storage interruption with
fresh-process recovery, completion preservation, and an uncertain effect whose
receipt remains unknown. Effect dispatch and model responses are simulated;
Agent/Runner, native approvals/ledger, the durable writer, canonical/display
projection, PostgreSQL, and clients are real. The deliberate session-attribution
conflict remains rejected; only independently acknowledged cancellation settles.
See [the repair and adoption contract](../../../docs/canonical-cancellation-projection.md).
