# Canonical admission pagination repair — 2026-09-07

## Cause and observed impact

Spartan Aegis rejected a saved follow-up with “The proposed runtime event is not
backed by server authority.” The failure occurred in the shared AI Assistant
SDK's durable start verifier, before the provider or financial tools ran.

`qualifyDurableApplicationTurnStarts` replayed the conversation successfully,
then searched a separate, single event-store page for the user message's
admission identity. PostgreSQL defaults that read to 1,000 events. Streaming
text and tool activity can produce over 1,000 events in a conversation with only
a few visible messages. Valid messages beyond that page were therefore rejected.

Read-only diagnostics observed production 0.1.534
(`db82c61c9176e1866d2095b260b30e15becbd927`) and conversation
`684c1d89-1eec-443d-9135-d142541e3a56`:

| Follow-up message revision | Turn-start revision | Stored text matches request | Admission identity matches | Durable output frames |
| --- | --- | --- | --- | --- |
| 1,167 | 1,168 | Yes | Yes | 0 |
| 1,174 | 1,175 | Yes | Yes | 0 |

Both durable turns retained `invalid_request`, the authority error, and
`retryable: false`. Subsequent reconciliation recorded the failed turns. This
explains the follow-up rejection; it does not explain or repair the earlier
financial journal posting failure.

## Local changes

- Added an internal canonical-event lookup that follows store-issued cursors
  using bounded pages, stops when it finds the required evidence, and rejects
  missing or cycling pagination cursors. It cannot accept another conversation's
  events as evidence.
- Durable starts use that lookup for the saved user message. Existing text,
  mutation identity, attachment, active-turn, and cancellation checks remain in
  force. Validation failures now distinguish message, identity, and attachment
  mismatches without including message contents or sensitive arguments.
- Approval membership and proposal-creation conflict recovery use the same
  lookup. A later-page SDK approval can be decided through the canonical audit
  coordinator instead of being rejected or mistaken for a legacy host proposal.
  Missing canonical approval evidence still requires the existing explicit host
  authority; conversation ownership checks are unchanged.
- Corrected the event-store interface comment to explain that omitted limits
  can still return a bounded page and callers must inspect `hasMore`.

No runtime event authority check was bypassed. The changes do not replay
historical journal actions, alter financial mappings, or rewrite conversations.

## Validation

The focused 11-suite regression run passed all 100 tests with one worker. It
covers follow-ups after 999, 1,000, 1,166, and 2,001 prior events; actual
PostgreSQL event-store pagination through isolated PGlite; mismatched messages,
identities, attachments, and conversations; invalid pagination; cancellation;
durable retries; synchronization; reconciliation; and approval/execution audit.
The PostgreSQL regression places the new message at revision 1,167, confirms that
the default first page omits it, rejects a wrong admission identity, then starts
the authorized turn exactly once across repeated durable start requests.

Long-history HTTP approval tests cover confirmation and rejection, retained
audit events, unauthorized callers, missing canonical evidence, and isolated
tool execution. Full SDK TypeScript checking and the normal SDK build passed.

## Delivery and applicability

These changes are local SDK source changes. No commit, push, PR, dependency
upgrade, deployment, or production financial mutation was performed for this
patch. Spartan still pins the public HTTPS Git dependency to
`74369d2116601b25a6d6367a745ff92c42d0812a` in its manifest and lockfile; rebuilding
Spartan against that unchanged dependency does not include this repair.

After delivery is authorized, review and commit the task-specific SDK changes,
make the approved commit available in its public HTTPS Git repository, then
freeze that full SHA and update Spartan's dependency and matching lockfile.
Keep SDK compilation in the normal install/build pipeline. There are separate
thread-loading and transcript-following changes in the shared checkout; review
them explicitly rather than treating every local change as part of this patch.

Validate the approved build in staging with a conversation over 1,000 events:
submit a new read-only follow-up after a failed turn, verify that it completes
and survives reload, and exercise approval/retry cases with isolated fixtures.
Deploy the approved revision to production only with authorization. After
delivery, reload Aegis and submit a new follow-up. Previously failed turns remain
failed history; they are not automatically retried or converted to successes.
No conversation migration is required.
