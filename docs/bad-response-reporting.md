# Optional bad-response reporting

The React chat preset and all its launcher/workspace wrappers accept
`badResponseReporting`. It is off by default. When explicitly enabled, a
**Bad response** action appears next to Copy on non-empty assistant messages.
It is disabled until the originating turn finishes, including cancellation or
failure with a partial response. Historical replies without turn records are
eligible when the conversation is idle. `messageActions={false}` hides both
actions. Custom React transcripts can use `BadResponseButton` from `/react`.

```tsx
import type { BadResponseReporter } from "@handrail/ai-assistant";
import { HandrailAssistantLauncher } from "@handrail/ai-assistant/react/styled";

function Assistant({ enabled, report }: {
  enabled: boolean;
  report: BadResponseReporter;
}) {
  return <HandrailAssistantLauncher endpoint="/api/assistant"
    badResponseReporting={{ enabled, report }} />;
}
```

The callback receives only `eventId`, `conversationId`, `messageId`, and
`turnId`, plus an abort signal. It must use the host's authenticated reporting
path and return an authoritative `BadResponseReportReceipt`. No conversation
text, attachments, tool arguments, prompts, or session credentials are copied.
Triage must resolve the referenced evidence with authorized server access.

The button waits for a receipt with the matching event ID, a non-empty bug ID,
`classification: "bad_response"`, and `reviewStatus: "pending" | "verified"`.
Only then does it show **Reported**. Failure leaves a safe retry action, using
the exact same request and event ID. Concurrent clicks are suppressed. Changing
the message/conversation or disabling the feature aborts pending work and
ignores late results. Unmount/remount does not retain the receipt or event ID;
server deduplication is therefore required. Hosts must reset the chat boundary
on account, tenant, or environment changes, as for the other session services.

## Bug SDK adapter

`createBadResponseBugReporter` accepts the existing Bug Reporter SDK's `submit`
function through a thin adapter. It owns no HTTP client, credentials, retry
loop, or redaction implementation. Its output is structurally compatible with
`@handrail/bug-reporter`'s `BugReportInput`, including a stable `eventId` and
`metadata.ai_response_feedback`:

```json
{
  "schema_version": 1,
  "classification": "bad_response",
  "conversation_id": "conversation-id",
  "message_id": "message-id",
  "turn_id": "turn-id-or-null",
  "requested_review": "manual"
}
```

`turn_id` is JSON null when unavailable. The adapter checks
`reviewQueueAvailable(signal)` before submitting. Until the platform implements
this intake contract, that callback must return false. Discovery failures must
also prevent submission. A generic bug receipt is insufficient; `resolveReceipt`
must read real classification/review fields from the authoritative intake
result, never synthesize them from `status: "submitted"` or a bug ID.

The host passes a current-session SDK submit callback, resolving server session
identity separately on every request. Browser integrations retain same-origin
authentication and CSRF protection. SDK report metadata is a requested
classification, not permission to change server workflow. Neither the absence
of automation requests nor a successful SDK POST establishes that automatic
triage has been suppressed.

## Platform implementation required before enablement

This SDK change does **not** implement Handrail's intake routing, Runtime Triage
queue, or Verify button. Those sources are outside the current AI Chatbot group
(Mills Family Office, Spartan Cyber ERP, and Handrail AI Assistant SDK).
The installed Bug Reporter SDK supports metadata, but no current contract
advertises the new manual-review behavior. Leave the feature disabled until
the following platform work is implemented and validated:

1. Authenticate the reporter against the exact project/environment, verify
   access to the referenced conversation/message, and derive attribution from
   the verified session. Do not trust client identities or reference ownership.
2. Accept this metadata through canonical bug intake, create a bug classified
   `bad_response`, and retain it in Runtime Triage with review state `pending`.
   Route this classification before any automatic diagnosis, verification,
   repair, or Ship enrollment. Retries must return the original receipt;
   deduplicate repeated flags by verified reporter and target response within
   the project/environment, including after client remounts. Keep responses
   distinct rather than grouping all reports by their fixed title/description.
3. Advertise manual-review support only when that route is active. Return
   authoritative event ID, bug ID, classification, and review state so the
   host can map the result to `BadResponseReportReceipt`.
4. Show a **Bad response** classification/filter and a **Verify** button in
   Runtime Triage. Verify manually confirms that the response is bad, records
   the authorized verifier and timestamp, and leaves it queued. It does not
   mark the bug fixed or resolved and does not use the existing bug lifecycle's
   fix-verification transition. Repeated Verify requests must be idempotent.
5. Test unauthorized/cross-scope references, duplicate intake, readiness
   changes, the pending-to-verified transition, and absence of automatic work
   both before and after Verify. Preserve ordinary bug behavior.

The manual confirmation behavior above was selected by the owner for this
first version. Additional workflows are deferred.

## Adoption and validation

This change adds reusable TypeScript/React SDK support only. Flutter and host
applications are not enabled by these source edits. No SDK dependency pin or
lockfile is changed. Consumer adoption requires an explicitly authorized SDK
commit/release and the normal public HTTPS Git dependency pinned to its full
commit SHA, with a matching lockfile and normal install/build pipeline.

Focused checks:

```sh
npm run typecheck
npm test -- --maxWorkers=2 --minWorkers=1 test/response-feedback.test.ts test/react-bad-response.test.tsx test/react-message-actions.test.tsx test/react-styled.test.tsx test/core-node-import.test.ts
npm run build
```

Workspace validation passed: full TypeScript typecheck, SDK build, 45 tests
across the five focused files above, and lint for the four new source/test
files. The 19 new tests also passed again after the final lint cleanup. A
compatibility check used the installed Bug Reporter SDK at commit
`7dfb33f548448f864cf957f19d96f8b5a27bc787` with an intercepted fetch and a mock
review receipt; it preserved SDK stamping, event identity, and feedback
metadata. No live bug was posted, and no live triage workflow was verified.
