# Shared chat document inputs

The current source adds DOCX to the canonical document MIME list, browser intake,
saved-event validation, protected default upload storage, and OpenAI provider input.
The high-level OpenAI provider defaults to PDF and DOCX, with at most two documents
across one request and 20 MiB per document. An explicit `document_input` descriptor
replaces those defaults; host business settings can narrow them further.

`openaiResponses({ savedConversation: true, ...providerOptions })` enables the
SDK's canonical saved-history preparation. It takes current messages and turn
identity from persisted events, bounds historical files, checks ownership around
file reads, and rejects changed input or cancelled admission. Existing apps using
`prepareRequest` must migrate explicitly; the two options cannot be combined.
An options object supports existing authorized storage rather than changing file
identities. This history option does not itself change upload retention. See the
explicit policy below. Prior-file listing/opening tools are still in progress.

Optional historical files that an authorized storage read identifies as expired
or missing are omitted with a notice that their contents were not included.
Current and explicitly selected unavailable files fail with a safe, specific
error. Permission denial, corrupt metadata and storage outages are never treated
as optional omissions. Custom storage adapters use
`SavedConversationFileUnavailableError` only for verified absence/expiry.

## Retained chat files

`createHandrailAssistant({ attachmentRetention: "conversation", ...options })`
opts new SDK uploads into a retained policy. Use it with the provider's
`savedConversation` option to reopen saved files on text follow-ups. The default
remains temporary staging for existing integrations until they opt in.

New drafts are scoped to the assistant, account and conversation. The canonical
user-message events and retained file copies commit in one database transaction.
Saving a message therefore retains its files before provider execution, even if
the provider fails or the user cancels. An exact admission retry recovers its saved
receipt without duplicating events or bytes. Unsent drafts expire after the
configured upload TTL; retained copies survive draft cleanup and process restart.
Explicit conversation deletion removes saved copies and bound drafts under the
same deletion fence. Uploads to an already deleted conversation cannot resurrect
its data. The normal assistant cleanup lifecycle includes the new managed drafts.

An expired or invalid draft is rejected before message admission with a fixed
correction message and no automatic retry or provider call. JavaScript and Flutter
must adopt the matching synchronization rejection support described in the
[wire protocol](./wire-protocol.md); this change does not retrofit older clients.

Protected downloads and provider reads check current host-catalog ownership.
Existing ordinary uploads stay in their original namespaces with their original
identities and expiry policy; fallback reads do not adopt or rewrite old data.
This is prospective retention, not a migration of historical attachments. Hosts
that use other existing storage can keep their authorized storage adapters.

## Saved-file handles

`createSavedFileHandles` provides bounded, paged `list` and protected `read`
operations over canonical user-message attachments. A handle is stable across
process restart and scoped to the trusted namespace and conversation. It is an
identity, not permission: both operations perform fresh authorization, and reads
recheck source provenance after asynchronous storage work. Listing never loads
binary data or asserts that an old upload is still available.

`read` returns the original bytes, resolved metadata and a SHA-256 digest for
server-side record attachment or provider input. When the metadata adapter supplies
a stored checksum, reads verify it. The retained assistant's `savedFiles` service
wires this API to shared protected storage, which also verifies retained checksums.
Existing-storage adapters keep their ownership/identity and byte-integrity checks
in the metadata/read callbacks. Do not serialize the returned bytes or private
content reference into model tool JSON; expose only the public entry fields.

### Model-facing list and open tools

`openaiResponses({ savedConversation: true, ...options })` installs shared
`handrail_files_list` and `handrail_files_open` tools through the assistant's
normal tool registry, admission policy, execution ledger and result events.
Use `savedConversation: { fileTools: false }` to disable these tools, or
`fileTools: { maximumTotalBytes }` to lower the aggregate open-selection budget.
The default aggregate budget is 25 MiB; the configured provider format, document
size and image/document count limits also apply. Host tool policies still apply.

Listing returns canonical metadata and a paging cursor, including files outside
the bounded recent history. Opening accepts handles from that list and reads the
original bytes through the protected service. A successful result records only
public metadata and SHA-256 checksums. Private content references and binary data
are never included in tool-result JSON. Opening does not attach a file to a
business record; use the separate record attachment service below.

The latest successful open selection replaces the previous selection in that
provider continuation. The server revalidates the receipt against current saved
files and rebuilds bounded provider input, retaining all current-message files.
It does not append every historical file. Required old files survive a legacy
message-only window limit, and approved-review context is preserved. A new turn
starts from canonical bounded history and can list/open prior files again.

Selection limits are checked against the current admitted message before an open
receipt succeeds. Expired, changed or inaccessible files produce safe failures.
Fresh checks also run before cached tool receipts and before connection retries
send saved content again. The SDK does not grant access from a handle or reuse
old file bytes across later tool steps. Existing-storage adapters use the same
authorized metadata and byte callbacks as canonical history preparation.

## Attaching an original file to a record

`createRecordFileAttachments` owns preparation, original-file verification,
immutable operation identity, receipt persistence and destination read-back.
It uses `createSavedFileHandles` and registered domain destinations. The host
supplies a trusted namespace (including account/user/service identity), the
saved-file service, `createPostgresRecordFileAttachmentStore(persistence, tenantId)`,
and its destination adapters. No separate database schema is needed.

The workflow has three stages:

1. `prepare({ conversationId, signal, idempotencyKey, request })` reads the original
   saved file and validates current target access and destination format/size
   limits. It durably freezes the source identity/checksum, destination, canonical
   target and metadata, plus any `writeOptions` such as an expected record version.
   The idempotency key comes from the trusted operation, not a model-chosen tenant
   or storage identity. Reusing it for different input is rejected. Preparation
   creates no business attachment and does not grant approval.
2. Present the returned intent through the existing SDK approval policy and UI.
   The mutation tool takes its `operationId` and runs `execute` only through that
   approved tool path. Compose `createRecordFileAttachmentAdmission({ toolNames,
   serviceFor })` with host admission; it checks current source/destination access
   and completed read-back before the SDK can replay a cached tool result.
   `inspect` is the equivalent read-only API for reviewing a prepared operation.
3. `execute({ conversationId, signal, operationId })` loads the frozen intent,
   reauthorizes, and resolves the original bytes again. It looks up the domain
   operation before writing. A successful receipt is persisted only after reading
   the destination's actual bytes, filename, MIME, stable target and metadata and
   comparing them with the prepared operation. The receipt contains identities,
   metadata and a checksum, never file bytes or private storage references.

Each destination registers `id`, `mediaTypes`, `maximumBytes`, `authorize`,
`lookup`, `attach` and `readBack`. These callbacks are business adapters, not a
second chat-file pipeline. They must use fresh identity/ownership/permissions and
the app's existing domain services. Canonicalize metadata before preparation;
read-back must return actual stored metadata. Optimistic mutation conditions
belong in `writeOptions`, so an updated record version is not confused with its
stable identity. An unnamed legacy source gets the new destination filename
`attachment`; its saved conversation reference is not rewritten.

**The domain write must atomically bind `operationId` and immutable input to its
mutation and deduplicate concurrent retries.** `lookup` must use that durable
binding; matching a filename or checksum is not proof that this operation ran.
A lookup outage must throw, not return null. After a lost acknowledgement the SDK
looks up and verifies the same operation. It never treats an accounting metadata
entry, an upload-start response, or an unverified tool result as a saved binary.
Removing a completed destination attachment does not authorize recreation on
retry. Cancellation can leave a committed domain outcome to reconcile; resume the
same operation instead of inventing a new identity.

The shared coordinator is tested with real files, a disposable PostgreSQL-compatible
domain store, and the existing SDK HTTP approval/restart flow. Application-specific
destination adapters and their installed-consumer adoption remain separate work;
this API's tests do not establish that any deployed app is using it.

## What the provider reads

- PDF: text and page images, including image-only scanned PDFs.
- DOCX: extracted text. Embedded images and charts are not provided to the model.
  Convert to PDF when their visual content matters.
- Legacy `.doc`: unsupported in this SDK. The React and Flutter intake errors
  explain how to save the file as DOCX or PDF. Do not advertise legacy DOC until
  the whole workflow has been qualified, even though the provider lists it.

These distinctions follow the [OpenAI file-input documentation](https://developers.openai.com/api/docs/guides/file-inputs).
They describe provider capabilities, not proof of a live model test in this change.

SDK server upload validation recognizes the DOCX container, bounds archive metadata
and extracted signature XML, rejects macros and malformed/disguised archives, and
preserves original bytes. Signature checks do not render a document or guarantee
that every semantic feature is supported by the provider. No external relationships
are followed by the validator. The archive reader is `fflate`, pinned in the normal
package manifest and lockfile; no separate packaging step is involved.

## Validation and rollout

Synthetic fixtures in `test/fixtures/documents` cover PNG, text PDF, scanned PDF,
and DOCX. Actual React composer outputs are saved as canonical events and reopened
on a follow-up, then passed through shared preparation into captured provider
requests with byte-for-byte assertions. Flutter client and widget tests use the
same fixtures and verify the saved-reference manifest; JS tests consume that
manifest through the high-level provider. PostgreSQL-compatible PGlite tests cover
protected DOCX upload, idempotent retry and read-back after assistant recreation.
The retained-file integration tests run the actual HTTP upload adapter, client
message synchronization, PostgreSQL-compatible admission and provider request for
all four formats. After assistant/client recreation and verified draft cleanup,
a text follow-up and protected download still read the original file bytes.
Storage tests cover failed-batch rollback, lost commit acknowledgements,
authorization changes, cancellation, explicit deletion and legacy identity
preservation.

The high-level list/open regression saves five documents, expires and removes
their staging copies, recreates the assistant/client, then reopens an omitted
scanned PDF or DOCX. Captured provider requests contain the exact original bytes,
including after another tool step. Further cases reject an open selection that
would exceed the current message's document limit and stop a connection retry
after access is revoked. These are scripted-provider transport/byte checks, not
live model content-analysis evidence.

These checks do not prove live provider extraction, application record attachment,
installed-consumer adoption or production
parity. Those remain separate gates. Apps receive this behavior only after a full
committed public HTTPS Git revision containing the changes is adopted with matching
locks, normal compilation and the required host configuration.
