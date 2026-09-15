# SDK-owned conversation titles

`createHandrailAssistant` owns automatic title generation as soon as a durable turn
has saved user text. This does not depend on Send, Enter, an open browser, or the client
implementation. Reading the catalog also checks imported
conversations that still have a placeholder title.

The default `openaiResponses({ model })` provider supplies a separate Responses
API call for titles. It uses capped user text, a short SDK-owned title prompt,
and the configured model. It sends no conversation tools, hosted search,
attachments, continuation data, or domain/system instructions. Both ordinary
text deltas and final output text are accepted without duplicating them.
The host continues to provide its authorized model and credential configuration.

## Configuration

New SDK catalogs leave an untitled conversation's title null. For existing
catalogs, configure the labels that mean “not named yet”:

```ts
const assistant = await createHandrailAssistant({
  // Existing authorization, provider, persistence, and usage configuration...
  automaticTitles: { placeholderTitles: ["New thread"] },
});
```

Automatic generation is enabled when `provider.generateTitle` exists.
`openaiResponses` supplies it without additional host code. A custom provider
implements that hook, returning text from `input.context.userTexts` and using
`input.signal`. Call `input.recordUsage(usage, status)` when reported provider
usage is available; otherwise the SDK records explicit unavailable token usage.
The SDK supplies authenticated context separately from model-visible title text.
Do not rename the catalog, schedule generation, or implement usage HTTP calls
inside the hook. The old `titleGeneration` endpoint override is retained for
compatibility; it does not replace the provider hook for automatic generation.

`automaticTitles: false` disables server automatic generation.
`timeoutMilliseconds` defaults to 30,000 and may be configured from 1 to 300,000.
Catalogs must support authorized optimistic `rename` operations. Existing named
or archived conversations are preserved, including manual changes made while
the model is generating a title.

## React surfaces

`HandrailAssistantLauncher` already uses the shared title observer. Custom React
and React Native presentations use the same hook from `react` or
`react/headless`:

```tsx
useConversationTitles({
  client,
  placeholderTitles: ["New thread"],
  onTitle: refreshConversationLabel,
});
```

The hook watches every loaded running or completed conversation, independent of the
selected thread and submit method. It refreshes the saved title and retains a
compatibility catalog write for older gateways that only return generated text.
It re-reads the catalog before writing so a server-persisted or manually renamed
title is not overwritten. `enabled: false` (or the launcher's `autoTitle={false}`)
disables this client observer, not server-owned generation.

Other clients read the same saved catalog title. They do not need to implement
generation or persistence; their normal catalog refresh determines when the new
label appears.

## Saved activity outside text turns

A host with separately persisted user speech can supply
`externalTitleUserTextsFor({ context, conversationId, signal })`. It must read only
currently authorized user speech from that exact conversation, respect cancellation,
and return strings. Do not return assistant speech, tool payloads, credentials,
or serialized metadata. The SDK uses this fallback only when canonical user text
is absent; it does not manufacture messages or turns. It bounds and normalizes
the text, reauthorizes catalog access after the read, and preserves concurrent
manual renames. Source reads share the title generation timeout. Empty sources
leave the existing title unchanged.

The host should select a stable saved source, such as an explicitly ended call,
using fresh account permissions rather than the call's expired media lease.
Catalog listing checks placeholder titles, or a client can explicitly request
the title endpoint and then refresh history. The Flutter controller's
`refreshGeneratedTitle(conversationId, operationId)` supports this server-owned
path without requiring a text message or falling back to a local rename.
Neither operation resumes calls, approves tools, or asserts spoken success.

When neither canonical text nor authorized speech exists, saved user attachment
types provide a deterministic label: “Shared documents”, “Shared images”, or
“Shared attachments”. This path does not call a title provider or expose file
names, references, or bytes. It uses the same authorized optimistic catalog
rename and preserves manual titles. A truly empty conversation keeps its
placeholder.

## Persistence and failures

The SDK authorizes catalog access before reading user text or joining pending
work. Concurrent requests within one server share a promise. A scoped durable
provider-operation claim prevents a second server from dispatching the same
operation. Its identity includes the assistant, tenant, scope, conversation,
and latest admitted turn. Running and completed observations of the same turn
share an operation identity. Completed generated results survive a failed catalog write
and can be persisted after restart without a second provider call.

The SDK uses the existing provider-operation store's uncertainty policy: an
operation that started but has no durable completed result is not blindly
dispatched again for that turn. A later turn has a new identity and
can try again; reconciling an uncertain operation remains an explicit operation.
The existing title stays visible, and title failures are diagnostic-only. Usage
admission and durable receipts are separate from the answer's invocation and
contain no prompt or transcript text.

## Consumer adoption

SDK source changes apply to consumers only after publication to a public HTTPS
Git full-SHA revision, matching lockfiles, and normal installation/build. Verify
installed packages and loaded releases separately. A working source checkout or
an adapter patch does not establish adoption. The external speech hook and
Flutter refresh method must both be available in the chosen published revisions
before enabling that integration.

Verify running turns from Enter and Send, reopened placeholders, manual
rename/archive races, provider failure, and separate usage receipts before
consumer deployment.
