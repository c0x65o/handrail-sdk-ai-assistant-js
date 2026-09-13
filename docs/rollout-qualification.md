# Historical AI Assistant 0.2 rollout qualification

Recorded: 2026-09-04

Historical snapshot: UI selectors, package pins and candidate status below are
not current rollout instructions. See [the September 13 local acceptance review](./shared-assistant-acceptance.md)
for the shared UI implementation, qualification and release dependencies.

This record separates source/API qualification from immutable release and
runtime rollout. A local packed candidate proves code compatibility but is not
a production package pin.

## Readiness matrix

| Target | Standard server | Standard UI | Recovery / telemetry | Compile and focused behavior | Immutable 0.2 pin | Status |
| --- | --- | --- | --- | --- | --- | --- |
| SDK | `createHandrailAssistant` | styled default + headless escape | durable outbox, worker, trusted-context recovery | focused UI/composer/file-input tests, build, and typecheck passed | `0.2.2` source candidate; no immutable release SHA yet | repair qualified; release blocked |
| Mills Family Office | high-level composition | legacy default; standard page launcher is explicit opt-in | trusted-session recovery; SDK outbox | typecheck, document intake/extraction, UI seam, and gateway passed | canonical `@handrail/ai-assistant` remains pinned to reviewed 0.2.1 SHA `8468d21f93a5b60ebc710e473c0477554316abe6` | source qualified; 0.2.2 pin pending |
| Spartan Cyber ERP | high-level Aegis adapter | legacy default; standard launcher is explicit opt-in | trusted-session recovery, Postgres pub-sub, authoritative receipt test | typecheck, attachment persistence/provider/UI seams passed | canonical `@handrail/ai-assistant` remains pinned to reviewed 0.2.1 SHA `8468d21f93a5b60ebc710e473c0477554316abe6` | source qualified; 0.2.2 pin pending |
| Remaining projects | standard template required | styled default unless documented headless exception | Handrail binding + same outbox contract | not run | not installed | not started |

Both real consumers now use the canonical package key and imports with regenerated
lockfiles. The current UI and generalized PDF/spreadsheet input repair remains an
uncommitted SDK working-tree change, so neither consumer may be moved to it until
review produces a new immutable SHA. Both consumers intentionally default their
browser selector to the legacy UI during that qualification window.

## Verification evidence

SDK candidate:

- `npm run typecheck`
- `npm run build`
- `npx vitest run test/openai-responses-tools.test.ts` — 9 passed
- `npx vitest run test/browser-attachments.test.ts` — 22 passed
- `npx vitest run test/react-presentations.test.tsx` — 7 passed
- `npx vitest run test/react-styled.test.tsx` — 15 passed
- `npx vitest run test/react-composer.test.tsx` — 13 passed
- `npx vitest run test/server-assistant.test.ts` — 4 passed
- `npx vitest run test/postgres-assistant-foundation.test.ts` — 5 passed
- `npm run check:adoption-tool` — 3 passed
- `npm run check:package-contract` — 30 passed
- `npm run check:vite-consumer` — passed

Mills real consumer:

- `npm run typecheck` — passed
- `npx vitest run src/client/assistant/assistant-api.test.ts` — 14 passed
- `npx vitest run src/server/assistant/contracts.test.ts` — 11 passed
- `npx vitest run src/server/assistant/property-document-content.test.ts` — 8 passed
- focused validated CSV upload/bind/serve lifecycle in
  `src/server/assistant/assistant.test.ts` — passed
- `npx vitest run src/server/assistant/handrail-ai-gateway.test.ts` — 10 passed
- `npx vitest run src/server/assistant/handrail-ai-gateway-postgres.test.ts` — 4 passed
- source conformance findings for high-level server, automatic telemetry,
  recovery/shutdown, and standard styled UI — passed

Spartan real consumer:

- `npm run typecheck` — passed
- focused attachment persistence, provider native-file input, and legacy picker
  tests in `tests/aegis.test.ts` — passed
- `npm test -- --run tests/aegis.test.ts` — 69 passed
- `npm test -- --run tests/aegis-handrail-ai-ui.test.ts` — 1 passed
- `npm test -- --run tests/aegis-handrail-ai-postgres-live-delivery.test.ts` — 1 passed
- `npm test -- --run tests/aegis-auth-composition.test.ts` — 2 passed
- `npm test -- --run tests/aegis-close.test.ts` — 14 passed
- focused default-client configuration test — passed
- source conformance findings for high-level server, automatic telemetry,
  recovery/shutdown, and standard styled UI — passed

The mounted Spartan high-level test sends reported provider usage through the
actual SDK durable receipt path and verifies the Telemetry URL plus authoritative
organization, project, service environment, user, session, provider, model,
conversation, turn, and token values. SDK tests prove transient retry, startup
drain, durable attempt retention, acknowledgement, and permanent-failure
dead-letter behavior. The supplied Handrail AI Runtime report screenshots prove
runtime receipt visibility for Mills and Spartan; post-release observation must
still cover successful, failed, and cancelled traffic over time.

## Release gate

The next authorized release operator must:

1. review the SDK UI-repair diff and create a new immutable release commit/tag;
2. record its full 40-character SHA and package integrity;
3. update Mills from the current canonical 0.2.1 SHA to the repaired SHA, clean
   install, rerun the listed Mills checks, and rerun conformance;
4. repeat only after Mills is green for Spartan, then rerun the listed Spartan
   checks and conformance;
5. publish `docs/adoption-standard.md` to the Handrail Knowledge Base and record
   entry ID/revision here;
6. perform a staging rollback rehearsal and compare AI Runtime invocation and
   receipt counts before any broader batch begins.

No commit, push, tag, deployment, Knowledge Base publication, or production
observation was performed by this qualification run.

## Bounded remaining rollout

After Mills and Spartan are immutable-pin and runtime qualified:

1. select two low-risk applications with different auth/tool shapes;
2. scaffold or migrate them with the CLI, allowing only the documented host
   seams;
3. stop on any conformance, auth isolation, usage, recovery, or rollback gap;
4. if both pass, proceed in batches of five;
5. start no later batch until every project in the previous batch has an
   approved SHA, clean lock, UI mode, test record, receipt parity, and rollback
   result.

Track each application as `not_started`, `integrating`, `shadowing`,
`qualified`, `rolled_back`, or `blocked`. Approximately thirty installations
are an inventory target; completed evidence, not dependency count, is the
rollout outcome.

## Open external gates

- Immutable package release: blocked by the explicit no-commit/no-push
  constraint for this run.
- Consumer dependency rename and clean lockfiles are complete; advancing the pin
  to the repaired SDK depends on the new immutable SHA.
- Handrail KB publication: no KB write API is available in this Dev Chat. The
  canonical source is ready, and guarded workflow-improvement proposal
  `c54f01ee-e497-4866-872f-886e42598c23` records the publication gap.
- Staging/runtime observation and the remaining-project inventory: require
  deployment/release authority and project selection beyond the three repos in
  the AI Chatbot group.
