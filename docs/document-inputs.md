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

This server API is implemented and tested. Its model-facing tools and shared
attachment-to-record integration remain separate work in progress.

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

These checks do not prove live provider extraction, application record attachment,
installed-consumer adoption or production
parity. Those remain separate gates. Apps receive this behavior only after a full
committed public HTTPS Git revision containing the changes is adopted with matching
locks, normal compilation and the required host configuration.
