# Trusted history and attachment preparation

The high-level `openaiResponses<TContext>` provider accepts two optional host
callbacks while retaining the SDK provider loop, approvals, execution ledger,
continuation and usage recording.

- `prepareRequest` receives the request, authenticated context, conversation ID,
  turn ID, mutation ID and cancellation signal. It runs once before provider
  work. Use it to check fresh ownership and construct input from saved history.
  Throwing stops provider dispatch; authorization errors remain classified and
  internal error text is not exposed. The SDK stops waiting when cancellation or
  the active deadline fires, even if a host callback has not settled; late results
  never resume provider dispatch. The host must still observe the signal and
  close its own resources.
- `attachmentResolver` receives an attachment reference, authenticated context,
  conversation ID and cancellation signal. Return its actual `media_type` and
  bytes only after checking account, conversation, message and file ownership.
  References are not authorization. The adapter checks returned media type and
  byte length before sending provider input, and observes cancellation after
  resolution. Pending resolution also stops being observed on cancellation, and
  late results do not reach the provider. Images retain protocol limits; documents retain configured MIME,
  count and byte limits.

Without a host attachment callback, the high-level provider uses SDK attachment
storage and its stored media type. This supports images, PDF and configured
spreadsheet formats without labelling every file as PDF. An existing explicit
synchronous image `resolveAttachment` option retains its behavior. The older
lower-level document resolver remains supported for other SDK consumers.

High-level `openaiResponses` now enables the shared PDF capability by default
(`DEFAULT_ASSISTANT_DOCUMENT_INPUT`: up to two PDFs per message, 20 MiB each, subject to
the application's negotiated upload/storage limits). Set `document_input: false`
for a model or host that does not accept documents, or supply the existing
descriptor to choose supported formats and tighter limits. Explicit descriptors
keep their previous behavior. The lower-level provider still requires an explicit
descriptor and trusted resolver; it does not assume SDK storage exists. This
default fixes the case where an application uses the complete assistant but its
picker rejects PDFs because no host document descriptor was supplied.

Staging now issues the protocol's `ref_…` content-reference grammar. Earlier
staging issued `blob_…`, which the shared upload queue correctly rejected even
after a successful HTTP upload. Retrying an existing staged upload exposes a
`ref_…` alias without creating a second blob or changing its stored identity,
fingerprint or expiry. Shared resolution accepts that alias and the original
legacy reference; consumption still updates/deletes the original stored record
and blob. Account and conversation checks apply to both paths.

Durable attachment events contain presentation metadata, not an authorization
grant or provider content reference. A host constructing saved provider history
must resolve those references using its trusted storage; do not synthesize a
content reference from a client identifier.

## Protected saved files in the optional web UI

The high-level assistant now provides `GET attachments/content` with
`conversationId` and `attachmentId` query parameters. Every request goes through
the application authorizer (`attachment_download`), the conversation catalog,
and the account/tenant-scoped attachment metadata store. Responses validate the
stored MIME and byte count and use `no-store`, `nosniff`, and download disposition.
Opaque IDs and staged content references are never public URLs.

This is advertised as `attachmentDownloads: { maximumBytes, url }` independently
of the upload capability. `attachmentUpload: false` hides new uploads without
removing access to existing files; server `attachmentDownloads: false` disables
the read handler explicitly. Older gateways omit this capability and clients
must not guess a URL. Custom staging stores may implement the optional
`getByAttachmentId` lookup; the standard PostgreSQL store supports it without a
schema change.

`createHandrailAiClient` exposes the negotiated `attachmentDownload` function.
`HandrailAssistantWorkspace` supplies it to the default saved-file renderer
automatically, so a minimal host needs no extra download state. The shared reader
uses the host's protected request/fetch adapter, rejects cross-origin negotiated
URLs and redirects, limits streamed bodies, and observes cancellation/deadlines
through authentication, fetch and body reads. Host callbacks must still observe
their signal to release their own resources.

The UI previews supported raster images, reauthorizes each Download activation,
deduplicates clicks, exposes safe retry text, and aborts/cleans up temporary URLs
on account, conversation or attachment replacement and unmount. Explicit host
`renderMessageAttachment` or `resolveAttachmentUrl` adapters retain precedence
for legacy storage; `loadAttachment` is the protected binary override for that
same shared UI. This does not move legacy host blobs into SDK staging.

Downloads preserve the configured staging retention. The default is **one hour**;
expired, deleted and consumed bytes are unavailable even if their message
metadata remains in history. Neither reading nor rendering extends expiry or
revives content. Applications needing longer retention must configure their
storage contract explicitly. The Flutter client's default workspace also
negotiates protected saved downloads; package adoption requires its own reviewed
committed revision and lockfile.

### Existing retained-file stores

`createConversationFileStorage` from `@handrail/ai-assistant/server/assistant`
provides the shared lifecycle for applications whose existing contract retains
conversation files after temporary uploads are consumed. It owns bounded SDK
staging, whole-request reference validation, immutable file retention in a
PostgreSQL transaction, checksummed reads and restart/replay behavior. Retention
commits before upload consumption; a failed metadata write rolls back the new
blob and leaves the upload usable. Saved bytes do not expire with staging.

Supply server-derived tenant/principal identity, `authorizeConversation`, file
content policy and size/type settings. Authorization runs on every materialize
and download, including replay. `import` is a server-trusted migration operation:
the importer must authorize original source and target ownership. It neither
executes historical operations nor changes source records.

The optional `identity` settings preserve existing upload scope, saved scope,
blob keys and transaction-lock namespace. Freeze those values when migrating an
existing consumer. Both current `ref_` references and SDK aliases for historical
`blob_` staging records resolve without host string rewriting. Spartan uses this
adapter with its original identities, media policy and authorized history import.
It no longer maintains a separate retention transaction or byte-integrity reader.

This is an explicit storage adapter, not a silent retention change to ordinary
high-level assistants. It is a local candidate API; ordinary consumers still
need a committed public SDK SHA and matching lockfile before using it.

Historical `message.created` events with `source.type = "import"` are inserted
by their original timestamp. Equal timestamps preserve insertion order, and
ordinary live arrivals are not reordered. Promoting an imported attachment
placeholder preserves its attachments. Existing message IDs are never
overwritten, so importers must reconcile saved user mutation IDs and reply/turn
links before importing. Do not deduplicate messages by equal text or infer that
importing history authorizes executing a recorded tool or proposal.

## Mills integration status

The same pending revision also fixes title usage capture: once provider usage
has been reported, a failed durable capture cannot be replaced by an unavailable
receipt under that identity. Generation fails without renaming or repeating the
external request after restart. `server-conversation-titles.test.ts` covers the
delayed capture failure and preserves the reported token values.

These additions are prepared in the SDK worktree after published revision
`1f2e381c2fe96c79108850ebcbab7b98954a5d3f`; they are not published or consumed by
Mills yet. Consumption requires an authorized publication followed by a public
HTTPS Git dependency pinned to the resulting full commit SHA and matching
lockfile. No local or vendored dependency is needed or permitted.

Tests cover stored image/PDF/CSV/XLSX projection, resolver ownership and byte/type
checks, retained synchronous image behavior, trusted preparation context and
redacted failures, chronological imports, placeholders and duplicate replay.
Provider-loop and high-level assistant recovery/ownership suites provide
regression checks. These are local fixture checks, not evidence of live provider
access or completion of Mills' history migration.


## Shared attachment content validation

`createAttachmentContentValidator` from `@handrail/ai-assistant/server/assistant`
checks common image/PDF/spreadsheet signatures, declared-type mismatches, UTF-8
delimited text, batch bounds and safe filenames. Defaults are five files,
10 MiB per file and 20 MiB total; `acceptedMediaTypes` can restrict the standard
formats. `AttachmentContentError.reason` supports branded error presentation
without copying the validation algorithm. These checks identify supported input
formats; they are not a document parser or a malware scanner.

```ts
import { createAttachmentContentValidator } from "@handrail/ai-assistant/server/assistant";

const validateContent = createAttachmentContentValidator({
  acceptedMediaTypes: ["image/png", "image/jpeg", "application/pdf"],
});
const validateFile = (input: { fileName: string; mediaType: string; data: Uint8Array }) => {
  const [file] = validateContent([{ ...input, declaredMediaType: input.mediaType }]);
  return { fileName: file!.fileName, mediaType: file!.mediaType, data: file!.data };
};
// Supply validateFile to createConversationFileStorage with host authorization,
// compatible limits and any frozen identities required by existing saved files.
```

The validator is synchronous and preserves the input byte type. Storage freezes
bytes before asynchronous work. Hosts with other formats provide a domain
validator; this addition does not change high-level staging's existing allowlist
or rewrite previously saved identities. Spartan now supplies only its limits,
format list and branded validation messages to this shared helper.
