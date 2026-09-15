# Single-conversation applications

Configure the authoritative catalog and the presentation together:

```ts
new PostgresConversationCatalog({
  ...authorizedCatalogOptions,
  conversationMode: "single",
  clearContents: input => clearPostgresConversation({
    ...input,
    relatedTenantIds: [voiceTenantId],
  }),
});
```

Use `threads={false}` on the React assistant launcher/workspace. This automatically
opens the conversation, suppresses thread navigation and generated titles, and
offers an explicit, confirmed Clear conversation action when the catalog supports
it. Keep any application heading, such as “Family Assistant”, separate from a
conversation title. Disable the server's `automaticTitles` and omit its provider
`generateTitle` capability as well, including external voice/attachment title paths.

The PostgreSQL catalog serializes first selection per tenant, catalog table and
authenticated `scopeId`. It adopts the most recently updated active legacy row,
or creates one when authorized. It records that selection durably. Repeated create
requests return the same identity. Rename, archive, restore and permanent deletion
are unavailable in this mode. Other legacy rows are retained; this feature is not
a history-deletion migration. Legacy records that are not selected require an
explicit authorized recovery path if they must be viewed again.

Clear must run inside the authorized catalog transaction. The helper holds the
same locks as event writes and related voice admission, checks for unresolved
turns, approvals, provider work and calls, and appends `conversation.cleared`.
Projection resets preserve event revisions and processed mutation IDs. Stored
events, effects and execution receipts remain available for audit/idempotency;
Clear does not delete household records, files or other business data. Cleared
voice calls are excluded from current call/workspace listings; explicit server
audit reads can use `calls.list({ includeCleared: true })` or `calls.get(id)`.

Flutter uses `HandrailAssistantController(threads: false)` with
`HandrailAssistantWorkspace(threads: false, onClearConversation:
controller.clearCurrentConversation)`. The controller suppresses titles and
retains a Clear request identity after a lost response. The workspace confirms
Clear, preserves an unsent draft and gates the action on host submission/voice
availability. The server remains responsible for fresh authorization and safe
reset. Flutter consumes canonical snapshots, including the cleared projection.

This adds a canonical event understood by the new SDK. Publish the SDK revisions,
then install public HTTPS Git full-SHA pins with matching locks through each
consumer's normal build. Do not enable the server mode until all required clients
understand reset. In particular, do not roll an enabled server back to an older
SDK that cannot parse `conversation.cleared`; disable the feature on the new SDK
or use a tested compatible rollback. Unit/component tests do not establish live
adoption or authenticated cross-device behavior.
