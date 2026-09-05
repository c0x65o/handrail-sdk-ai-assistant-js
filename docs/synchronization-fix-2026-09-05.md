# Synchronization and streamed completion fix — 2026-09-05

Current candidate: **0.2.8 / 7da9e04328a4**. Both web applications pin
`vendor/handrail-ai-assistant-0.2.8-parity.7da9e04328a4.tgz` in their manifest and lockfile. The archive and provenance
must be included with the host changes; a maintenance-card action or registry
publication is not needed to install this relative-file dependency.

## Findings and changes

- Production Spartan deployment `36582ac4a2705aefc151f6ff5989e1a790eecc4b`
  still pinned 0.2.7 / 5683009ec79b. Its 2026-09-05 14:52:32 UTC turn streamed
  text and then failed with an internal TypeError; synchronization subsequently
  returned 503. Read-only database evidence showed retained deltas and a failed
  durable/canonical turn, rather than a missing answer or missing schema.
- Aegis assumed raw OpenAI stream completions contained the client's non-streaming
  `output_text` convenience field. Calling `.trim()` threw after visible deltas.
  The provider now extracts output-text parts from the final response when the
  convenience field is absent. A raw-wire fixture reproduced the crash before
  the fix. Mills already extracts text from the response output.
- Three SDK PostgreSQL queries selected `revision::text AS revision` and sorted
  by that alias. They could report revision 9 after revision 17. They now sort by
  the qualified numeric table column. This fixes latest-revision reads, append
  validation and the append conflict evidence query for all PostgreSQL hosts.
- If history advances during batch validation, the sync adapter now returns a
  revision conflict for client catch-up. Invalid batches against current history
  still return denial. No authorization check is removed.

## Validation and deployment

The raw streaming provider test and a mounted Aegis test exercise completion,
reopening, synchronization and a second send, with exactly two provider calls.
PostgreSQL integration coverage exercises revisions through 102, both append
interfaces, latest-revision reads and stale-write rejection. SDK typecheck/build
and scoped compiles for both hosts pass. Both installed packages match all 320
files of the same archive; lock integrity and SHA-256 are verified.

These are controlled-provider/local database tests, plus read-only production
incident evidence. This session did not deploy, commit, push, publish or rewrite
production conversations. Existing failed turns retain their historical outcome.
After deploying the updated host, reload the browser, refresh conversation history
and send a new message; test a second send and reopening as well. This patch needs
no schema migration. It does not complete the separate audio billing contract or
sign off full live parity.

## Follow-up: completed reply retained in composer

Production read-only evidence at 2026-09-05 23:09 UTC confirmed that the
previous candidate was deployed. The server stored a completed greeting while
a browser synchronization append returned 503. This differs from the earlier
provider failure. Logs did not retain the underlying transaction exception.

The shared runtime now performs one authoritative history catch-up after a
failed observation/frame write. Only a matching saved terminal turn can settle
that send; otherwise the original failure remains. A completed send lets the
composer clear only the submitted draft, preserving text edited during execution.
Synchronization still checks ownership and validates every proposed mutation,
but failure of opportunistic transcript/activity repair no longer prevents access
to the canonical event store. Repair failures remain diagnostic events and are
retried on later requests. No provider request is repeated by this catch-up.

Regression coverage includes failed writes with and without a saved completion,
and mounted gateway synchronization while activity persistence is offline.
This change does not rewrite historical failed turns or prove the live deployment
is repaired; the updated host archive must be deployed and exercised there.
